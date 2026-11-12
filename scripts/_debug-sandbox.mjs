import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const port = 9366
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })

let ws, nextId = 1
const pending = new Map()
const logs = []
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
function connect(url) {
  return new Promise((resolve, reject) => { const s = new WebSocket(url); s.onopen = () => resolve(s); s.onerror = reject })
}
function wire(s) {
  s.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return }
    if (m.method === 'Log.entryAdded') logs.push(`${m.params?.entry?.source}: ${m.params?.entry?.text}`)
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`console.${m.params?.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`)
  }
}

try {
  await sleep(5000)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  wire(ws)
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable')
  await sleep(1000)

  const minimal = '<scr' + 'ipt>parent.postMessage({__ping:1},"*")</scr' + 'ipt>'

  // A：blob + sandbox，最小文档（无 CSP meta）
  const a = await evaluate(`new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    const url = URL.createObjectURL(new Blob([${JSON.stringify(minimal)}], { type: 'text/html' }))
    let loaded = false
    frame.onload = () => { loaded = true }
    frame.src = url
    const timer = setTimeout(() => resolve({ loaded, gotMessage: false }), 2000)
    function onMessage(e) { if (e.data && e.data.__ping) { clearTimeout(timer); resolve({ loaded, gotMessage: true }) } }
    window.addEventListener('message', onMessage)
    document.body.appendChild(frame)
  })`)
  console.log('A blob+sandbox minimal:', JSON.stringify(a))

  // B：srcdoc + sandbox，最小文档
  const b = await evaluate(`new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    let loaded = false
    frame.onload = () => { loaded = true }
    frame.srcdoc = ${JSON.stringify(minimal)}
    const timer = setTimeout(() => resolve({ loaded, gotMessage: false }), 2000)
    function onMessage(e) { if (e.data && e.data.__ping) { clearTimeout(timer); resolve({ loaded, gotMessage: true }) } }
    window.addEventListener('message', onMessage)
    document.body.appendChild(frame)
  })`)
  console.log('B srcdoc+sandbox minimal:', JSON.stringify(b))

  // C：blob 但不加 sandbox（对照组：确认 blob 本身能加载）
  const c = await evaluate(`new Promise((resolve) => {
    const frame = document.createElement('iframe')
    const url = URL.createObjectURL(new Blob([${JSON.stringify(minimal)}], { type: 'text/html' }))
    let loaded = false
    frame.onload = () => { loaded = true }
    frame.src = url
    const timer = setTimeout(() => resolve({ loaded, gotMessage: false }), 2000)
    function onMessage(e) { if (e.data && e.data.__ping) { clearTimeout(timer); resolve({ loaded, gotMessage: true }) } }
    window.addEventListener('message', onMessage)
    document.body.appendChild(frame)
  })`)
  console.log('C blob no-sandbox minimal:', JSON.stringify(c))

  console.log('LOGS', JSON.stringify(logs.slice(0, 10)))
} catch (e) {
  console.error('ERR', e)
} finally {
  try { child.kill() } catch {}
}