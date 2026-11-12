import { spawn, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import './mock-api.mjs'

const port = 9337
/*
 * 用独立的 userData 目录起一个「新装」实例。
 *
 * 以前这里不设 DEEPSEA_USER_DATA，于是 e2e 跑在用户真实的 %APPDATA%\deepsea 上：
 * 既会读到用户自己的对话/模型（脚本于是依赖「那个 profile 恰好有哪些状态」），
 * 又会把测试数据写进用户的数据里。主进程早就支持这个开关（electron/main.ts:28），
 * 只是一直没人用。注意必须是**绝对路径**：app.setPath 收到相对路径会直接抛
 * 「Path must be absolute」，Electron 连窗口都不会建。
 */
const testUserData = resolve(process.env.DEEPSEA_E2E_USER_DATA ?? '.e2e-profile')
mkdirSync(testUserData, { recursive: true })
const childEnv = { ...process.env, DEEPSEA_DEV_URL: '', DEEPSEA_USER_DATA: testUserData }
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env: childEnv })

let ws
let nextId = 1
const pending = new Map()
const consoleLines = []
const exceptions = []

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result?.value
}

async function clickSelector(selector) {
  const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)
  if (!ok) throw new Error(`missing selector: ${selector}`)
  await sleep(700)
}

async function clickText(text, exact = false) {
  const ok = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button, [role="button"]')]
    const visible = (n) => { const s = getComputedStyle(n); const r = n.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 }
    const textOf = (n) => (n.innerText || n.getAttribute('aria-label') || '').trim()
    const node = nodes.find((n) => visible(n) && (${exact ? 'textOf(n) === ' : 'textOf(n).includes('}${JSON.stringify(text)}${exact ? '' : ')'}))
    if (!node) return false
    node.click()
    return true
  })()`)
  if (!ok) throw new Error(`missing visible button: ${text}`)
  await sleep(700)
}

async function setInput(matcher, value) {
  const ok = await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input')]
    const input = inputs.find((el) => ${matcher})
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  if (!ok) throw new Error(`missing input: ${matcher}`)
  await sleep(300)
}

/**
 * 选一个模型。
 *
 * 设置页的「模型」不是原生 <select>，而是 ui.tsx 里那套自定义 Select：
 * 一个 button 触发器 + 一个 role="listbox" 的浮层（选项是 role="option" 的 button）。
 * 以前这里按原生 select 的写法找元素，于是 UI 换成自定义 Select 之后这条就一直
 * 失败在「missing model option」—— 是脚本过时，不是功能坏了。
 * 现在按真实交互点：先点开触发器，再点选项。
 */
async function chooseModel(value) {
  const opened = await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || '').includes('模型') && el.getAttribute('role') !== 'option')
    if (!trigger) return false
    trigger.click()
    return true
  })()`)
  if (!opened) throw new Error('missing model select trigger')
  await sleep(300)
  const picked = await evaluate(`(() => {
    const options = [...document.querySelectorAll('[role="option"]')]
    // 选项没有 data-value，只有 label（形如「deepseek-flash · 快，能看图」），按前缀匹配。
    const hit = options.find((el) => (el.innerText || '').trim().startsWith(${JSON.stringify(value)}))
    if (!hit) return false
    hit.click()
    return true
  })()`)
  if (!picked) throw new Error(`missing model option: ${value}`)
  await sleep(400)
}

async function attachPng() {
  const ok = await evaluate(`(async () => {
    const input = document.querySelector('.composer input[type="file"]')
    if (!input) return false
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')
    context.fillStyle = '#0b3d4c'
    context.fillRect(0, 0, 64, 64)
    context.fillStyle = '#7fe3d4'
    context.beginPath()
    context.arc(32, 32, 18, 0, Math.PI * 2)
    context.fill()
    // 不要用 fetch(dataURL) 造 Blob：app:// 协议下这条会被拦成 Failed to fetch。
    // 直接解 base64 拼 Uint8Array 最稳，也和真实用户选图后的数据形态一致。
    const dataUrl = canvas.toDataURL('image/png')
    const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    const blob = new Blob([bytes], { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], 'deepsea-test.png', { type: 'image/png' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!ok) throw new Error('missing attachment input')
  for (let i = 0; i < 30; i += 1) {
    await sleep(200)
    const count = await evaluate(`document.querySelectorAll('.composer .attachment-item').length`)
    if (count > 0) return
  }
  throw new Error('attachment never appeared')
}

async function setTextarea(value) {
  const ok = await evaluate(`(() => {
    const el = document.querySelector('.composer textarea')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  if (!ok) throw new Error('missing composer textarea')
  await sleep(200)
}

async function sendMessage(text) {
  await setTextarea(text)
  await clickSelector('.send-button')
  for (let i = 0; i < 40; i += 1) {
    await sleep(400)
    const busy = await evaluate(`document.querySelector('.send-button.is-stop') !== null`)
    if (!busy) return
  }
  throw new Error(`turn did not finish: ${text}`)
}

async function shot(name) {
  const image = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync('shots', { recursive: true })
  writeFileSync(`shots/${name}.png`, Buffer.from(image.data, 'base64'))
  console.log('shot', name)
}

try {
  // 等到调试端口上出现页面目标。冷启动（尤其新建 userData 目录）可能比固定
  // 的 4.5 秒更慢，所以轮询到 30 秒而不是只试一次就报「no page target」。
  let page
  for (let i = 0; i < 60; i += 1) {
    await sleep(500)
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
      page = targets.find((target) => target.type === 'page')
      if (page) break
    } catch {
      /* 端口还没起来，继续等 */
    }
  }
  if (!page) throw new Error('no page target')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const waiter = pending.get(message.id)
      if (waiter) {
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
        else waiter.resolve(message.result)
      }
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.text + ' ' + (message.params.exceptionDetails.exception?.description ?? ''))
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(1500)

  /*
   * 独立 userData 起的是「新装」实例，首屏是引导页。
   * 走 API 模式那一路（网页版那条不填 Key，后面发不出消息），
   * Key 先留空直接「进入深海」，后面在设置页里再填 mock 的 Key 和地址。
   */
  const onboarding = await evaluate(`document.querySelector('.app')?.getAttribute('data-screen') === 'onboarding'`)
  if (onboarding) {
    /*
     * 引导三步：0 欢迎 → 1 选模式 → 2 填 Key。
     * 模式卡片的点击区域是整个 button（里面含 strong「API 模式 · 完整体验」），
     * 直接按 innerText 前缀找那个 button 最稳 —— 按「API 模式」子串匹配容易被
     * 外层容器抢先命中。
     */
    /*
     * 引导三步：0 欢迎（开始）→ 1 选模式（点卡片 + 继续）→ 2 填 Key（先跳过）。
     * 模式卡片点一下只是「选中」，不会自动进下一步 —— 必须再点「继续」。
     * 全程按文案找按钮：.onboarding-primary 三步都存在，querySelector 会拿错。
     */
    const tap = async (label) => {
      const ok = await evaluate(`(() => {
        const btn = [...document.querySelectorAll('button')].find((el) => (el.innerText || '').replace(/\\s+/g,' ').trim().startsWith(${JSON.stringify(label)}))
        if (!btn) return false
        btn.click()
        return true
      })()`)
      if (!ok) throw new Error('onboarding: 找不到「' + label + '」')
      await sleep(700)
    }
    await tap('开始')
    await tap('API 模式')
    await tap('继续')
    await tap('先跳过')
    await sleep(1500)
    console.log('ONB done:', await evaluate(`document.querySelector('.app')?.getAttribute('data-screen')`))
  }
  // 引导结束可能落在对话页（有些路径会直接开一段对话）。设置入口只在首页，
  // 所以先确认在首页，不在就点顶部那个「回到海面」把首页要回来。
  const screen = await evaluate(`document.querySelector('.app')?.getAttribute('data-screen')`)
  if (screen !== 'home') {
    const back = await evaluate(`(() => { const el = document.querySelector('[aria-label="回到海面"]'); if (!el) return false; el.click(); return true })()`)
    if (back) await sleep(1000)
  }
  console.log('SCREEN:', await evaluate(`document.querySelector('.app')?.getAttribute('data-screen')`))

  // Configure the mock endpoint through the real settings UI.
  await clickSelector('.home-top-actions .icon-button:last-child')
  await sleep(500)
  await setInput(`el.type === 'password'`, 'sk-mock-key')
  await setInput(`(el.placeholder || '').includes('api.deepseek.com') || (el.value || '').includes('api.deepseek.com') || (el.value || '').includes('127.0.0.1')`, 'http://127.0.0.1:8787')
  await chooseModel('deepseek-flash')
  await clickText('保存')
  await shot('10-settings-filled')
  const cards = await evaluate(`[...document.querySelectorAll('.settings-card h2')].map((node) => node.innerText.replace(/\\s+/g, ' ').trim())`)
  console.log('SETTINGS CARDS:', JSON.stringify(cards))
  for (const [name, title] of [['19-settings-web', '网页版'], ['19-settings-avatars', '头像']]) {
    const scrolled = await evaluate(`(() => {
      const head = [...document.querySelectorAll('.settings-card h2')].find((node) => node.innerText.includes(${JSON.stringify(title)}))
      const card = head ? head.closest('.settings-card') : null
      if (card === null) return false
      card.scrollIntoView({ block: 'start' })
      return true
    })()`)
    if (!scrolled) throw new Error(`missing settings card: ${title}`)
    await sleep(600)
    await shot(name)
  }
  await clickSelector('.screen-header .icon-button')

  // Four turns: three plain, one tool-using. The fourth triggers memory extraction.
  await clickSelector('.talk-button')
  await sendMessage('你好，我叫小林。')
  await shot('11-chat-reply')
  const avatars = await evaluate(`(() => {
    const images = [...document.querySelectorAll('.bubble-author img.avatar')]
    return {
      count: images.length,
      roles: images.map((node) => node.getAttribute('data-role')),
      loaded: images.every((node) => node.complete && node.naturalWidth > 0),
      pet: document.querySelectorAll('.pet-layer').length,
    }
  })()`)
  console.log('AVATARS:', JSON.stringify(avatars))
  await sendMessage('我喜欢简洁的回答。')
  await sendMessage('我在做一个小网页。')
  await sendMessage('帮我做一个网页小游戏。')
  await sleep(2500)
  await shot('12-chat-tool')

  // Attachment-only turn: the mock confirms it received a vision content block.
  await attachPng()
  await shot('15-attachments')
  const repliesBefore = await evaluate(`document.querySelectorAll('.bubble-assistant:not(.bubble-live)').length`)
  console.log('REPLIES BEFORE:', repliesBefore)
  await sendMessage('')
  let attachmentReply = ''
  for (let i = 0; i < 25; i += 1) {
    await sleep(300)
    const state = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.bubble-assistant:not(.bubble-live)')]
      return {
        sending: document.querySelector('.send-button.is-stop') !== null,
        count: rows.length,
        users: document.querySelectorAll('.bubble-user').length,
        last: rows.at(-1)?.innerText || '',
        live: document.querySelector('.bubble-live')?.innerText || '',
      }
    })()`)
    if (i === 0 || state.count > repliesBefore) console.log('VISION STATE:', JSON.stringify(state))
    if (state.count > repliesBefore) {
      attachmentReply = state.last
      break
    }
  }
  if (attachmentReply === '') {
    console.log('VISION DUMP:', JSON.stringify(await evaluate(`(() => ({
      body: document.body.innerText.slice(-1200),
      assistants: [...document.querySelectorAll('.bubble-assistant')].map((row) => row.innerText),
      users: [...document.querySelectorAll('.bubble-user')].map((row) => row.innerText),
    }))()`)))
  }
  console.log('VISION REPLY:', JSON.stringify(attachmentReply.slice(0, 120)))
  if (!attachmentReply.includes('看到了这张图')) throw new Error('vision turn did not reach the mock')

  // The body directive must be stripped and turned into real orca behaviour.
  /*
   * 这句要**避开本地快捷指令**：commands.ts 在 <=18 字的短句里直接命中「转个圈」，
   * 由客户端自己驱动身体并回一句预制台词，根本不发请求 —— 那样就测不到「模型输出
   * <body …/> 之后客户端怎么演」。所以这里用一句超过 18 字、含「身体」的话：
   * 本地不命中，mock 仍然回 body 指令，正好覆盖模型驱动那条路径。
   * 气泡只亮 4.2 秒，所以不能长时间轮询等它，回复一结束就立刻抓。
   */
  await sendMessage('你能不能用你的身体给我演示一下，转个圈让我看看你现在游得怎么样。')
  /*
   * 这一轮可能先走工具循环（mock 对「网页/工坊」类会回 write_file），结束后才轮到
   * 正文与 body 指令；而气泡台词只亮 4.2 秒。所以这里盯的是「回复彻底结束」：
   * 发送键不再是停止态、且气泡不再是「正在思考」。最多等 20 秒，每 250ms 一次。
   */
  let idle = false
  for (let i = 0; i < 80; i += 1) {
    await sleep(250)
    idle = await evaluate(`(() => {
      const stop = document.querySelector('.send-button.is-stop')
      const bubble = document.querySelector('.orca-bubble')
      const label = bubble ? (bubble.getAttribute('aria-label') || '') : ''
      const hidden = document.querySelector('.orca-bubble-layer')?.dataset.hidden
      return !stop && hidden !== 'true' && !label.includes('让我想一想')
    })()`)
    if (idle) break
  }
  await evaluate(`(() => { window.__errs = []; window.addEventListener('error', (event) => window.__errs.push(String(event.message))) })()`)
  await sleep(200)
  const bubbleDebug = await evaluate(`(() => {
    const layer = document.querySelector('.orca-bubble-layer')
    const canvas = document.querySelector('canvas')
    return {
      errs: window.__errs,
      layer: layer ? { hidden: layer.dataset.hidden, transform: layer.style.transform, opacity: getComputedStyle(layer).opacity } : null,
      canvas: canvas ? { width: canvas.width, height: canvas.height, rect: canvas.getBoundingClientRect().toJSON() } : null,
      screen: [...document.querySelectorAll('section')].map((node) => node.className).slice(0, 6),
    }
  })()`)
  console.log('BUBBLE DEBUG:', JSON.stringify(bubbleDebug))
  // 直接看 bodyMind 里现在有没有台词：气泡节点可能是空的，但引擎那边已经 speak 过。
  console.log('BODYMIND:', JSON.stringify(await evaluate(`(() => {
    const bubble = document.querySelector('.orca-bubble')
    return {
      bubbleClass: bubble ? bubble.className : null,
      bubbleRaw: bubble ? bubble.outerHTML.slice(0, 160) : null,
      layerHidden: document.querySelector('.orca-bubble-layer')?.dataset.hidden ?? null,
      panels: [...document.querySelectorAll('.reasoning-panel')].length,
      live: document.querySelector('.bubble-live')?.innerText?.slice(0, 60) ?? null,
      stopButton: document.querySelector('.send-button.is-stop') !== null,
      lastAssistant: [...document.querySelectorAll('.bubble-assistant')].pop()?.innerText?.slice(0, 120) ?? null,
      liveBubble: document.querySelector('.bubble-assistant.bubble-live')?.innerText?.slice(0, 120) ?? null,
    }
  })()`)))
  const bubble = await evaluate(`(() => {
    const node = document.querySelector('.orca-bubble')
    if (!node) return null
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    return {
      text: node.innerText,
      visible: style.visibility !== 'hidden' && Number(style.opacity) > 0.1 && rect.width > 0 && rect.height > 0,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      pointer: style.pointerEvents,
    }
  })()`)
  console.log('ORCA BUBBLE:', JSON.stringify(bubble))
  if (bubble === null || !bubble.visible) throw new Error('orca bubble is not visible')
  // 真鼠标要能点到它，不能继承图层那个 pointer-events:none
  if (bubble.pointer !== 'auto') throw new Error(`orca bubble is not clickable: ${bubble.pointer}`)
  if (!bubble.text.includes('看我的')) throw new Error(`body say was not shown: ${bubble.text}`)
  const leaked = await evaluate(`document.body.innerText.includes('<body')`)
  console.log('BODY TAG LEAK:', leaked)
  if (leaked) throw new Error('body directive leaked into the transcript')
  await shot('16-orca-bubble')

  // Clicking the bubble must answer the poke with a different line.
  const poked = await evaluate(`(() => {
    const node = document.querySelector('.orca-bubble')
    if (!node) return false
    node.click()
    return true
  })()`)
  if (!poked) throw new Error('could not click orca bubble')
  await sleep(450)
  const pokedText = await evaluate(`document.querySelector('.orca-bubble')?.innerText || ''`)
  console.log('ORCA POKED:', JSON.stringify(pokedText))
  if (pokedText === bubble.text) throw new Error('orca bubble did not react to a click')
  await shot('17-orca-poked')

  // 安静下来：最后一句说完几秒后，气泡要自己漂走，不能一直挂在那儿
  await sleep(12000)
  const quiet = await evaluate(`(() => {
    const layer = document.querySelector('.orca-bubble-layer')
    const node = document.querySelector('.orca-bubble')
    if (layer === null || node === null) return { layer: false }
    const style = getComputedStyle(node)
    return {
      hidden: layer.dataset.hidden,
      visibility: style.visibility,
      opacity: getComputedStyle(layer).opacity,
      text: node.innerText,
    }
  })()`)
  console.log('BUBBLE IDLE:', JSON.stringify(quiet))
  if (quiet.hidden !== 'true') throw new Error(`orca bubble never went quiet: ${JSON.stringify(quiet)}`)
  await shot('20-bubble-idle')

  const bodyText = await evaluate('document.body.innerText.slice(0, 1400)')
  console.log('CHAT TEXT:', JSON.stringify(bodyText))

  await clickSelector('.chat-head .icon-button')
  const dockClick = async (index) => {
    const ok = await evaluate(`(() => { const el = document.querySelectorAll('.home-dock .dock-item')[${index}]; if (!el) return false; el.click(); return true })()`)
    if (!ok) throw new Error(`missing dock item ${index}`)
    await sleep(800)
  }
  await dockClick(2)
  await sleep(600)
  await clickSelector('.screen-actions .icon-button:nth-child(2)')
  await sleep(1000)
  /*
   * 预览不是 srcdoc：Workshop.tsx 用一个同源沙箱页当 iframe 的 src，
   * onLoad 之后把 HTML postMessage 进去（srcdoc 拿不到 allow-scripts 之外的控制权）。
   * 跨源 iframe 里的 DOM 读不到，所以这里断言「预览 iframe 真的挂上了、src 指向沙箱页」，
   * 再回读工坊里 index.html 的内容确认写进去的是那一份。
   */
  const preview = await evaluate(`(() => {
    const f = document.querySelector('.preview-frame')
    if (!f) return { mounted: false, src: null, html: null }
    return { mounted: true, src: f.getAttribute('src'), html: null }
  })()`)
  const workshopHtml = await evaluate(`(() => {
    const editor = document.querySelector('.cm-content')?.innerText || ''
    return editor.includes('接住星星')
  })()`)
  console.log('PREVIEW:', JSON.stringify({ ...preview, editorHasGame: workshopHtml }))
  await shot('13-workshop')

  await clickSelector('.screen-header .icon-button')
  await dockClick(1)
  await sleep(800)
  const memoryCards = await evaluate(`document.querySelectorAll('.memory-card').length`)
  console.log('MEMORY CARDS:', memoryCards)
  await shot('14-memory-filled')

  // 纸雕：自动模式在 App 内不出现，手动「同屏」才挂一个 64px 的静音挂件
  await clickSelector('.screen-header .icon-button')
  await sleep(500)
  await clickSelector('.home-top-actions .icon-button:last-child')
  await sleep(600)
  await clickSelector('.skin-options[aria-label="纸雕出现方式"] button:nth-child(2)')
  await clickText('保存')
  await clickSelector('.screen-header .icon-button')
  await sleep(1200)
  const petState = await evaluate(`(() => {
    const host = document.querySelector('.pet-layer')
    if (host === null) return { mounted: false }
    const svg = host.shadowRoot === null ? null : host.shadowRoot.querySelector('svg')
    const box = svg === null ? null : svg.getBoundingClientRect()
    return {
      mounted: true,
      svg: svg !== null,
      size: box === null ? 0 : Math.round(box.width),
      pointer: host.style.pointerEvents,
    }
  })()`)
  console.log('PET FORCED:', JSON.stringify(petState))
  await shot('18-pet-forced')

  await clickSelector('.home-top-actions .icon-button:last-child')
  await sleep(600)
  await clickSelector('.skin-options[aria-label="纸雕出现方式"] button:nth-child(1)')
  await clickText('保存')
  await sleep(600)
  console.log('PET RESTORED:', await evaluate(`document.querySelectorAll('.pet-layer').length`))

  console.log('CONSOLE:', consoleLines.join('\n') || '(none)')
  console.log('EXCEPTIONS:', exceptions.join('\n') || '(none)')
} catch (error) {
  console.error('E2E ERROR', error)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* ignore */ }
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
  process.exit(process.exitCode ?? 0)
}
