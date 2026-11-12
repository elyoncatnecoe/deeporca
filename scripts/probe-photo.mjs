import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port = 9349
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })
let ws, id = 1
const pending = new Map()
const logs = []
const send = (m, p = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => pending.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result?.value }
const click = async (sel, wait = 900) => { const r = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'MISSING';el.click();return 'OK'})()`); await sleep(wait); return r }
try {
  await sleep(5200)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } } if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')); if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description ?? '')) }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  try { await send('Page.setWebLifecycleState', { state: 'active' }) } catch {}
  await sleep(2400)
  await click('.home-top-actions .icon-button:nth-child(3)', 1800)
  await click('.room-tabs .room-tab:nth-child(3)', 700)
  console.log('SHOOT', await click('.room-panel .room-cta', 5000))
  console.log('ALBUM COUNT', await ev(`(()=>{const t=document.querySelector('.room-dock')?.innerText??'';return (t.match(/相册（(\\d+)）/)||[])[1]})()`))
  console.log('LOGS', JSON.stringify(logs.filter((l) => /orca|photo|拍|Error|error/i.test(l)), null, 1))
} catch (e) { console.error('ERR', e) } finally {
  console.log('ALL LOGS', JSON.stringify(logs.slice(-12), null, 1))
  try { ws?.close() } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
}
