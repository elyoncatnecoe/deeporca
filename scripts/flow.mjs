import { spawn, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const port = 9334
const electron = 'node_modules/electron/dist/electron.exe'
const childEnv = { ...process.env, DEEPSEA_DEV_URL: '' }
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env: childEnv })

let ws
let nextId = 1
const pending = new Map()
const consoleLines = []
const exceptions = []

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result?.value
}

async function clickText(text) {
  const clicked = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button, [role="button"]')]
    const visible = (n) => {
      const s = getComputedStyle(n)
      const r = n.getBoundingClientRect()
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const node = nodes.find((n) => visible(n) && (n.innerText || n.getAttribute('aria-label') || '').includes(${JSON.stringify(text)}))
    if (!node) return false
    node.click()
    return true
  })()`)
  if (!clicked) throw new Error(`no visible clickable contains: ${text}`)
  await sleep(900)
}

async function shot(name) {
  const image = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync('shots', { recursive: true })
  writeFileSync(`shots/${name}.png`, Buffer.from(image.data, 'base64'))
  console.log('shot', name)
}

try {
  await sleep(4500)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error(`no page target: ${JSON.stringify(targets)}`)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const waiter = pending.get(message.id)
      if (waiter) {
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
        else waiter.resolve(message.result)
      }
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.text + ' ' + (message.params.exceptionDetails.exception?.description ?? ''))
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(1800)
  const onboarding = await evaluate('document.body.innerText.includes("开始下潜")')
  if (onboarding) {
    await shot('01-onboarding')
    await clickText('开始下潜')
    await shot('02-mode')
    await clickText('网页版 · 不用 Key')
    await clickText('继续')
  }
  await sleep(4500)
  await shot('03-home')
  const homeText = await evaluate('document.body.innerText.slice(0, 400)')
  console.log('HOME TEXT:', JSON.stringify(homeText))
  const canvas = await evaluate('document.querySelectorAll("canvas").length')
  console.log('CANVAS COUNT:', canvas)
  await clickText('和深鲸说点什么')
  await sleep(1200)
  await shot('04-chat')
  await clickText('回到海面')
  await sleep(500)
  await clickText('记忆')
  await sleep(700)
  await shot('05-memory')
  await clickText('返回')
  await sleep(500)
  await clickText('设置')
  await sleep(700)
  await shot('06-settings')
  console.log('CONSOLE:', consoleLines.join('\n') || '(none)')
  console.log('EXCEPTIONS:', exceptions.join('\n') || '(none)')
} catch (error) {
  console.error('FLOW ERROR', error)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* ignore */ }
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
}
