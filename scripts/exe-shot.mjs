import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port=9344
const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE
const child=spawn('dist-app/win-unpacked/深鲸.exe',[`--remote-debugging-port=${port}`],{stdio:'ignore',env})
let ws,id=1;const pending=new Map();const consoleLines=[];const exceptions=[]
const send=(m,p={})=>{const i=id++;ws.send(JSON.stringify({id:i,method:m,params:p}));return new Promise((res,rej)=>pending.set(i,{res,rej}))}
const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result?.value}
try{
 await sleep(5000)
 const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())
 const page=targets.find(t=>t.type==='page')
 ws=new WebSocket(page.webSocketDebuggerUrl)
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
 ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result)}};if(m.method==='Runtime.consoleAPICalled')consoleLines.push(m.params.type+': '+m.params.args.map(a=>a.value??a.description??'').join(' '));if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails.text+' '+(m.params.exceptionDetails.exception?.description??''))}
 await send('Runtime.enable');await send('Page.enable');await sleep(2000)
 console.log('TEXT',JSON.stringify(await ev('document.body.innerText.slice(0,220)')))
 console.log('CANVAS',await ev('document.querySelectorAll("canvas").length'))
 const img=await send('Page.captureScreenshot',{format:'png'});mkdirSync('shots',{recursive:true});writeFileSync('shots/40-exe.png',Buffer.from(img.data,'base64'))
 console.log('CONSOLE',consoleLines.join('\n')||'(none)');console.log('EXCEPTIONS',exceptions.join('\n')||'(none)')
}catch(e){console.error('ERR',e)}finally{try{ws?.close()}catch{};try{execSync('taskkill /IM "深鲸.exe" /F',{stdio:'ignore'})}catch{}}
