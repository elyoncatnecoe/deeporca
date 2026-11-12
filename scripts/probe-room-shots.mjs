import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port = 9351
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

  // 手机视口
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(2800)
  await shot('150-mobile-home')
  await click('.home-top-actions .icon-button:nth-child(3)', 2000)
  await shot('151-mobile-room-feed')
  await click('.room-tabs .room-tab:nth-child(4)', 800)
  await shot('152-mobile-room-companions')
  await click('.room-tabs .room-tab:nth-child(3)', 700)
  await click('.room-panel .room-cta', 5000)
  await shot('153-mobile-room-photo')
  await click('.room-row--between .room-ghost', 1400)
  console.log('ALBUM ITEMS', await ev(`document.querySelectorAll('.album-item').length`))
  await shot('154-mobile-album')
  await ev(`document.querySelector('.modal-head .icon-button')?.click()`); await sleep(800)
  await click('.room-tabs .room-tab:nth-child(5)', 800)
  await shot('155-mobile-room-look')
  await click('.room-screen .screen-actions .icon-button', 1800)
  await shot('156-mobile-zen')
  await click('.zen-dot', 1200)

  // 桌面视口
  await send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 0, mobile: false })
  await sleep(2000)
  await click('.room-screen .screen-header .icon-button', 1200)
  await click('.home-top-actions .icon-button:nth-child(4)', 1600)
  await shot('157-desktop-settings')
  await ev(`document.querySelector('.screen-header .icon-button')?.click()`); await sleep(1000)
  await click('.home-top-actions .icon-button:nth-child(3)', 1800)
  await shot('158-desktop-room')
} catch (e) { console.error('ERR', e) } finally {
  try { ws?.close() } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
}
