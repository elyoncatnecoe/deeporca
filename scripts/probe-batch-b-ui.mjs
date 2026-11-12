import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * B 批 UI 探针：真的点一次「运行代码」。
 *
 * 往库里塞一段带 ```js / ```html 的对话，打开它，点代码块上的「运行」，
 * 看 CodeRunModal 是不是真的把输出拿回来了（沙箱走 public/sandbox.html）。
 */
const port = 9367
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
    if (await evaluate(`Boolean(document.querySelector('.app'))`)) return true
    await sleep(250)
  }
  return false
}

const CONV_ID = 'conv_probe_run'
const TITLE = '运行代码探针'
const JS_CODE = "var start = Date.now(); while (Date.now() - start < 1200) {} console.log('ui', 2 * 3); return 7"
const HTML_CODE = '<h1 id="probe-heading" style="color:#7ff">预览 OK</h1>'

try {
  await sleep(5000)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  wire(ws)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(1000)
  check('应用能正常启动', await waitForApp())

  // 代码块的三反引号不能直接写进模板字符串（会把模板截断），先在 Node 侧拼好再注入。
  const fence = '```'
  const jsMessage = { id: 'msg_probe_js', conversationId: CONV_ID, role: 'assistant', content: `${fence}js\n${JS_CODE}\n${fence}`, status: 'done' }
  const htmlMessage = { id: 'msg_probe_html', conversationId: CONV_ID, role: 'assistant', content: `${fence}html\n${HTML_CODE}\n${fence}`, status: 'done' }
  const conversation = { id: CONV_ID, title: TITLE, model: 'deepseek-chat' }
  const seeded = await evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open('deepsea')
    req.onerror = () => reject(new Error('open failed'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['conversations', 'messages', 'search'], 'readwrite')
      const now = Date.now()
      tx.objectStore('conversations').put({ ...${JSON.stringify(conversation)}, createdAt: now, updatedAt: now })
      tx.objectStore('messages').put({ ...${JSON.stringify(jsMessage)}, createdAt: now })
      tx.objectStore('messages').put({ ...${JSON.stringify(htmlMessage)}, createdAt: now + 1 })
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); reject(new Error('tx failed')) }
    }
  })`)
  check('塞进一段带代码块的对话', seeded === true)

  await send('Page.reload')
  await sleep(2600)
  check('重启后能正常启动', await waitForApp())

  // 打开历史抽屉 → 点进这段对话
  await evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="历史对话"]')
    if (btn) btn.click()
    return Boolean(btn)
  })()`)
  await sleep(700)
  const opened = await evaluate(`(() => {
    const row = [...document.querySelectorAll('button.drawer-row')].find((el) => (el.innerText || '').includes(${JSON.stringify(TITLE)}))
    if (!row) return 'no-row'
    row.click()
    return 'clicked'
  })()`)
  await sleep(900)
  const chatState = await evaluate(`(() => ({
    drawer: Boolean(document.querySelector('.drawer')),
    chat: Boolean(document.querySelector('.chat-screen')),
    codeButtons: document.querySelectorAll('button[data-code-action="run"]').length,
  }))()`)
  check('能打开这段对话（抽屉关掉、进聊天页）', opened === 'clicked' && chatState.drawer === false && chatState.chat === true, JSON.stringify({ opened, ...chatState }))
  check('代码块上有「运行」按钮', chatState.codeButtons >= 2, String(chatState.codeButtons))

  // 点 JS 代码块上的「运行」
  const runClicked = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button[data-code-action="run"]')]
    const target = buttons.find((el) => (el.getAttribute('data-lang') || '') === 'js') || buttons[0]
    if (!target) return 'no-run-button'
    target.click()
    return target.getAttribute('data-lang') || 'clicked'
  })()`)
  check('点到了 JS 代码块的「运行」', runClicked !== 'no-run-button', String(runClicked))
  // 代码里带了一段 1.2 秒的忙等，趁它还在跑的时候看沙箱 iframe 的属性。
  await sleep(350)
  const sandboxInfo = await evaluate(`(() => {
    const frame = [...document.querySelectorAll('iframe')].find((el) => (el.title || '') === '运行沙箱')
    return frame ? { sandbox: frame.getAttribute('sandbox'), src: frame.getAttribute('src') } : null
  })()`)
  check('沙箱 iframe 没有 allow-same-origin', sandboxInfo !== null && !String(sandboxInfo.sandbox).includes('allow-same-origin'), JSON.stringify(sandboxInfo))
  check('沙箱用的是独立页面而不是 srcDoc', sandboxInfo !== null && String(sandboxInfo.src).includes('sandbox.html'), JSON.stringify(sandboxInfo?.src))

  await sleep(2200)
  const output = await evaluate(`document.querySelector('.run-output')?.innerText ?? ''`)
  check('P0-4：JS 在沙箱里跑出了输出', output.includes('ui 6') && output.includes('7'), JSON.stringify(output))
  const stillMounted = await evaluate(`[...document.querySelectorAll('iframe')].some((el) => (el.title || '') === '运行沙箱')`)
  check('跑完之后沙箱被卸载（不留后台脚本）', stillMounted === false, String(stillMounted))
  await shot('87-batch-b-run-js')

  // 关掉弹窗，再点 HTML 预览
  await evaluate(`(() => {
    const close = document.querySelector('.modal-close, button[aria-label="关闭"]')
    if (close) close.click()
    return Boolean(close)
  })()`)
  await sleep(600)
  const htmlRun = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button[data-code-action="run"]')]
    const target = buttons.find((el) => (el.getAttribute('data-lang') || '') === 'html')
    if (!target) return 'no-html-button'
    target.click()
    return 'clicked'
  })()`)
  await sleep(1500)
  const htmlFrame = await evaluate(`(() => {
    const frame = [...document.querySelectorAll('iframe')].find((el) => (el.title || '') === '预览')
    return frame ? { sandbox: frame.getAttribute('sandbox'), src: frame.getAttribute('src'), w: frame.getBoundingClientRect().width } : null
  })()`)
  check('HTML 预览也是沙箱 iframe', htmlRun === 'clicked' && htmlFrame !== null && !String(htmlFrame.sandbox).includes('allow-same-origin'), JSON.stringify(htmlFrame))
  await shot('87-batch-b-run-html')

  console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
  check('没有 console 报错', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)))

  // 收拾：删掉探针对话
  await evaluate(`new Promise((resolve) => {
    const req = indexedDB.open('deepsea')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['conversations', 'messages'], 'readwrite')
      tx.objectStore('conversations').delete(${JSON.stringify(CONV_ID)})
      tx.objectStore('messages').delete('msg_probe_js')
      tx.objectStore('messages').delete('msg_probe_html')
      tx.oncomplete = () => { db.close(); resolve(true) }
    }
  })`)

  const failed = results.filter((r) => !r.ok)
  console.log(`SUMMARY pass=${results.length - failed.length} fail=${failed.length}`)
  if (failed.length > 0) process.exitCode = 1
} catch (e) {
  console.error('PROBE ERROR', e)
  process.exitCode = 1
} finally {
  try { child.kill() } catch {}
}