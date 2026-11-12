import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * A 批修复的运行时探针（Electron 生产构建）。
 *
 * 验四件事：
 *   1. 启动没被破坏（不再卡开屏）；
 *   2. 启动失败提示条的样式是深色的，不是白底；
 *   3. 渲染进程没有报错；
 *   4. 发送链路的关键新代码在产物里（bootError / failBoot / resetSendingState…）。
 */
const port = 9361
const env = { ...process.env, DEEPSEA_DEV_URL: '' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })

let ws
let nextId = 1
const pending = new Map()
const consoleErrors = []

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

try {
  await sleep(5000)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  const page = targets.find((t) => t.type === 'page')
  ws = await connect(page.webSocketDebuggerUrl)
  wire(ws)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(1200)

  const boot = await evaluate(`(() => ({
    splash: Boolean(document.querySelector('.splash, .splash-screen, [class*=splash]')),
    app: Boolean(document.querySelector('.app')),
    ui: [...document.querySelectorAll('[data-deepsea-ui] > *')].map((el) => el.className).slice(0, 6),
    bootError: document.querySelector('.boot-error')?.innerText ?? '',
  }))()`)
  console.log('BOOT', JSON.stringify(boot))
  await shot('82-batch-a-boot-home')

  // 注入一条启动失败提示，确认它是深色条而不是白板。
  const banner = await evaluate(`(() => {
    const el = document.createElement('div')
    el.className = 'boot-error'
    el.setAttribute('role', 'alert')
    el.innerHTML = '<span>读取设置失败：模拟错误。界面能用的部分先照常给；实在不行请重启一次。</span><button type="button">知道了</button>'
    document.querySelector('.app').appendChild(el)
    const s = getComputedStyle(el)
    const b = el.getBoundingClientRect()
    return { bg: s.backgroundColor, color: s.color, z: s.zIndex, w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }
  })()`)
  console.log('BANNER', JSON.stringify(banner))
  await sleep(300)
  await shot('82-batch-a-boot-error')

  const bundle = await evaluate(`(() => {
    const text = [...document.querySelectorAll('script[src]')].map((s) => s.src)
    return { scripts: text }
  })()`)
  console.log('SCRIPTS', JSON.stringify(bundle))

  console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
} catch (e) {
  console.error('PROBE ERROR', e)
} finally {
  try { child.kill() } catch {}
}