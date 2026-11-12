import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * 手机端排版 + 主题配色的运行时探针（真实 Electron，360×792@3x ≈ 1080 宽的安卓机）。
 *
 * 验四件在真机截图上暴露过的事：
 *   1. 气泡动作条只有图标（用户 2 个 / 助手 3 个），不会再被压成「多/选」一字一行；
 *   2. 头部标题不再被挤成「早…」，副标题单行省略；
 *   3. 轮次导航四键整颗都在面板内，不再被 overflow 裁掉；
 *   4. 三套主题（深海 / 雾霭 / 暖阳）真的换了用户气泡与强调色。
 *
 * 跑法：node scripts/probe-mobile-chrome.mjs
 */

const CDP_PORT = 9367
const CONV_ID = 'conv_mobile_probe'
const now = Date.now()

const CONVERSATION = { id: CONV_ID, title: '手机排版探针', createdAt: now - 9000, updatedAt: now, model: '' }
const MESSAGES = [
  { id: 'mb_m1', conversationId: CONV_ID, role: 'user', content: '这是一条用来量排版的消息，稍微长一点点。', createdAt: now - 8000 },
  { id: 'mb_m2', conversationId: CONV_ID, role: 'assistant', content: '第一段回答，用来确认气泡宽度和动作条图标。', reasoning: '先想一想。', createdAt: now - 7000, status: 'done' },
  { id: 'mb_m3', conversationId: CONV_ID, role: 'user', content: '再问一句。', createdAt: now - 6000 },
  { id: 'mb_m4', conversationId: CONV_ID, role: 'assistant', content: '第二段回答。', createdAt: now - 5000, status: 'done' },
  { id: 'mb_m5', conversationId: CONV_ID, role: 'user', content: '第三问。', createdAt: now - 4000 },
  { id: 'mb_m6', conversationId: CONV_ID, role: 'assistant', content: '第三段回答。', createdAt: now - 3000, status: 'done' },
]

const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore', env })

let ws
let nextId = 1
const pending = new Map()
const consoleErrors = []
const results = []

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}

async function shot(name) {
  const image = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`shots/${name}.png`, Buffer.from(image.data, 'base64'))
  console.log('shot', name)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url)
    s.onopen = () => resolve(s)
    s.onerror = reject
  })
}

function wire(s) {
  s.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'exception')
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
  }
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` :: ${detail}`}`)
}

async function waitForApp() {
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate(`Boolean(document.querySelector('.app'))`)
    if (ready) return true
    await sleep(250)
  }
  return false
}

const IDB_HELPER = `
window.__probeDb = (op, store, value) => new Promise((resolve, reject) => {
  const req = indexedDB.open('deepsea')
  req.onerror = () => reject(new Error('open failed'))
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction(store, op === 'getAll' || op === 'get' ? 'readonly' : 'readwrite')
    const os = tx.objectStore(store)
    if (op === 'getAll') {
      const g = os.getAll()
      g.onsuccess = () => { db.close(); resolve(g.result) }
      g.onerror = () => { db.close(); reject(new Error('getAll failed')) }
      return
    }
    if (op === 'get') {
      const g = os.get(value)
      g.onsuccess = () => { db.close(); resolve(g.result ?? null) }
      g.onerror = () => { db.close(); reject(new Error('get failed')) }
      return
    }
    if (op === 'delete') {
      const d = os.delete(value)
      d.onsuccess = () => { db.close(); resolve(true) }
      d.onerror = () => { db.close(); reject(new Error('delete failed')) }
      return
    }
    const p = os.put(value)
    p.onsuccess = () => { db.close(); resolve(true) }
    p.onerror = () => { db.close(); reject(new Error('put failed')) }
  }
})
true
`

async function openConversation() {
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || '') === '历史对话')
    if (btn) btn.click()
    return Boolean(btn)
  })()`)
  await sleep(700)
  const opened = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.drawer-row')].find((el) => (el.innerText || '').includes('手机排版探针'))
    if (!row) return '<no-row>'
    row.click()
    return 'ok'
  })()`)
  await sleep(900)
  return opened
}

async function setTheme(theme) {
  const raw = await evaluate(`window.__probeDb('get', 'settings', 'app')`)
  const value = { ...(raw?.value ?? {}), theme }
  await evaluate(`window.__probeDb('put', 'settings', ${JSON.stringify({ key: 'app', value })})`)
  await send('Page.reload')
  await sleep(2400)
  const ready = await waitForApp()
  // 页面重载后 IDB 助手会丢，后面还要用它还原现场。
  if (ready) await evaluate(IDB_HELPER)
  return ready
}

try {
  await sleep(5000)
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
  ws = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  wire(ws)
  await send('Runtime.enable')
  await send('Page.enable')
  // 1080×2376 的安卓机 ≈ 360×792 CSS px @3x
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 792, deviceScaleFactor: 3, mobile: true })
  await sleep(800)
  check('应用能正常启动', await waitForApp())
  await evaluate(IDB_HELPER)

  const originalSettings = await evaluate(`window.__probeDb('get', 'settings', 'app')`)
  writeFileSync('_tmp/probe-mobile-settings-backup.json', JSON.stringify(originalSettings ?? null), 'utf8')

  await evaluate(`window.__probeDb('put', 'conversations', ${JSON.stringify(CONVERSATION)})`)
  for (const message of MESSAGES) {
    await evaluate(`window.__probeDb('put', 'messages', ${JSON.stringify(message)})`)
  }
  await send('Page.reload')
  await sleep(2600)
  check('埋完对话还能正常启动', await waitForApp())
  await evaluate(IDB_HELPER)

  // 用户自己那台机器存的是「暖阳」，探针先把主题钉成深海再量颜色。
  check('能切到深海主题', await setTheme('deep'))
  const opened = await openConversation()
  check('能打开探针对话', opened === 'ok', String(opened))

  // ---------- 1) 动作条：只有图标 ----------
  const acts = await evaluate(`[...document.querySelectorAll('.chat-scroll .bubble')].map((el) => el.querySelectorAll('.bubble-act').length)`)
  check('用户气泡 2 个图标、助手气泡 3 个图标', JSON.stringify(acts) === JSON.stringify([2, 3, 2, 3, 2, 3]), JSON.stringify(acts))
  const actBox = await evaluate(`(() => {
    const btn = document.querySelector('.bubble-act')
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  check('图标按钮尺寸正常（≥26×26）', actBox !== null && actBox.w >= 26 && actBox.h >= 26, JSON.stringify(actBox))
  // 助手气泡是整宽，量「行」没意义；量三个按钮加起来的实际宽度。
  const actsWidth = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.chat-scroll .bubble')][1].querySelectorAll('.bubble-act')
    return Math.round([...buttons].reduce((sum, el) => sum + el.getBoundingClientRect().width, 0))
  })()`)
  check('三个图标一行放得下（总宽 < 120px，不会折行）', actsWidth > 0 && actsWidth < 120, String(actsWidth))

  // ---------- 2) 头部 ----------
  const head = await evaluate(`(() => {
    const strong = document.querySelector('.chat-title strong')
    const sub = document.querySelector('.chat-title span')
    const head = document.querySelector('.chat-head')
    if (!strong || !sub || !head) return null
    const r = strong.getBoundingClientRect()
    const s = sub.getBoundingClientRect()
    return { titleW: Math.round(r.width), subH: Math.round(s.height), headH: Math.round(head.getBoundingClientRect().height), text: (strong.innerText || '').trim() }
  })()`)
  check('标题有可用宽度（≥90px）', head !== null && head.titleW >= 90, JSON.stringify(head))
  check('副标题只占一行（高度 ≤ 20px）', head !== null && head.subH <= 20, JSON.stringify(head))

  // ---------- 3) 轮次导航四键不被裁 ----------
  const nav = await evaluate(`(() => {
    const keys = document.querySelector('.turn-nav-compact')
    const sheet = document.querySelector('.chat-sheet')
    if (!keys || !sheet) return null
    const k = keys.getBoundingClientRect()
    const s = sheet.getBoundingClientRect()
    return { keyRight: Math.round(k.right), sheetRight: Math.round(s.right), keyCount: keys.querySelectorAll('.turn-nav-key').length }
  })()`)
  check('四键整颗都在面板内（右边缘不超出）', nav !== null && nav.keyRight <= nav.sheetRight, JSON.stringify(nav))
  // ---------- 5) 「⋯」菜单的层级：必须挂在 .app 上，不能被对话面板裁住 ----------
  await evaluate(`(() => {
    const bubbles = document.querySelectorAll('.chat-scroll .bubble')
    const more = bubbles[1] ? bubbles[1].querySelector('.bubble-act[aria-label="更多"]') : null
    if (more) more.click()
    return Boolean(more)
  })()`)
  await sleep(600)
  const portal = await evaluate(`(() => {
    const backdrop = document.querySelector('.modal-backdrop')
    if (!backdrop) return null
    const r = backdrop.getBoundingClientRect()
    return {
      parentClass: backdrop.parentElement ? String(backdrop.parentElement.className) : '',
      insideSheet: Boolean(backdrop.closest('.chat-sheet')),
      w: Math.round(r.width),
      h: Math.round(r.height),
      vw: window.innerWidth,
      vh: window.innerHeight,
      z: getComputedStyle(backdrop).zIndex,
    }
  })()`)
  check('弹层挂在 .app 上（不在对话面板里）', portal !== null && portal.insideSheet === false && portal.parentClass.includes('app'), JSON.stringify(portal))
  check('弹层铺满视口（没有被面板裁住）', portal !== null && Math.abs(portal.w - portal.vw) <= 2 && Math.abs(portal.h - portal.vh) <= 2, JSON.stringify(portal))
  const topmost = await evaluate(`(() => {
    const el = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2))
    if (!el) return null
    return { insideModal: Boolean(el.closest('.modal-backdrop')), tag: String(el.tagName), cls: String(el.className || '') }
  })()`)
  check('弹层盖在对话内容之上（中心点命中的是弹层里的元素）', topmost !== null && topmost.insideModal === true, JSON.stringify(topmost))
  await shot('123-mobile-message-menu')
  await evaluate(`(() => {
    const close = [...document.querySelectorAll('.modal-head button')].find((el) => (el.getAttribute('aria-label') || '') === '关闭')
    if (close) close.click()
    return Boolean(close)
  })()`)
  await sleep(400)
  check('关闭后弹层消失', (await evaluate(`Boolean(document.querySelector('.modal-backdrop'))`)) === false)

  // ---------- 6) 抓手向上拖 = 拉到全屏 ----------
  const beforeH = await evaluate(`Math.round(document.querySelector('.chat-sheet').getBoundingClientRect().height)`)
  await evaluate(`(() => {
    const grip = document.querySelector('.sheet-grip')
    if (!grip) return false
    const r = grip.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y - 80, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y - 80, pointerId: 1 }))
    return true
  })()`)
  await sleep(700)
  const afterH = await evaluate(`Math.round(document.querySelector('.chat-sheet').getBoundingClientRect().height)`)
  check('向上拖抓手面板变高（一档）', afterH > beforeH, `${beforeH} -> ${afterH}`)

  // 真机 bug：拖到全屏后顶部被顶出屏幕，抓手跟着消失，就再也拖不回来。
  const fullState = await evaluate(`(() => {
    const sheet = document.querySelector('.chat-sheet')
    const grip = document.querySelector('.sheet-grip')
    const s = sheet.getBoundingClientRect()
    const g = grip.getBoundingClientRect()
    return { top: Math.round(s.top), gripTop: Math.round(g.top), vh: window.innerHeight, cls: String(sheet.className) }
  })()`)
  check('全屏时面板顶部没被顶出屏幕', fullState !== null && fullState.top >= 0, JSON.stringify(fullState))
  check('全屏时抓手还在屏幕里（拖得回来）', fullState !== null && fullState.gripTop >= 0 && fullState.gripTop < fullState.vh, JSON.stringify(fullState))

  // 往下拖：应该收回一档。
  const dragBy = async (dy) => evaluate(`(() => {
    const grip = document.querySelector('.sheet-grip')
    if (!grip) return false
    const r = grip.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y + ${dy}, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y + ${dy}, pointerId: 1 }))
    return true
  })()`)
  await dragBy(90)
  await sleep(700)
  const shrunkH = await evaluate(`Math.round(document.querySelector('.chat-sheet').getBoundingClientRect().height)`)
  check('向下拖能收回去', shrunkH < afterH, `${afterH} -> ${shrunkH}`)

  // pointercancel 不能当成 pointerup：以前它会把每次「往下拉」都算成「往上拖到底」。
  const beforeCancel = await evaluate(`Math.round(document.querySelector('.chat-sheet').getBoundingClientRect().height)`)
  await evaluate(`(() => {
    const grip = document.querySelector('.sheet-grip')
    const r = grip.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, clientX: x, clientY: 0, pointerId: 1 }))
    return true
  })()`)
  await sleep(600)
  const afterCancel = await evaluate(`Math.round(document.querySelector('.chat-sheet').getBoundingClientRect().height)`)
  check('pointercancel 不会误改面板高度', afterCancel === beforeCancel, `${beforeCancel} -> ${afterCancel}`)

  await shot('120-mobile-deep')

  // ---------- 4) 三套主题的用户气泡 ----------
  const deepBg = await evaluate(`(() => { const el = document.querySelector('.bubble-user'); return el ? getComputedStyle(el).backgroundImage : '' })()`)
  check('深海主题：用户气泡是珊瑚色渐变', deepBg.includes('rgb(255, 177, 149)'), deepBg.slice(0, 80))

  check('能切到雾霭主题', await setTheme('iceberg'))
  await evaluate(IDB_HELPER)
  const iceOpened = await openConversation()
  const iceBg = await evaluate(`(() => { const el = document.querySelector('.bubble-user'); return el ? getComputedStyle(el).backgroundImage : '' })()`)
  check('雾霭主题：用户气泡换成冷蓝灰渐变', iceBg.includes('rgb(169, 214, 229)'), `${iceOpened} ${iceBg.slice(0, 80)}`)
  const iceAccent = await evaluate(`(() => getComputedStyle(document.querySelector('.app')).getPropertyValue('--aqua').trim())()`)
  check('雾霭主题：强调色跟着换', iceAccent === '#9fd8ea', iceAccent)
  await shot('121-mobile-iceberg')

  check('能切到暖阳主题', await setTheme('tropical'))
  await evaluate(IDB_HELPER)
  await openConversation()
  const tropBg = await evaluate(`(() => { const el = document.querySelector('.bubble-user'); return el ? getComputedStyle(el).backgroundImage : '' })()`)
  check('暖阳主题：用户气泡换成蜜桃渐变', tropBg.includes('rgb(255, 207, 159)'), tropBg.slice(0, 80))
  await shot('122-mobile-tropical')

  // ---------- 还原 ----------
  await setTheme(originalSettings?.value?.theme ?? 'deep')
  for (const message of MESSAGES) {
    await evaluate(`window.__probeDb('delete', 'messages', ${JSON.stringify(message.id)})`)
  }
  await evaluate(`window.__probeDb('delete', 'conversations', ${JSON.stringify(CONV_ID)})`)
  await send('Page.reload')
  await sleep(1600)

  console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
  const failed = results.filter((r) => !r.ok)
  console.log(`SUMMARY pass=${results.length - failed.length} fail=${failed.length}`)
  if (failed.length > 0) process.exitCode = 1
} catch (e) {
  console.error('PROBE ERROR', e)
  process.exitCode = 1
} finally {
  try { child.kill() } catch {}
}