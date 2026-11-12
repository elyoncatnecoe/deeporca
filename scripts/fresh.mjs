import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port=9345
const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE
const child=spawn('dist-app/win-unpacked/深鲸.exe',[`--remote-debugging-port=${port}`],{stdio:'ignore',env})
let ws,id=1;const pending=new Map()
const send=(m,p={})=>{const i=id++;ws.send(JSON.stringify({id:i,method:m,params:p}));return new Promise((res,rej)=>pending.set(i,{res,rej}))}
const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});return r.result?.value}
try{
 await sleep(5000)
 const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())
 const page=targets.find(t=>t.type==='page');ws=new WebSocket(page.webSocketDebuggerUrl)
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
 ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result)}}}
 await send('Runtime.enable');await send('Page.enable');await sleep(1800)
 console.log('TEXT',JSON.stringify(await ev('document.body.innerText.slice(0,160)')))
 console.log('ONBOARDING',await ev('document.body.innerText.includes("开始下潜")'))
 const img=await send('Page.captureScreenshot',{format:'png'});mkdirSync('shots',{recursive:true});writeFileSync('shots/41-fresh.png',Buffer.from(img.data,'base64'))
}catch(e){console.error('ERR',e)}finally{try{ws?.close()}catch{};try{execSync('taskkill /IM "深鲸.exe" /F',{stdio:'ignore'})}catch{}}
