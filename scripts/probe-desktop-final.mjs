import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port = 9353
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })
let ws, id = 1
const pending = new Map()
const send = (m, p = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => pending.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value }
const shot = async (n) => { const img = await send('Page.captureScreenshot', { format: 'png' }); mkdirSync('shots', { recursive: true }); writeFileSync(`shots/${n}.png`, Buffer.from(img.data, 'base64')); console.log('SHOT', n) }
const click = async (sel, wait = 900) => { const r = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'MISSING';el.click();return 'OK'})()`); await sleep(wait); return r }
try {
  await sleep(5200)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } } }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  try { await send('Page.setWebLifecycleState', { state: 'active' }) } catch {}
  await sleep(2600)
  console.log('VIEWPORT', await ev(`[innerWidth,innerHeight,devicePixelRatio]`))
  await click('.home-top-actions .icon-button:nth-child(3)', 2200)
  console.log('CHAT', await ev(`(()=>{const e=document.querySelector('.chat-screen');return e?getComputedStyle(e).display:'none'})()`))
  console.log('CANVAS', await ev(`(()=>{const c=document.querySelector('canvas');return [c.width,c.height,Math.round(c.getBoundingClientRect().width)]})()`))
  await shot('159-desktop-room-native')
  await click('.room-tabs .room-tab:nth-child(4)', 900)
  await shot('160-desktop-companions-native')
} catch (e) { console.error('ERR', e) } finally {
  try { ws?.close() } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
}
