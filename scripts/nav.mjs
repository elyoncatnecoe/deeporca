import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'
const port=9336
const env={...process.env, DEEPSEA_DEV_URL:''}; delete env.ELECTRON_RUN_AS_NODE
const child=spawn('node_modules/electron/dist/electron.exe',['.',`--remote-debugging-port=${port}`],{stdio:'ignore',env})
let ws,id=1;const pending=new Map()
const send=(m,p={})=>{const i=id++;ws.send(JSON.stringify({id:i,method:m,params:p}));return new Promise((res,rej)=>pending.set(i,{res,rej}))}
const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result?.value}
try{
 await sleep(4500)
 const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())
 const page=targets.find(t=>t.type==='page');ws=new WebSocket(page.webSocketDebuggerUrl)
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
 ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result)}}}
 await send('Runtime.enable');await sleep(2000)
 console.log('START',JSON.stringify(await ev('document.body.innerText.slice(0,200)')))
 const btns=await ev(`[...document.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.height>0}).map(b=>({t:(b.innerText||b.getAttribute('aria-label')||'').trim(),c:b.className,r:[Math.round(b.getBoundingClientRect().x),Math.round(b.getBoundingClientRect().y)]}))`)
 console.log('BUTTONS',JSON.stringify(btns))
 const clicked=await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='记忆'&&x.getBoundingClientRect().width>0);if(!b)return false;b.click();return true})()`)
 console.log('CLICKED_MEMORY',clicked)
 await sleep(1200)
 console.log('AFTER',JSON.stringify(await ev('document.body.innerText.slice(0,300)')))
 console.log('MEM?',await ev('!!document.querySelector(".memory-screen")'),'SET?',await ev('!!document.querySelector(".settings-screen")'))
 const img=await send('Page.captureScreenshot',{format:'png'});writeFileSync('shots/nav.png',Buffer.from(img.data,'base64'))
}catch(e){console.error(e)}finally{try{ws?.close()}catch{};try{execSync(`taskkill /PID ${child.pid} /T /F`,{stdio:'ignore'})}catch{}}
