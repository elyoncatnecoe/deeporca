import { Capacitor, registerPlugin } from '@capacitor/core'
import type { HttpBridgeBinaryResponse, HttpBridgeRequest, HttpBridgeResponse, HttpStreamEvent } from './global'

/**
 * API 网络层：把「要发出去的 HTTP」从 WebView 里挪出去。
 *
 * 为什么必须这样：Capacitor（Android）和 Electron 的界面层都是浏览器上下文，
 * 跨域请求要先过 CORS。而第三方的 OpenAI 兼容接口大多是给服务器对服务器用的，
 * 根本不返回 `Access-Control-Allow-Origin`：
 *   - 实测 developer.amd.com.cn：OPTIONS 直接 405，没有任何 CORS 头；
 *   - 实测 model.inferx.net：预检回了 `*`，但真正的 POST 响应没有 ACAO；
 *   - 实测 www.moyu.cn：预检和 POST 都带 `ACAO: *` —— 所以只有它能用。
 * 浏览器对前两家只会给一句 `Failed to fetch`，换网络、开加速器都没用。
 * 这不是某一家站点的问题，是「WebView 直连第三方 API」这个架构的通病。
 *
 * 所以这里分三层，对上层暴露同一组函数：
 *   - Electron：走主进程 fetch（没有 CORS）—— preload 暴露的 httpRequest/httpStream；
 *   - Android：走原生 HttpURLConnection 插件（DeepSeaHttp）；
 *   - 其它（纯浏览器预览）：退回 window.fetch。
 */

export interface NetResponse {
  status: number
  headers: Record<string, string>
  text: string
}

/**
 * 二进制响应（生图 URL 下载 / OpenAI TTS 音频）。
 *
 * base64 而不是 Uint8Array：跨 Electron IPC / Capacitor 桥时 ArrayBuffer 的形状
 * 各家实现不一致，而 base64 字符串在三条通道上都能稳定传递；最后在渲染层
 * 拼成 data URL 交给 <img>/<audio>。
 */
export interface NetBinaryResponse {
  status: number
  headers: Record<string, string>
  base64: string
  mime: string
  /** 错误响应体的可读文本（JSON 错误时用）；二进制响应时为空。 */
  text?: string
}

export interface NetRequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface StreamHandlers {
  /** 响应头到达时触发（此时正文还没读完）。 */
  onStatus?: (status: number, headers: Record<string, string>) => void
  /** 正文增量（原生层保证按字符切，不会把一个多字节字符劈成两半）。 */
  onChunk?: (chunk: string) => void
}

export type NetErrorKind = 'network' | 'aborted' | 'timeout' | 'unsupported'

export class NetError extends Error {
  readonly kind: NetErrorKind

  constructor(kind: NetErrorKind, message: string) {
    super(message)
    this.name = 'NetError'
    this.kind = kind
  }
}

interface NativeStreamStartResult {
  streamId: string
}

interface NativeStatusEvent {
  streamId: string
  status: number
  headers?: Record<string, string>
}

interface NativeChunkEvent {
  streamId: string
  chunk: string
}

interface NativeEndEvent {
  streamId: string
  status: number
  headers?: Record<string, string>
}

interface NativeErrorEvent {
  streamId: string
  message: string
}

interface NativeHttpPlugin {
  request: (options: HttpBridgeRequest) => Promise<HttpBridgeResponse>
  /** 二进制请求：Android 原生插件返回 base64（TTS 音频/图片下载）。 */
  requestBinary?: (options: HttpBridgeRequest) => Promise<HttpBridgeBinaryResponse>
  streamStart: (options: HttpBridgeRequest) => Promise<NativeStreamStartResult>
  streamAbort: (options: { streamId: string }) => Promise<void>
  addListener: (
    eventName: 'httpStatus' | 'httpChunk' | 'httpEnd' | 'httpError',
    listener: (event: never) => void,
  ) => Promise<{ remove: () => Promise<void> | void }> | { remove: () => Promise<void> | void }
}

const bridge = () => (typeof window === 'undefined' ? undefined : window.deepsea)

const isAndroidPlatform = (): boolean => {
  try {
    return Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

let nativePlugin: NativeHttpPlugin | null = null

/** 懒注册：只有真在 Android 上才碰 Capacitor 插件，浏览器预览不受影响。 */
function androidHttp(): NativeHttpPlugin | null {
  if (!isAndroidPlatform()) return null
  if (nativePlugin === null) nativePlugin = registerPlugin<NativeHttpPlugin>('DeepSeaHttp')
  return nativePlugin
}

/** 当前平台有没有「不走 CORS」的原生通道。 */
export function nativeTransportAvailable(): boolean {
  if (bridge()?.httpRequest !== undefined) return true
  return isAndroidPlatform()
}

/** 给人看的传输层名字，错误提示里用得上。 */
export function transportName(): string {
  if (bridge()?.httpRequest !== undefined) return '桌面端原生通道'
  if (isAndroidPlatform()) return '原生通道'
  return '浏览器 fetch'
}

function toBridgeRequest(options: NetRequestOptions): HttpBridgeRequest {
  const request: HttpBridgeRequest = { url: options.url }
  if (options.method !== undefined) request.method = options.method
  if (options.headers !== undefined) request.headers = options.headers
  if (options.body !== undefined) request.body = options.body
  if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs
  return request
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 把各层的网络异常收成一句用户能行动的话。
 *
 * 关键是别再让「CORS 被浏览器拦掉」看起来像「你网络不好」—— 那种提示会让人
 * 去换 Wi-Fi、开加速器，全都白费。原生通道下不会再有 CORS；如果还失败，那才是
 * 真的网络 / TLS 问题。
 */
function mapNetworkError(error: unknown, url: string): NetError {
  const detail = describe(error)
  if (/abort/i.test(detail)) return new NetError('aborted', '请求已取消')
  if (/timeout|timed out|超时/i.test(detail)) return new NetError('timeout', `连接 ${hostOf(url)} 超时`)
  if (isAndroidPlatform() || bridge()?.httpRequest !== undefined) {
    return new NetError('network', `连不上 ${hostOf(url)}：${detail}`)
  }
  return new NetError(
    'network',
    `连不上 ${hostOf(url)}：浏览器直连被跨域（CORS）拦住了。` +
      '这家接口没有返回 Access-Control-Allow-Origin —— 换网络或加速器都没用，' +
      '需要 App 的原生通道（Android / 桌面安装版）才能直连。',
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 非流式请求（列模型 / 记忆抽取 / 测连接这类）。 */
export async function netRequest(options: NetRequestOptions): Promise<NetResponse> {
  const native = bridge()
  if (native?.httpRequest !== undefined) {
    try {
      const result = await native.httpRequest(toBridgeRequest(options))
      if (result === null || result === undefined) {
        throw new NetError('network', '原生通道拒绝了这次请求（地址或请求头不合法）')
      }
      return result
    } catch (error) {
      if (error instanceof NetError) throw error
      throw mapNetworkError(error, options.url)
    }
  }

  const plugin = androidHttp()
  if (plugin !== null) {
    try {
      const result = await plugin.request(toBridgeRequest(options))
      return { status: result.status, headers: result.headers ?? {}, text: result.text ?? '' }
    } catch (error) {
      throw mapNetworkError(error, options.url)
    }
  }

  /*
   * 浏览器兜底。注意超时和「用户取消」在 fetch 里都是 AbortError —— 必须自己
   * 记一个 timedOut 标记，否则超时会被翻译成「请求已取消」，用户以为是误触。
   */
  const controller = new AbortController()
  let timedOut = false
  const timer = options.timeoutMs !== undefined
    ? setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    : undefined
  const relayAbort = (): void => controller.abort()
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', relayAbort, { once: true })
  }
  try {
    const response = await fetch(options.url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    })
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text: await response.text(),
    }
  } catch (error) {
    if (timedOut) throw new NetError('timeout', `连接 ${hostOf(options.url)} 超时`)
    throw mapNetworkError(error, options.url)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', relayAbort)
  }
}

/**
 * 二进制请求（音频/图片下载）。
 *
 * 和 netRequest 的差别只有响应读取方式：这里拿 arrayBuffer 后转 base64，避免
 * 把 MP3/PNG 当 UTF-8 文本解码（那会把字节破坏成 U+FFFD）。三端实现：
 * - Electron：preload 的 httpRequestBinary → 主进程 Buffer；
 * - Android：DeepSeaHttp.requestBinary → Base64.NO_WRAP；
 * - 浏览器：fetch().arrayBuffer() 本地转 base64。
 */
export async function netRequestBinary(options: NetRequestOptions): Promise<NetBinaryResponse> {
  const native = bridge()
  if (native?.httpRequestBinary !== undefined) {
    try {
      const result = await native.httpRequestBinary(toBridgeRequest(options))
      if (result === null || result === undefined) {
        throw new NetError('network', '原生通道拒绝了这次请求（地址或请求头不合法）')
      }
      return normalizeBinaryResponse(result)
    } catch (error) {
      if (error instanceof NetError) throw error
      throw mapNetworkError(error, options.url)
    }
  }

  const plugin = androidHttp()
  if (plugin !== null && plugin.requestBinary !== undefined) {
    try {
      const result = await plugin.requestBinary(toBridgeRequest(options))
      return normalizeBinaryResponse(result)
    } catch (error) {
      throw mapNetworkError(error, options.url)
    }
  }

  return await requestBinaryViaFetch(options)
}

function mimeOfHeaders(headers: Record<string, string>): string {
  const raw = headers['content-type'] ?? headers['Content-Type'] ?? ''
  return raw.split(';')[0]?.trim().toLowerCase() ?? ''
}

function bytesToBase64(bytes: Uint8Array): string {
  /*
   * 用数组收集再一次性 join（T-20）。
   *
   * 以前是 `binary += ...` 反复拼：一张 16MB 的图会拼出几十 MB 的中间字符串，
   * 峰值常驻内存是最终结果的数倍（WebView 里很容易直接 OOM）。
   */
  const parts: string[] = []
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    parts.push(String.fromCharCode(...bytes.subarray(index, index + chunk)))
  }
  return btoa(parts.join(''))
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function textOfBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

function normalizeBinaryResponse(result: HttpBridgeBinaryResponse): NetBinaryResponse {
  const headers = result.headers ?? {}
  const mime = (result.mime ?? mimeOfHeaders(headers)).trim().toLowerCase()
  let text = result.text
  if (text === undefined && result.base64 !== '' && (mime.includes('json') || mime.startsWith('text/'))) {
    text = textOfBytes(base64ToBytes(result.base64))
  }
  return {
    status: result.status,
    headers,
    base64: result.base64,
    mime,
    ...(text !== undefined ? { text } : {}),
  }
}

async function requestBinaryViaFetch(options: NetRequestOptions): Promise<NetBinaryResponse> {
  const controller = new AbortController()
  let timedOut = false
  const timer = options.timeoutMs !== undefined
    ? setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    : undefined
  const relayAbort = (): void => controller.abort()
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', relayAbort, { once: true })
  }
  try {
    const response = await fetch(options.url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    })
    const headers = Object.fromEntries(response.headers.entries())
    const mime = mimeOfHeaders(headers)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      status: response.status,
      headers,
      base64: bytesToBase64(bytes),
      mime,
      ...(mime.includes('json') || mime.startsWith('text/') ? { text: textOfBytes(bytes) } : {}),
    }
  } catch (error) {
    if (timedOut) throw new NetError('timeout', `连接 ${hostOf(options.url)} 超时`)
    throw mapNetworkError(error, options.url)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', relayAbort)
  }
}

/**
 * 流式请求。返回时正文已经读完（text 是完整原文），但 onChunk 是边到边给的，
 * 所以 SSE 解析可以保持「一有增量就渲染」的体验。
 */
export async function netStream(
  options: NetRequestOptions,
  handlers: StreamHandlers = {},
): Promise<NetResponse> {
  const native = bridge()
  if (native?.httpStreamStart !== undefined && native.onHttpStream !== undefined) {
    return await streamViaBridge(native, options, handlers)
  }

  const plugin = androidHttp()
  if (plugin !== null) {
    return await streamViaPlugin(plugin, options, handlers)
  }

  return await streamViaFetch(options, handlers)
}

async function streamViaBridge(
  native: NonNullable<ReturnType<typeof bridge>>,
  options: NetRequestOptions,
  handlers: StreamHandlers,
): Promise<NetResponse> {
  const chunks: string[] = []
  let status = 0
  let headers: Record<string, string> = {}
  const buffered: HttpStreamEvent[] = []
  let streamId = ''
  let settle: ((value: NetResponse) => void) | null = null
  let fail: ((error: Error) => void) | null = null

  const outcome = new Promise<NetResponse>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  function apply(event: HttpStreamEvent): void {
    if (event.type === 'status') {
      status = event.status
      headers = event.headers ?? {}
      handlers.onStatus?.(status, headers)
      return
    }
    if (event.type === 'chunk') {
      chunks.push(event.chunk)
      handlers.onChunk?.(event.chunk)
      return
    }
    if (event.type === 'end') {
      status = event.status
      headers = event.headers ?? headers
      cleanup()
      settle?.({ status, headers, text: chunks.join('') })
      return
    }
    cleanup()
    fail?.(mapNetworkError(event.message, options.url))
  }

  const handle = (event: HttpStreamEvent): void => {
    if (streamId !== '' && event.id !== streamId) return
    if (streamId === '') {
      buffered.push(event)
      return
    }
    apply(event)
  }

  const unsubscribe = native.onHttpStream!(handle)
  function cleanup(): void {
    try {
      unsubscribe()
    } catch {
      /* 已卸载 */
    }
  }

  const abort = (): void => {
    if (streamId !== '') void native.httpStreamAbort?.(streamId).catch(() => undefined)
  }
  if (options.signal !== undefined) {
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', abort, { once: true })
  }

  try {
    const started = await native.httpStreamStart!(toBridgeRequest(options))
    if (started === null || started === undefined || typeof started.id !== 'string' || started.id === '') {
      throw new NetError('network', '原生通道拒绝了这次请求（参数不合法）')
    }
    streamId = started.id
    // 回放订阅早于 id 到达时收到的事件（status 可能最先到）。
    for (const event of buffered.splice(0)) apply(event)
    return await outcome
  } catch (error) {
    cleanup()
    if (error instanceof NetError) throw error
    throw mapNetworkError(error, options.url)
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

async function streamViaPlugin(
  plugin: NativeHttpPlugin,
  options: NetRequestOptions,
  handlers: StreamHandlers,
): Promise<NetResponse> {
  const chunks: string[] = []
  const queued: Array<{ type: 'status' | 'chunk' | 'end' | 'error'; data: unknown }> = []
  let streamId = ''
  let settle: ((value: NetResponse) => void) | null = null
  let fail: ((error: Error) => void) | null = null

  const outcome = new Promise<NetResponse>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  function consume(type: 'status' | 'chunk' | 'end' | 'error', data: unknown): void {
    if (streamId === '') {
      queued.push({ type, data })
      return
    }
    if (type === 'status') {
      const event = data as NativeStatusEvent
      handlers.onStatus?.(event.status, event.headers ?? {})
      return
    }
    if (type === 'chunk') {
      const event = data as NativeChunkEvent
      chunks.push(event.chunk)
      handlers.onChunk?.(event.chunk)
      return
    }
    if (type === 'end') {
      const event = data as NativeEndEvent
      cleanup()
      settle?.({ status: event.status, headers: event.headers ?? {}, text: chunks.join('') })
      return
    }
    const event = data as NativeErrorEvent
    cleanup()
    fail?.(mapNetworkError(event.message, options.url))
  }

  const subscriptions: Array<{ remove: () => Promise<void> | void }> = []
  for (const name of ['httpStatus', 'httpChunk', 'httpEnd', 'httpError'] as const) {
    const listener = (event: never): void => {
      const payload = event as unknown as { streamId: string }
      if (streamId !== '' && payload.streamId !== streamId) return
      const type = name === 'httpStatus' ? 'status' : name === 'httpChunk' ? 'chunk' : name === 'httpEnd' ? 'end' : 'error'
      consume(type, event)
    }
    const handle = plugin.addListener(name, listener)
    subscriptions.push(handle instanceof Promise ? await handle : handle)
  }

  function cleanup(): void {
    for (const subscription of subscriptions.splice(0)) {
      try {
        void subscription.remove()
      } catch {
        /* 已卸载 */
      }
    }
  }

  const abort = (): void => {
    if (streamId !== '') void plugin.streamAbort({ streamId }).catch(() => undefined)
  }
  if (options.signal !== undefined) {
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', abort, { once: true })
  }

  try {
    const started = await plugin.streamStart(toBridgeRequest(options))
    streamId = started.streamId
    for (const item of queued.splice(0)) consume(item.type, item.data)
    return await outcome
  } catch (error) {
    cleanup()
    if (error instanceof NetError) throw error
    throw mapNetworkError(error, options.url)
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

async function streamViaFetch(
  options: NetRequestOptions,
  handlers: StreamHandlers,
): Promise<NetResponse> {
  const controller = new AbortController()
  let timedOut = false
  const relayAbort = (): void => controller.abort()
  const timer = options.timeoutMs !== undefined
    ? setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    : undefined
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', relayAbort, { once: true })
  }
  try {
    const response = await fetch(options.url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    })
    handlers.onStatus?.(response.status, Object.fromEntries(response.headers.entries()))
    if (response.body === null) {
      return { status: response.status, headers: {}, text: '' }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parts: string[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      if (text === '') continue
      parts.push(text)
      handlers.onChunk?.(text)
    }
    const tail = decoder.decode()
    if (tail !== '') {
      parts.push(tail)
      handlers.onChunk?.(tail)
    }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text: parts.join('') }
  } catch (error) {
    if (timedOut) throw new NetError('timeout', `连接 ${hostOf(options.url)} 超时`)
    throw mapNetworkError(error, options.url)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', relayAbort)
  }
}
