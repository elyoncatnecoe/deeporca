/**
 * DeepSeek 网页账号的纯 HTTP 客户端（Electron 主进程）。
 *
 * 登录态从网页窗的 localStorage.userToken 读一次（分区 persist:deepseek 持久化），
 * 存到本地文件；之后聊天完全不依赖窗口，窗口关不关都行。
 *
 * 协议要点（照 chat.deepseek.com 自己的网页客户端来）：
 *   1. POST /api/v0/chat_session/create            建会话，拿 chat_session_id
 *   2. POST /api/v0/chat/create_pow_challenge      拿工作量证明挑战
 *   3. 本地解 DeepSeekHashV1（纯 JS，见 pow.ts）     → x-ds-pow-response 头
 *   4. POST /api/v0/chat/completion                发消息，回 text/event-stream
 *   5. 状态 INCOMPLETE 时接 /chat/continue 续写；
 *      空回复时接 /chat/resume_stream 重读（这两条不要 PoW）
 *
 * 之前的实现有三处致命错误，都已修正：
 *   - PoW 去下载厂商的 wasm 再按 wasm-bindgen ABI 调 wasm_solve —— 依赖 CDN 域名，
 *     网络一挡就全断；其实 DeepSeekHashV1 纯 JS 就能算。
 *   - 只看 response.ok 就往下走，没有按 text/event-stream 解析 SSE 的 event/close。
 *   - 请求体里塞了 model_type（只有新会话才该带），且缺 x-client-timezone-offset。
 *
 * 协议参考 volcanicll/magpie-deepseek-web-auth（MIT）。
 */

import { session as electronSession, app, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { PatchReader, iterSse } from './sse'
import { powHeader, solvePow, type PowChallenge } from './pow'
import { decidePersona } from '../src/lib/web-persona-state'

const CHAT_ORIGIN = 'https://chat.deepseek.com'
const COMPLETION_PATH = '/api/v0/chat/completion'
const CONTINUE_PATH = '/api/v0/chat/continue'
const RESUME_PATH = '/api/v0/chat/resume_stream'
const SESSION_CREATE_PATH = '/api/v0/chat_session/create'
const POW_CHALLENGE_PATH = '/api/v0/chat/create_pow_challenge'
const UPLOAD_PATH = '/api/v0/file/upload_file'
const FETCH_FILES_PATH = '/api/v0/file/fetch_files'
const WEB_PARTITION = 'persist:deepseek'
/** 网页客户端版本号，跟页面一致。 */
const APP_VERSION = '2.0.0'
/** 续写次数上限，避免 INCOMPLETE 循环把一轮挂死。 */
const MAX_CONTINUES = 20

function sessionFile(): string {
  return join(app.getPath('userData'), 'deepseek-web-session.json')
}

function threadsFile(): string {
  return join(app.getPath('userData'), 'deepseek-web-threads.json')
}

export interface WebSession {
  token: string
  userAgent: string
  savedAt: number
}

export class WebApiError extends Error {
  readonly kind: 'no-session' | 'expired' | 'http' | 'pow' | 'aborted' | 'network'
  constructor(kind: WebApiError['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}

/* ------------------------------------------------------------------ */
/* 登录态                                                              */
/* ------------------------------------------------------------------ */

let cachedSession: WebSession | null = null

function loadSession(): WebSession | null {
  if (cachedSession !== null) return cachedSession
  try {
    const parsed = JSON.parse(readFileSync(sessionFile(), 'utf8')) as WebSession
    if (typeof parsed.token === 'string' && parsed.token !== '') cachedSession = parsed
  } catch {
    /* 没有存档是正常状态 */
  }
  return cachedSession
}

function saveSession(next: WebSession): void {
  cachedSession = next
  try {
    mkdirSync(dirname(sessionFile()), { recursive: true })
    writeFileSync(sessionFile(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* 写不进去就只用内存里的 */
  }
}

export function hasWebSession(): boolean {
  return loadSession() !== null
}

export function forgetWebSession(): void {
  cachedSession = null
  try {
    writeFileSync(sessionFile(), '', 'utf8')
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 从网页窗采集登录态                                                  */
/* ------------------------------------------------------------------ */

/** 网页把 token 存在 localStorage.userToken 里，形状是 {"value":"<TOKEN>"}。 */
const READ_TOKEN_JS = `(() => {
  try {
    var raw = window.localStorage.getItem('userToken');
    if (!raw) return null;
    var o = JSON.parse(raw);
    return (o && o.value) ? o.value : null;
  } catch (e) { return null; }
})()`

export async function captureSessionFromWindow(win: BrowserWindow): Promise<WebSession | null> {
  const token = await win.webContents
    .executeJavaScript(READ_TOKEN_JS, true)
    .catch(() => null) as string | null
  if (token === null || token === '') return null
  const userAgent = await win.webContents
    .executeJavaScript('navigator.userAgent', true)
    .catch(() => '') as string
  const next: WebSession = {
    token,
    userAgent: userAgent !== '' ? userAgent : 'Mozilla/5.0',
    savedAt: Date.now(),
  }
  saveSession(next)
  return next
}

/* ------------------------------------------------------------------ */
/* HTTP 底座                                                           */
/* ------------------------------------------------------------------ */

function baseHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: '*/*',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    origin: CHAT_ORIGIN,
    referer: `${CHAT_ORIGIN}/a/chat/`,
    'x-client-platform': 'web',
    'x-client-version': APP_VERSION,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset()),
    'user-agent': loadSession()?.userAgent ?? 'Mozilla/5.0',
    ...extra,
  }
}

/**
 * 走 persist:deepseek 分区的 cookie jar（含 httpOnly 与 WAF cookie）。
 *
 * 关键点：Electron 的 `net.fetch` 只会用 defaultSession，`init.session` 不是合法选项
 * （传了也会被忽略）。要带分区 cookie，必须显式调 `session.fromPartition(...).fetch()`。
 * 之前用 net.fetch + session 选项，等于压根没带上网页登录的 httpOnly / WAF cookie，
 * 服务端经常回 403，然后被下面的逻辑误判成「登录过期」——这是「反复要求重新登录」的头号原因。
 */
async function rawFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await electronSession.fromPartition(WEB_PARTITION).fetch(url, {
      ...init,
      credentials: 'include',
    } as RequestInit)
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    throw new WebApiError('network', `连不上 chat.deepseek.com：${raw.slice(0, 140)}`)
  }
}

/**
 * 统一处理鉴权状态码。
 *
 * 只有 401 才代表「登录真的过期」；403 多半是 WAF 风控、限频或接口拒绝，
 * 这时候清登录态会让用户被反复踢回登录页、越登越坏（和上面的 cookie 问题是叠加的）。
 */
function throwForAuth(response: Response): void {
  if (response.status === 401) {
    forgetWebSession()
    throw new WebApiError('expired', '网页登录过期了，请重新登录一次')
  }
  if (response.status === 403) {
    throw new WebApiError(
      'http',
      'DeepSeek 拒绝了这个请求（403），多半是风控或限频。稍等一两分钟再试；先不用重新登录。',
    )
  }
}

/**
 * 解开 DeepSeek 的信封 {code, msg, data:{biz_code, biz_msg, biz_data}}。
 * `allow` 里的 biz_code 视为成功（例如续写流一次性返回整条消息时是 22）。
 */
function envelope(value: unknown, what: string, allow: number[] = []): Record<string, unknown> | null {
  const record = value as { code?: number; msg?: string; data?: { biz_code?: number; biz_msg?: string; biz_data?: unknown } } | null
  if (record === null || typeof record !== 'object') throw new WebApiError('http', `DeepSeek ${what}：返回格式不对`)
  const code = record.data?.biz_code ?? record.code
  const message = record.data?.biz_msg ?? record.msg ?? ''
  const ok = code === undefined || code === null || code === 0 || allow.includes(Number(code))
  if (!ok) throw new WebApiError('http', `DeepSeek ${what} 拒绝（${String(code)}）：${message || '没给原因'}`)
  return (record.data?.biz_data ?? null) as Record<string, unknown> | null
}

async function postJson(
  path: string,
  body: unknown,
  options: { pow?: string; signal?: AbortSignal; what?: string; allow?: number[] } = {},
): Promise<{ response: Response; biz: Record<string, unknown> | null }> {
  const current = loadSession()
  if (current === null) throw new WebApiError('no-session', '还没有登录网页账号')
  const extra: Record<string, string> = {}
  if (options.pow !== undefined) extra['x-ds-pow-response'] = options.pow

  const response = await rawFetch(CHAT_ORIGIN + path, {
    method: 'POST',
    headers: baseHeaders(current.token, extra),
    body: JSON.stringify(body ?? {}),
    signal: options.signal,
  })
  if (response.status === 401 || response.status === 403) throwForAuth(response)
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 180)
    throw new WebApiError('http', `DeepSeek 返回 ${response.status}：${detail}`)
  }
  // 流式接口不走这里，调用方自己判断 content-type。
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new WebApiError('http', `DeepSeek 返回的不是 JSON：${text.slice(0, 180)}`)
    }
    return { response, biz: envelope(parsed, options.what ?? path, options.allow ?? []) }
  }
  return { response, biz: null }
}

/* ------------------------------------------------------------------ */
/* PoW                                                                 */
/* ------------------------------------------------------------------ */

async function fetchChallenge(targetPath: string, signal?: AbortSignal): Promise<PowChallenge> {
  const { biz } = await postJson(
    POW_CHALLENGE_PATH,
    { target_path: targetPath },
    { signal, what: '工作量证明挑战' },
  )
  const challenge = biz?.challenge as Record<string, unknown> | undefined
  if (challenge === undefined || typeof challenge.challenge !== 'string') {
    throw new WebApiError('pow', 'DeepSeek 没返回 PoW 挑战')
  }
  return {
    algorithm: String(challenge.algorithm ?? ''),
    challenge: String(challenge.challenge),
    salt: String(challenge.salt ?? ''),
    difficulty: Number(challenge.difficulty ?? 0),
    expireAt: Number(challenge.expire_at ?? 0),
    signature: String(challenge.signature ?? ''),
    targetPath: String(challenge.target_path ?? targetPath),
  }
}

/** 拿挑战 → 本地解 → 拼头。 */
async function makePow(targetPath: string, signal?: AbortSignal): Promise<string> {
  const challenge = await fetchChallenge(targetPath, signal)
  try {
    const answer = await solvePowAsync(challenge)
    return powHeader(challenge, answer, targetPath)
  } catch (error) {
    throw new WebApiError('pow', error instanceof Error ? error.message : 'PoW 解不出来')
  }
}

/* ------------------------------------------------------------------ */
/* PoW 解算：放 worker 里，别堵主进程                                    */
/* ------------------------------------------------------------------ */

/**
 * 解一道挑战，在 worker 线程里跑。
 *
 * 实测 14 万难度约 5 秒，同步跑会把主进程事件循环堵死（窗口不响应、IPC 停摆），
 * 用户感觉就是「发一条消息整个 App 卡住」。所以必须挪出去。
 *
 * worker 起不来（打包路径不对等）时退回同步解算——宁可卡一下，也不能发不出消息。
 */
let worker: Worker | null = null
let workerSeq = 0
/** worker 脚本文件本身找不到（或构造直接抛错）才永久标记失败——这种情况重试也没用。 */
let workerBroken = false
/** 临时故障（超时 / 运行期 error / exit）后的冷却截止时间；冷却结束就允许再试一次 worker。 */
let workerRetryAt = 0
/** 等 worker 回复的下限；真实上限按题目难度估算（见 workerTimeoutMs），避免大难度被误杀。 */
const WORKER_TIMEOUT_FLOOR_MS = 60_000
const WORKER_TIMEOUT_CAP_MS = 300_000
const WORKER_COOLDOWN_MS = 60_000
const workerPending = new Map<number, { resolve: (n: number) => void; reject: (e: Error) => void }>()

/** 按难度估算等待上限：实测约 2.5 万 nonce/秒，留 3 倍余量，再夹到上下限。 */
function workerTimeoutMs(difficulty: number): number {
  const estimate = Math.ceil(difficulty / 25_000) * 1000 * 3
  return Math.min(WORKER_TIMEOUT_CAP_MS, Math.max(WORKER_TIMEOUT_FLOOR_MS, estimate))
}

function ensureWorker(): Worker | null {
  if (worker !== null) return worker
  if (workerBroken) return null
  if (Date.now() < workerRetryAt) return null
  try {
    // worker 脚本必须能从磁盘读到：asar 内的 JS 用 worker_threads 加载不可靠
    // （那条路径走 Node 原生 fs，asar 补丁不一定生效）。所以 package.json 里
    // 用 asarUnpack 把它解到 app.asar.unpacked，这里优先用解包后的真实路径。
    const workerPath = resolveWorkerPath()
    if (workerPath === null) {
      workerBroken = true
      return null
    }
    worker = new Worker(workerPath)
    worker.on('message', (message: { id: number; ok: boolean; answer?: number; error?: string }) => {
      const pending = workerPending.get(message.id)
      if (pending === undefined) return
      workerPending.delete(message.id)
      if (message.ok && typeof message.answer === 'number') pending.resolve(message.answer)
      else pending.reject(new Error(message.error ?? 'PoW 解算失败'))
    })
    worker.on('error', (error) => {
      // 运行期异常可能是临时的（机器瞬时问题等）：进入冷却，冷却后可重试，
      // 不能永久判死——否则之后每条消息都退化成主线程解 PoW，界面分钟级冻结。
      workerRetryAt = Date.now() + WORKER_COOLDOWN_MS
      for (const pending of workerPending.values()) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
      workerPending.clear()
      worker = null
    })
    worker.on('exit', (code) => {
      // 没走 error 的静默退出也要放行等待中的请求，否则要干等到超时才回落同步解算。
      workerRetryAt = Date.now() + WORKER_COOLDOWN_MS
      for (const pending of workerPending.values()) {
        pending.reject(new Error(`PoW worker 异常退出（code ${String(code)}）`))
      }
      workerPending.clear()
      worker = null
    })
    worker.unref()
    return worker
  } catch {
    workerRetryAt = Date.now() + WORKER_COOLDOWN_MS
    worker = null
    return null
  }
}

/** 找到 worker 脚本的真实磁盘路径：优先解包目录，其次同目录（开发态）。 */
function resolveWorkerPath(): string | null {
  const beside = join(__dirname, 'pow-worker.cjs')
  // 打包后 __dirname 是 .../resources/app.asar/electron-dist，
  // asarUnpack 会把文件放到 .../resources/app.asar.unpacked/electron-dist。
  const unpacked = beside.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  for (const candidate of [unpacked, beside]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function solvePowAsync(challenge: PowChallenge): Promise<number> {
  const active = ensureWorker()
  if (active === null) {
    // 兜底：没有 worker 就在当前线程解，至少功能可用。
    return solvePow(challenge)
  }
  workerSeq += 1
  const id = workerSeq
  const answer = await new Promise<number | null>((resolve) => {
    workerPending.set(id, {
      resolve: (value) => resolve(value),
      reject: () => resolve(null),
    })
    active.postMessage({ id, challenge })
    // worker 可能已经死了但还没报错。超时按难度估算，超了就进入冷却、回退同步解算。
    const timer = setTimeout(() => {
      if (!workerPending.has(id)) return
      workerPending.delete(id)
      // 超时是临时故障：冷却后可再试，不永久判死。
      workerRetryAt = Date.now() + WORKER_COOLDOWN_MS
      try {
        worker?.terminate()
      } catch {
        /* 忽略 */
      }
      worker = null
      resolve(null)
    }, workerTimeoutMs(challenge.difficulty))
    timer.unref?.()
  })
  if (answer === null) return solvePow(challenge)
  return answer
}

/* ------------------------------------------------------------------ */
/* 对话线程                                                            */
/* ------------------------------------------------------------------ */

interface WebThread {
  sid: string
  mid: number | null
  /** 已经拼进 prompt 的人设稳定块；内容没变就不再重拼。 */
  persona: string
}

const threadMap = new Map<string, WebThread>()

function loadThreads(): void {
  if (threadMap.size > 0) return
  try {
    const parsed = JSON.parse(readFileSync(threadsFile(), 'utf8')) as Record<string, Partial<WebThread>>
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== 'object' || typeof value.sid !== 'string' || value.sid === '') continue
      threadMap.set(key, {
        sid: value.sid,
        mid: typeof value.mid === 'number' ? value.mid : null,
        persona: typeof value.persona === 'string' ? value.persona : '',
      })
    }
  } catch {
    /* 没有存档就从头开始 */
  }
}

function saveThreads(): void {
  try {
    mkdirSync(dirname(threadsFile()), { recursive: true })
    const obj: Record<string, WebThread> = {}
    for (const [key, value] of threadMap.entries()) obj[key] = value
    writeFileSync(threadsFile(), JSON.stringify(obj, null, 2), 'utf8')
  } catch {
    /* 忽略 */
  }
}

/**
 * 把所有线程「这一版人设已经拼过」的标记清掉（并落盘）。
 *
 * 助手被关掉时调用：那一刻渲染层推下来的是空人设，不注入是对的，但**缓存必须一起清**。
 * 否则用户再打开同一个助手、人设内容一个字都没变，去重会认为「A 已经拼过」而永远跳过，
 * 网页那边就一直用关掉之前的旧设定说话。
 *
 * 只动 `persona` 这一个字段：sid / mid / 历史消息一律保留 —— 清标记不等于撤回旧消息，
 * 已经发进网页会话里的设定本来就撤不回来。
 */
export function clearPersonaCache(): void {
  loadThreads()
  let changed = false
  for (const thread of threadMap.values()) {
    if (thread.persona === '') continue
    thread.persona = ''
    changed = true
  }
  if (changed) saveThreads()
}

export function forgetThread(conversationKey: string): void {
  threadMap.delete(conversationKey)
  saveThreads()
}

async function createSession(signal?: AbortSignal): Promise<string> {
  const { biz } = await postJson(SESSION_CREATE_PATH, {}, { signal, what: '建会话' })
  const id = (biz?.chat_session as Record<string, unknown> | undefined)?.id ?? biz?.id
  if (id === undefined || id === null || String(id) === '') {
    throw new WebApiError('http', 'DeepSeek 没返回会话 id')
  }
  return String(id)
}

/* ------------------------------------------------------------------ */
/* 发消息                                                              */
/* ------------------------------------------------------------------ */

export interface WebSendOptions {
  conversationKey: string
  prompt: string
  /** 人设 + 常驻记忆的稳定块。只在首轮或它真的变了之后拼进 prompt。 */
  systemPrompt?: string
  thinking: boolean
  /** 已经上传到网页账号的附件 id；放进 completion 的 ref_file_ids。 */
  refFileIds?: string[]
  signal?: AbortSignal
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
}

export interface WebSendResult {
  threadCreated: boolean
  text: string
  reasoning: string
}

/* ------------------------------------------------------------------ */
/* 附件上传                                                            */
/* ------------------------------------------------------------------ */

/** data URL → 字节。渲染层已经把图片压成 data URL，这里只负责解码。 */
function decodeDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new WebApiError('http', '附件格式不对（不是 data URL）')
  const meta = dataUrl.slice(0, comma)
  if (!meta.includes(';base64')) throw new WebApiError('http', '附件不是 base64 编码，暂时不支持')
  return Buffer.from(dataUrl.slice(comma + 1), 'base64')
}

/**
 * 上传一个附件到网页账号，返回 file_id（已等到服务端处理成功）。
 *
 * 流程（照 chat.deepseek.com 网页客户端）：
 *   1. POST /api/v0/file/upload_file（multipart，带 PoW）
 *   2. 轮询 GET /api/v0/file/fetch_files?file_ids=… 直到 status=SUCCESS
 * 拿到的 file_id 再放进 completion 的 ref_file_ids。
 */
export async function uploadWebFile(dataUrl: string, filename: string, signal?: AbortSignal): Promise<string> {
  const current = loadSession()
  if (current === null) throw new WebApiError('no-session', '还没有登录网页账号')
  const bytes = decodeDataUrl(dataUrl)
  const pow = await makePow(UPLOAD_PATH, signal)
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2)
  const CRLF = '\r\n'
  const safeName = (filename !== '' ? filename : 'image.png').replace(/["\r\n]/g, '_')
  const header =
    `--${boundary}${CRLF}`
    + `Content-Disposition: form-data; name="file"; filename="${safeName}"${CRLF}`
    + `Content-Type: application/octet-stream${CRLF}${CRLF}`
  const footer = `${CRLF}--${boundary}--${CRLF}`
  const body = Buffer.concat([Buffer.from(header, 'utf8'), bytes, Buffer.from(footer, 'utf8')])

  const response = await rawFetch(CHAT_ORIGIN + UPLOAD_PATH, {
    method: 'POST',
    headers: baseHeaders(current.token, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-ds-pow-response': pow,
      'x-file-size': String(bytes.length),
      'x-model-type': 'default',
      'x-thinking-enabled': '0',
    }),
    body,
    signal,
  } as RequestInit)
  if (response.status === 401 || response.status === 403) throwForAuth(response)
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 180)
    throw new WebApiError('http', `上传返回 ${response.status}：${detail}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.text())
  } catch {
    throw new WebApiError('http', '上传返回的不是 JSON')
  }
  const bizData = envelope(parsed, '上传文件')
  const fileId = bizData?.id
  if (fileId === undefined || fileId === null || String(fileId) === '') {
    throw new WebApiError('http', '上传没返回 file_id')
  }
  return pollWebFile(current.token, String(fileId), signal)
}

async function pollWebFile(token: string, fileId: string, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (signal?.aborted === true) throw new WebApiError('aborted', '已停止')
    const response = await rawFetch(
      CHAT_ORIGIN + `${FETCH_FILES_PATH}?file_ids=${encodeURIComponent(fileId)}`,
      { method: 'GET', headers: baseHeaders(token), signal } as RequestInit,
    )
    if (response.status === 401 || response.status === 403) throwForAuth(response)
    if (!response.ok) throw new WebApiError('http', `查询文件返回 ${response.status}`)
    let parsed: unknown
    try {
      parsed = JSON.parse(await response.text())
    } catch {
      throw new WebApiError('http', '查询文件返回的不是 JSON')
    }
    const bizData = envelope(parsed, '查询文件')
    const files = bizData?.files
    const first = Array.isArray(files) ? (files[0] as Record<string, unknown> | undefined) : undefined
    if (first === undefined) throw new WebApiError('http', '文件查询结果为空')
    const status = String(first.status ?? '')
    if (status === 'SUCCESS') return fileId
    if (status === 'ERROR' || first.error_code !== undefined) {
      throw new WebApiError('http', `文件处理失败：${String(first.error_code ?? '')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new WebApiError('http', '文件处理超时')
}

let activeController: AbortController | null = null

export function abortWebSend(): void {
  activeController?.abort()
}

/**
 * 一轮发送的总时限。
 *
 * 服务端偶尔会把连接吊着不回（流不 close、也不发 FINISHED），没有上限的话
 * 这个请求就永远挂着：主进程的资源不释放，渲染层的看门狗又先报「太久没回」，
 * 两边状态就对不上了。给个总时限，到点自己掐掉。
 */
const SEND_TIMEOUT_MS = 300_000

export async function webSend(options: WebSendOptions): Promise<WebSendResult> {
  const controller = new AbortController()
  activeController = controller
  const onOuterAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  // 总时限：超时也走 abort，让 fetch 和流读取一起停下来。
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
  try {
    return await webSendInner(options, controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      // 分清「用户主动停止」和「超时」：提示语不一样。
      throw new WebApiError('aborted', options.signal?.aborted === true ? '已停止' : '网页那边太久没回，先断了')
    }
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onOuterAbort)
    if (activeController === controller) activeController = null
  }
}

async function webSendInner(options: WebSendOptions, signal: AbortSignal): Promise<WebSendResult> {
  loadThreads()
  const existing = threadMap.get(options.conversationKey)
  const threadCreated = existing === undefined

  let thread: WebThread
  if (existing === undefined) {
    thread = { sid: await createSession(signal), mid: null, persona: '' }
    threadMap.set(options.conversationKey, thread)
    saveThreads()
  } else {
    thread = existing
  }

  // 人设只在这段对话的第一轮（或人设/记忆真的改过之后）拼一次：
  // 网页线程自己记得上下文，每轮重复灌既浪费上下文，网页那边看着也难看。
  //
  // 判据是「和上次拼进去的是不是同一段文字」，不是「是不是首轮」：
  // 用户中途换助手、改人设时得让新设定生效，否则网页那边会一直用旧人设说话。
  // 传进来的只有稳定块（人设 + 常驻记忆，见 src/lib/web-context.ts），所以正常
  // 情况下除了首轮都不会命中——每轮都在变的东西（身体读数、时间、摘要）绝不能
  // 进这个字符串，否则这里就退化成「每条消息都重拼一遍人设」。
  const persona = (options.systemPrompt ?? '').trim()
  /*
   * 去重规则抽到 src/lib/web-persona-state.ts，和 Android 的 WebApiClient 逐条对应。
   * 关键一条：人设为空（助手被关掉）时要返回 cache='' —— 缓存不清的话，
   * 「开 A → 关 → 再开 A」第三步会以为 A 已经拼过，于是再也不注入。
   */
  const decision = decidePersona(thread.persona, persona)
  const needPersona = decision.inject
  /*
   * 空人设（助手被关掉）：这一轮不注入，但**立刻**把去重标记清掉并落盘。
   *
   * 不清的话，「开 A → 关 → 再开 A」第三步会被判成「A 已经拼过」而永久跳过，
   * 网页那边就一直用关掉之前的旧设定。只清标记：sid / 历史消息都不动。
   * （decision.cache 在空人设时就是 ''，所以这里直接用返回值，不另写一份规则。）
   */
  if (persona === '' && thread.persona !== decision.cache) {
    thread.persona = decision.cache
    threadMap.set(options.conversationKey, thread)
    saveThreads()
  }
  const promptText = needPersona ? `${persona}\n\n---\n\n${options.prompt}` : options.prompt

  const reader = new PatchReader()
  let continues = 0
  let endpoint = COMPLETION_PATH
  // 已推送给渲染层的长度。跨续写轮次保持，避免把已发过的字重复推一遍。
  let seenText = 0
  let seenReasoning = 0
  let payload: Record<string, unknown> = {
    action: null,
    chat_session_id: thread.sid,
    parent_message_id: thread.mid,
    prompt: promptText,
    ref_file_ids: options.refFileIds ?? [],
    thinking_enabled: options.thinking,
    search_enabled: false,
    preempt: false,
  }

  for (;;) {
    // 只有 completion 要 PoW；continue / resume_stream 传了会被判 INVALID_TARGET_PATH。
    const needsPow = endpoint === COMPLETION_PATH
    const pow = needsPow ? await makePow(endpoint, signal) : undefined
    const current = loadSession()
    if (current === null) throw new WebApiError('no-session', '还没有登录网页账号')

    const response = await rawFetch(CHAT_ORIGIN + endpoint, {
      method: 'POST',
      headers: baseHeaders(current.token, pow === undefined ? {} : { 'x-ds-pow-response': pow }),
      body: JSON.stringify(payload),
      signal,
    })
    if (response.status === 401 || response.status === 403) throwForAuth(response)
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 180)
      throw new WebApiError('http', `DeepSeek 返回 ${response.status}：${detail}`)
    }

    // 服务端已经收下这条消息了：这时候才敢把「人设拼过了」记下来。
    // 只在整轮成功结束时记的话，中途断流/被停止就会漏记，下一轮又把设定重拼一遍。
    if (needPersona) {
      thread.persona = decision.cache
      threadMap.set(options.conversationKey, thread)
      saveThreads()
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      // 续写/重读可能一次性给整条消息（biz_code 22）。
      const text = await response.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new WebApiError('http', `期望流式回复，实际是 ${contentType || '无类型'}：${text.slice(0, 160)}`)
      }
      const biz = envelope(parsed, 'completion', [22])
      const whole = biz?.response as Record<string, unknown> | undefined
      if (whole === undefined) throw new WebApiError('http', 'DeepSeek 没返回可读的回复')
      reader.apply({ v: { response: whole } })
      break
    }

    if (response.body === null) throw new WebApiError('http', '回复流是空的')

    reader.status = null
    // 增量基准要跨续写轮次保持：INCOMPLETE 续写时 reader.text 会接着变长，
    // 如果每轮把基准重置成当前长度，已推过的字会再推一遍。
    for await (const frame of iterSse(response.body)) {
      if (signal.aborted) throw new WebApiError('aborted', '已停止')
      if (frame.event === 'close') break
      if (frame.event !== 'message' && frame.event !== 'ready') continue
      reader.apply(frame.data)
      // 边解析边推增量，渲染层就能实时看到字。
      if (reader.text.length > seenText) {
        options.onText?.(reader.text.slice(seenText))
        seenText = reader.text.length
      }
      if (reader.reasoning.length > seenReasoning) {
        options.onReasoning?.(reader.reasoning.slice(seenReasoning))
        seenReasoning = reader.reasoning.length
      }
    }

    // 说了一半：接着写。这是长回复不完整的唯一修法。
    if (reader.status === 'INCOMPLETE' && reader.messageId !== null && continues < MAX_CONTINUES) {
      continues += 1
      endpoint = CONTINUE_PATH
      payload = { chat_session_id: thread.sid, message_id: reader.messageId, fallback_to_resume: true }
      continue
    }
    // 空回复但已结束：让服务端把这条流重读一遍。
    if (
      reader.status === 'FINISHED'
      && reader.text === ''
      && reader.reasoning === ''
      && reader.messageId !== null
      && continues === 0
    ) {
      continues += 1
      endpoint = RESUME_PATH
      payload = { chat_session_id: thread.sid, message_id: reader.messageId }
      continue
    }
    break
  }

  if (reader.messageId !== null) thread.mid = reader.messageId
  threadMap.set(options.conversationKey, thread)
  saveThreads()
  return { threadCreated, text: reader.text, reasoning: reader.reasoning }
}

/* ------------------------------------------------------------------ */
/* 自检                                                                */
/* ------------------------------------------------------------------ */

export interface WebDiagnosis {
  hasSession: boolean
  sessionValid: boolean
  powReady: boolean
  powSource: string
  notes: string[]
}

/**
 * 自检：登录态 → 挑战接口 → PoW 本地解算，三段分别探一遍。
 *
 * PoW 现在是纯 JS，不再需要下载 wasm，所以 powReady 恒为本地能力；
 * 真正的风险只剩「登录态」和「网络」两段。
 */
export async function diagnose(): Promise<WebDiagnosis> {
  const notes: string[] = []
  const hasSession = hasWebSession()
  let sessionValid = false

  if (!hasSession) {
    notes.push('还没有登录态：先点「登录网页账号」')
  } else {
    try {
      const challenge = await fetchChallenge(COMPLETION_PATH)
      sessionValid = true
      // 顺手真解一道，验证 PoW 链路。走 worker（同正常发送），别在主进程同步解，
      // 否则自检会把界面卡住几十秒。
      const startedAt = Date.now()
      await solvePowAsync(challenge)
      notes.push(`PoW 本地解算正常（${Date.now() - startedAt}ms）`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof WebApiError && error.kind === 'expired') {
        notes.push('登录态已过期：重新登录一次')
      } else if (error instanceof WebApiError && error.kind === 'network') {
        notes.push(message)
      } else {
        notes.push(`挑战接口异常：${message}`)
      }
    }
  }

  if (notes.length === 0) notes.push('各项都正常')
  return { hasSession, sessionValid, powReady: true, powSource: 'local', notes }
}

export async function verifySession(): Promise<{ ok: boolean; reason?: string }> {
  if (loadSession() === null) return { ok: false, reason: '还没有登录' }
  try {
    await fetchChallenge(COMPLETION_PATH)
    return { ok: true }
  } catch (error) {
    if (error instanceof WebApiError) {
      // 网络不通时别删登录态，但如实告诉用户现在用不了。
      return { ok: false, reason: error.message }
    }
    return { ok: false, reason: error instanceof Error ? error.message : '未知错误' }
  }
}