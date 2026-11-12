import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * 「获取可用模型」的运行时探针（真实 Electron + 真实 IndexedDB + 真实假供应商）。
 *
 * 验四件用户能直接看见的事：
 *   1. 模型目录为空时，供应商页显示空态文案；
 *   2. 点「获取可用模型」能把假供应商 /v1/models 里的模型拉回来、勾选并追加进目录；
 *   3. 拉回来的模型真的进了库（models + modelMeta），并出现在聊天页的模型 popover 里；
 *   4. 401 时给出可读红字，且手动添加仍然可用。
 *
 * 跑法：node scripts/probe-model-catalog.mjs
 */

const CATALOG_PORT = 18787
const CDP_PORT = 9365
const PROBE_ID = 'provider_catalog_probe'

const REMOTE_MODELS = [
  { id: 'alpha-1' },
  { id: 'beta-2', display_name: 'Beta 二号', context_length: 128000, max_output_tokens: 8192 },
]

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${CATALOG_PORT}`)
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  const send = (status, body) => {
    res.writeHead(status, { ...cors, 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/v1/models') return send(200, { data: REMOTE_MODELS })
  if (url.pathname === '/empty/models') return send(200, { data: [] })
  if (url.pathname === '/unauth/models') return send(401, { error: { message: 'invalid api key' } })
  return send(404, { error: { message: 'not found' } })
})
await new Promise((resolve) => server.listen(CATALOG_PORT, '127.0.0.1', resolve))

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
  for (let i = 0; i < 40; i += 1) {
    const ready = await evaluate(`Boolean(document.querySelector('.app'))`)
    if (ready) return true
    await sleep(250)
  }
  return false
}

const IDB_HELPER = `
window.__probeIdb = (mode, value) => new Promise((resolve, reject) => {
  const req = indexedDB.open('deepsea')
  req.onerror = () => reject(new Error('open failed'))
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('settings', mode === 'get' ? 'readonly' : 'readwrite')
    const store = tx.objectStore('settings')
    if (mode === 'get') {
      const g = store.get('app')
      g.onsuccess = () => { db.close(); resolve(g.result ? g.result.value : null) }
      g.onerror = () => { db.close(); reject(new Error('get failed')) }
    } else {
      const p = store.put({ key: 'app', value })
      p.onsuccess = () => { db.close(); resolve(true) }
      p.onerror = () => { db.close(); reject(new Error('put failed')) }
    }
  }
})
true
`

const clickByText = (text, scope = 'document') => `(() => {
  const root = ${scope}
  const btn = [...root.querySelectorAll('button')].find((el) => (el.innerText || '').includes(${JSON.stringify(text)}))
  if (!btn) return '<missing>'
  if (btn.disabled) return '<disabled>'
  btn.click()
  return 'ok'
})()`

const setTextInput = (placeholderPart, text) => `(() => {
  const el = [...document.querySelectorAll('input')].find((x) => (x.placeholder || '').includes(${JSON.stringify(placeholderPart)}))
  if (!el) return '<missing>'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(text)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el.value
})()`

const setBaseUrl = (text) => `(() => {
  const field = [...document.querySelectorAll('.field')].find((el) => (el.innerText || '').includes('API 地址'))
  const input = field ? field.querySelector('input') : null
  if (!input) return '<missing>'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(text)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return input.value
})()`

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
  const original = await evaluate(`window.__probeIdb('get')`)
  writeFileSync('_tmp/probe-catalog-settings-backup.json', JSON.stringify(original ?? null), 'utf8')

  // ---------- 埋一个「模型目录为空」的供应商 ----------
  const base = original ?? {}
  const others = (base.providers ?? []).filter((p) => p.id !== PROBE_ID)
  const probe = {
    id: PROBE_ID,
    name: '探针供应商',
    protocol: 'openai',
    baseUrl: `http://127.0.0.1:${CATALOG_PORT}/v1`,
    apiKey: 'sk-probe-catalog',
    models: [],
    headers: {},
    enabled: true,
  }
  await evaluate(`window.__probeIdb('put', ${JSON.stringify({ ...base, providers: [...others, probe], providerId: PROBE_ID, model: '' })})`)
  await send('Page.reload')
  await sleep(2600)
  check('改完库还能正常启动', await waitForApp())
  await evaluate(IDB_HELPER)

  // ---------- 设置 → 供应商 → 编辑探针供应商 ----------
  const docked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.home-dock .dock-item')].find((el) => (el.innerText || '').includes('设置'))
    if (!item) return '<no-dock>'
    item.click()
    return 'ok'
  })()`)
  check('能进设置页', docked === 'ok', String(docked))
  await sleep(700)
  const toProviders = await evaluate(clickByText('管理供应商'))
  check('能进到供应商页', toProviders === 'ok', String(toProviders))
  await sleep(700)

  const opened = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.assistant-row')].find((el) => (el.innerText || '').includes('探针供应商'))
    if (!row) return '<no-row>'
    const edit = [...row.querySelectorAll('button')].find((el) => (el.innerText || '').includes('编辑'))
    if (!edit) return '<no-edit>'
    edit.click()
    return 'ok'
  })()`)
  check('能打开探针供应商的编辑面板', opened === 'ok', String(opened))
  await sleep(700)

  const emptyText = await evaluate(`(() => {
    const box = document.querySelector('.model-catalog-empty')
    return box ? box.innerText.replace(/\\s+/g, ' ').trim() : '<missing>'
  })()`)
  check('目录为空时显示空态文案', emptyText.includes('模型选择器中将不显示任何模型') && emptyText.includes('目录外 ID 仍可直接发送'), emptyText)
  check('目录为空时没有任何模型行', (await evaluate(`document.querySelectorAll('.model-catalog-row').length`)) === 0)
  await shot('101-catalog-empty')

  // API Key 存在安全存储里（IndexedDB 落库时会被剥掉），所以探针必须像用户那样
  // 在编辑面板里敲一次 Key，否则「获取可用模型」是禁用态。
  const keySet = await evaluate(`(() => {
    const input = [...document.querySelectorAll('.settings-card input[type="password"]')].pop()
    if (!input) return '<missing>'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'sk-probe-catalog')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
  check('能在编辑面板里填上 API Key', keySet === 'sk-probe-catalog', String(keySet))
  await sleep(600)
  // ---------- 获取可用模型 ----------
  const fetchClicked = await evaluate(clickByText('获取可用模型', `document.querySelector('.model-catalog') ?? document`))
  check('「获取可用模型」可点', fetchClicked === 'ok', String(fetchClicked))
  await sleep(1400)
  const pickerRows = await evaluate(`document.querySelectorAll('.model-picker-row').length`)
  check('拉回来 2 个候选模型', pickerRows === 2, String(pickerRows))
  const pickerText = await evaluate(`(() => { const el = document.querySelector('.model-picker'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : '<missing>' })()`)
  check('候选里带显示名（display_name 别名解析生效）', pickerText.includes('Beta 二号'), pickerText.slice(0, 140))
  await shot('102-catalog-picker')

  const selectAll = await evaluate(clickByText('全选', `document.querySelector('.model-picker-toolbar') ?? document`))
  check('候选弹窗里能全选', selectAll === 'ok', String(selectAll))
  await sleep(300)
  const confirmed = await evaluate(clickByText('添加所选', `document.querySelector('.modal-foot') ?? document`))
  check('能点「添加所选」', confirmed === 'ok', String(confirmed))
  await sleep(900)
  const rowCount = await evaluate(`document.querySelectorAll('.model-catalog-row').length`)
  check('添加后目录里出现 2 行', rowCount === 2, String(rowCount))

  const savedProvider = await evaluate(`window.__probeIdb('get').then((s) => (s?.providers ?? []).find((p) => p.id === ${JSON.stringify(PROBE_ID)}) ?? null)`)
  check('模型 id 落库', JSON.stringify(savedProvider?.models ?? []) === JSON.stringify(['alpha-1', 'beta-2']), JSON.stringify(savedProvider?.models))
  check('显示名/上下文落库到 modelMeta', savedProvider?.modelMeta?.['beta-2']?.name === 'Beta 二号' && savedProvider?.modelMeta?.['beta-2']?.contextWindow === 128000, JSON.stringify(savedProvider?.modelMeta))

  // ---------- 401 失败路径 ----------
  const changed = await evaluate(setBaseUrl(`http://127.0.0.1:${CATALOG_PORT}/unauth`))
  check('能改 API 地址', String(changed).includes('/unauth'), String(changed))
  await sleep(400)
  await evaluate(clickByText('获取可用模型', `document.querySelector('.model-catalog') ?? document`))
  await sleep(1400)
  const errorText = await evaluate(`(() => { const el = document.querySelector('.model-catalog-error'); return el ? el.innerText.trim() : '<missing>' })()`)
  check('401 时给出可读红字', errorText.includes('401') && errorText.includes('API Key'), errorText)

  // ---------- 手动添加仍然可用 ----------
  await evaluate(clickByText('添加模型', `document.querySelector('.model-catalog') ?? document`))
  await sleep(400)
  const manual = await evaluate(setTextInput('模型 id', 'gamma-3'))
  check('手动添加的输入框可用', manual === 'gamma-3', String(manual))
  await evaluate(clickByText('确认', `document.querySelector('.model-catalog') ?? document`))
  await sleep(700)
  const rowCount2 = await evaluate(`document.querySelectorAll('.model-catalog-row').length`)
  check('手动添加后目录变成 3 行', rowCount2 === 3, String(rowCount2))
  await shot('103-catalog-filled')

  // ---------- 聊天页 popover 吃目录 ----------
  await evaluate(`(() => {
    const back = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || '') === '返回')
    if (back) back.click()
    return Boolean(back)
  })()`)
  await sleep(600)
  await evaluate(`(() => {
    const back = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || '') === '返回')
    if (back) back.click()
    return Boolean(back)
  })()`)
  await sleep(700)
  await evaluate(`(() => {
    const talk = document.querySelector('.dock-talk') ?? document.querySelector('.talk-button')
    if (talk) talk.click()
    return Boolean(talk)
  })()`)
  await sleep(1000)
  await evaluate(`(() => {
    const chip = document.querySelector('.composer-model .composer-chip')
    if (chip) chip.click()
    return Boolean(chip)
  })()`)
  await sleep(600)
  const popoverText = await evaluate(`(() => { const el = document.querySelector('.model-popover'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : '<missing>' })()`)
  check('聊天页 popover 里出现刚拉取的模型', popoverText.includes('alpha-1') && popoverText.includes('beta-2') && popoverText.includes('gamma-3'), popoverText.slice(0, 200))
  await shot('104-chat-popover-catalog')

  // ---------- 还原现场 ----------
  await evaluate(`window.__probeIdb('put', ${JSON.stringify(original ?? null)})`)
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
  try { server.close() } catch {}
}