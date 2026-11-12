import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * 对话内生图 / 语音（TTS）运行时探针。
 *
 * 真实 Electron + 真实 IndexedDB + mock 媒体 API：
 * 1. 设置页能看到「生图与语音」，两套配置能显示；
 * 2. 用户说「画一只虎鲸」→ 模型（mock）返回 generate_image → 图片卡片出现；
 * 3. 用户说「用语音说你好」→ 模型返回 speak → 音频播放器出现；
 * 4. reload 后图片仍在（说明 media 表按消息引用读回来了）。
 *
 * 跑法：node scripts/probe-media.mjs
 */

const MEDIA_PORT = 18789
const CDP_PORT = 9366
const PROFILE = resolve(process.cwd(), '.probe-media-profile')

// mock 服务独立进程：和 scripts/mock-api.mjs 共用同一套返回形状。
const mock = spawn(process.execPath, ['scripts/mock-api.mjs'], {
  env: { ...process.env, MOCK_PORT: String(MEDIA_PORT) },
  stdio: 'ignore',
})
const cleanupRoot = () => {
  try { mock.kill() } catch {}
}
process.on('exit', cleanupRoot)

// 先等 mock 起监听；失败时下面的请求会给出明确错误。
await sleep(400)

const env = { ...process.env, DEEPSEA_DEV_URL: '', DEEPSEA_USER_DATA: PROFILE }
delete env.ELECTRON_RUN_AS_NODE
try { rmSync(PROFILE, { recursive: true, force: true }) } catch {}
mkdirSync('shots', { recursive: true })

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
  for (let i = 0; i < 50; i += 1) {
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

const setTextarea = (text) => `(() => {
  const el = document.querySelector('textarea')
  if (!el) return '<missing>'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(text)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el.value
})()`

const clickSend = `(() => {
  const btn = document.querySelector('button[aria-label="发送"]')
  if (!btn) return '<missing>'
  if (btn.disabled) return '<disabled>'
  btn.click()
  return 'ok'
})()`

try {
  await sleep(7000)
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
  const base = original ?? {}
  const providerId = 'provider_probe_media'
  const imageApi = {
    enabled: true,
    protocol: 'openrouter',
    baseUrl: `http://127.0.0.1:${MEDIA_PORT}/v1`,
    apiKey: '',
    model: 'mock/image-model',
    defaultSize: '1024x1024',
    quality: '',
    extraHeaders: {},
    timeoutMs: 120000,
  }
  const speechApi = {
    enabled: true,
    protocol: 'openrouter',
    baseUrl: `http://127.0.0.1:${MEDIA_PORT}/v1`,
    apiKey: '',
    model: 'mock/audio-model',
    voice: 'alloy',
    format: 'mp3',
    speed: 1,
    extraHeaders: {},
    timeoutMs: 120000,
  }
  const probeProvider = {
    id: providerId,
    name: '媒体探针供应商',
    protocol: 'openai',
    baseUrl: `http://127.0.0.1:${MEDIA_PORT}/v1`,
    apiKey: '',
    models: ['deepseek-flash'],
    headers: {},
    enabled: true,
  }
  const firstSettings = {
    ...base,
    onboardingDone: true,
    providers: [...(base.providers ?? []).filter((p) => p.id !== providerId), probeProvider],
    providerId,
    model: 'deepseek-flash',
    imageApi,
    speechApi,
  }
  // Key 走安全存储（真实用户也是这么填的）；IndexedDB 里的 apiKey 永远是空。
  await evaluate(`window.deepsea.secureSet(${JSON.stringify(JSON.stringify({
    [providerId]: 'sk-probe-chat',
    'media:image': 'sk-probe-image',
    'media:speech': 'sk-probe-speech',
  }))})`)
  await evaluate(`window.__probeIdb('put', ${JSON.stringify(firstSettings)})`)
  await send('Page.reload')
  await sleep(2600)
  check('改完设置后能正常启动', await waitForApp())
  await evaluate(IDB_HELPER)

  // 设置页入口
  const docked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.home-dock .dock-item')].find((el) => (el.innerText || '').includes('设置'))
    if (!item) return '<no-dock>'
    item.click()
    return 'ok'
  })()`)
  check('能进设置页', docked === 'ok', String(docked))
  await sleep(700)
  const toMedia = await evaluate(clickByText('管理生图与语音'))
  check('能进「生图与语音」页', toMedia === 'ok', String(toMedia))
  await sleep(700)
  const mediaText = await evaluate(`(() => (document.querySelector('.settings-body')?.innerText ?? '').replace(/\\s+/g, ' ').trim())()`)
  check('设置页显示两套 API 和说明', mediaText.includes('生图 API') && mediaText.includes('语音 API') && mediaText.includes('需要你自己点播放'), mediaText.slice(0, 220))
  await shot('media-01-settings')

  // 回到聊天
  for (let i = 0; i < 3; i += 1) {
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || '') === '返回'); if (b) b.click(); return Boolean(b) })()`)
    await sleep(450)
  }
  const talk = await evaluate(`(() => { const el = document.querySelector('.dock-talk') ?? document.querySelector('.talk-button'); if (el) el.click(); return Boolean(el) })()`)
  check('能打开对话', talk === true)
  await sleep(900)

  // 生图
  check('能输入生图请求', await evaluate(setTextarea('画一只虎鲸')) === '画一只虎鲸')
  check('能点发送（生图）', await evaluate(clickSend) === 'ok')
  await sleep(2800)
  const imageCount = await evaluate(`document.querySelectorAll('.tool-media__image img').length`)
  check('对话里出现生成图片', imageCount >= 1, String(imageCount))
  const mediaRecordCount = await evaluate(`(async () => {
    return await new Promise((resolve) => {
      const req = indexedDB.open('deepsea')
      req.onsuccess = () => { const db = req.result; const tx = db.transaction('media', 'readonly'); const g = tx.objectStore('media').getAll();
        g.onsuccess = () => { db.close(); resolve(g.result.length) }; g.onerror = () => { db.close(); resolve(-1) } }
      req.onerror = () => resolve(-1)
    })
  })()`)
  check('media 表真的落了一张图', mediaRecordCount >= 1, String(mediaRecordCount))
  await shot('media-02-image')

  // 语音
  check('能输入语音请求', await evaluate(setTextarea('用语音说你好')) === '用语音说你好')
  check('能点发送（语音）', await evaluate(clickSend) === 'ok')
  await sleep(2800)
  const audioCount = await evaluate(`document.querySelectorAll('.tool-media__audio audio').length`)
  check('对话里出现语音播放器', audioCount >= 1, String(audioCount))
  const speechButtonCount = await evaluate(`document.querySelectorAll('.bubble-assistant button[aria-label="朗读这条回复"]').length`)
  check('助手气泡有传统「朗读这条」按钮', speechButtonCount >= 1, String(speechButtonCount))
  const speechClicked = await evaluate(`(() => {
    const btn = document.querySelector('.bubble-assistant button[aria-label="朗读这条回复"]')
    if (!btn) return '<missing>'
    btn.click()
    return 'ok'
  })()`)
  check('「朗读这条」按钮可点击', speechClicked === 'ok', String(speechClicked))
  await sleep(900)
  const mediaCountAfterVoice = await evaluate(`(async () => {
    return await new Promise((resolve) => {
      const req = indexedDB.open('deepsea')
      req.onsuccess = () => { const db = req.result; const tx = db.transaction('media', 'readonly'); const g = tx.objectStore('media').getAll();
        g.onsuccess = () => { db.close(); resolve(g.result.length) }; g.onerror = () => { db.close(); resolve(-1) } }
      req.onerror = () => resolve(-1)
    })
  })()`)
  console.log('MEDIA_ROWS_AFTER_VOICE', mediaCountAfterVoice)
  const lastMediaText = await evaluate(`(() => { const cards = [...document.querySelectorAll('.tool-media')]; const el = cards[cards.length - 1]; return el ? el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 240) : '<none>' })()`)
  console.log('LAST_MEDIA_TEXT', lastMediaText)
  await shot('media-03-audio')

  // reload 后图片仍能按 media 表读回
  await send('Page.reload')
  await sleep(2600)
  check('reload 后仍能启动', await waitForApp())
  await evaluate(IDB_HELPER)
  await sleep(900)
  const imageAfterReload = await evaluate(`document.querySelectorAll('.tool-media__image img').length`)
  check('reload 后生成图片仍在', imageAfterReload >= 1, String(imageAfterReload))

  await evaluate(`window.__probeIdb('put', ${JSON.stringify(original ?? null)})`)
  await send('Page.reload')
  await sleep(1500)
  console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
  const failed = results.filter((r) => !r.ok)
  console.log(`SUMMARY pass=${results.length - failed.length} fail=${failed.length}`)
  if (failed.length > 0) process.exitCode = 1
} catch (e) {
  console.error('PROBE ERROR', e)
  process.exitCode = 1
} finally {
  try { child.kill() } catch {}
  try { mock.kill() } catch {}
}
