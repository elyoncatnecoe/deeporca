import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
const port=9340
const env={...process.env, DEEPSEA_DEV_URL:''}; delete env.ELECTRON_RUN_AS_NODE
const child=spawn('node_modules/electron/dist/electron.exe',['.',`--remote-debugging-port=${port}`],{stdio:'ignore',env})
let ws,id=1;const pending=new Map()
function connect(url){return new Promise((res,rej)=>{const sock=new WebSocket(url);sock.onopen=()=>{res(sock)};sock.onerror=rej})}
const sendOn=(sock,m,p={})=>{const i=id++;sock.send(JSON.stringify({id:i,method:m,params:p}));return new Promise((res,rej)=>pending.set(i,{res,rej}))}
try{
 await sleep(4500)
 let targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())
 const main=targets.find(t=>t.type==='page')
 ws=await connect(main.webSocketDebuggerUrl)
 ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result)}}}
 await sendOn(ws,'Runtime.enable');await sleep(1500)
 await sendOn(ws,'Runtime.evaluate',{expression:`document.querySelectorAll('.home-dock .dock-item')[3].click()`})
 await sleep(8000)
 targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())
 console.log('TARGETS',targets.map(t=>({type:t.type,url:t.url.slice(0,80)})))
 const web=targets.find(t=>t.url.includes('deepseek.com'))
 if(!web) throw new Error('web window target not found')
 const w=await connect(web.webSocketDebuggerUrl)
 w.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result)}}}
 await sendOn(w,'Runtime.enable');await sendOn(w,'Page.enable');await sendOn(w,'Page.bringToFront');await sleep(2500)
 const focusInfo=await sendOn(w,'Runtime.evaluate',{expression:`({ visibility: document.visibilityState, focus: document.hasFocus() })`,returnByValue:true})
 console.log('FOCUS',JSON.stringify(focusInfo.result?.value))
 const info=await sendOn(w,'Runtime.evaluate',{expression:`(() => {
   const box = (el) => {
     if (!el) return null
     const r = el.getBoundingClientRect()
     const s = getComputedStyle(el)
     return { tag: el.tagName, cls: String(el.className).slice(0, 80), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], opacity: s.opacity, visibility: s.visibility, display: s.display, color: s.color, filter: s.filter, transform: s.transform }
   }
   const at = document.elementFromPoint(window.innerWidth / 2, 280)
   return {
     title: document.title,
     bg: getComputedStyle(document.body).backgroundColor,
     skin: document.documentElement.dataset.deepseaSkin,
     styles: [...document.querySelectorAll('style')].map((s) => ({ id: s.id, len: s.textContent?.length ?? 0 })).slice(0, 12),
     root: box(document.querySelector('#root')),
     rootChild: box(document.querySelector('#root > div')),
     children: [...document.body.children].map(box).slice(0, 8),
     newChat: (() => {
       const nodes = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').includes('开启新对话'))
       return nodes.slice(0, 3).map((el) => {
         const chain = []
         let node = el
         for (let i = 0; i < 5 && node; i += 1) { chain.push(box(node)); node = node.parentElement }
         return chain
       })
     })(),
     hit: at ? box(at) : null,
     atNewChat: document.elementsFromPoint(106, 90).slice(0, 6).map(box),
     atCenter: document.elementsFromPoint(600, 300).slice(0, 6).map(box),
     rootStyle: (() => {
       const el = document.querySelector('#root')
       if (!el) return null
       const s = getComputedStyle(el)
       return { height: s.height, overflow: s.overflow, position: s.position, zIndex: s.zIndex, display: s.display }
     })(),
     childStyle: (() => {
       const el = document.querySelector('#root > div')
       if (!el) return null
       const s = getComputedStyle(el)
       return { height: s.height, minHeight: s.minHeight, maxHeight: s.maxHeight, display: s.display, position: s.position, flex: s.flex, padding: s.padding, boxSizing: s.boxSizing, alignSelf: s.alignSelf }
     })(),
     sideStyle: (() => {
       const el = [...document.querySelectorAll('*')].find((n) => n.getBoundingClientRect().height > 500 && n.getBoundingClientRect().width < 300)
       if (!el) return null
       const s = getComputedStyle(el)
       return { cls: String(el.className).slice(0, 60), height: s.height, minHeight: s.minHeight, display: s.display, flex: s.flex, alignSelf: s.alignSelf }
     })(),
     sheets: [...document.styleSheets].map((sheet) => {
       let sample = ''
       let count = 0
       try {
         count = sheet.cssRules.length
         sample = sheet.cssRules[0]?.cssText?.slice(0, 60) || ''
       } catch (error) { sample = 'blocked' }
       return { owner: sheet.ownerNode?.tagName || null, href: sheet.href, count, sample }
     }),
     text: document.body.innerText.slice(0, 120),
   }
 })()`,returnByValue:true})
 console.log('WEB',JSON.stringify(info.result?.value,null,1))
 const dom=await sendOn(w,'Runtime.evaluate',{expression:`(() => {
   const root = document.querySelector('#root > div')
   const seen = new Set()
   const walk = (el, depth) => {
     if (!el || depth > 3 || seen.has(el)) return null
     seen.add(el)
     const r = el.getBoundingClientRect()
     const s = getComputedStyle(el)
     return {
       tag: el.tagName.toLowerCase(),
       cls: String(el.className).slice(0, 70),
       role: el.getAttribute('role'),
       testid: el.getAttribute('data-testid'),
       rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
       bg: s.backgroundColor,
       radius: s.borderRadius,
       children: [...el.children].slice(0, 5).map((c) => walk(c, depth + 1)).filter(Boolean),
     }
   }
   const ta = document.querySelector('textarea')
   const chain = []
   let node = ta
   for (let i = 0; i < 8 && node; i += 1) {
     const r = node.getBoundingClientRect()
     const s = getComputedStyle(node)
     chain.push({ tag: node.tagName.toLowerCase(), cls: String(node.className).slice(0, 70), role: node.getAttribute('role'), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg: s.backgroundColor, border: s.border, radius: s.borderRadius, shadow: s.boxShadow.slice(0, 60) })
     node = node.parentElement
   }
   return { tree: walk(root, 0), textarea: chain }
 })()`,returnByValue:true})
 console.log('DOM',JSON.stringify(dom.result?.value,null,1))
 const img=await sendOn(w,'Page.captureScreenshot',{format:'png'});mkdirSync('shots',{recursive:true});writeFileSync('shots/30-webchat.png',Buffer.from(img.data,'base64'))
 const disabled=await sendOn(w,'Runtime.evaluate',{expression:`(() => {
   let hits = 0
   for (const sheet of document.styleSheets) {
     try {
       if ([...sheet.cssRules].some((rule) => (rule.cssText || '').includes('--ds-body-bg'))) {
         sheet.disabled = true
         hits += 1
       }
     } catch (error) { /* cross-origin */ }
   }
   return hits
 })()`,returnByValue:true})
 console.log('DISABLED SKIN SHEETS',disabled.result?.value)
 await sleep(600)
 const native=await sendOn(w,'Page.captureScreenshot',{format:'png'});writeFileSync('shots/31-web-native.png',Buffer.from(native.data,'base64'))
 const opened=await sendOn(w,'Runtime.evaluate',{expression:`(() => {
   const node = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '图灵谷')
   if (!node) return false
   node.click()
   return true
 })()`,returnByValue:true})
 console.log('OPENED CONVERSATION',opened.result?.value)
 await sleep(5000)
 const conv=await sendOn(w,'Page.captureScreenshot',{format:'png'});writeFileSync('shots/32-web-conversation.png',Buffer.from(conv.data,'base64'))
 await sendOn(w,'Runtime.evaluate',{expression:`document.querySelector('.deepsea-dock-btn[data-mode="dark"]')?.click()`,returnByValue:true})
 await sleep(900)
 const dark=await sendOn(w,'Page.captureScreenshot',{format:'png'});writeFileSync('shots/33-web-dark.png',Buffer.from(dark.data,'base64'))
 const darkProbe=await sendOn(w,'Runtime.evaluate',{expression:`(() => {
   const info = (el) => {
     if (!el) return null
     const r = el.getBoundingClientRect()
     const s = getComputedStyle(el)
     return { tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), role: el.getAttribute('role'), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg: s.backgroundColor, color: s.color, radius: s.borderRadius }
   }
   const chat = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '开启新对话')
   const chain = []
   let node = chat
   for (let i = 0; i < 6 && node; i += 1) { chain.push(info(node)); node = node.parentElement }
   const p = document.querySelector('.ds-markdown p')
   const span = chat ? chat.parentElement : null
   const user = document.querySelector('[data-deepsea-user]')
   const userTree = []
   if (user) {
     const walk = (el, depth) => {
       if (!el || depth > 4 || userTree.length > 30) return
       const r = el.getBoundingClientRect()
       const s = getComputedStyle(el)
       userTree.push({ depth, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg: s.backgroundColor, radius: s.borderRadius })
       for (const child of el.children) walk(child, depth + 1)
     }
     walk(user, 0)
   }
   const spanStyle = span ? getComputedStyle(span) : null
   const layers = []
   if (chat) {
     let node = chat
     for (let i = 0; i < 5 && node; i += 1) {
       const s = getComputedStyle(node)
       const b = getComputedStyle(node, '::before')
       const a = getComputedStyle(node, '::after')
       layers.push({ cls: String(node.className).slice(0, 40), opacity: s.opacity, filter: s.filter, blend: s.mixBlendMode, before: { content: b.content, bg: b.backgroundColor, opacity: b.opacity, z: b.zIndex }, after: { content: a.content, bg: a.backgroundColor, opacity: a.opacity, z: a.zIndex } })
       node = node.parentElement
     }
   }
   return { newChat: chain, newChatText: spanStyle ? { color: spanStyle.color, fill: spanStyle.webkitTextFillColor, opacity: spanStyle.opacity, filter: spanStyle.filter } : null, layers, paragraph: info(p), markdown: info(document.querySelector('.ds-markdown')), userTree, skin: document.documentElement.dataset.deepseaSkin }
 })()`,returnByValue:true})
 console.log('DARK PROBE',JSON.stringify(darkProbe.result?.value,null,1))
 const stack=await sendOn(w,'Runtime.evaluate',{expression:`(() => {
   const box = (el) => {
     const r = el.getBoundingClientRect()
     const s = getComputedStyle(el)
     return { tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), text: (el.textContent || '').trim().slice(0, 24), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg: s.backgroundColor, color: s.color, radius: s.borderRadius, current: el.getAttribute('aria-current'), selected: el.getAttribute('aria-selected') }
   }
   const at = document.elementsFromPoint(900, 630).slice(0, 12).map(box)
   const whiteAt = document.elementsFromPoint(200, 225).slice(0, 10).map(box)
   const chatLinks = [...document.querySelectorAll('[data-deepsea-chat]')].slice(0, 8).map((el) => ({ ...box(el), active: el.hasAttribute('data-deepsea-chat-active') }))
   const side = document.querySelector('[data-deepsea-sidebar]')
   const probe = document.querySelector('._0a3d93b')
   const probeInfo = probe ? { html: probe.outerHTML.slice(0, 1500), parent: probe.parentElement ? probe.parentElement.outerHTML.slice(0, 600) : null } : null
   let active = null
   if (side) {
     const leaf = [...side.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '图灵谷')
     if (leaf) {
       active = []
       let node = leaf
       for (let i = 0; i < 6 && node; i += 1) { active.push(box(node)); node = node.parentElement }
     }
   }
   return { at, whiteAt, chatLinks, active, probeInfo }
 })()`,returnByValue:true})
 console.log('STACK',JSON.stringify(stack.result?.value,null,1))
 await sendOn(w,'Runtime.evaluate',{expression:`document.querySelector('.deepsea-dock-btn[data-mode="light"]')?.click()`,returnByValue:true})
 await sleep(900)
 const light=await sendOn(w,'Page.captureScreenshot',{format:'png'});writeFileSync('shots/34-web-light.png',Buffer.from(light.data,'base64'))
 const messages=await sendOn(w,'Runtime.evaluate',{expression:`(() => {
   const box = (el) => {
     const r = el.getBoundingClientRect()
     const s = getComputedStyle(el)
     return { tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 70), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg: s.backgroundColor, radius: s.borderRadius }
   }
   const chain = (el, n) => { const out = []; let node = el; for (let i = 0; i < n && node; i += 1) { out.push(box(node)); node = node.parentElement } return out }
   const md = document.querySelector('.ds-markdown')
   const scrollers = [...document.querySelectorAll('[class*="scroll"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.height > 200 && r.width > 400 }).slice(0, 3)
   return { markdown: md ? chain(md, 7) : null, scrollers: scrollers.map((el) => chain(el, 3)), classes: [...new Set([...document.querySelectorAll('[class*="message"], [class*="bubble"], [class*="chat-item"]')].map((el) => String(el.className).slice(0, 60)))].slice(0, 20) }
 })()`,returnByValue:true})
 console.log('MESSAGES',JSON.stringify(messages.result?.value,null,1))
 const paint=await sendOn(w,'Runtime.evaluate',{expression:`(() => {
   const info = (el) => {
     if (!el) return null
     const r = el.getBoundingClientRect()
     const s = getComputedStyle(el)
     const before = getComputedStyle(el, '::before')
     const after = getComputedStyle(el, '::after')
     return {
       tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60),
       rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
       bg: s.backgroundColor, radius: s.borderRadius,
       before: before.content !== 'none' ? { bg: before.backgroundColor, inset: before.inset, radius: before.borderRadius } : null,
       after: after.content !== 'none' ? { bg: after.backgroundColor, inset: after.inset, radius: after.borderRadius } : null,
     }
   }
   const large = [...document.querySelectorAll('*')].map(info).filter((x) => {
     const m = x.bg.match(/rgba?\\(([^)]+)\\)/)
     if (!m) return false
     const parts = m[1].split(',').map(Number)
     const alpha = parts.length > 3 ? parts[3] : 1
     return alpha > 0.4 && x.rect[2] > 300 && x.rect[3] > 120
   }).slice(0, 25)
   const bubbles = [...document.querySelectorAll('*')].map(info).filter((x) => {
     const radius = parseFloat(x.radius) || 0
     return radius >= 12 && x.rect[2] > 180 && x.rect[3] > 40 && x.rect[3] < 700
   }).slice(-25)
   const ta = document.querySelector('textarea')
   const composer = []
   let node = ta
   for (let i = 0; i < 7 && node; i += 1) {
     composer.push({ ...info(node), display: getComputedStyle(node).display, overflow: getComputedStyle(node).overflow })
     node = node.parentElement
   }
   return { large, bubbles, composer }
 })()`,returnByValue:true})
 console.log('PAINT',JSON.stringify(paint.result?.value,null,1))
}catch(e){console.error('WEBMODE ERROR',e)}finally{try{ws?.close()}catch{};try{execSync(`taskkill /PID ${child.pid} /T /F`,{stdio:'ignore'})}catch{}}
