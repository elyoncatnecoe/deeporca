/**
 * 网页模式验收：打开 App → 设置 → 网页版，然后连进 chat.deepseek.com 那个页面，
 * 看注入的头像和纸雕到底认没认出来。
 *
 * 需要真实网络和已登录的 persist:deepseek 分区；没有登录的话只验证纸雕能挂上。
 * 用法：node scripts/probe-web.mjs   （先 pnpm build）
 */
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const port = 9351
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env })

let ws
let id = 1
const pending = new Map()
const send = (m, p = {}) => {
  const i = id++
  ws.send(JSON.stringify({ id: i, method: m, params: p }))
  return new Promise((res, rej) => pending.set(i, { res, rej }))
}
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

async function attach(target) {
  const sock = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej })
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) {
      const p = pending.get(m.id)
      if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
    }
  }
  return sock
}

try {
  await sleep(5200)
  let targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  const main = targets.find((t) => t.type === 'page')
  ws = await attach(main)
  await send('Runtime.enable')
  await sleep(1600)
  console.log('BODY', JSON.stringify((await ev('document.body.innerText')).slice(0, 100)))
  const entered = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').includes('设置'))
    if (!b) return false
    b.click()
    return true
  })()`)
  console.log('ENTERED_SETTINGS', entered)
  await sleep(1500)
  const opened = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').includes('打开网页版'))
    if (!b) return 'no-button'
    b.click()
    return 'clicked'
  })()`)
  console.log('OPEN_WEB', opened)
  await sleep(10000)
  targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  console.log('TARGETS', targets.map((t) => `${t.type}:${t.url.slice(0, 70)}`))
  const web = targets.find((t) => t.url.includes('deepseek.com'))
  if (!web) {
    console.log('NO_WEB_TARGET')
  } else {
    const w = await attach(web)
    const saved = ws
    ws = w
    await send('Runtime.enable')
    await send('Page.enable')
    await sleep(2000)
    await send('Page.bringToFront')
    let opened = 'none'
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const spot = await ev(`(() => {
        const nodes = [...document.querySelectorAll('div,span,a')].filter((n) => n.children.length === 0 && (n.textContent || '').trim() === '早安问候')
        if (nodes.length === 0) return null
        const r = nodes[0].getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })()`)
      if (spot === null) { opened = 'no-title'; await sleep(2000); continue }
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
      }
      opened = 'clicked@' + Math.round(spot.x) + ',' + Math.round(spot.y)
      await sleep(3000)
      const title = await ev('document.title')
      if (title !== 'DeepSeek') break
    }
    console.log('OPEN_CHAT', opened)
    let rows = 0
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(700)
      rows = await ev(`(() => {
        const list = document.querySelector('.ds-virtual-list-visible-items')
        return list === null ? -1 : list.children.length
      })()`)
      if (rows > 0) break
    }
    console.log('ROWS', rows, 'TITLE', await ev('document.title'))
    const info = await ev(`(() => {
      const box = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return { tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], display: s.display, flexDir: s.flexDirection }
      }
      const list = document.querySelector('.ds-virtual-list-visible-items')
      if (list === null) return { list: null }
      const rows = [...list.children].map((row) => ({
        ...box(row),
        marks: row.querySelectorAll('.ds-markdown').length,
        text: (row.textContent || '').trim().slice(0, 20),
        kids: [...row.children].map(box),
        grand: [...row.children].flatMap((kid) => [...kid.children].slice(0, 4).map(box)),
      }))
      return { list: box(list), rows }
    })()`)
    console.log('STRUCT', JSON.stringify(info, null, 1))
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync('shots/web-mode.png', Buffer.from(shot.data, 'base64'))
    console.log('SHOT shots/web-mode.png')
    ws = saved
  }
} catch (error) {
  console.log('PROBE_ERROR', error instanceof Error ? error.message : String(error))
} finally {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
}
