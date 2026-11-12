import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'
const port=9338
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
 await send('Runtime.enable');await sleep(1800)
 await ev(`document.querySelectorAll('.home-top-actions .icon-button')[1].click()`);await sleep(700)
 const rows=await ev(`[...document.querySelectorAll('.drawer-row')].map((r,i)=>({i,t:r.innerText.slice(0,40)}))`)
 console.log('ROWS',JSON.stringify(rows))
 await ev(`document.querySelector('.drawer-row').click()`);await sleep(1500)
 const info=await ev(`(() => {
   const cards=[...document.querySelectorAll('.tool-card')]
   return {
     count: cards.length,
     cards: cards.map(c=>{const s=getComputedStyle(c),r=c.getBoundingClientRect();return {text:c.innerText.slice(0,80),display:s.display,visibility:s.visibility,opacity:s.opacity,color:s.color,rect:[r.x,r.y,r.width,r.height],html:c.outerHTML.slice(0,200)}}),
     scroll:{top:document.querySelector('.chat-scroll').scrollTop,height:document.querySelector('.chat-scroll').scrollHeight,client:document.querySelector('.chat-scroll').clientHeight},
     msgCount:document.querySelectorAll('.bubble').length,
   }
 })()`)
 console.log(JSON.stringify(info,null,2))
 const img=await send('Page.captureScreenshot',{format:'png'});writeFileSync('shots/toolinspect.png',Buffer.from(img.data,'base64'))
}catch(e){console.error(e)}finally{try{ws?.close()}catch{};try{execSync(`taskkill /PID ${child.pid} /T /F`,{stdio:'ignore'})}catch{}}
