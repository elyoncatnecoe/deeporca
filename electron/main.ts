import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeAllStdio, closeStdio, notifyStdio, requestStdio } from './mcp-stdio'
import { resolveAppPath } from './app-protocol-path'
import { isAllowedMainWindowNavigation, isTrustedIpcSenderUrl } from './trust'
import {
  type SafeStorageLike,
  readSecureValue,
  removeSecureValue,
  writeSecureValue,
} from './secure-store'
import { webRelayScript } from '../src/lib/web-relay'
import {
  WebApiError,
  abortWebSend,
  captureSessionFromWindow,
  diagnose,
  forgetWebSession,
  hasWebSession,
  takeWebSessionIssue,
  verifySession,
  uploadWebFile,
  webSend,
  type SessionPersistResult,
} from './deepseek-api'

/** 等用户登录最多等这么久（扫码/人机校验都需要时间）。 */
const LOGIN_TIMEOUT_MS = 300_000

/**
 * 把「登录态没存下来」翻译成给用户看的一句话。
 *
 * 注意：双重失败（新会话写不进 + 旧会话清不掉）不会走到这里 —— 那条路径由
 * `save()` 直接抛 `SessionRemoveError`，经 IPC rejection 传到前端 `.catch()`。
 */
function persistFailureText(result: Extract<SessionPersistResult, { ok: false }>): string {
  try {
    forgetWebSession()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `${result.message}；且本地旧登录态未能清除（${detail}），重启后可能恢复旧账号`
  }
  return `${result.message}；为避免下次启动恢复旧账号，本地登录态已清除`
}

/**
 * 测试/自动化用：指定独立的 userData 目录，起一个「新装」实例。
 *
 * 只有显式设置 DEEPSEA_USER_DATA 时才生效（探针用），正常启动不受影响。
 * 必须在 app ready 之前调用，否则 profile 已经建好了。
 */
const testUserData = process.env.DEEPSEA_USER_DATA
if (typeof testUserData === 'string' && testUserData !== '') {
  app.setPath('userData', testUserData)
}

const APP_ORIGIN = 'app://deepsea'
const DEEPSEEK_HOSTS = new Set(['chat.deepseek.com', 'account.deepseek.com', 'platform.deepseek.com'])
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

let mainWindow: BrowserWindow | null = null
let webChatWindow: BrowserWindow | null = null

function distRoot(): string {
  return resolve(app.getAppPath(), 'dist')
}

function mimeOf(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.woff2')) return 'font/woff2'
  if (path.endsWith('.wasm')) return 'application/wasm'
  return 'application/octet-stream'
}

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    // 路径判断（host / 解码 / 越界）全部在 app-protocol-path.ts，那边有回归测试；
    // 这里只负责把解析结果变成 HTTP 响应。
    const resolved = resolveAppPath(distRoot(), request.url)
    if (!resolved.ok) return new Response('forbidden', { status: 403 })
    const target = resolved.target
    if (!existsSync(target)) return new Response('not found', { status: 404 })
    // 命中目录时 readFileSync 会抛 EISDIR，直接当 404 更符合预期。
    let isFile = false
    try {
      isFile = statSync(target).isFile()
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (!isFile) return new Response('not found', { status: 404 })
    return new Response(readFileSync(target), {
      headers: { 'Content-Type': mimeOf(target) },
    })
  })
}

function secureFile(): string {
  return join(app.getPath('userData'), 'secure.json')
}

/** 判断逻辑在 secure-store.ts（可单测），这里只注入真实的 safeStorage 与文件路径。 */
const safeStorageLike: SafeStorageLike = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plainText) => safeStorage.encryptString(plainText),
  decryptString: (encrypted) => safeStorage.decryptString(encrypted),
}

function isAllowedNavigation(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    return DEEPSEEK_HOSTS.has(url.hostname) || url.hostname.endsWith('.deepseek.com')
  } catch {
    return false
  }
}

/**
 * 渲染层的信任边界。
 *
 * 主窗口跑的是我们自己的页面，它通过 preload 拿到了 window.deepsea 桥
 * （读 Key、读写文件、mcpStdioRequest 任意命令）。只要页面被导航到别处，
 * 或者有别的框架混进来，这个桥就等于交给了外人 —— 而模型输出里一条普通的
 * markdown 链接就能把页面导航走（BUG-REVIEW P0-3）。所以两件事都要做：
 *   1. 不让主窗口导航出去（见 createWindow 里的 will-navigate）；
 *   2. 每个 IPC 入口先验来源（下面这两个包装器）。
 */

/*
 * URL 级判断在 trust.ts（可单测）；这里保留 frame 级的守卫，因为 Electron 的
 * event.senderFrame 类型只在这一层可用。
 *
 * 两者合起来的语义：只接受主窗口顶层框架、且地址是我们自己的页面。
 * about:blank / about:srcdoc 不再享有任何白名单（见 trust.ts 的说明）。
 */

/** 只接受主窗口顶层框架的调用：子框架一律不认。 */
function isTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const frame = event.senderFrame
  if (frame === null) return false
  // 沙箱预览用 srcdoc / about:blank，但它们的 parent 不为 null，这里直接挡掉。
  if (frame.parent !== null) return false
  return isTrustedIpcSenderUrl(frame.url, process.env.DEEPSEA_DEV_URL)
}

/* 参数类型跟 ipcMain 本身一致，这里不追求更精确的泛型。 */
type TrustedHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
type TrustedListener = (event: Electron.IpcMainEvent, ...args: any[]) => void

/** 注册一个「只允许主窗口调用」的 IPC 处理器。 */
function trustedHandle(channel: string, handler: TrustedHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error(`拒绝调用 ${channel}：来源不可信`)
    return await handler(event, ...args)
  })
}

/** 注册一个「只允许主窗口调用」的同步 IPC 通道。 */
function trustedOn(channel: string, listener: TrustedListener): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      // 同步通道必须给个返回值，否则渲染进程会一直等下去。
      event.returnValue = null
      return
    }
    listener(event, ...args)
  })
}

/* ---------------- 主进程 HTTP 桥（绕开渲染层 CORS） ----------------
 *
 * 渲染进程跑在 app://deepsea 这个浏览器上下文里，第三方 OpenAI 兼容端点如果
 * 不回 CORS 头，renderer 里的 fetch 会直接 `fetch failed`。主进程没有 CORS
 * 限制，所以 API 的 HTTP 统一走这里：普通请求一次取回全量，SSE 用 stream 把
 * 解出来的文本块逐段推给窗口。
 */

type HttpBridgeOptions = {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

type HttpStreamEvent =
  | { id: string; type: 'status'; status: number; headers: Record<string, string> }
  | { id: string; type: 'chunk'; chunk: string }
  | { id: string; type: 'end'; status: number; headers: Record<string, string> }
  | { id: string; type: 'error'; message: string }

/** 正在进行的流式请求：id → AbortController（结束/出错时删掉）。 */
const httpStreams = new Map<string, AbortController>()

/** 校验并归一化渲染层传来的 HTTP 参数；不合法返回 null。 */
function parseHttpBridgeOptions(raw: unknown): HttpBridgeOptions | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  if (typeof input.url !== 'string' || input.url === '') return null
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  let method = 'GET'
  if (input.method !== undefined && input.method !== null && input.method !== '') {
    if (typeof input.method !== 'string') return null
    method = input.method.toUpperCase()
  }

  // headers 必须是扁平 string→string 记录；嵌套/数组/非字符串值一律拒绝。
  const headers: Record<string, string> = {}
  if (input.headers !== undefined && input.headers !== null) {
    if (typeof input.headers !== 'object' || Array.isArray(input.headers)) return null
    for (const [key, value] of Object.entries(input.headers as Record<string, unknown>)) {
      if (typeof value !== 'string') return null
      // 主进程不携带任何 Cookie（Node fetch 本来也没有 cookie jar，这里再兜一层）。
      const lower = key.toLowerCase()
      if (lower === 'cookie' || lower === 'cookie2') continue
      headers[key] = value
    }
  }

  let body: string | undefined
  if (input.body !== undefined && input.body !== null) {
    if (typeof input.body !== 'string') return null
    body = input.body
  }

  let timeoutMs = 120_000
  if (input.timeoutMs !== undefined && input.timeoutMs !== null) {
    if (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) return null
    timeoutMs = Math.floor(input.timeoutMs)
  }

  return { url: parsed.toString(), method, headers, body, timeoutMs }
}

function openExternal(raw: string): void {
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:' || url.protocol === 'http:') void shell.openExternal(url.toString())
  } catch {
    /* ignore malformed URLs */
  }
}

let lastWebCss = ''
let lastWebJs = ''

/**
 * 把皮肤 CSS 注入网页窗口。
 *
 * 以前用的是 webContents.insertCSS()，而它对每次调用都**新增**一份样式表：
 * 用户每点一次「网页版」，页面上就多一份 30KB 的 !important 规则，层叠
 * 计算量线性增长，点几次就开始卡。现在改成写一个固定 id 的 <style>，
 * 重复注入只是替换内容，永远是同一份。
 */
const CSS_STYLE_ID = 'deepsea-skin-style'

function injectCss(win: Electron.BrowserWindow, css: string): void {
  if (css.trim() === '') return
  const script = `(function(){
    var id = ${JSON.stringify(CSS_STYLE_ID)};
    var el = document.getElementById(id);
    if (el === null) {
      el = document.createElement('style');
      el.id = id;
      (document.head || document.documentElement).appendChild(el);
    }
    if (el.textContent !== ${JSON.stringify(css)}) el.textContent = ${JSON.stringify(css)};
  })();`
  void win.webContents.executeJavaScript(script, true).catch(() => undefined)
}

/**
 * 把「网页账号中继脚本」注入网页窗。
 *
 * 脚本本体在 src/lib/web-relay.ts，构建时由 scripts/build-relay.mjs 生成
 * electron/relay-source.ts 内联进来（主进程不能直接 import src 里的 TS）。
 * 幂等：重复注入只刷新，不重复绑事件。
 */
function injectRelay(win: Electron.BrowserWindow): Promise<void> {
  return win.webContents
    .executeJavaScript(webRelayScript(), true)
    .then(() => undefined)
    .catch(() => undefined)
}

/** 网页窗现在还能不能用（存在且没被销毁）。 */
function liveWebChatWindow(): Electron.BrowserWindow | null {
  if (webChatWindow === null || webChatWindow.isDestroyed()) return null
  return webChatWindow
}

/** 确保网页窗存在；不存在就按上次的配置开一个。 */
async function ensureWebChatWindow(): Promise<Electron.BrowserWindow | null> {
  const existing = liveWebChatWindow()
  if (existing !== null) {
    await injectRelay(existing)
    return existing
  }
  openWebChat(lastWebCss, lastWebJs)
  const created = liveWebChatWindow()
  if (created === null) return null
  await new Promise<void>((resolve) => {
    if (created.webContents.isLoading()) created.webContents.once('dom-ready', () => resolve())
    else resolve()
  })
  await injectRelay(created)
  return created
}

function openWebChat(css: string, js = ''): void {
  lastWebCss = css
  lastWebJs = js
  if (webChatWindow !== null && !webChatWindow.isDestroyed()) {
    // 网页账号模式把它当「后台会话引擎」用，所以这里不再强制抢焦点；
    // 需要用户去登录时，由 webchat:show 显式唤出。
    webChatWindow.show()
    webChatWindow.focus()
    injectCss(webChatWindow, css)
    if (js.trim() !== '') void webChatWindow.webContents.executeJavaScript(js, true).catch(() => undefined)
    return
  }
  const partition = 'persist:deepseek'
  webChatWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: '深鲸 · 网页版',
    // 站点自己管浅色/深色，这个底色只在页面加载完成前露一瞬。
    // 用中性浅色比深蓝安全：浅色主题下不会闪一下黑，深色下也只是一瞬。
    backgroundColor: '#eef2f5',
    autoHideMenuBar: true,
    icon: join(app.getAppPath(), 'resources', 'icon.png'),
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })
  const win = webChatWindow
  win.webContents.setUserAgent(CHROME_UA)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) return { action: 'allow' as const }
    openExternal(url)
    return { action: 'deny' as const }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault()
      openExternal(url)
    }
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault()
      openExternal(url)
    }
  })
  win.webContents.on('dom-ready', () => {
    injectCss(win, css)
    if (js.trim() !== '') {
      // The script is self-contained and idempotent; DeepSeek may reload the
      // page after login, so run it on every dom-ready rather than once.
      void win.webContents.executeJavaScript(js, true).catch(() => undefined)
    }
    // 中继脚本必须每次都重挂：登录会整页重载，旧引用随之失效。
    void injectRelay(win)
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.alt && input.key === 'Left') {
      if (win.webContents.canGoBack()) win.webContents.goBack()
      event.preventDefault()
    }
    if (input.alt && input.key === 'Right') {
      if (win.webContents.canGoForward()) win.webContents.goForward()
      event.preventDefault()
    }
    if (input.key === 'F5') {
      win.webContents.reload()
      event.preventDefault()
    }
  })
  win.on('closed', () => {
    webChatWindow = null
  })
  void win.loadURL('https://chat.deepseek.com/')
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '深鲸',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { type: 'separator' },
        { label: '打开网页版', click: () => openWebChat(lastWebCss, lastWebJs) },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: '深鲸 · DeepSea',
    backgroundColor: '#04141d',
    icon: join(app.getAppPath(), 'resources', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  // 主窗口不许导航走：模型输出里一个普通链接就能把整个 App 换成别的页面，
  // 而那个页面会拿到完整的 window.deepsea 桥（BUG-REVIEW P0-3）。
  // 外部链接交给系统浏览器，App 自己不动。
  // 注意用的是「导航白名单」而不是 IPC 的来源判断：以前两者共用一个函数，
  // 里面的 about:blank 例外等于把这条保护自己开了个口子。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedMainWindowNavigation(url, process.env.DEEPSEA_DEV_URL)) return
    event.preventDefault()
    openExternal(url)
  })
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (isAllowedMainWindowNavigation(url, process.env.DEEPSEA_DEV_URL)) return
    event.preventDefault()
  })
  // 子框架不单独拦：这一版 Electron 的类型里还没有 will-frame-navigate，
  // 而子框架的风险由 index.html 的 CSP 兜住（frame-src 只允许 'self' 与 data:）。
  // 这个应用不用 <webview>，一律拒绝，少一条攻击面。
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env.DEEPSEA_DEV_URL
  if (devUrl !== undefined && devUrl !== '') await mainWindow.loadURL(devUrl)
  else await mainWindow.loadURL(`${APP_ORIGIN}/index.html`)
}

app.setAppUserModelId('com.elyoncat.deepsea')

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    // Chromium 启动时会去探测 Google 的组件/变体服务（clients2.google.com 等）。
    // 国内网络下这些域名连不通，控制台就会刷
    //   `handshake failed; SSL error code 1, net_error -100`
    // 这条日志跟本应用的功能无关，纯属噪音，会让人误以为网页账号坏了。
    // 关掉后台网络服务与相关探测即可。
    app.commandLine.appendSwitch('disable-background-networking')
    app.commandLine.appendSwitch('disable-component-update')
    app.commandLine.appendSwitch('disable-domain-reliability')
    app.commandLine.appendSwitch('no-pings')

    registerAppProtocol()
    buildMenu()
    trustedOn('app:version', (event) => {
      event.returnValue = app.getVersion()
    })

    /* ---------------- 主进程 HTTP 桥（绕 CORS） ---------------- */

    /**
     * 普通 HTTP 请求：一次取回完整响应。
     *
     * 校验不过返回 null（渲染层据此报「请求参数不合法」）；网络错误/超时则抛
     * Error 给 IPC 的 invoke Promise，由渲染层 catch 后展示原因。
     */
    trustedHandle('http:request', async (_event, raw: unknown) => {
      const options = parseHttpBridgeOptions(raw)
      if (options === null) return null
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, options.timeoutMs)
      try {
        const response = await fetch(options.url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          signal: controller.signal,
          redirect: 'follow',
        })
        // 非 2xx 也把 body 读出来：错误响应体里通常带着 API 的具体报错信息。
        const text = await response.text()
        return { status: response.status, headers: Object.fromEntries(response.headers), text }
      } catch (error) {
        const message = timedOut
          ? `请求超时（${options.timeoutMs} ms）`
          : error instanceof Error ? error.message : 'HTTP 请求失败'
        throw new Error(message)
      } finally {
        clearTimeout(timer)
      }
    })

    /**
     * 二进制 HTTP 请求：TTS 音频 / 生图外链下载。
     *
     * 不能复用 http:request 的 `response.text()`：MP3/PNG 是字节，按 UTF-8 解码会
     * 坏成替换字符。这里读 arrayBuffer 后 base64 回渲染层；错误响应体仍解成文本
     * 放 `text`，供界面显示接口的具体报错。
     */
    trustedHandle('http:requestBinary', async (_event, raw: unknown) => {
      const options = parseHttpBridgeOptions(raw)
      if (options === null) return null
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, options.timeoutMs)
      try {
        const response = await fetch(options.url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          signal: controller.signal,
          redirect: 'follow',
        })
        const headers = Object.fromEntries(response.headers)
        const mime = (headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
        const buffer = Buffer.from(await response.arrayBuffer())
        const text = mime.includes('json') || mime.startsWith('text/')
          ? buffer.toString('utf8')
          : undefined
        return {
          status: response.status,
          headers,
          base64: buffer.toString('base64'),
          mime,
          ...(text !== undefined ? { text } : {}),
        }
      } catch (error) {
        const message = timedOut
          ? `请求超时（${options.timeoutMs} ms）`
          : error instanceof Error ? error.message : 'HTTP 二进制请求失败'
        throw new Error(message)
      } finally {
        clearTimeout(timer)
      }
    })

    /**
     * 流式请求：立刻返回 id，之后通过 `http:stream:event` 推 status / chunk / end / error。
     *
     * 非 2xx 的响应也必须先把 body 读完再发 end（带上真实 status）——渲染层要
     * 靠错误 body 显示 API 的报错，不能一看到状态码就丢掉正文。
     */
    trustedHandle('http:stream:start', async (event, raw: unknown) => {
      const options = parseHttpBridgeOptions(raw)
      if (options === null) return null
      const id = randomUUID()
      const controller = new AbortController()
      httpStreams.set(id, controller)

      /** 把事件推给主窗口；窗口在途中被关掉就安静丢弃，不让流读取崩掉。 */
      const send = (payload: HttpStreamEvent): void => {
        try {
          if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
          mainWindow.webContents.send('http:stream:event', payload)
        } catch {
          /* 窗口销毁竞态，忽略 */
        }
      }

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, options.timeoutMs)

      // 不 await：id 先还给渲染层，正文在后台按块推。
      void (async () => {
        try {
          const response = await fetch(options.url, {
            method: options.method,
            headers: options.headers,
            body: options.body,
            signal: controller.signal,
            redirect: 'follow',
          })
          const headers = Object.fromEntries(response.headers)
          // 状态事件必须先到：SSE 消费方要先知道这是 200 流还是 4xx/5xx 的
          // JSON 错误体，再决定把后续 chunk 喂给 SSE 解析器还是错误处理。
          send({ id, type: 'status', status: response.status, headers })
          if (response.body !== null) {
            const reader = response.body.getReader()
            const decoder = new TextDecoder('utf-8')
            try {
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                const chunk = decoder.decode(value, { stream: true })
                if (chunk !== '') send({ id, type: 'chunk', chunk })
              }
              // flush 解码器里剩的半个多字节字符（如果有）。
              const tail = decoder.decode()
              if (tail !== '') send({ id, type: 'chunk', chunk: tail })
            } finally {
              try {
                reader.releaseLock()
              } catch {
                /* reader 已不可用，忽略 */
              }
            }
          }
          send({ id, type: 'end', status: response.status, headers })
        } catch (error) {
          let message = error instanceof Error ? error.message : 'HTTP 流式请求失败'
          if (controller.signal.aborted && controller.signal.reason === 'aborted') message = 'aborted'
          else if (timedOut) message = `请求超时（${options.timeoutMs} ms）`
          send({ id, type: 'error', message })
        } finally {
          clearTimeout(timer)
          httpStreams.delete(id)
        }
      })()

      return { id }
    })

    /**
     * 中止一条流式请求。
     *
     * 语义：调用 controller.abort('aborted')，正在读的流会走 catch，向窗口补发
     * 一条 `{ id, type: 'error', message: 'aborted' }` 后清掉 map 条目。未知 id
     * 返回 false，不报错。
     */
    trustedHandle('http:stream:abort', (_event, id: unknown) => {
      if (typeof id !== 'string' || id === '') return false
      const controller = httpStreams.get(id)
      if (controller === undefined) return false
      controller.abort('aborted')
      return true
    })

    /*
     * 读凭证：返回 `{ value, status }` 而不是裸字符串。
     *
     * 只回 `string | null` 的话，「读失败」和「没配置」在渲染层无法区分，上层只能
     * 猜 —— 猜错的代价是把用户还能恢复的密文覆盖掉。status 的三种取值见
     * secure-store.ts（读/写/迁移的完整逻辑都在那边，有单测）。
     */
    trustedHandle('secure:get', async () => readSecureValue(safeStorageLike, secureFile()))
    trustedHandle('secure:set', async (_event, value: string) => {
      if (typeof value !== 'string') throw new Error('secure:set 需要一个字符串')
      // 加密不可用时 encryptValue 抛在写盘之前，原密文不受影响。
      writeSecureValue(safeStorageLike, secureFile(), value)
    })
    trustedHandle('secure:remove', async () => removeSecureValue(secureFile()))
    trustedHandle('webchat:open', (_event, css: string, js: string) => {
      openWebChat(
        typeof css === 'string' ? css.slice(0, 200_000) : '',
        typeof js === 'string' ? js.slice(0, 200_000) : '',
      )
    })

    /* ---------------- 网页账号模式（不填 Key，用网页登录态） ---------------- */

    /** 把一段话交给网页窗发送。返回是否成功，失败时给一句人话。 */
    trustedHandle('webchat:send', async (_event, text: string) => {
      const win = await ensureWebChatWindow()
      if (win === null) return { ok: false, error: 'no-window' }
      const payload = typeof text === 'string' ? text.slice(0, 200_000) : ''
      try {
        const ok = await win.webContents.executeJavaScript(
          `(function(){
            var r = window.__deepseaRelay;
            if (!r) return 'no-relay';
            if (typeof r.send !== 'function') return 'no-send';
            return r.send(${JSON.stringify(payload)}) === true ? 'ok' : 'failed';
          })();`,
          true,
        ) as string
        if (ok === 'ok') return { ok: true }
        if (ok === 'no-relay' || ok === 'no-send') return { ok: false, error: '网页还没准备好，稍等一下再发' }
        return { ok: false, error: '没找到对话框，先在这个窗口里打开一段对话' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '网页那边出错了' }
      }
    })

    /** 读当前这条回复的进度。网页窗不在就返回 null。 */
    trustedHandle('webchat:state', async () => {
      const win = liveWebChatWindow()
      if (win === null) return null
      try {
        return await win.webContents.executeJavaScript(
          `(function(){
            var r = window.__deepseaRelay;
            if (!r || typeof r.getState !== 'function') return null;
            return r.getState();
          })();`,
          true,
        ) as { busy: boolean; text: string; reasoning?: string; done: boolean; error?: string } | null
      } catch {
        return null
      }
    })

    /** 写入人设/记忆前缀（用户改了助手设定后会再调一次，保持同步）。 */
    trustedHandle('webchat:context', async (_event, text: string) => {
      const win = liveWebChatWindow()
      if (win === null) return
      const payload = typeof text === 'string' ? text.slice(0, 60_000) : ''
      try {
        await win.webContents.executeJavaScript(
          `(function(){
            var r = window.__deepseaRelay;
            if (r && typeof r.setContext === 'function') r.setContext(${JSON.stringify(payload)});
          })();`,
          true,
        )
      } catch {
        /* 页面还没准备好就算了，下次发送前会再同步 */
      }
    })

    /** 把隐藏的网页窗叫出来，让用户去登录。 */
    trustedHandle('webchat:show', async () => {
      const win = await ensureWebChatWindow()
      if (win === null) return
      win.show()
      win.focus()
    })

    /* ---------------- 网页账号·纯 HTTP 模式 ----------------
     *
     * DOM 遥控要求网页窗一直开着，用户关掉窗口回话就断。纯 HTTP 模式改成：
     * 登录态（localStorage.userToken + 分区 Cookie）采集一次存盘，之后聊天
     * 由主进程直接调 chat.deepseek.com 的内部接口，窗口关不关都行。
     * 协议参考 sums001/Deepseek-API 与 LLM-Red-Team/deepseek-free-api。
     */

    /**
     * 登录：打开网页窗，等用户登进去，然后把登录态采集下来。
     *
     * 关键在「等」：用户可能要先扫码/输密码，甚至过一道人机校验。以前一开窗
     * 就采集，必然拿到空 token，于是永远显示「还没登录」。
     * 这里改成轮询窗口里的 localStorage.userToken，出现即采集，再验证一次。
     */
    trustedHandle('webapi:login', async () => {
      const win = await ensureWebChatWindow()
      if (win === null) return { ok: false, error: 'no-window' }
      win.show()
      win.focus()

      const deadline = Date.now() + LOGIN_TIMEOUT_MS
      while (Date.now() < deadline) {
        // 注意：这里**不 catch**。`save()` 的「双重清理失败」是
        // SessionRemoveError，必须原样抛出去变成 IPC rejection ——
        // 一旦在这里转成 `{ ok: false }` 的正常返回，调用方很容易只判 ok 后
        // 当成普通失败处理，界面就会误报「已清除」。
        const captured = await captureSessionFromWindow(win)
        if (captured !== null) {
          // 存不下来就别假装登录成功：内存已经回滚，这里如实告诉用户原因，
          // 否则重启后会莫名其妙回到旧账号。
          if (!captured.persist.ok) {
            return { ok: false, error: persistFailureText(captured.persist) }
          }
          // 验证 token 真的能用，避免存下一个过期的登录态。
          const verified = await verifySession()
          if (verified.ok) {
            // 登录完成就把窗口藏起来：之后聊天不再需要它。
            win.hide()
            return { ok: true }
          }
          // 网络问题不能说明 token 无效：别把刚采集到的登录态删了，
          // 直接把原因回给用户，让他去查代理。
          if (verified.reason !== undefined && /连不上|网络|SSL|TLS/i.test(verified.reason)) {
            return { ok: false, error: verified.reason }
          }
          forgetWebSession()
        }
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
      return { ok: false, error: '登录超时了；请重试一次' }
    })

    /**
     * 自检：登录态 / 接口 / PoW 分别探一遍，返回给设置页显示。
     *
     * 顺带把「登录态迁移失败」这类没有独立 UI 入口的问题带出去 —— 否则用户只会
     * 看到「未登录」，却不知道盘上那份旧明文还没升级成功。
     */
    trustedHandle('webapi:diagnose', async () => {
      const result = await diagnose()
      const issue = takeWebSessionIssue()
      if (issue !== null) result.notes.push(`网页登录态：${issue.message}`)
      return result
    })

    /** 本机是否已经有可用的网页登录态。 */
    trustedHandle('webapi:has-session', async () => {
      if (!hasWebSession()) return false
      // 有存档也要确认没过期，否则用户会看到一堆莫名失败。
      const verified = await verifySession()
      return verified.ok
    })

    /** 从网页窗采集登录态（用户登录完由渲染进程调）。 */
    trustedHandle('webapi:capture', async () => {
      const win = liveWebChatWindow()
      if (win === null) return { ok: false, error: 'no-window' }
      // 同样不 catch：失败以 IPC rejection 传出去，由前端 .catch() 显示。
      const captured = await captureSessionFromWindow(win)
      if (captured === null) return { ok: false, error: '还没登录：窗口里没有 userToken' }
      if (!captured.persist.ok) {
        return { ok: false, error: persistFailureText(captured.persist) }
      }
      return { ok: true }
    })

    /**
     * 忘掉登录态（登出/过期后重新引导）。
     *
     * 删除失败**不吞**：直接让 IPC 以 rejection 返回，调用方必须处理。
     * 这里绝不返回「已清除」之类的成功信号。
     */
    trustedHandle('webapi:forget', () => {
      forgetWebSession()
    })

    /**
     * 发一条消息并流式回推。
     *
     * 渲染进程不轮询：主进程通过 `webchat:delta` 事件把文本/思考增量推回来，
     * `webchat:done` 表示结束（带最终文本与错误）。conversationKey 是 App 对话
     * 的 id，用来把 App 对话映射到网页线程（chat_session_id）。
     */
    trustedHandle(
      'webapi:send',
      async (event, conversationKey: string, prompt: string, thinking: boolean, systemPrompt: string, refFileIds: unknown) => {
        const push = (channel: string, payload: Record<string, unknown>): void => {
          if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
        }
        const files = Array.isArray(refFileIds)
          ? refFileIds.filter((id): id is string => typeof id === 'string' && id !== '')
          : []
        try {
          const result = await webSend({
            conversationKey: typeof conversationKey === 'string' ? conversationKey : 'default',
            prompt: typeof prompt === 'string' ? prompt.slice(0, 200_000) : '',
            // 人设 + 常驻记忆的稳定块：只在网页线程首轮（或它真的变了之后）拼进去。
            // 上层只传稳定块，所以正常情况下除了首轮都不会重拼。
            systemPrompt: typeof systemPrompt === 'string' ? systemPrompt.slice(0, 60_000) : '',
            thinking: thinking === true,
            refFileIds: files,
            onText: (delta) => push('webchat:delta', { kind: 'text', delta }),
            onReasoning: (delta) => push('webchat:delta', { kind: 'reasoning', delta }),
          })
          push('webchat:done', { text: result.text, reasoning: result.reasoning, threadCreated: result.threadCreated })
          return { ok: true }
        } catch (error) {
          const kind = error instanceof WebApiError ? error.kind : 'http'
          const message = error instanceof Error ? error.message : '网页接口出错'
          push('webchat:done', { text: '', reasoning: '', error: message, kind })
          return { ok: false, error: message, kind }
        }
      },
    )

    /** 上传一个附件（data URL）到网页账号，返回 file_id。 */
    trustedHandle('webapi:upload', async (_event, dataUrl: string, filename: string) => {
      if (typeof dataUrl !== 'string' || dataUrl === '') return { ok: false, error: '附件为空' }
      try {
        const fileId = await uploadWebFile(dataUrl, typeof filename === 'string' ? filename : 'image.png')
        return { ok: true, fileId }
      } catch (error) {
        const message = error instanceof Error ? error.message : '上传失败'
        return { ok: false, error: message }
      }
    })

    /** 中断一次进行中的网页请求（用户点了停止）。 */
    trustedHandle('webapi:abort', () => {
      abortWebSend()
    })
    trustedHandle('file:save', async (_event, name: string, content: string) => {
      if (mainWindow === null) return false
      // 测试/自动化用：设了 DEEPSEA_TEST_SAVE_PATH 就直接写盘，不弹对话框。
      // 原生对话框会阻塞渲染进程，无头测试没法应答它。
      const testPath = process.env.DEEPSEA_TEST_SAVE_PATH
      if (typeof testPath === 'string' && testPath !== '') {
        try {
          mkdirSync(dirname(testPath), { recursive: true })
          writeFileSync(testPath, content, 'utf8')
          return true
        } catch {
          return false
        }
      }
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: name,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'HTML', extensions: ['html'] },
          { name: 'JSON', extensions: ['json'] },
          { name: 'Text', extensions: ['txt'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (result.canceled || result.filePath === undefined) return false
      writeFileSync(result.filePath, content, 'utf8')
      return true
    })
    /**
     * 保存图片（二进制）。
     *
     * 不能复用上面的 file:save：那条是 `writeFileSync(content, 'utf8')`，把 base64
     * 原样当文本写，产出一个「扩展名是 .jpg 的文本文件」，双击打不开、还提示保存成功。
     * 所以这里收**已经剥掉 `data:...;base64,` 前缀的纯 base64**，用 Buffer 写成真字节。
     */
    trustedHandle('file:saveImage', async (_event, name: string, base64: string) => {
      if (mainWindow === null) return false
      if (typeof base64 !== 'string' || base64 === '') return false
      // 测试/自动化用：设了 DEEPSEA_TEST_SAVE_IMAGE_PATH 就直接写盘，不弹对话框。
      const testPath = process.env.DEEPSEA_TEST_SAVE_IMAGE_PATH
      if (typeof testPath === 'string' && testPath !== '') {
        try {
          mkdirSync(dirname(testPath), { recursive: true })
          writeFileSync(testPath, Buffer.from(base64, 'base64'))
          return true
        } catch {
          return false
        }
      }
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: name,
        filters: [
          { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (result.canceled || result.filePath === undefined) return false
      try {
        writeFileSync(result.filePath, Buffer.from(base64, 'base64'))
        return true
      } catch {
        return false
      }
    })
    trustedHandle('file:open', async (_event, accept: string) => {
      if (mainWindow === null) return null
      // 测试/自动化用：直接读这个路径，不弹对话框。
      const testPath = process.env.DEEPSEA_TEST_OPEN_PATH
      if (typeof testPath === 'string' && testPath !== '') {
        try {
          return readFileSync(testPath, 'utf8')
        } catch {
          return null
        }
      }
      // accept 传进来是 ".json,application/json" 这样的串，这里只取扩展名。
      const extensions = (typeof accept === 'string' ? accept : '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.startsWith('.') && part.length > 1)
        .map((part) => part.slice(1))
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
          { name: '备份 / Backup', extensions: extensions.length > 0 ? extensions : ['json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      const filePath = result.filePaths[0]
      if (result.canceled || filePath === undefined) return null
      try {
        return readFileSync(filePath, 'utf8')
      } catch {
        return null
      }
    })
    trustedHandle('open:external', (_event, url: string) => {
      openExternal(url)
    })
    // MCP stdio：本地 MCP 服务器由主进程代跑，渲染进程只发请求。
    trustedHandle('mcp:stdio:request', async (_event, command: string, args: string[], request: { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> }, timeoutMs: number) => {
      return requestStdio(command, args, request, typeof timeoutMs === 'number' ? timeoutMs : 30_000)
    })
    trustedHandle('mcp:stdio:notify', (_event, command: string, args: string[], message: { jsonrpc: '2.0'; method: string; params?: Record<string, unknown> }) => {
      notifyStdio(command, args, message)
    })
    trustedHandle('mcp:stdio:close', (_event, command: string, args: string[]) => {
      closeStdio(command, args)
    })
    await createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 退出前把本地 MCP 子进程都收掉，别留孤儿。
  app.on('before-quit', () => {
    closeAllStdio()
  })
}
