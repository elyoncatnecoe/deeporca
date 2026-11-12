import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'

const port = 9347
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })
let ws, id = 1
const pending = new Map()
const exceptions = []
const send = (m, p = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => pending.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result?.value }
const shot = async (n) => { const img = await send('Page.captureScreenshot', { format: 'png' }); mkdirSync('shots', { recursive: true }); writeFileSync(`shots/${n}.png`, Buffer.from(img.data, 'base64')); console.log('SHOT', n) }
const click = async (sel, wait = 900) => { const r = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'MISSING';el.click();return 'OK'})()`); await sleep(wait); return r }
const tapCanvas = async (x, y) => ev(`(()=>{const c=document.querySelector('canvas');const o={clientX:${x},clientY:${y},bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1};
  c.dispatchEvent(new PointerEvent('pointerdown',o));c.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}));return 'TAP'})()`)
const stats = async () => ev(`(()=>{const d=[...document.querySelectorAll('.room-stats strong')].map(e=>e.textContent);const t=document.querySelector('.room-dock')?.innerText??'';return {stats:d,photo:(t.match(/相册（(\\d+)）/)||[])[1]??null,decor:(t.match(/清空（(\\d+)）/)||[])[1]??null}})()`)

try {
  await sleep(5200)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } } if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text) }
  await send('Runtime.enable'); await send('Page.enable')
  // 让页面认为自己是可见 + 有焦点的，否则 rAF 被节流，token 不落、拍照等不到下一帧
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  try { await send('Page.setWebLifecycleState', { state: 'active' }) } catch (e) { console.log('lifecycle n/a') }
  await sleep(2600)
  console.log('HIDDEN', await ev(`document.hidden`), 'HASFOCUS', await ev(`document.hasFocus()`))
  console.log('FPS PROBE', await ev(`new Promise(r=>{let n=0;const t=setTimeout(()=>r(n),1000);const f=()=>{n++;if(n<200)requestAnimationFrame(f)};requestAnimationFrame(f)})`))

  await click('.home-top-actions .icon-button:nth-child(3)', 2000)
  console.log('ROOM', await ev(`document.querySelector('.app').dataset.screen`))

  // 投喂：上膛后点一片区域，命中虎鲸就算成功
  console.log('ARM', await click('.room-cta', 800))
  const w = await ev(`innerWidth`), h = await ev(`innerHeight`)
  const cx = Math.round(w * 0.5), cy = Math.round(h * 0.46)
  for (const [dx, dy] of [[0, 0], [-60, 0], [60, 0], [0, -50], [0, 50], [-100, 20], [100, 20]]) {
    await tapCanvas(cx + dx, cy + dy)
    await sleep(700)
  }
  await sleep(5000)
  await click('.room-dock--compact .room-ghost', 800)
  console.log('FEED RESULT', await stats())
  await shot('142-desktop-feed-ok')

  // 拍照
  console.log('TAB PHOTO', await click('.room-tabs .room-tab:nth-child(3)', 700))
  console.log('SHOOT', await click('.room-panel .room-cta', 5000))
  console.log('PHOTO RESULT', await stats())
  await shot('143-desktop-photo-ok')
  console.log('ALBUM', await click('.room-row--between .room-ghost', 1200))
  console.log('ALBUM OPEN', await ev(`!!document.querySelector('.album-grid')`), await ev(`document.querySelectorAll('.album-item').length`))
  await shot('144-desktop-album')
} catch (e) { console.error('ERR', e) } finally {
  console.log('EXCEPTIONS', exceptions.join('\n') || '(none)')
  try { ws?.close() } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
}
