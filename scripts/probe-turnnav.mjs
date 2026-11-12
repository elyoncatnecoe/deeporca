import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port = 9359
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })
let ws, id = 1
const pending = new Map()
const send = (m, p = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => pending.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result?.value }
const shot = async (n) => { const img = await send('Page.captureScreenshot', { format: 'png' }); mkdirSync('shots', { recursive: true }); writeFileSync(`shots/${n}.png`, Buffer.from(img.data, 'base64')); console.log('SHOT', n) }
const click = async (sel, wait = 900) => { const r = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'MISSING';el.click();return 'OK'})()`); await sleep(wait); return r }
const measure = async (tag) => console.log(tag, JSON.stringify(await ev(`(()=>{const nav=document.querySelector('.turn-nav');const rail=document.querySelector('.turn-nav-rail');const sheet=document.querySelector('.chat-sheet');if(!nav||!rail)return {nav:!!nav,rail:!!rail,cls:sheet?.className};const marks=[...document.querySelectorAll('.turn-nav-mark')];return {cls:sheet.className,sheetH:sheet.clientHeight,navH:nav.clientHeight,railH:rail.offsetHeight,marks:marks.length,ok:rail.offsetHeight<=nav.clientHeight+1}})()`)))
try {
  await sleep(5200)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } } }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  try { await send('Page.setWebLifecycleState', { state: 'active' }) } catch {}
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(2400)

  const seeded = await ev(`(async()=>{
    const db = await new Promise((res,rej)=>{const r=indexedDB.open('deepsea',2);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})
    const all = await new Promise((res)=>{const rq=db.transaction('conversations','readonly').objectStore('conversations').getAll();rq.onsuccess=()=>res(rq.result)})
    if(!all.length) return 'NO CONVERSATIONS'
    const conv = all[0]
    const tx = db.transaction(['messages','conversations'],'readwrite')
    const ms = tx.objectStore('messages')
    for(let i=0;i<14;i++){
      ms.put({id:'seed-'+conv.id+'-'+i, conversationId:conv.id, role: i%2===0?'user':'assistant', content:'第 '+(i+1)+' 条（seed）', createdAt: Date.now()-((14-i)*60000)})
    }
    tx.objectStore('conversations').put({...conv, updatedAt: Date.now()})
    await new Promise((res)=>{tx.oncomplete=res})
    return conv.id
  })()`)
  console.log('SEEDED', seeded)

  await send('Page.reload', { ignoreCache: false })
  await sleep(6000)
  await click('.talk-button', 1500)
  console.log('HISTORY', await click('.chat-head-actions .icon-button:nth-child(4)', 1200))
  console.log('PICK', await ev(`(()=>{const el=document.querySelector('.drawer-item');if(!el)return 'NO ITEM';const btn=el.querySelector('button')??el;btn.click();return 'CLICKED'})()`))
  await sleep(2500)
  console.log('TITLE', await ev(`document.querySelector('.chat-title h1')?.textContent ?? document.querySelector('.chat-title')?.textContent`))
  await measure('FULL')
  await ev(`(()=>{const s=document.querySelector('.chat-sheet');if(s)s.className='chat-sheet sheet-peek';return 1})()`)
  await sleep(1400)
  await measure('PEEK')
  await shot('166-turnnav-peek')
  await ev(`(()=>{const s=document.querySelector('.chat-sheet');if(s)s.className='chat-sheet sheet-full';return 1})()`)
  await sleep(1300)
  await measure('FULL-AGAIN')
  await shot('167-turnnav-full')
} catch (e) { console.error('ERR', e) } finally {
  try { ws?.close() } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
}
