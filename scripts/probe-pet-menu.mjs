import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import ts from 'typescript'

/**
 * 探针：在真实 Chromium 里挂一次纸雕，验证右键菜单。
 *
 * 为什么不用浏览器假 DOM：菜单要靠 shadow DOM + position:fixed + 剪贴板兜底，
 * 这些行为只有真引擎才准。这里用 Electron 开一个空白页，把 mountPet 转译后
 * 直接挂上去，全程不碰 App 的 store 和 DeepSeek。
 */

const PORT = 9386
const TMP = '_tmp/probe-pet'
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const source = readFileSync('src/components/pet/mountPet.ts', 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const css = readFileSync('src/components/pet/pet.css', 'utf8')
const svg = readFileSync('src/components/pet/pet.svg', 'utf8')

writeFileSync(
  `${TMP}/main.cjs`,
  [
    "const { app, BrowserWindow } = require('electron')",
    'app.whenReady().then(() => {',
    "  const win = new BrowserWindow({ width: 900, height: 640, show: true, webPreferences: { contextIsolation: false, nodeIntegration: false } })",
    "  win.loadURL('data:text/html,<html><body style=\"margin:0;background:%2304141d\"></body></html>')",
    '})',
    "app.on('window-all-closed', () => app.quit())",
  ].join('\n'),
)

const env = { ...process.env }
// 这个环境里 ELECTRON_RUN_AS_NODE 是开着的（其他探针也都要先删掉），
// 不删的话 electron.exe 会退化成普通 node，require('electron') 是空的。
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  'node_modules/electron/dist/electron.exe',
  [`${TMP}/main.cjs`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}/ud`],
  { stdio: 'ignore', env },
)

let ws = null
let nextId = 1
const pending = new Map()

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.onopen = () => resolve(socket)
    socket.onerror = (error) => reject(error)
  })
}

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result?.value
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`)
}

try {
  let target = null
  for (let attempt = 0; attempt < 40 && target === null; attempt += 1) {
    await sleep(300)
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json())
      target = list.find((item) => item.type === 'page') ?? null
    } catch (error) {
      target = null
    }
  }
  if (target === null) throw new Error('连不上 Electron 调试端口')
  ws = await connect(target.webSocketDebuggerUrl)
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const slot = pending.get(message.id)
    if (slot === undefined) return
    pending.delete(message.id)
    if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
    else slot.resolve(message.result)
  }
  await send('Runtime.enable')

  // 等页面真的加载完：data URL 也是异步的，body 可能还没建出来。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await evaluate('({ ready: document.readyState, body: document.body !== null })')
    if (state?.ready === 'complete' && state?.body === true) break
    await sleep(150)
  }

  const mounted = await evaluate(`(() => {
    var exports = {};
    ${js}
    var mountPet = exports.mountPet;
    if (typeof mountPet !== 'function') return { error: 'mountPet 没有导出' };
    var host = document.createElement('div');
    host.id = 'probe-host';
    var parent = document.body !== null ? document.body : document.documentElement;
    parent.appendChild(host);
    window.__host = host;
    window.__dispose = mountPet(host, ${JSON.stringify(svg)}, ${JSON.stringify(css)}, {
      interactive: true,
      zIndex: 999999,
      onCopyPersonaPrompt: function () { return 'PERSONA-TEXT'; },
      onCopyMemoryExportMarkdown: function () { return 'EXPORT-TEXT'; },
    });
    return { hasShadow: host.shadowRoot !== null };
  })()`)
  check('mountPet 挂载成功', mounted?.hasShadow === true, mounted)

  const menu = await evaluate(`(() => {
    const host = window.__host;
    const shadow = host.shadowRoot;
    const wrap = shadow.getElementById('orcaWrap');
    const out = { wrap: wrap !== null, inShadow: null, items: 0, labels: [], display: null, copied: null, stubOk: false };
    if (wrap === null) return out;
    const rect = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10 }));
    const box = shadow.querySelector('.orca-context-menu');
    if (box === null) return out;
    out.inShadow = box.parentNode === shadow;
    out.display = box.style.display;
    out.items = box.querySelectorAll('.orca-context-menu-item').length;
    out.labels = Array.prototype.map.call(box.querySelectorAll('.orca-context-menu-item'), (node) => node.textContent);
    out.rect = [Math.round(box.getBoundingClientRect().left), Math.round(box.getBoundingClientRect().top)];
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (text) => { window.__copied = text; return Promise.resolve() } },
      });
      out.stubOk = true;
    } catch (error) {
      out.stubOk = false;
    }
    box.querySelector('.orca-context-menu-item').click();
    out.copied = window.__copied === undefined ? null : window.__copied;
    out.afterClick = box.style.display;
    out.cards = Array.prototype.map.call(shadow.querySelectorAll('.speech-card-inner'), (node) => node.textContent);
    return out;
  })()`)
  check('右键弹出菜单（挂在 shadow root 直属节点）', menu?.display === 'block' && menu?.inShadow === true, menu)
  check('菜单有两个人设/记忆菜单项', menu?.items === 2, menu?.labels)
  check('点第一项复制的是人格提示词', menu?.copied === 'PERSONA-TEXT', menu?.copied)
  check('点完菜单收起', menu?.afterClick === 'none', menu?.afterClick)

  const close = await evaluate(`(() => {
    const shadow = window.__host.shadowRoot;
    const wrap = shadow.getElementById('orcaWrap');
    const box = shadow.querySelector('.orca-context-menu');
    const rect = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10 }));
    const reopened = box.style.display;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const afterEsc = box.style.display;
    wrap.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10 }));
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, clientX: 5, clientY: 5 }));
    const afterOutside = box.style.display;
    // 视口收敛：贴着右边缘右键，菜单不能溢出
    wrap.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: window.innerWidth - 2, clientY: window.innerHeight - 2 }));
    const bounds = box.getBoundingClientRect();
    return {
      reopened,
      afterEsc,
      afterOutside,
      fits: bounds.right <= window.innerWidth + 1 && bounds.bottom <= window.innerHeight + 1,
    };
  })()`)
  check('再次右键能打开', close?.reopened === 'block', close?.reopened)
  check('Esc 关闭菜单', close?.afterEsc === 'none', close?.afterEsc)
  check('点外部关闭菜单', close?.afterOutside === 'none', close?.afterOutside)
  check('贴边右键时菜单收敛在视口内', close?.fits === true, close)

  const touch = await evaluate(`new Promise((resolve) => {
    const shadow = window.__host.shadowRoot;
    const wrap = shadow.getElementById('orcaWrap');
    const box = shadow.querySelector('.orca-context-menu');
    box.style.display = 'none';
    const rect = wrap.getBoundingClientRect();
    const x = rect.left + 24;
    const y = rect.top + 24;
    wrap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: y, button: 0 }));
    setTimeout(() => {
      const opened = box.style.display;
      wrap.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: y }));
      resolve({ opened, afterUp: box.style.display });
    }, 700);
  })`)
  check('触摸长按 520ms 也能弹菜单（手机没有右键）', touch?.opened === 'block' && touch?.afterUp === 'block', touch)

  const disposed = await evaluate(`(() => { window.__dispose(); return { empty: window.__host.shadowRoot.innerHTML === '' } })()`)
  check('dispose 清空 shadow（菜单节点一起清掉）', disposed?.empty === true, disposed)
} catch (error) {
  console.error('PROBE ERROR', error instanceof Error ? error.message : error)
  checks.push({ name: 'probe', ok: false })
} finally {
  if (ws !== null) ws.close()
  child.kill()
  await sleep(600)
  rmSync(TMP, { recursive: true, force: true })
}

const failed = checks.filter((item) => item.ok !== true)
console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
process.exit(failed.length === 0 ? 0 : 1)
