import { spawn, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const port = 9333
const electron = 'node_modules/electron/dist/electron.exe'
const childEnv = { ...process.env, DEEPSEA_DEV_URL: '' }
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
  stdio: 'ignore',
  env: childEnv,
})

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
  await send('Log.enable')
  await sleep(2200)
  const text = await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0, 600)', returnByValue: true })
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync('shots', { recursive: true })
  writeFileSync('shots/home.png', Buffer.from(shot.data, 'base64'))
  console.log('TEXT:', JSON.stringify(text.result?.value))
  console.log('CONSOLE:', consoleLines.join('\n') || '(none)')
  console.log('EXCEPTIONS:', exceptions.join('\n') || '(none)')
  console.log('SHOT: shots/home.png')
} catch (error) {
  console.error('SMOKE ERROR', error)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* ignore */ }
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
}
