import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * 「分享 / 导出」的运行时探针（真实 Electron + 真实 IndexedDB）。
 *
 * 验四件用户能直接看见的事：
 *   1. 气泡动作条能进入消息级多选，底部三键是 取消 / 全选 / 确定；
 *   2. 确定后打开「导出格式」弹层，默认勾选就是刚才选中的那些；
 *   3. 「导出思维过程」默认开，预览里是 <details>，关掉后消失；
 *   4. 点 Markdown 卡片真的写出一份 .md（走 Electron 原生落盘，用测试钩子免对话框）。
 *
 * 跑法：node scripts/probe-export-select.mjs
 */

const CDP_PORT = 9366
const CONV_ID = 'conv_export_probe'
const OUT_PATH = '_tmp/probe-export.md'

const env = {
  ...process.env,
  DEEPSEA_DEV_URL: '',
  DEEPSEA_TEST_SAVE_PATH: OUT_PATH,
}
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
  for (let i = 0; i < 40; i += 1) {
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
    const tx = db.transaction(store, op === 'getAll' ? 'readonly' : 'readwrite')
    const os = tx.objectStore(store)
    if (op === 'getAll') {
      const g = os.getAll()
      g.onsuccess = () => { db.close(); resolve(g.result) }
      g.onerror = () => { db.close(); reject(new Error('getAll failed')) }
      return
    }
    if (op === 'clear') {
      const c = os.clear()
      c.onsuccess = () => { db.close(); resolve(true) }
      c.onerror = () => { db.close(); reject(new Error('clear failed')) }
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

const clickByText = (text, scope = 'document') => `(() => {
  const root = ${scope}
  const btn = [...root.querySelectorAll('button')].find((el) => (el.innerText || '').includes(${JSON.stringify(text)}))
  if (!btn) return '<missing>'
  btn.click()
  return 'ok'
})()`

const clickSwitch = (rowText) => `(() => {
  const row = [...document.querySelectorAll('.switch-row')].find((el) => (el.innerText || '').includes(${JSON.stringify(rowText)}))
  if (!row) return '<no-row>'
  const sw = row.querySelector('.switch')
  if (!sw) return '<no-switch>'
  sw.click()
  return sw.getAttribute('aria-checked')
})()`

const switchState = (rowText) => `(() => {
  const row = [...document.querySelectorAll('.switch-row')].find((el) => (el.innerText || '').includes(${JSON.stringify(rowText)}))
  const sw = row ? row.querySelector('.switch') : null
  return sw ? sw.getAttribute('aria-checked') : '<missing>'
})()`

const now = Date.now()
const CONVERSATION = { id: CONV_ID, title: '导出探针对话', createdAt: now - 5000, updatedAt: now, model: '' }
const MESSAGES = [
  { id: 'probe_m1', conversationId: CONV_ID, role: 'user', content: '第一问 PROBE-Q1', createdAt: now - 4000 },
  { id: 'probe_m2', conversationId: CONV_ID, role: 'assistant', content: '第一答 PROBE-A1', reasoning: '思考过程 PROBE-R1', createdAt: now - 3000, status: 'done' },
  { id: 'probe_m3', conversationId: CONV_ID, role: 'user', content: '第二问 PROBE-Q2', createdAt: now - 2000 },
  { id: 'probe_m4', conversationId: CONV_ID, role: 'assistant', content: '第二答 PROBE-A2', createdAt: now - 1000, status: 'done' },
  { id: 'probe_m5', conversationId: CONV_ID, role: 'tool', content: '工具输出 PROBE-TOOL', toolName: 'echo', createdAt: now - 900, status: 'done' },
]

try {
  await sleep(5000)
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
  ws = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  wire(ws)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true })
  await sleep(800)
  check('应用能正常启动', await waitForApp())
  await evaluate(IDB_HELPER)

  // ---------- 埋一段对话（4 条可导出 + 1 条工具） ----------
  await evaluate(`window.__probeDb('put', 'conversations', ${JSON.stringify(CONVERSATION)})`)
  for (const message of MESSAGES) {
    await evaluate(`window.__probeDb('put', 'messages', ${JSON.stringify(message)})`)
  }
  await send('Page.reload')
  await sleep(2600)
  check('埋完对话还能正常启动', await waitForApp())
  await evaluate(IDB_HELPER)

  // ---------- 打开这段对话 ----------
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || '') === '历史对话')
    if (btn) btn.click()
    return Boolean(btn)
  })()`)
  await sleep(700)
  const opened = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.drawer-row')].find((el) => (el.innerText || '').includes('导出探针对话'))
    if (!row) return '<no-row>'
    row.click()
    return 'ok'
  })()`)
  check('历史抽屉里能打开探针对话', opened === 'ok', String(opened))
  await sleep(900)
  const bubbleCount = await evaluate(`document.querySelectorAll('.chat-scroll .bubble').length`)
  check('对话里有 4 条气泡（工具消息渲染成工具卡，不参与导出）', bubbleCount === 4, String(bubbleCount))

  // ---------- 动作条：只有图标（复制 / 重新生成 / ⋯） ----------
  const acts = await evaluate(`[...document.querySelectorAll('.chat-scroll .bubble')].map((el) => el.querySelectorAll('.bubble-act').length)`)
  check('用户气泡 2 个图标、助手气泡 3 个图标', JSON.stringify(acts) === JSON.stringify([2, 3, 2, 3]), JSON.stringify(acts))
  const actWidth = await evaluate(`(() => { const btn = document.querySelector('.bubble-act'); return btn ? Math.round(btn.getBoundingClientRect().width) : 0 })()`)
  check('图标按钮不会被挤扁（宽度 ≥ 26px）', actWidth >= 26, String(actWidth))

  // ---------- ⋯ → 分享 → 进入多选 ----------
  const openedMenu = await evaluate(`(() => {
    const bubbles = document.querySelectorAll('.chat-scroll .bubble')
    const more = bubbles[1] ? bubbles[1].querySelector('.bubble-act[aria-label="更多"]') : null
    if (!more) return '<missing>'
    more.click()
    return 'ok'
  })()`)
  check('⋯ 能打开消息菜单', openedMenu === 'ok', String(openedMenu))
  await sleep(500)
  const menuText = await evaluate(`(() => { const el = document.querySelector('.bubble-menu'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : '<missing>' })()`)
  check('菜单里有分享/编辑/分叉/删除', ['分享', '编辑', '分叉', '删除'].every((word) => menuText.includes(word)), menuText.slice(0, 120))
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.bubble-menu-row')].find((el) => (el.innerText || '').includes('分享'))
    if (row) row.click()
    return Boolean(row)
  })()`)
  await sleep(500)
  check('多选条出现', (await evaluate(`Boolean(document.querySelector('.selection-bar'))`)) === true)
  const countText = await evaluate(`(() => { const el = document.querySelector('.selection-bar-count'); return el ? el.innerText.trim() : '<missing>' })()`)
  check('分享预选「从第一条到这一条」（第 2 条 → 已选 2 条）', countText.includes('已选 2 条'), countText)

  const selectAll = await evaluate(`(() => {
    const btn = document.querySelector('.selection-bar-btn[aria-label="全选"]')
    if (!btn) return '<missing>'
    btn.click()
    return 'ok'
  })()`)
  check('全选按钮存在', selectAll === 'ok', String(selectAll))
  await sleep(400)
  const countAll = await evaluate(`(() => { const el = document.querySelector('.selection-bar-count'); return el ? el.innerText.trim() : '<missing>' })()`)
  check('全选后是 4 条（工具消息不参与）', countAll.includes('已选 4 条'), countAll)
  await shot('110-selection-mode')

  // ---------- 确定 → 导出格式弹层 ----------
  await evaluate(`(() => {
    const btn = document.querySelector('.selection-bar-btn[aria-label="确定"]')
    if (btn) btn.click()
    return Boolean(btn)
  })()`)
  await sleep(700)
  const dialogTitle = await evaluate(`(() => { const h = document.querySelector('.modal-card h2'); return h ? h.innerText.trim() : '<missing>' })()`)
  check('弹层标题是「导出格式」', dialogTitle === '导出格式', dialogTitle)
  const chosenRows = await evaluate(`document.querySelectorAll('.export-select-row.is-on').length`)
  check('弹层里默认勾选 4 条', chosenRows === 4, String(chosenRows))
  const summary = await evaluate(`(() => { const el = document.querySelector('.export-summary'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : '<missing>' })()`)
  check('摘要显示已选 4 条', summary.includes('已选 4 条'), summary)
  check('有 Markdown 格式卡片', (await evaluate(`Boolean(document.querySelector('.export-format-card'))`)) === true)
  check('没有图片/PNG 导出入口', (await evaluate(`(() => { const t = document.querySelector('.modal-card')?.innerText || ''; return t.includes('图片') || t.includes('PNG') })()`)) === false)
  check('「导出思维过程」默认开', (await evaluate(switchState('导出思维过程'))) === 'true')

  // ---------- 预览：<details> 的两种状态 ----------
  await evaluate(clickSwitch('预览'))
  await sleep(500)
  const previewOn = await evaluate(`(() => { const el = document.querySelector('.export-preview'); return el ? el.innerText : '<missing>' })()`)
  check('预览里有 <details> 与思考内容', previewOn.includes('<details>') && previewOn.includes('PROBE-R1'), previewOn.slice(0, 160))
  check('预览里有正文', previewOn.includes('PROBE-Q1') && previewOn.includes('PROBE-A2'))

  await evaluate(clickSwitch('导出思维过程'))
  await sleep(500)
  const previewOff = await evaluate(`(() => { const el = document.querySelector('.export-preview'); return el ? el.innerText : '<missing>' })()`)
  check('关掉后预览里没有 <details>', !previewOff.includes('<details>'), previewOff.slice(0, 160))
  await shot('111-export-sheet')
  await evaluate(clickSwitch('导出思维过程'))
  await sleep(300)

  // ---------- 点卡片真的写文件 ----------
  if (existsSync(OUT_PATH)) writeFileSync(OUT_PATH, '')
  await evaluate(`(() => {
    const card = document.querySelector('.export-format-card')
    if (!card) return '<missing>'
    card.click()
    return 'ok'
  })()`)
  await sleep(1500)
  const wrote = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : ''
  check('点 Markdown 卡片真的写出了文件', wrote.length > 0, `${wrote.length} bytes`)
  check('文件里有标题', wrote.includes('# 导出探针对话'), wrote.slice(0, 80))
  check('文件里有双方正文', wrote.includes('PROBE-Q1') && wrote.includes('PROBE-A2'))
  check('文件里有思考过程（默认导出）', wrote.includes('<details>') && wrote.includes('PROBE-R1'))
  check('工具消息没有被导出', !wrote.includes('PROBE-TOOL'))
  check('导出后弹层已关闭', (await evaluate(`Boolean(document.querySelector('.modal-card'))`)) === false)
  check('导出后多选条已消失', (await evaluate(`Boolean(document.querySelector('.selection-bar'))`)) === false)

  // ---------- 取消路径 ----------
  await evaluate(`(() => {
    const bubbles = document.querySelectorAll('.chat-scroll .bubble')
    const more = bubbles[1] ? bubbles[1].querySelector('.bubble-act[aria-label="更多"]') : null
    if (more) more.click()
    return Boolean(more)
  })()`)
  await sleep(400)
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.bubble-menu-row')].find((el) => (el.innerText || '').includes('分享'))
    if (row) row.click()
    return Boolean(row)
  })()`)
  await sleep(500)
  await evaluate(`(() => {
    const btn = document.querySelector('.selection-bar-btn[aria-label="取消多选"]')
    if (btn) btn.click()
    return Boolean(btn)
  })()`)
  await sleep(400)
  check('点 ✕ 能退出多选', (await evaluate(`Boolean(document.querySelector('.selection-bar'))`)) === false)

  // ---------- 清掉探针数据 ----------
  for (const message of MESSAGES) {
    await evaluate(`window.__probeDb('delete', 'messages', ${JSON.stringify(message.id)})`)
  }
  await evaluate(`window.__probeDb('delete', 'conversations', ${JSON.stringify(CONV_ID)})`)
  await send('Page.reload')
  await sleep(1800)
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