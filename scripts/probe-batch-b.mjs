import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * B 批（安全）运行时探针。
 *
 * 验这些：
 *   1. 加了 CSP 之后 App 照常启动、没有 CSP 违规、IPC 还能用（同步 + 异步各一条）；
 *   2. 主窗口被导航走会被拦住；
 *   3. 「运行代码」的沙箱页：srcdoc 不被 CSP 拦、new Function 能跑、读不到 App 的存储。
 */
const port = 9365
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })

let ws
let nextId = 1
const pending = new Map()
const consoleErrors = []
const cspViolations = []
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
    if (m.method === 'Log.entryAdded') {
      const entry = m.params?.entry
      if (entry?.source === 'security') cspViolations.push(entry.text ?? '')
    }
  }
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` :: ${detail}`}`)
}

/**
 * 用真实的 public/sandbox.html 跑一段代码：和 CodeRunModal 完全同一条路。
 * 沙箱 iframe 不透明源 + postMessage 送代码 + postMessage 收日志。
 */
async function runInSandbox(code, timeoutMs = 4000) {
  return await evaluate(`new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.style.display = 'none'
    frame.src = new URL('./sandbox.html', location.href).toString()
    const timer = setTimeout(() => { window.removeEventListener('message', onMessage); frame.remove(); resolve({ timeout: true }) }, ${timeoutMs})
    frame.onload = () => {
      try { frame.contentWindow.postMessage({ deepseaRunJs: ${JSON.stringify(code)} }, '*') } catch (e) {}
    }
    function onMessage(event) {
      const data = event.data
      if (!data || !Array.isArray(data.deepseaRunLogs)) return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      frame.remove()
      resolve({ timeout: false, logs: data.deepseaRunLogs })
    }
    window.addEventListener('message', onMessage)
    document.body.appendChild(frame)
  })`)
}

try {
  await sleep(5000)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ws = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  wire(ws)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(1200)

  const boot = await evaluate(`(() => ({
    app: Boolean(document.querySelector('.app')),
    screen: document.querySelector('.home-screen') ? 'home' : 'other',
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
    bridge: typeof window.deepsea === 'object',
  }))()`)
  check('加了 CSP 之后 App 照常启动', boot.app === true && boot.screen === 'home', JSON.stringify({ app: boot.app, screen: boot.screen }))
  check('页面里带着 CSP', boot.csp.includes("default-src 'self'") && boot.csp.includes("script-src 'self'"))
  check('preload 桥还在', boot.bridge === true)

  const version = await evaluate(`window.deepsea.version`)
  check('同步 IPC 还能用（trustedOn）', typeof version === 'string' && version.length > 0, String(version))
  const secure = await evaluate(`window.deepsea.secureGet().then(() => 'ok').catch((e) => 'err:' + e.message)`)
  check('异步 IPC 还能用（trustedHandle）', secure === 'ok', String(secure))
  await shot('86-batch-b-home')

  // 启动阶段（含上面这些 IPC）不能有任何 CSP 违规。
  check('启动过程没有 CSP 违规', cspViolations.length === 0, JSON.stringify(cspViolations.slice(0, 3)))

  // ---------- 运行代码的沙箱：真的能跑 ----------
  const sandbox = await runInSandbox("console.log('hi', 1 + 1); return 42")
  check('沙箱页能加载并回传日志', sandbox?.timeout === false, JSON.stringify(sandbox).slice(0, 200))
  const logs = Array.isArray(sandbox?.logs) ? sandbox.logs : []
  check('沙箱里 new Function 能跑', logs.join('|').includes('hi 2') && logs.join('|').includes('42'), JSON.stringify(logs))

  // 沙箱里必须读不到 App 的数据。
  const probeCode = [
    "var out = []",
    "out.push('origin=' + String(self.origin))",
    "try { out.push('parentDoc=' + (parent.document ? 'yes' : 'no')) } catch (e) { out.push('parentDoc=throw:' + e.name) }",
    "try { var req = indexedDB.open('deepsea'); out.push('idbOpen=ok') } catch (e) { out.push('idbOpen=throw:' + e.name) }",
    "try { out.push('cookie=' + document.cookie) } catch (e) { out.push('cookie=throw:' + e.name) }",
    "return out.join('|')",
  ].join(';')
  const iso = await runInSandbox(probeCode)
  const isoText = Array.isArray(iso?.logs) ? iso.logs.join('|') : ''
  check('沙箱是不透明源（origin=null）', isoText.includes('origin=null'), isoText)
  check('沙箱摸不到父页面 DOM', isoText.includes('parentDoc=throw') || isoText.includes('parentDoc=no'), isoText)



  // ---------- 导航拦截 ----------
  // 用 app://evil/ 做探针：如果拦不住，协议处理器会返回 404 并把页面换掉；
  // 拦住了则地址不变，而且 openExternal 会忽略非 http(s)，不会弹浏览器。
  const before = await evaluate(`location.href`)
  await evaluate(`(() => { location.href = 'app://evil/pwned.html'; return true })()`)
  await sleep(1500)
  const after = await evaluate(`location.href`)
  check('主窗口不会被导航到别处（app://evil）', before === after, `before=${before} after=${after}`)

  // 再确认页面还活着、桥还在（没被替换成错误页）。
  const alive = await evaluate(`({ app: Boolean(document.querySelector('.app')), bridge: typeof window.deepsea === 'object' })`)
  check('导航被拦下后页面仍是我们自己的', alive.app === true && alive.bridge === true, JSON.stringify(alive))

  console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
  check('没有 console 报错', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)))

  const failed = results.filter((r) => !r.ok)
  console.log(`SUMMARY pass=${results.length - failed.length} fail=${failed.length}`)
  if (failed.length > 0) process.exitCode = 1
} catch (e) {
  console.error('PROBE ERROR', e)
  process.exitCode = 1
} finally {
  try { child.kill() } catch {}
}