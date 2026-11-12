import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const port=9335
const env={...process.env, DEEPSEA_DEV_URL:''}; delete env.ELECTRON_RUN_AS_NODE
const child=spawn('node_modules/electron/dist/electron.exe',['.',`--remote-debugging-port=${port}`],{stdio:'ignore',env})
let ws, id=1; const pending=new Map()
const send=(method,params={})=>{ const i=id++; ws.send(JSON.stringify({id:i,method,params})); return new Promise((res,rej)=>pending.set(i,{res,rej})) }
try {
  await sleep(4500)
  const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())
  const page=targets.find(t=>t.type==='page'); ws=new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
  ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id){const p=pending.get(m.id); if(p){pending.delete(m.id); m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result)}}}
  await send('Runtime.enable')
  await sleep(1500)
  const r=await send('Runtime.evaluate',{expression:`(() => {
    const out=[]
    for (const el of document.querySelectorAll('*')) {
      const s=getComputedStyle(el)
      if (s.display==='none'||s.visibility==='hidden') continue
      if (s.position!=='fixed'&&s.position!=='absolute') continue
      const r=el.getBoundingClientRect()
      if (r.width<8||r.height<8) continue
      if (r.right < innerWidth*0.6 || r.bottom < innerHeight*0.55) continue
      const z=parseInt(s.zIndex)||0
      if (z<1) continue
      out.push({tag:el.tagName, cls:el.className, z, text:(el.innerText||'').slice(0,40), r:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]})
    }
    return out
  })()`,returnByValue:true})
  console.log(JSON.stringify(r.result.value,null,2))
  const btns=await send('Runtime.evaluate',{expression:`[...document.querySelectorAll('button')].map(b=>({t:(b.innerText||b.getAttribute('aria-label')||'').slice(0,30),cls:b.className,vis:getComputedStyle(b).display!=='none'})).filter(b=>b.t.includes('☰')||b.t.includes('设置')||b.t.includes('返回'))`,returnByValue:true})
  console.log('BTNS',JSON.stringify(btns.result.value,null,2))
} catch(e){console.error(e)} finally {try{ws?.close()}catch{}; try{execSync(`taskkill /PID ${child.pid} /T /F`,{stdio:'ignore'})}catch{}}
