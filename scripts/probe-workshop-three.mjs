import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * 「工坊 / 运行代码」对 three.js 的兼容性探针。
 *
 * 用户反馈「工坊对 three.js 的支持有问题」，真机上两条路都断了：
 *   1. 沙箱页 CSP 只允许 inline 脚本 → 从 CDN 引的库被拦（预览白屏）；
 *   2. `new Function` 里出现 import/export 是语法错误 → 模块写法必挂。
 * 这里用一台本地「假 CDN」把两条路都跑一遍（不依赖外网，结果可复现）。
 *
 * 跑法：node scripts/probe-workshop-three.mjs
 */

const PORT = 18788
const CDP_PORT = 9369
const PROBE_FILE_ID = 'file_probe_three'

const UMD_STUB = 'window.THREE = { REVISION: "stub-160", WebGLRenderer: function () { return { domElement: document.createElement("canvas"), setSize: function () {}, render: function () {} } }, Scene: function () { this.add = function () {} }, PerspectiveCamera: function () { this.position = { z: 0 } }, Mesh: function () {}, BoxGeometry: function () {}, MeshNormalMaterial: function () {} };'
const ESM_STUB = 'export const REVISION = "stub-160"; export default { REVISION: "stub-160" };'

const server = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'content-type': 'text/javascript; charset=utf-8' }
  if (req.url === '/three-stub.js') { res.writeHead(200, cors); res.end(UMD_STUB); return }
  if (req.url === '/three.module.js') { res.writeHead(200, cors); res.end(ESM_STUB); return }
  res.writeHead(404, cors); res.end('')
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

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
    const tx = db.transaction(store, op === 'getAll' ? 'readonly' : 'readwrite')
    const os = tx.objectStore(store)
    if (op === 'getAll') {
      const g = os.getAll()
      g.onsuccess = () => { db.close(); resolve(g.result) }
      g.onerror = () => { db.close(); reject(new Error('getAll failed')) }
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
window.__probeMsgs = []
window.addEventListener('message', (event) => {
  try { window.__probeMsgs.push(JSON.stringify(event.data)) } catch (error) { /* 忽略 */ }
})
true
`

const waitForMessage = async (needle, timeoutMs = 15000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const hit = await evaluate(`(window.__probeMsgs || []).find((item) => item.includes(${JSON.stringify(needle)})) ?? ''`)
    if (typeof hit === 'string' && hit !== '') return hit
    await sleep(400)
  }
  return ''
}

try {
  await sleep(5000)
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
  ws = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  wire(ws)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(800)
  check('应用能正常启动', await waitForApp())
  await evaluate(IDB_HELPER)

  // ---------- 1) 沙箱页直连：classic 代码 ----------
  await evaluate(`(() => {
    const old = document.getElementById('probe-sandbox')
    if (old) old.remove()
    const frame = document.createElement('iframe')
    frame.id = 'probe-sandbox'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.src = './sandbox.html'
    frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:240px'
    document.body.appendChild(frame)
    return true
  })()`)
  await sleep(1500)
  await evaluate(`(() => {
    const frame = document.getElementById('probe-sandbox')
    frame.contentWindow.postMessage({ deepseaRunJs: "console.log('CLASSIC', 1 + 1)" }, '*')
    return true
  })()`)
  const classic = await waitForMessage('CLASSIC 2', 8000)
  check('沙箱能跑普通 JS（classic 路径）', classic !== '', classic)

  // ---------- 2) 沙箱页直连：ES module + 远程 import ----------
  await evaluate(`(() => {
    const frame = document.getElementById('probe-sandbox')
    frame.contentWindow.postMessage({
      deepseaRunJs: "import * as THREE from 'http://127.0.0.1:${PORT}/three.module.js'\\nconsole.log('MODULE', THREE.REVISION)"
    }, '*')
    return true
  })()`)
  const moduleHit = await waitForMessage('MODULE stub-160', 15000)
  check('模块写法能跑，且能远程 import（three.js 的用法）', moduleHit !== '', moduleHit || '未收到日志')

  // ---------- 3) 工坊预览：页面里引远程 three（用户真实场景） ----------
  // 用拼字符串的方式写结束标签：直接写字面量的话，这段源码本身会被 HTML 解析器提前截断。
  const CLOSE = '<' + '/script>'
  const page = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>html,body{margin:0;height:100%;background:#04141d;color:#7fe3d4;font:14px monospace}</style>',
    '</head><body>',
    '<script src="http://127.0.0.1:' + PORT + '/three-stub.js">' + CLOSE,
    '<script>',
    '  parent.postMessage({ probeHtml: "THREE=" + (window.THREE ? window.THREE.REVISION : "missing") }, "*")',
    '  try {',
    '    const renderer = new THREE.WebGLRenderer(); renderer.setSize(200, 150)',
    '    document.body.appendChild(renderer.domElement)',
    '    const scene = new THREE.Scene()',
    '    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100); camera.position.z = 3',
    '    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial()))',
    '    renderer.render(scene, camera)',
    '    parent.postMessage({ probeHtml: "RENDER=ok" }, "*")',
    '  } catch (error) { parent.postMessage({ probeHtml: "RENDER=fail " + error.message }, "*") }',
    CLOSE,
    '</body></html>',
  ].join('\n')

  const seeded = {
    id: PROBE_FILE_ID,
    workspaceId: 'default',
    path: 'index.html',
    content: page,
    updatedAt: Date.now(),
  }
  // 工坊里本来就有示例 index.html；同一个路径两个 id 时 entry 取先来的那个，
  // 所以先把同名文件挪走（结束时还原），否则预览的还是示例页。
  const existingFiles = await evaluate(`window.__probeDb('getAll', 'files')`)
  const displaced = (existingFiles ?? []).filter((file) => String(file.path).toLowerCase() === 'index.html')
  writeFileSync('_tmp/probe-workshop-files-backup.json', JSON.stringify(displaced, null, 2), 'utf8')
  for (const file of displaced) {
    await evaluate(`window.__probeDb('delete', 'files', ${JSON.stringify(file.id)})`)
  }
  await evaluate(`window.__probeDb('put', 'files', ${JSON.stringify(seeded)})`)
  await send('Page.reload')
  await sleep(2600)
  check('埋完工坊文件还能正常启动', await waitForApp())
  await evaluate(IDB_HELPER)

  const toWorkshop = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.home-dock .dock-item')].find((el) => (el.innerText || '').includes('工坊'))
    if (!item) return '<no-dock>'
    item.click()
    return 'ok'
  })()`)
  check('能进工坊', toWorkshop === 'ok', String(toWorkshop))
  await sleep(1200)
  const toPreview = await evaluate(`(() => {
    const tab = [...document.querySelectorAll('button')].find((el) => (el.innerText || '').trim() === '预览')
    if (!tab) return '<no-tab>'
    tab.click()
    return 'ok'
  })()`)
  check('能切到预览页', toPreview === 'ok', String(toPreview))
  await sleep(3000)

  const threeHit = await waitForMessage('THREE=stub-160', 12000)
  check('工坊预览里能加载远程 three（CSP 放行）', threeHit !== '', threeHit || '未收到页面消息')
  const renderHit = await waitForMessage('RENDER=ok', 12000)
  check('页面里能建 WebGL renderer 并渲染一帧', renderHit !== '', renderHit || '未收到页面消息')
  await shot('130-workshop-three')

  // ---------- 清理 ----------
  await evaluate(`window.__probeDb('delete', 'files', ${JSON.stringify(PROBE_FILE_ID)})`)
  for (const file of displaced) {
    await evaluate(`window.__probeDb('put', 'files', ${JSON.stringify(file)})`)
  }
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
  try { server.close() } catch {}
}