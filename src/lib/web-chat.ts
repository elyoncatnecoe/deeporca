/**
 * 网页账号的桥接层（渲染进程侧）。
 *
 * 两条路，优先级从高到低：
 *   1. 纯 HTTP（Electron）：主进程拿登录态直调 chat.deepseek.com 接口。
 *      网页窗关不关都行——这就是 magpie 的体验：登录一次，之后不再需要窗口。
 *   2. DOM 遥控（后备/Android）：注入中继脚本到网页窗里替用户点发送。
 *      要求窗口开着；窗口关了就报「网页窗关掉了」。
 *
 * 纯 HTTP 模式没有「读状态」这回事：增量是主进程通过事件推回来的，
 * 所以这里的轮询逻辑只服务 DOM 遥控那条路。
 */

import { Capacitor, registerPlugin } from '@capacitor/core'
import { raceAbort } from './abort.ts'
import type { RelayState } from './web-relay.ts'

/** DOM 遥控的轮询节奏。 */
const POLL_MS = 400
/** DOM 遥控下一条回复最多等多久。 */
const REPLY_TIMEOUT_MS = 180_000

export type WebChatStatus = 'ok' | 'no-session' | 'no-window' | 'no-input' | 'timeout' | 'unsupported'

export interface WebChatReply {
  status: WebChatStatus
  content: string
  reasoning?: string
  /** 给用户看的一句话。 */
  message?: string
}

interface NativeWebChatPlugin {
  isOpen: () => Promise<{ open: boolean }>
  send: (options: { text: string }) => Promise<{ ok: boolean; error?: string }>
  state: () => Promise<RelayState | undefined>
  setContext: (options: { text: string }) => Promise<void>
  launch: (options: { url: string; css: string; js?: string }) => Promise<void>
  /* 纯 HTTP 模式（Android）：登录一次后网页窗关掉也能聊 */
  webApiHasSession: () => Promise<{ hasSession: boolean }>
  webApiCapture: () => Promise<{ ok: boolean; error?: string }>
  webApiForget: () => Promise<void>
  webApiSend: (options: { conversationKey: string; prompt: string; systemPrompt: string; thinking: boolean; refFileIds?: string[] }) =>
    Promise<{ ok: boolean; text?: string; reasoning?: string; error?: string }>
  /** 上传一个附件（data URL）到网页账号，返回 file_id。 */
  webApiUpload?: (options: { dataUrl: string; filename: string }) =>
    Promise<{ ok: boolean; fileId?: string; error?: string }>
  /** 用户按「停止」时把正在跑的那一轮请求掐掉（可选：老版本 APK 没有）。 */
  webApiAbort?: () => Promise<void>
}

const NativeWebChat = registerPlugin<NativeWebChatPlugin>('DeepSeaWebChat')
const isAndroid = Capacitor.getPlatform() === 'android'

interface ElectronWebChatBridge {
  webChatSend?: (text: string) => Promise<{ ok: boolean; error?: string }>
  webChatState?: () => Promise<RelayState | null>
  webChatContext?: (text: string) => Promise<void>
  webChatShow?: () => Promise<void>
  webApiHasSession?: () => Promise<boolean>
  webApiCapture?: () => Promise<{ ok: boolean; error?: string }>
  webApiLogin?: () => Promise<{ ok: boolean; error?: string }>
  webApiDiagnose?: () => Promise<{ hasSession: boolean; sessionValid: boolean; powReady: boolean; powSource: string; notes: string[] }>
  webApiForget?: () => Promise<void>
  webApiSend?: (conversationKey: string, prompt: string, thinking: boolean, systemPrompt: string, refFileIds?: string[]) => Promise<{ ok: boolean; error?: string; kind?: string }>
  webApiUpload?: (dataUrl: string, filename: string) => Promise<{ ok: boolean; fileId?: string; error?: string }>
  webApiAbort?: () => Promise<void>
  onWebChatDelta?: (handler: (payload: { kind: 'text' | 'reasoning'; delta: string }) => void) => () => void
  onWebChatDone?: (handler: (payload: { text: string; reasoning: string; error?: string; kind?: string }) => void) => () => void
}

function electron(): ElectronWebChatBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return window.deepsea as ElectronWebChatBridge | undefined
}

/**
 * HTTP 模式可用吗（有桥且本机有登录态）。
 *
 * 两个平台各有一套后端：Electron 走主进程的 net.fetch，Android 走
 * WebApiClient（Java 里自己算 PoW）。对渲染层来说接口形状一致。
 */
async function httpModeReady(): Promise<boolean> {
  const native = electron()
  if (native?.webApiSend !== undefined && native.webApiHasSession !== undefined) {
    try {
      return await native.webApiHasSession()
    } catch {
      return false
    }
  }
  if (isAndroid) {
    try {
      const result = await NativeWebChat.webApiHasSession()
      return result.hasSession === true
    } catch {
      return false
    }
  }
  return false
}

/** 当前环境能不能用网页账号模式（任一条路通就算能）。 */
export function webChatAvailable(): boolean {
  const native = electron()
  if (native?.webApiSend !== undefined || native?.webChatSend !== undefined) return true
  return isAndroid
}

/** 本机有没有登录态（HTTP 模式用；DOM 遥控不依赖它）。 */
export async function webChatLoggedIn(): Promise<boolean> {
  const native = electron()
  if (native?.webApiHasSession !== undefined) {
    try {
      return await native.webApiHasSession()
    } catch {
      return false
    }
  }
  if (isAndroid) {
    try {
      const result = await NativeWebChat.webApiHasSession()
      return result.hasSession === true
    } catch {
      return false
    }
  }
  return false
}

/**
 * 登录流程：打开网页窗让用户登录，然后采集登录态。
 * 返回是否成功采集（失败时给一句人话）。
 */
export async function loginWebChat(): Promise<{ ok: boolean; message?: string }> {
  // Android：launch 开网页窗 → 轮询采集，直到用户登录成功或超时。
  if (isAndroid) {
    if (await webChatLoggedIn()) return { ok: true }
    try {
      await NativeWebChat.launch({ url: 'https://chat.deepseek.com/', css: '' })
    } catch {
      return { ok: false, message: '打不开网页窗' }
    }
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    let lastError = ''
    while (Date.now() < deadline) {
      await sleep(1500)
      try {
        const captured = await NativeWebChat.webApiCapture()
        if (captured.ok) return { ok: true }
        lastError = captured.error ?? ''
      } catch {
        /* 用户还在登录，继续等 */
      }
    }
    return { ok: false, message: lastError === '' ? '登录超时了，请重试一次' : lastError }
  }

  const native = electron()
  if (native === undefined) return { ok: false, message: '这个版本不支持网页账号' }

  // 主进程负责「开窗 → 等用户登录 → 采集 → 验证 → 收窗」这一整套。
  if (native.webApiLogin !== undefined) {
    const result = await native.webApiLogin()
    if (!result.ok) return { ok: false, message: result.error ?? '登录没有完成' }
    return { ok: true }
  }

  // 没有 login 方法的老版本：开窗 + 采集两步走。
  if (native.webChatShow !== undefined) await native.webChatShow()
  if (native.webApiCapture === undefined) return { ok: true }
  const captured = await native.webApiCapture()
  if (!captured.ok) return { ok: false, message: captured.error ?? '采集登录态失败' }
  return { ok: true }
}

/** 等用户登录的上限（扫码、人机校验都需要时间）。 */
const LOGIN_TIMEOUT_MS = 300_000

/** 忘掉登录态（重新登录用）。 */
export async function logoutWebChat(): Promise<void> {
  const native = electron()
  if (native?.webApiForget !== undefined) {
    await native.webApiForget()
    return
  }
  if (isAndroid) {
    try {
      await NativeWebChat.webApiForget()
    } catch {
      /* 已经没了 */
    }
  }
}

/** 把助手人设 + 记忆前缀写进网页窗（DOM 遥控路用；HTTP 路不需要）。 */
export async function setWebChatContext(text: string): Promise<void> {
  const native = electron()
  if (native?.webChatContext !== undefined) {
    await native.webChatContext(text)
    return
  }
  if (isAndroid) {
    try {
      await NativeWebChat.setContext({ text })
    } catch {
      /* 网页窗没开就算了 */
    }
  }
}

/** 把网页窗叫到前台，让用户去登录。 */
export async function showWebChat(): Promise<boolean> {
  const native = electron()
  if (native?.webChatShow !== undefined) {
    await native.webChatShow()
    return true
  }
  if (isAndroid) {
    try {
      await NativeWebChat.launch({ url: 'https://chat.deepseek.com/', css: '' })
      return true
    } catch {
      return false
    }
  }
  return false
}

/** 读一次网页窗的当前状态（DOM 遥控路）。 */
export async function readWebChatState(): Promise<RelayState | null> {
  const native = electron()
  if (native?.webChatState !== undefined) return await native.webChatState()
  if (isAndroid) {
    try {
      const state = await NativeWebChat.state()
      return state ?? null
    } catch {
      return null
    }
  }
  return null
}

/** 网页窗是否就绪（DOM 遥控路）。 */
export async function webChatReady(): Promise<boolean> {
  if (!webChatAvailable()) return false
  if (await httpModeReady()) return true
  const state = await readWebChatState()
  return state !== null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/* ---------------- 纯 HTTP 模式的发送 ---------------- */

interface HttpSendResult {
  status: WebChatStatus
  content: string
  reasoning: string
  message?: string
}

/**
 * 通过主进程直发。
 *
 * 增量走事件，结束走 done 事件；invoke 的返回值只表示「请求有没有发出去」。
 * conversationKey 让主进程把这段 App 对话映射到网页线程（chat_session_id）。
 */
function sendViaHttp(
  conversationKey: string,
  prompt: string,
  thinking: boolean,
  systemPrompt: string,
  refFileIds: string[],
  signal: AbortSignal | undefined,
  onText: (full: string) => void,
  onReasoning: (full: string) => void,
): Promise<HttpSendResult> {
  return new Promise((resolve) => {
    const native = electron()
    if (native?.webApiSend === undefined || native.onWebChatDelta === undefined || native.onWebChatDone === undefined) {
      resolve({ status: 'unsupported', content: '', reasoning: '' })
      return
    }

    let text = ''
    let reasoning = ''
    let finished = false

    const offDelta = native.onWebChatDelta((payload) => {
      if (payload.kind === 'text') {
        text += payload.delta
        onText(text)
      } else {
        reasoning += payload.delta
        onReasoning(reasoning)
      }
    })

    const finish = (status: WebChatStatus, message?: string): void => {
      if (finished) return
      finished = true
      window.clearTimeout(watchdog)
      offDelta()
      offDone()
      signal?.removeEventListener('abort', onAbort)
      resolve({ status, content: text, reasoning, message })
    }

    // 用户按「停止」：先让主进程把请求掐掉，然后当场收尾 —— 别等 180 秒保险丝。
    const onAbort = (): void => {
      native.webApiAbort?.().catch(() => undefined)
      finish('ok', '已停止')
    }

    // 保险丝：done 事件万一丢了也别把用户挂在「正在思考」上。
    const watchdog = window.setTimeout(() => {
      finish(text === '' ? 'timeout' : 'ok', text === '' ? '网页那边太久没回' : undefined)
    }, REPLY_TIMEOUT_MS)

    const offDone = native.onWebChatDone((payload) => {
      if (payload.text !== '') {
        // done 里带的是全文；以它为准，避免事件丢帧导致结尾缺字。
        text = payload.text
        onText(text)
      }
      if (payload.reasoning !== '') {
        reasoning = payload.reasoning
        onReasoning(reasoning)
      }
      if (payload.error !== undefined && payload.error !== '') {
        const kind = payload.kind
        const status: WebChatStatus = kind === 'no-session' || kind === 'expired' ? 'no-session' : 'no-input'
        finish(status, payload.error)
        return
      }
      finish('ok')
    })

    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    void (async () => {
      try {
        if (finished) return
        const send = native.webApiSend
        if (send === undefined) {
          finish('unsupported', '这个版本不支持网页账号模式')
          return
        }
        const sent = await send(conversationKey, prompt, thinking, systemPrompt, refFileIds)
        if (!sent.ok) {
          const status: WebChatStatus = sent.kind === 'no-session' || sent.kind === 'expired' ? 'no-session' : 'no-input'
          finish(status, sent.error ?? '网页接口出错')
        }
        // ok 时等 done 事件来收尾。
      } catch (error) {
        finish('no-input', error instanceof Error ? error.message : '网页接口出错')
      }
    })()
  })
}

/* ---------------- DOM 遥控模式的发送（后备） ---------------- */

interface SendResult {
  ok: boolean
  error?: string
}

async function sendRaw(text: string): Promise<SendResult> {
  const native = electron()
  if (native?.webChatSend !== undefined) return await native.webChatSend(text)
  if (isAndroid) {
    try {
      return await NativeWebChat.send({ text })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '网页那边没发出去' }
    }
  }
  return { ok: false, error: 'unsupported' }
}

async function sendViaDom(
  text: string,
  options: { onDelta?: (full: string) => void; onReasoning?: (full: string) => void; signal?: AbortSignal } = {},
): Promise<WebChatReply> {
  const sent = await sendRaw(text)
  if (!sent.ok) {
    if (sent.error === 'unsupported') {
      return { status: 'unsupported', content: '', message: '这个版本不支持网页账号模式' }
    }
    return {
      status: sent.error === 'no-window' ? 'no-window' : 'no-input',
      content: '',
      message: sent.error === 'no-window'
        ? '网页窗还没打开。先在设置里点「打开网页版」并登录一次。'
        : sent.error ?? '网页那边没发出去',
    }
  }

  const startedAt = Date.now()
  let last = ''
  let thought = ''
  while (true) {
    if (options.signal?.aborted === true) {
      return { status: 'ok', content: last, reasoning: thought, message: '已停止' }
    }
    const state = await readWebChatState()
    if (state === null) {
      return { status: 'no-window', content: last, reasoning: thought, message: '网页窗关掉了，回话断了' }
    }
    if (state.text !== last) {
      last = state.text
      options.onDelta?.(last)
    }
    if (state.reasoning !== undefined && state.reasoning !== '' && state.reasoning !== thought) {
      thought = state.reasoning
      options.onReasoning?.(thought)
    }
    if (state.error !== undefined && state.error !== '') {
      return { status: 'no-input', content: last, reasoning: thought, message: state.error }
    }
    if (state.done) return { status: 'ok', content: last, reasoning: thought }
    if (Date.now() - startedAt > REPLY_TIMEOUT_MS) {
      return { status: 'timeout', content: last, reasoning: thought, message: '网页那边太久没回，先算这段' }
    }
    await sleep(POLL_MS)
  }
}

/* ---------------- 对外入口 ---------------- */

export interface SendOptions {
  /** App 对话 id：HTTP 模式靠它把对话映射到网页线程。 */
  conversationKey?: string
  /** 是否打开思考模式（HTTP 模式才生效）。 */
  thinking?: boolean
  /** 人设 + 常驻记忆的稳定块；HTTP 模式只在首轮或它变了之后拼进 prompt。 */
  systemPrompt?: string
  /**
   * 本轮要带进网页账号的图片附件（data URL）。
   *
   * 只有纯 HTTP 模式能上传（网页窗遥控无法往页面里塞文件）；上传后拿到的
   * file_id 会放进 completion 的 ref_file_ids。
   */
  images?: { dataUrl: string; name: string }[]
  onDelta?: (fullText: string) => void
  onReasoning?: (fullText: string) => void
  signal?: AbortSignal
}

/**
 * 上传一张图片附件到网页账号。桌面走主进程、Android 走原生插件。
 * 两个平台的外形一致；老版本没有上传能力时返回明确错误。
 */
async function uploadWebImage(dataUrl: string, name: string): Promise<{ ok: boolean; fileId?: string; error?: string }> {
  const native = electron()
  if (native?.webApiUpload !== undefined) {
    try {
      return await native.webApiUpload(dataUrl, name)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '上传失败' }
    }
  }
  if (isAndroid) {
    try {
      const result = await NativeWebChat.webApiUpload?.({ dataUrl, filename: name })
      return result ?? { ok: false, error: '这个版本的 App 还不支持上传附件' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '上传失败' }
    }
  }
  return { ok: false, error: '这个版本不支持上传附件' }
}

/**
 * 发一条消息并等回话。
 *
 * `onDelta` / `onReasoning` 收到的是**完整正文**（不是增量），调用方自己 diff；
 * 这样事件丢帧也不会漏字。
 */
export async function sendViaWebChat(text: string, options: SendOptions = {}): Promise<WebChatReply> {
  if (!webChatAvailable()) {
    return { status: 'unsupported', content: '', message: '这个版本不支持网页账号模式' }
  }

  // 图片附件：只有纯 HTTP 模式能上传（网页窗遥控塞不进文件）。
  const refFileIds: string[] = []
  if (options.images !== undefined && options.images.length > 0) {
    if (!(await httpModeReady())) {
      return {
        status: 'no-input',
        content: '',
        message: '当前是网页窗遥控模式，发附件要先用「登录网页账号」建成免窗口模式，或切回 API 模型。',
      }
    }
    for (const image of options.images) {
      const uploaded = await uploadWebImage(image.dataUrl, image.name)
      if (uploaded.ok !== true || uploaded.fileId === undefined || uploaded.fileId === '') {
        return { status: 'no-input', content: '', message: uploaded.error ?? '附件上传失败' }
      }
      refFileIds.push(uploaded.fileId)
    }
  }

  // 先走 HTTP：窗口关不关都行，也不受 DOM 改版影响。
  if (await httpModeReady()) {
    // Android 的 HTTP 后端是一次性返回整段（Java 里不做流式回调），
    // Electron 那边是事件驱动的流式。这里统一成「拿到完整正文」再交给上层。
    if (isAndroid) {
      return await sendViaAndroidHttp(text, options, refFileIds)
    }
    const result = await sendViaHttp(
      options.conversationKey ?? 'default',
      text,
      options.thinking === true,
      options.systemPrompt ?? '',
      refFileIds,
      options.signal,
      (full) => options.onDelta?.(full),
      (full) => options.onReasoning?.(full),
    )
    if (result.status === 'no-session') {
      return { status: 'no-session', content: result.content, reasoning: result.reasoning, message: result.message ?? '网页登录过期了' }
    }
    if (result.status === 'unsupported') {
      // HTTP 路中途不可用（极少），退回 DOM 遥控。
    } else {
      return { status: result.status, content: result.content, reasoning: result.reasoning, message: result.message }
    }
  }

  // 后备：DOM 遥控。
  return await sendViaDom(text, options)
}

/**
 * Android 的 HTTP 发送。
 *
 * 与桌面端不同，Java 侧不回流式增量，所以这里一次性拿到全文，
 * 再一次性回调 onDelta——上层看到的是「整段突然出现」，但没有正确性问题。
 *
 * 人设**由 Java 侧决定是否拼**（它记着这个线程上次拼进去的是哪一段）；
 * 这里不能自己先拼一遍，否则会拼两次。
 */
async function sendViaAndroidHttp(text: string, options: SendOptions, refFileIds: string[]): Promise<WebChatReply> {
  const signal = options.signal
  // 用一个本地标记而不是反复读 signal.aborted：TS 会把上面那次判断的结果带下来，
  // 后面再比较一次就会被判成「恒为假」。
  let stopped = signal?.aborted === true
  if (stopped) return { status: 'ok', content: '', message: '已停止' }
  // Java 侧是一次性拿整段（没有流式回调），所以「停止」要两边一起做：
  // 通知原生把连接断开，同时让这边立刻松手，别再干等那 180 秒读超时。
  const onAbort = (): void => {
    stopped = true
    void NativeWebChat.webApiAbort?.().catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const pending = NativeWebChat.webApiSend({
      conversationKey: options.conversationKey ?? 'default',
      prompt: text,
      systemPrompt: options.systemPrompt ?? '',
      thinking: options.thinking === true,
      refFileIds,
    })
    // raceAbort 会先 reject；pending 自己的失败也得有人接住，否则是 unhandled rejection。
    void pending.catch(() => undefined)
    const result = await raceAbort(pending, signal)
    if (!result.ok) {
      const message = result.error ?? '网页那边没发出去'
      // 登录过期/未登录都归到 no-session，让上层引导重新登录。
      const status: WebChatStatus = /登录|过期|token/i.test(message) ? 'no-session' : 'no-input'
      return { status, content: '', message }
    }
    const content = result.text ?? ''
    const thought = result.reasoning ?? ''
    if (content !== '') options.onDelta?.(content)
    if (thought !== '') options.onReasoning?.(thought)
    return { status: 'ok', content, reasoning: thought }
  } catch (error) {
    if (stopped) return { status: 'ok', content: '', message: '已停止' }
    return {
      status: 'no-input',
      content: '',
      message: error instanceof Error ? error.message : '网页接口出错',
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 自检：把「登录态 / 接口 / PoW」三段分别探一遍，拼成一句人话。
 *
 * 用户报「有 bug」时最需要知道卡在哪一段。这个结果直接显示在设置页，
 * 也让排查不必再靠猜。
 */
export async function diagnoseWebChat(): Promise<string> {
  const native = electron()
  if (native?.webApiDiagnose === undefined) return '这个版本不支持自检'

  const result = await native.webApiDiagnose()
  const parts = [
    result.hasSession ? '登录态：有' : '登录态：无',
    result.sessionValid ? '接口：通' : '接口：不通',
    result.powReady ? `PoW：就绪（${result.powSource}）` : 'PoW：未就绪',
  ]
  return `${parts.join('｜')}。${result.notes.join('；')}`
}