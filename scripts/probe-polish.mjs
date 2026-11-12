import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port = 9355
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
try {
  await sleep(5200)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } } if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text) }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  try { await send('Page.setWebLifecycleState', { state: 'active' }) } catch {}
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(2600)

  // ---- 1) 台词 pill ----
  await click('.home-top-actions .icon-button:nth-child(3)', 1900)
  console.log('GROWTH FEEDS', await ev(`(()=>{const b=[...document.querySelectorAll('.room-ghost')].find(x=>x.textContent.includes('复原'));return b?b.disabled:'no button'})()`))
  await click('.room-panel .room-ghost', 700)
  const pill = await ev(`(()=>{const t=document.querySelector('.orca-thought');if(!t)return 'NO ELEMENT';const cs=getComputedStyle(t);return {display:cs.display,opacity:cs.opacity,show:t.dataset.show,text:t.textContent}})()`)
  console.log('THOUGHT PILL', JSON.stringify(pill))
  await shot('161-thought-pill')

  // ---- 2) 动作速度滑杆 ----
  await click('.room-tabs .room-tab:nth-child(5)', 900)
  console.log('SLIDER EXISTS', await ev(`document.querySelectorAll('.room-panel input[type=range]').length`))
  const before = await ev(`localStorage.getItem('orca-aquarium-shell:save:v1') ? JSON.parse(localStorage.getItem('orca-aquarium-shell:save:v1')).motionSpeed : 'none'`)
  await ev(`(()=>{const s=[...document.querySelectorAll('.room-panel input[type=range]')].find(i=>i.getAttribute('aria-label')==='动作速度');if(!s)return 'MISSING';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(s,'0.55');s.dispatchEvent(new Event('input',{bubbles:true}));return 'OK'})()`)
  await sleep(800)
  console.log('MOTION before/after', before, '->', await ev(`JSON.parse(localStorage.getItem('orca-aquarium-shell:save:v1')).motionSpeed`))
  console.log('MOTION LABEL', await ev(`[...document.querySelectorAll('.room-value')].map(e=>e.textContent)`))
  await shot('162-motion-slider')

  // ---- 3) 快捷指令 ----
  await click('.room-screen .screen-header .icon-button', 1200)
  await click('.talk-button', 1600)
  console.log('TRIGGER', await ev(`!!document.querySelector('.quick-cmd-trigger')`))
  await click('.quick-cmd-trigger', 900)
  console.log('CHIPS', await ev(`document.querySelectorAll('.quick-cmd-chip').length`), 'ITEMS', await ev(`document.querySelectorAll('.quick-cmd-item').length`))
  await shot('163-quick-commands')
  await click('.quick-cmd-chip', 900)
  console.log('DRAFT', JSON.stringify(await ev(`document.querySelector('textarea')?.value ?? 'NO TEXTAREA'`)))
  await click('.quick-cmd-trigger', 700)
  await click('.quick-cmd-item', 900)
  console.log('DRAFT2', JSON.stringify(await ev(`document.querySelector('textarea')?.value ?? ''`)))
  await shot('164-quick-commands-filled')

  // ---- 4) turn-nav 对齐 ----
  const nav = await ev(`(()=>{const sheet=document.querySelector('.chat-sheet');if(!sheet)return 'NO SHEET';sheet.className='chat-sheet sheet-peek';return 'forced peek'})()`)
  await sleep(1200)
  console.log('NAV', nav, JSON.stringify(await ev(`(()=>{const nav=document.querySelector('.turn-nav');const rail=document.querySelector('.turn-nav-rail');const sheet=document.querySelector('.chat-sheet');if(!nav||!rail)return 'NO NAV';return {sheetH:sheet.clientHeight,navH:nav.clientHeight,railH:rail.offsetHeight,ok:rail.offsetHeight<=nav.clientHeight+1}})()`)))
  await shot('165-turnnav-peek')
} catch (e) { console.error('ERR', e) } finally {
  console.log('EXCEPTIONS', exceptions.join('\n') || '(none)')
  try { ws?.close() } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
}
