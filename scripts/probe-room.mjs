import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'

const port = 9341
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })

let ws, id = 1
const pending = new Map()
const exceptions = []
const errors = []
const send = (m, p = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => pending.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result?.value }
const shot = async (n) => { const img = await send('Page.captureScreenshot', { format: 'png' }); mkdirSync('shots', { recursive: true }); writeFileSync(`shots/${n}.png`, Buffer.from(img.data, 'base64')); console.log('SHOT', n) }
const click = async (sel, wait = 900) => { const ok = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'MISSING';el.click();return 'OK'})()`); await sleep(wait); return ok }

try {
  await sleep(5000)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description ?? ''))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
  await send('Runtime.enable')
  await send('Page.enable')

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(2600)

  console.log('SCREEN', await ev(`document.querySelector('.app')?.dataset.screen`))
  console.log('TONE', await ev(`document.querySelector('.app')?.dataset.tone`))
  console.log('HOME ICONS', await ev(`document.querySelectorAll('.home-top-actions .icon-button').length`))
  await shot('120-home-room-entry')

  console.log('CLICK ROOM', await click('.home-top-actions .icon-button:nth-child(3)', 2000))
  console.log('SCREEN NOW', await ev(`document.querySelector('.app')?.dataset.screen`))
  console.log('CANVAS', await ev(`document.querySelectorAll('canvas').length`))
  console.log('ROOM TEXT', JSON.stringify(await ev(`document.querySelector('.room-screen')?.innerText.slice(0,240) ?? 'NO ROOM'`)))
  await shot('121-room-feed')

  console.log('TAB DECOR', await click('.room-tabs .room-tab:nth-child(2)'))
  await shot('122-room-decor')
  console.log('TAB PHOTO', await click('.room-tabs .room-tab:nth-child(3)'))
  await shot('123-room-photo')
  console.log('TAB COMPANION', await click('.room-tabs .room-tab:nth-child(4)'))
  console.log('CLAWD', await click('.room-toggle-row:nth-child(1) .switch', 1400))
  console.log('SEAL', await click('.room-toggle-row:nth-child(2) .switch', 1800))
  console.log('COMPANION STATE', JSON.stringify(await ev(`(()=>{const s=[...document.querySelectorAll('.room-toggle-row .switch')];return s.map(x=>x.getAttribute('aria-checked'))})()`)))
  await shot('124-room-companions')
  console.log('TAB LOOK', await click('.room-tabs .room-tab:nth-child(5)'))
  await shot('125-room-look')

  console.log('ZEN', await click('.room-screen .screen-actions .icon-button', 1500))
  console.log('ZEN STATE', await ev(`document.querySelector('.app')?.dataset.zen`))
  console.log('ZEN DOT', await ev(`!!document.querySelector('.zen-dot')`))
  await shot('126-zen')
  console.log('ZEN EXIT', await click('.zen-dot', 1200))
  console.log('ZEN AFTER', await ev(`document.querySelector('.app')?.dataset.zen`))

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(2200)
  console.log('CHAT VISIBLE', await ev(`(()=>{const el=document.querySelector('.chat-screen');if(!el)return 'NO CHAT';const cs=getComputedStyle(el);return cs.display})()`))
  await shot('127-room-desktop')
} catch (e) {
  console.error('ERR', e)
} finally {
  console.log('EXCEPTIONS', exceptions.join('\n') || '(none)')
  console.log('CONSOLE ERRORS', errors.join('\n') || '(none)')
  try { ws?.close() } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
}
