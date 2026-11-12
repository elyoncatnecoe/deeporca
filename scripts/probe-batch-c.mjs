import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * C 批（数据一致性）的运行时探针。
 *
 * 验两件用户能直接看见的事：
 *   1. P1-12：库里存着「网页账号（deepseek-web）」供应商时，冷启动不会被改写成
 *      openai，而且下一次保存设置也不会把这个错值固化回去；
 *   2. P1-15：供应商编辑页的「模型列表 / 请求头」文本域，回车能加第二行、
 *      冒号没打完的半行不会被吞掉。
 */
const port = 9363
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })

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

const PROBE_ID = 'provider_web_probe'
const PROBE_PROVIDER = {
  id: PROBE_ID,
  name: '网页账号（探针）',
  protocol: 'deepseek-web',
  baseUrl: 'https://chat.deepseek.com',
  models: ['deepseek-chat-web'],
  headers: {},
  enabled: true,
}

// 模拟「被老版本改坏」的历史数据：名字是网页账号，协议却被写成了 openai。
const CORRUPT_ID = 'provider_web_corrupt_probe'
const CORRUPT_PROVIDER = {
  id: CORRUPT_ID,
  name: '网页账号（历史数据）',
  protocol: 'openai',
  baseUrl: 'https://chat.deepseek.com',
  models: ['deepseek-chat-web'],
  headers: {},
  enabled: true,
}

try {
  await sleep(5000)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  wire(ws)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(800)
  check('应用能正常启动', await waitForApp())

  await evaluate(IDB_HELPER)

  // ---------- 埋一份「网页账号供应商」进库 ----------
  const original = await evaluate(`window.__probeIdb('get')`)
  writeFileSync('_tmp/probe-settings-backup.json', JSON.stringify(original ?? null), 'utf8')
  const base = original ?? {}
  const others = (base.providers ?? []).filter((p) => p.id !== PROBE_ID && p.id !== CORRUPT_ID)
  // providerId 故意指向别的供应商：这样探针那一行会出现「切换」按钮，
  // 点它就是一次真实的 setSettings → persistSettings，能验「会不会把错值固化」。
  const otherId = others[0]?.id ?? 'provider_deepseek'
  const seeded = {
    ...base,
    providers: [...others, PROBE_PROVIDER, CORRUPT_PROVIDER],
    providerId: otherId,
    model: 'deepseek-chat-web',
  }
  await evaluate(`window.__probeIdb('put', ${JSON.stringify(seeded)})`)

  await send('Page.reload')
  await sleep(2600)
  check('改完库还能正常启动', await waitForApp())
  await evaluate(IDB_HELPER)

  // ---------- 进供应商页 ----------
  await evaluate(`(() => {
    const dock = [...document.querySelectorAll('.home-dock .dock-item')].find((el) => (el.innerText || '').includes('设置'))
    if (dock) dock.click()
    return Boolean(dock)
  })()`)
  await sleep(700)
  const toProviders = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => (el.innerText || '').includes('管理供应商'))
    if (!btn) return false
    btn.click()
    return true
  })()`)
  check('能进到供应商页', toProviders === true)
  await sleep(700)

  const rowLabel = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.assistant-row')].find((el) => (el.innerText || '').includes('网页账号（探针）'))
    return row ? row.innerText.replace(/\s+/g, ' ').trim() : ''
  })()`)
  check('P1-12：列表里显示的协议是「网页账号」', rowLabel.includes('网页账号') && !rowLabel.includes('OpenAI 兼容'), rowLabel)

  const corruptLabel = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.assistant-row')].find((el) => (el.innerText || '').includes('网页账号（历史数据）'))
    return row ? row.innerText.replace(/\\s+/g, ' ').trim() : ''
  })()`)
  check('P1-12：被改坏的历史供应商在界面上被修回「网页账号」', corruptLabel.includes('网页账号') && !corruptLabel.includes('OpenAI 兼容'), corruptLabel)

  // ---------- 点「切换」= 一次真实保存，验会不会固化错值 ----------
  const switched = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.assistant-row')].find((el) => (el.innerText || '').includes('网页账号（探针）'))
    if (!row) return 'no-row'
    const btn = [...row.querySelectorAll('button')].find((el) => (el.innerText || '').includes('切换'))
    if (!btn) return 'no-switch-button'
    btn.click()
    return 'clicked'
  })()`)
  await sleep(900)
  const afterSave = await evaluate(`window.__probeIdb('get')`)
  const savedProvider = (afterSave?.providers ?? []).find((p) => p.id === PROBE_ID)
  const savedCorrupt = (afterSave?.providers ?? []).find((p) => p.id === CORRUPT_ID)
  check('P1-12：保存后被改坏的历史供应商也写成 deepseek-web 了', savedCorrupt?.protocol === 'deepseek-web', String(savedCorrupt?.protocol))
  check('P1-12：保存后 protocol 仍然是 deepseek-web（不会被固化回 openai）', savedProvider?.protocol === 'deepseek-web', `switch=${switched} protocol=${String(savedProvider?.protocol)} providerId=${String(afterSave?.providerId)}`)
  check('P1-12：切过去之后 providerId 也落在网页账号上', afterSave?.providerId === PROBE_ID, String(afterSave?.providerId))

  // ---------- P1-15：文本域 ----------
  // 注意：网页账号供应商的编辑面板只显示一段说明（不需要 Key/地址/模型），
  // 那两个文本域属于普通 API 供应商，所以这里挑一个非网页账号的行来测。
  const opened = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.assistant-row')]
    const row = rows.find((el) => !(el.innerText || '').includes('网页账号（探针）'))
    if (!row) return 'no-other-provider'
    const edit = [...row.querySelectorAll('button')].find((el) => (el.innerText || '').includes('编辑'))
    if (!edit) return 'no-edit-button'
    edit.click()
    return (row.innerText || '').split('\\n')[0]
  })()`)
  await sleep(700)
  check('能打开普通供应商的编辑面板', typeof opened === 'string' && opened !== 'no-other-provider' && opened !== 'no-edit-button', String(opened))

  const typeInto = (placeholderPart, text) => `(() => {
    const el = [...document.querySelectorAll('textarea')].find((x) => (x.placeholder || '').includes(${JSON.stringify(placeholderPart)}))
    if (!el) return '<missing>'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`

  const readArea = (placeholderPart) => `(() => {
    const el = [...document.querySelectorAll('textarea')].find((x) => (x.placeholder || '').includes(${JSON.stringify(placeholderPart)}))
    return el ? el.value : '<missing>'
  })()`

  await evaluate(typeInto('deepseek-reasoner', 'aaa\n'))
  await sleep(300)
  const afterEnter = await evaluate(readArea('deepseek-reasoner'))
  check('P1-15：模型列表回车后行尾换行还在（能加第二行）', afterEnter === 'aaa\n', JSON.stringify(afterEnter))

  await evaluate(typeInto('deepseek-reasoner', 'aaa\nbbb'))
  await sleep(300)
  const twoLines = await evaluate(readArea('deepseek-reasoner'))
  check('P1-15：两行内容都留得住', twoLines === 'aaa\nbbb', JSON.stringify(twoLines))

  await evaluate(typeInto('HTTP-Referer', 'Author'))
  await sleep(300)
  const halfHeader = await evaluate(readArea('HTTP-Referer'))
  check('P1-15：请求头敲到一半（没有冒号）不会被吞掉', halfHeader === 'Author', JSON.stringify(halfHeader))

  await evaluate(typeInto('HTTP-Referer', 'Authorization: Bearer abc'))
  await sleep(300)
  const fullHeader = await evaluate(readArea('HTTP-Referer'))
  check('P1-15：写完整的请求头能留住', fullHeader === 'Authorization: Bearer abc', JSON.stringify(fullHeader))

  await shot('84-batch-c-providers-editing')

  // ---------- 还原现场 ----------
  await evaluate(`window.__probeIdb('put', ${JSON.stringify(original ?? null)})`)
  await send('Page.reload')
  await sleep(2000)
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