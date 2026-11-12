import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port=9339
const env={...process.env, DEEPSEA_DEV_URL:''}; delete env.ELECTRON_RUN_AS_NODE
const child=spawn('node_modules/electron/dist/electron.exe',['.',`--remote-debugging-port=${port}`],{stdio:'ignore',env})
let ws,id=1;const pending=new Map()
const send=(m,p={})=>{const i=id++;ws.send(JSON.stringify({id:i,method:m,params:p}));return new Promise((res,rej)=>pending.set(i,{res,rej}))}
const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result?.value}
const shot=async(n)=>{const img=await send('Page.captureScreenshot',{format:'png'});mkdirSync('shots',{recursive:true});writeFileSync(`shots/${n}.png`,Buffer.from(img.data,'base64'))}
try{
 await sleep(4500)
 const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())
 const page=targets.find(t=>t.type==='page');ws=new WebSocket(page.webSocketDebuggerUrl)
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
 ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result)}}}
 await send('Runtime.enable');await send('Page.enable')
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true})
 await sleep(2000)
 await shot('20-mobile-home')
 await ev(`document.querySelector('.talk-button')?.click()`);await sleep(1200)
 await shot('21-mobile-chat')
 await ev(`document.querySelector('.chat-head .icon-button')?.click()`);await sleep(600)
 await ev(`document.querySelectorAll('.home-dock .dock-item')[4]?.click()`);await sleep(800)
 await shot('22-mobile-settings')
 console.log('DONE')
}catch(e){console.error(e)}finally{try{ws?.close()}catch{};try{execSync(`taskkill /PID ${child.pid} /T /F`,{stdio:'ignore'})}catch{}}
