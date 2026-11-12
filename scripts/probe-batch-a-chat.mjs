import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * A 批修复的第二个探针：聊天页正常收发没有被我改坏。
 *
 * 这里不带 Key，走的是「本地短话」那条路（runOfflineReply）：
 * 它同样经过 Chat.send() → 返回值决定是否清空输入框。
 */
const port = 9362
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })

let ws
let nextId = 1
const pending = new Map()
const consoleErrors = []

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}

async function shot(name) {
  const image = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`shots/${name}.png`, Buffer.from(image.data, 'base64'))
  console.log('shot', name)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url)
    s.onopen = () => resolve(s)
    s.onerror = reject
  })
}

function wire(s) {
  s.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'exception')
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
  }
}

try {
  await sleep(5000)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  wire(ws)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(1000)

  // 从首页点进对话页。
  const opened = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.home-dock .dock-item')].find((el) => (el.innerText || '').includes('对话'))
    if (!item) return false
    item.click()
    return true
  })()`)
  console.log('OPENED_CHAT', opened)
  await sleep(900)
  await shot('83-batch-a-chat')

  const before = await evaluate(`(() => {
    const area = document.querySelector('.composer textarea')
    return {
      hasComposer: Boolean(area),
      sendDisabled: document.querySelector('.send-button')?.disabled ?? null,
      stopButtons: document.querySelectorAll('.send-button.is-stop').length,
      bubbles: document.querySelectorAll('.bubble').length,
    }
  })()`)
  console.log('BEFORE', JSON.stringify(before))

  await evaluate(`document.querySelector('.composer textarea')?.focus()`)
  await send('Input.insertText', { text: '你好呀' })
  await sleep(400)
  const typed = await evaluate(`(() => ({
    value: document.querySelector('.composer textarea')?.value ?? '',
    sendDisabled: document.querySelector('.send-button')?.disabled ?? null,
  }))()`)
  console.log('TYPED', JSON.stringify(typed))

  await evaluate(`document.querySelector('.send-button:not(.is-stop)')?.click()`)
  await sleep(2600)

  const after = await evaluate(`(() => ({
    value: document.querySelector('.composer textarea')?.value ?? '',
    bubbles: document.querySelectorAll('.bubble').length,
    assistantText: [...document.querySelectorAll('.bubble-assistant .bubble-body')].map((el) => el.innerText.trim()).slice(-2),
    stopButtons: document.querySelectorAll('.send-button.is-stop').length,
    sendDisabled: document.querySelector('.send-button')?.disabled ?? null,
    toast: document.querySelector('.toast')?.innerText ?? '',
  }))()`)
  console.log('AFTER', JSON.stringify(after))
  await shot('83-batch-a-chat-after-send')
  console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
} catch (e) {
  console.error('PROBE ERROR', e)
} finally {
  try { child.kill() } catch {}
}