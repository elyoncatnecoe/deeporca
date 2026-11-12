import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port = 9365
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
  await click('.talk-button', 1600)
  await click('.chat-head-actions .icon-button:nth-child(4)', 1100)
  await ev(`(()=>{const el=document.querySelector('.drawer-item');const b=el?.querySelector('button')??el;b?.click();return 1})()`)
  await sleep(2400)
  const m = async (tag) => console.log(tag, JSON.stringify(await ev(`(()=>{const nav=document.querySelector('.turn-nav');const rail=document.querySelector('.turn-nav-rail');const keys=document.querySelectorAll('.turn-nav-key');const sheet=document.querySelector('.chat-sheet');if(!nav)return {nav:false};if(!rail)return {compact:true,keys:keys.length,navH:Math.round(nav.getBoundingClientRect().height)};return {compact:false,marks:document.querySelectorAll('.turn-nav-mark').length,sheetH:Math.round(sheet.getBoundingClientRect().height),navH:Math.round(nav.clientHeight),railH:Math.round(rail.offsetHeight),ok:rail.offsetHeight<=nav.clientHeight+1}})()`)))
  await m('DESKTOP-FULL')
  await shot('172-desktop-nav-full')
  await ev(`(()=>{const s=document.querySelector('.chat-sheet');if(s)s.className='chat-sheet sheet-peek';return 1})()`)
  await sleep(1400)
  await m('DESKTOP-PEEK')
  await shot('173-desktop-nav-peek')
} catch (e) { console.error('ERR', e) } finally {
  try { ws?.close() } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
}
