import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port = 9363
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })
let ws, id = 1
const pending = new Map()
const send = (m, p = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => pending.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value }
const shot = async (n) => { const img = await send('Page.captureScreenshot', { format: 'png' }); mkdirSync('shots', { recursive: true }); writeFileSync(`shots/${n}.png`, Buffer.from(img.data, 'base64')); console.log('SHOT', n) }
const click = async (sel, wait = 900) => { const r = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'MISSING';el.click();return 'OK'})()`); await sleep(wait); return r }
const nav = async (tag) => console.log(tag, JSON.stringify(await ev(`(()=>{const n=document.querySelector('.turn-nav');const sheet=document.querySelector('.chat-sheet');const keys=[...document.querySelectorAll('.turn-nav-key')];if(!n)return {nav:false};const r=n.getBoundingClientRect();const sr=sheet.getBoundingClientRect();return {sheetH:Math.round(sr.height),navH:Math.round(r.height),keys:keys.length,keyH:keys[0]?Math.round(keys[0].getBoundingClientRect().height):0,gaps:keys.length>1?Math.round(keys[1].getBoundingClientRect().top-keys[0].getBoundingClientRect().bottom):0,navTop:Math.round(r.top-sr.top),navBottom:Math.round(r.bottom-sr.top)}})()`)))
try {
  await sleep(5200)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } } }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  try { await send('Page.setWebLifecycleState', { state: 'active' }) } catch {}
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 792, deviceScaleFactor: 3, mobile: true })
  await sleep(2600)
  await click('.talk-button', 1500)
  await click('.chat-head-actions .icon-button:nth-child(4)', 1100)
  await ev(`(()=>{const el=document.querySelector('.drawer-item');const b=el?.querySelector('button')??el;b?.click();return 1})()`)
  await sleep(2400)
  await nav('HALF')
  await ev(`(()=>{const s=document.querySelector('.chat-sheet');if(s)s.className='chat-sheet sheet-peek';return 1})()`)
  await sleep(1400)
  await nav('PEEK')
  await shot('170-nav-fixed-peek')
  await ev(`(()=>{const s=document.querySelector('.chat-sheet');if(s)s.className='chat-sheet sheet-full';return 1})()`)
  await sleep(1300)
  await nav('FULL')
  await shot('171-nav-fixed-full')
} catch (e) { console.error('ERR', e) } finally {
  try { ws?.close() } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
}
