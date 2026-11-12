import type { ChatRequestMessage, Settings, ThinkingEffort, TokenUsage, ToolCall } from './types'
import { chatEndpoint, chatHeaders, currentProvider, isWebChatProvider } from './providers'
import { sendViaWebChat, webChatAvailable, webChatLoggedIn } from './web-chat'
import { isCompleteToolArguments, resolveOutputCap } from './budget'
import { NetError, netRequest, netStream, type NetResponse } from './net'
import {
  buildAnthropicBody,
  buildGoogleBody,
  buildOpenAiBody,
  finalizedToolDrafts,
  googleStreamUrl,
  mergeToolDelta,
  parseAnthropicEvent,
  parseCompleteContent,
  parseGoogleEvent,
  type ToolDraft,
} from './protocols'

export class ApiError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, detail: string) {
    super(friendlyMessage(status, detail))
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

function friendlyMessage(status: number, detail: string): string {
  // 本地「没填 Key」和服务端「Key 被拒」都会走到 401，但用户该做的事完全不同：
  // 前者是去填一个 Key，后者是换一个 Key。用 detail 区分开，别让人白找。
  if (status === 401 && detail === 'missing key') {
    return '还没有填 API Key；如果你用的是网页账号模式，请在设置里把供应商切换成「网页账号」'
  }
  if (status === 401) return 'API Key 无效或已过期，请在设置里重新填写'
  if (status === 402) return '账户余额不足，请到 DeepSeek 平台充值'
  if (status === 429) return '请求太频繁了，等几秒再试'
  if (status === 400) return `请求被拒绝：${detail.slice(0, 180)}`
  if (status === 413) return '附件太大了，请减少图片数量或换小一点的图'
  if (status === 422) return `请求参数不被支持：${detail.slice(0, 180)}`
  if (status >= 500) return 'DeepSeek 服务暂时不可用，稍后再试'
  return `请求失败（${status}）：${detail.slice(0, 180)}`
}

export interface StreamHandlers {
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
  onToolCall?: (call: ToolCall) => void
  onUsage?: (usage: TokenUsage) => void
}

export interface StreamResult {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  /**
   * 参数不是完整 JSON 的那些调用的 id（流被切断时常见）。
   * 它们仍在 toolCalls 里（对话里的 tool_calls / tool 结果要配成对），但引擎**不能执行**，
   * 只回一句「参数被截断了，请重新调用」。
   */
  truncatedToolCallIds: string[]
  usage?: TokenUsage
  finishReason?: string
  aborted: boolean
}

/**
 * 这个供应商需不需要 API Key。
 *
 * 网页账号模式不需要：登录态在 chat.deepseek.com 的 Cookie 里，我们只是遥控
 * 那个已登录的浏览器窗口。以前这里只看 key 是否为空，于是网页模式下必然
 * 抛出「API Key 无效或已过期」——用户明明已经登录了网页，却被要求填 Key。
 */
function hasKey(settings: Settings): boolean {
  // 判定走 isWebChatProvider（以模型为准），别只看供应商协议——
  // 用户是在模型下拉里选网页账号的，供应商可能还是官方那个。
  if (isWebChatProvider(settings)) return true
  const provider = currentProvider(settings)
  return provider.apiKey.trim() !== '' || settings.apiKey.trim() !== ''
}

function headers(settings: Settings): Record<string, string> {
  const provider = currentProvider(settings)
  // 有些调用方只改了 settings.apiKey（onboarding、测试连接），供应商里还是空的。
  // 这种情况下用 settings.apiKey 兜底，避免明明填了 key 却报 missing key。
  if (provider.apiKey.trim() === '' && settings.apiKey.trim() !== '') {
    return chatHeaders({ ...provider, apiKey: settings.apiKey })
  }
  return chatHeaders(provider)
}

/**
 * 从错误响应正文里刨出可读的 message。
 *
 * 各家形状不一样：OpenAI 兼容多是 {"error":{"message":...}}，AMD 那家是
 * {"detail":"Invalid bearer token"}，还有直接回纯文本的 —— 都兜住，
 * 否则用户只能看到「请求被拒绝：」后面跟一段 JSON。
 */
function errorDetailText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string; detail?: string }
    return parsed.error?.message ?? parsed.message ?? parsed.detail ?? text
  } catch {
    return text
  }
}

/** 分片累积的形状直接取自协议层（mergeToolDelta 两家共用一份）。 */
type ToolAccumulator = ToolDraft

/**
 * DeepSeek's 2026 API toggles thinking explicitly and budgets it with
 * reasoning_effort. `off` disables thinking entirely; the other three map to
 * low / high / max (official docs treat "medium" as high).
 */
function openAiThinking(settings: Settings): { thinking?: Record<string, unknown>; reasoningEffort?: string } {
  if (settings.thinkingEffort === 'off') return { thinking: { type: 'disabled' } }
  return { thinking: { type: 'enabled' }, reasoningEffort: settings.thinkingEffort }
}

/** Anthropic 的思考按「预算 token 数」给，按强度映射。 */
const ANTHROPIC_EFFORT_BUDGET: Record<ThinkingEffort, number> = {
  off: 0, low: 1024, high: 4096, max: 8192,
}

/** Gemini 的 thinkingBudget：0 表示不让它想。 */
const GOOGLE_EFFORT_BUDGET: Record<ThinkingEffort, number> = {
  off: 0, low: 1024, high: 4096, max: 8192,
}

/**
 * Anthropic 的思考预算。关闭时不给 thinking 字段。
 * 这里只做「强度 → 想要多少」的映射；`budget_tokens` 必须严格小于 max_tokens
 * 这条纪律在协议层（buildAnthropicBody），因为它各家不同、也最容易被调用方记错。
 */
function anthropicThinkingBudget(settings: Settings): number | undefined {
  const want = ANTHROPIC_EFFORT_BUDGET[settings.thinkingEffort] ?? 0
  return settings.thinkingEffort === 'off' || want <= 0 ? undefined : want
}

/** Gemini 的 thinkingBudget（同上，大小关系由 buildGoogleBody 收）。 */
function googleThinkingBudget(settings: Settings): number | undefined {
  const level = settings.thinkingEffort
  if (level === 'off') return 0
  const want = GOOGLE_EFFORT_BUDGET[level]
  return want > 0 ? want : undefined
}

/** Gemini 把模型名放在路径里，其余协议用固定端点。 */
function requestUrl(provider: ReturnType<typeof currentProvider>, model: string, streaming: boolean): string {
  if (provider.protocol === 'google') return googleStreamUrl(provider.baseUrl, model, streaming)
  return chatEndpoint(provider)
}

function stripReasoning(messages: ChatRequestMessage[]): ChatRequestMessage[] {
  return messages.map((message) => {
    if (message.reasoning_content === undefined) return message
    const copy = { ...message }
    delete copy.reasoning_content
    return copy
  })
}

/**
 * Stream one assistant turn. The caller owns conversation state; this function
 * only turns SSE bytes into text, reasoning, tool-call drafts and usage.
 */
export async function streamChat(options: {
  settings: Settings
  messages: ChatRequestMessage[]
  tools?: unknown[]
  signal?: AbortSignal
  handlers?: StreamHandlers
  /** App 对话 id：网页账号的 HTTP 模式用它映射到网页线程。 */
  conversationId?: string
  /**
   * 网页账号模式要带过去的人设稳定块（人设 + 常驻记忆）。
   * 由上层用 web-context.ts 的 buildWebChatContext 拼好——这里只负责传，
   * 不自己从 messages 里刨 system：那样会把每轮都变的身体/时间/摘要一起带进去，
   * 「变了才重拼」的去重就永远失效。
   */
  webContext?: string
  /**
   * 这一轮是不是「改写历史」（编辑重发 / 重新生成）。
   *
   * 网页会话只能追加：App 侧把旧消息改了或删了，网页那边那条还在。补一句说明，
   * 模型才知道该以哪一条为准，不至于把两份都当真。
   */
  webRewrite?: 'edit' | 'regenerate'
  /**
   * 覆盖这一轮要发的输出上限（见 budget.ts 的 retryCap）。
   *
   * 引擎在「思考把额度吃光、正文和工具都是空的」时会用翻倍的上限**原地重试一次**，
   * 不改历史、不重新组请求。平时不传。
   */
  maxTokensOverride?: number
}): Promise<StreamResult> {
  const { settings, tools, signal, handlers } = options
  if (!hasKey(settings)) throw new ApiError(401, 'missing key')

  const provider = currentProvider(settings)
  const protocol = provider.protocol
  let messages = options.messages

  // 网页账号模式：不发 HTTP 到开放 API，改走 chat.deepseek.com 的会话接口。
  // 判定看「模型」而不只是供应商协议——用户是在模型下拉里选它的。
  if (isWebChatProvider(settings)) {
    return await streamViaWebChat({ ...options, conversationId: options.conversationId })
  }

  // 输出上限：正文预算 + 思考预留，见 budget.ts 的注释。
  // 以前这里直接把 settings.maxTokens 当上限发出去，而推理模型的 max_tokens 是
  // reasoning_content 与 content **共用**的整段额度 —— 长思考一撞顶，正文与
  // tool_calls 双双为空，工坊看起来「根本没被调用」。
  const cap = resolveOutputCap(settings, provider)
  const limit = options.maxTokensOverride ?? cap.cap
  // 正文预算填 0（自动）→ null → 干脆不发这个字段（Anthropic 必填，由协议层兜一个尽量大的值）。
  const effective = limit ?? cap.modelMax ?? undefined

  /**
   * 按当前消息与上限拼请求体。三个协议的形状差异全在 protocols.ts 里，
   * 这里只负责把**数字**递过去（正文预算 + 思考预留 = budget.ts，思考预算与上限的大小关系由协议层保证）。
   *
   * 做成函数是因为 400 退避要能用另一个上限重来一次；早先是 const body + 事后改字段，
   * 那等于在传输层抄了一份「各家的上限字段放在哪」的知识，两处很容易走偏。
   */
  const buildBody = (maxTokens: number | undefined): Record<string, unknown> => protocol === 'openai'
    // OpenAI 兼容：走原来的构造（含 thinking / reasoning_effort），这是我们的原生形态。
    ? buildOpenAiBody({
      model: settings.model,
      messages,
      temperature: settings.temperature,
      maxTokens,
      tools,
      stream: true,
      includeUsage: true,
      ...openAiThinking(settings),
    })
    : protocol === 'anthropic'
      ? buildAnthropicBody({
        model: settings.model,
        messages,
        temperature: settings.temperature,
        maxTokens,
        tools,
        stream: true,
        thinkingBudget: anthropicThinkingBudget(settings),
      })
      : buildGoogleBody({
        messages,
        temperature: settings.temperature,
        maxTokens,
        thinkingBudget: googleThinkingBudget(settings),
        // 工坊工具以前在这里就断了 —— buildGoogleBody 的签名里没有 tools，
        // Gemini 下四个工具静默消失（P1-11）。
        tools,
      })

  let body = buildBody(effective)

  /* ---------------- 流式解析状态（与传输层无关） ---------------- */
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let usage: TokenUsage | undefined
  const toolDrafts = new Map<number, ToolAccumulator>()
  let buffer = ''

  const handlePayload = (payload: string): boolean => {
    if (payload === '[DONE]') return true

    // 非 OpenAI 协议：交给适配层归一化成同一组增量。
    if (protocol !== 'openai') {
      const delta = protocol === 'anthropic' ? parseAnthropicEvent(payload) : parseGoogleEvent(payload)
      if (delta === null) return false
      if (delta.usage !== undefined) {
        usage = delta.usage
        handlers?.onUsage?.(usage)
      }
      if (delta.reasoning !== undefined && delta.reasoning !== '') {
        reasoning += delta.reasoning
        handlers?.onReasoning?.(delta.reasoning)
      }
      if (delta.text !== undefined && delta.text !== '') {
        content += delta.text
        handlers?.onDelta?.(delta.text)
      }
      if (delta.toolCallDelta !== undefined) {
        // Anthropic：按 content_block 的序号累积 partial_json，流结束才在 finalizeTools 定稿。
        mergeToolDelta(toolDrafts, delta.toolCallDelta)
      }
      if (delta.toolCall !== undefined) {
        // Google：functionCall 整块给出，接在已有草稿后面。
        mergeToolDelta(toolDrafts, {
          index: toolDrafts.size,
          id: delta.toolCall.id ?? '',
          name: delta.toolCall.name,
          arguments: delta.toolCall.arguments,
        })
      }
      if (delta.finishReason !== undefined) finishReason = delta.finishReason
      return delta.done === true
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return false
    }
    const chunk = parsed as {
      error?: { message?: string }
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_content?: string
          tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string | null
      }>
    }
    if (chunk.error?.message) throw new Error(chunk.error.message)
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      }
      handlers?.onUsage?.(usage)
    }
    const choice = chunk.choices?.[0]
    if (choice === undefined) return false
    const delta = choice.delta
    if (delta?.reasoning_content) {
      reasoning += delta.reasoning_content
      handlers?.onReasoning?.(delta.reasoning_content)
    }
    if (delta?.content) {
      content += delta.content
      handlers?.onDelta?.(delta.content)
    }
    if (delta?.tool_calls) {
      // 与 Anthropic 共用同一条累积路径：两家的分片语义一样，只是 index 的来源
      // 和参数键名不同（arguments / partial_json）。
      for (const part of delta.tool_calls) {
        mergeToolDelta(toolDrafts, {
          index: part.index,
          id: part.id,
          name: part.function?.name,
          arguments: part.function?.arguments,
        })
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
    return false
  }

  /**
   * 收流：把草稿定稿成工具调用，并组装返回值。
   * 两个出口（读到 [DONE] / 流自然结束或被中断）共用一份，避免其中一处漏了字段。
   */
  const finish = (isAborted: boolean): StreamResult => {
    const finalized = finalizeTools(toolDrafts, handlers)
    return {
      content,
      reasoning,
      toolCalls: finalized.calls,
      truncatedToolCallIds: finalized.truncatedIds,
      usage,
      finishReason,
      aborted: isAborted,
    }
  }

  /** 把一段原始文本喂给 SSE 解析器；返回 true 表示收到 [DONE]。 */
  const consume = (chunk: string): boolean => {
    buffer += chunk
    while (true) {
      const separator = /\r?\n\r?\n/.exec(buffer)
      if (separator === null) break
      const rawEvent = buffer.slice(0, separator.index)
      buffer = buffer.slice(separator.index + separator[0].length)
      const payload = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (payload !== '' && handlePayload(payload)) return true
    }
    return false
  }

  const resetStream = (): void => {
    content = ''
    reasoning = ''
    finishReason = undefined
    usage = undefined
    toolDrafts.clear()
    buffer = ''
  }

  /**
   * 发一次请求并读完正文。
   *
   * 走 net.ts 的传输层（桌面主进程 / Android 原生 / 浏览器 fetch 三选一）——
   * 第三方接口大多不带 CORS 响应头，在 WebView 里直接 fetch 只会得到
   * `Failed to fetch`，换网络、开加速器都没用（详见 net.ts 顶部注释）。
   * 非 2xx 的正文是 JSON 错误体，不喂给 SSE 解析器，原样交给 400 退避判断。
   */
  const runOnce = async (): Promise<{ status: number; errorText: string }> => {
    resetStream()
    let status = 0
    let sawErrorStatus = false
    let payloadError: Error | null = null
    let done = false
    const payload = protocol === 'openai'
      ? { ...body, messages, ...(includeUsage ? { stream_options: { include_usage: true } } : {}) }
      : body
    const response = await netStream(
      {
        url: requestUrl(provider, settings.model, true),
        method: 'POST',
        headers: headers(settings),
        body: JSON.stringify(payload),
        signal,
      },
      {
        onStatus: (next) => {
          status = next
          sawErrorStatus = next >= 400
        },
        onChunk: (chunk) => {
          if (payloadError !== null || sawErrorStatus) return
          try {
            if (!done && consume(chunk)) done = true
          } catch (error) {
            payloadError = error instanceof Error ? error : new Error(String(error))
          }
        },
      },
    )
    if (payloadError !== null) throw payloadError
    return { status: response.status, errorText: response.status >= 400 ? response.text : '' }
  }

  let sentLimit = effective
  let includeUsage = true
  for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
    let outcome: { status: number; errorText: string }
    try {
      outcome = await runOnce()
    } catch (error) {
      if (signal?.aborted || (error instanceof NetError && error.kind === 'aborted')) {
        return finish(true)
      }
      throw error instanceof Error ? error : new Error('网络连接失败')
    }
    if (outcome.status < 400) return finish(false)
    if (outcome.status !== 400) throw new ApiError(outcome.status, outcome.errorText || '请求失败')

    // Compatibility fallback: older gateways and some proxies reject new fields.
    // Peel off only the capability the error actually names, then retry once more.
    const detail = outcome.errorText
    let changed = false
    if (detail.includes('stream_options') && includeUsage) {
      includeUsage = false
      changed = true
    }
    if (detail.includes('reasoning_effort') || detail.includes('thinking')) {
      if (body.thinking !== undefined || body.reasoning_effort !== undefined) {
        delete body.thinking
        delete body.reasoning_effort
        changed = true
      }
    }
    if (detail.includes('reasoning_content')) {
      messages = stripReasoning(messages)
      changed = true
    }
    if (detail.includes('max_tokens') || detail.includes('budget_tokens')) {
      // 抬高的上限被中转站拒了：退回「正文预算」，用协议层重新拼一次请求体。
      // 填 0（自动，本来就没发这个字段）时无从退起，直接说清楚，不空转。
      const current = sentLimit
      if (cap.body > 0 && (current === undefined || cap.body < current)) {
        sentLimit = cap.body
        body = buildBody(cap.body)
        changed = true
      }
    }
    if (!changed) throw new ApiError(400, detail)
  }
  throw new ApiError(400, '请求被拒绝：按兼容性退避重试后仍然返回 400')
}

/**
 * 网页会话只能追加，改写历史时给模型补的一句说明。
 *
 * App 里「编辑重发」改的是本地历史，「重新生成」删的是本地那条回复；网页线程里
 * 旧消息和旧回复都还在。没有这句说明，模型会看到同一件事的两个版本，容易答串。
 */
const REWRITE_NOTES: Record<'edit' | 'regenerate', string> = {
  edit: '（说明：我改写了前面那条消息，请以这一条为准，之前那条作废。）',
  regenerate: '（说明：请重新回答这条消息，以这一次的回答为准。）',
}

/**
 * 网页账号模式的一轮回复。
 *
 * 把「system + 最近若干轮」压成一段话交给隐藏网页窗；回话靠轮询 DOM 拿。
 * 没有原生 function-calling，所以工具调用在这里恒为空 —— 上层据此提示用户
 * 切回 API 模式。
 */
async function streamViaWebChat(options: {
  settings: Settings
  messages: ChatRequestMessage[]
  /** 人设 + 常驻记忆的稳定块；只在网页线程首轮（或它真的变了之后）拼进去。 */
  webContext?: string
  /** 这一轮是不是改写历史（编辑重发 / 重新生成）。 */
  webRewrite?: 'edit' | 'regenerate'
  /** App 对话 id：HTTP 模式用它把对话映射到网页线程。 */
  conversationId?: string
  signal?: AbortSignal
  handlers?: StreamHandlers
}): Promise<StreamResult> {
  const { messages, signal, handlers } = options
  const images = lastUserImages(messages)
  const prompt = buildWebChatPrompt(messages)
  if (prompt.trim() === '' && images.length === 0) {
    throw new ApiError(400, '这段话里没有可以发给网页的内容')
  }
  const basePrompt = prompt.trim() === '' ? '请看这张图片。' : prompt
  // 网页会话只追加，改写历史时补一句说明，别让模型把旧的那份也当真。
  const note = options.webRewrite === undefined ? '' : REWRITE_NOTES[options.webRewrite]
  const sent = note === '' ? basePrompt : note + '\n\n' + basePrompt

  let last = ''
  let lastThought = ''
  const reply = await sendViaWebChat(sent, {
    // HTTP 模式靠它把 App 对话映射到网页线程；DOM 遥控用不到。
    conversationKey: options.conversationId ?? 'default',
    thinking: options.settings.thinkingEffort !== 'off',
    // 图片附件：HTTP 模式先上传拿 file_id，再放进 ref_file_ids。
    images: images.length > 0 ? images : undefined,
    // 人设 + 常驻记忆：HTTP 模式由主进程在建线程的首轮拼进去，
    // DOM 遥控则由中继脚本的 setContext 负责。没有它，网页那边的模型
    // 完全不知道自己是「深鲸」。
    systemPrompt: options.webContext ?? '',
    signal,
    onDelta: (full) => {
      // 桥接层给的是完整正文；这里 diff 出增量再交给上层，保持和 SSE 一致的行为。
      if (full.length <= last.length) return
      const delta = full.slice(last.length)
      last = full
      handlers?.onDelta?.(delta)
    },
    onReasoning: (full) => {
      // 网页版的思考块也是一段一段长出来的；同样 diff 成增量往上抛，
      // 否则「已思考」面板要等整条回复结束才出现内容。
      if (full.length <= lastThought.length) return
      const delta = full.slice(lastThought.length)
      lastThought = full
      handlers?.onReasoning?.(delta)
    },
  })

  if (reply.status === 'unsupported') {
    throw new ApiError(400, reply.message ?? '这个版本不支持网页账号模式')
  }
  if (reply.status === 'no-session') {
    // 登录态没了/过期：让上层引导用户重新登录，而不是抛一个看不懂的错。
    throw new ApiError(401, reply.message ?? '网页登录过期了，请在设置里重新登录一次网页账号')
  }
  if (reply.status === 'no-window') {
    throw new ApiError(400, reply.message ?? '网页窗还没打开')
  }
  if (reply.status === 'no-input') {
    throw new ApiError(400, reply.message ?? '网页那边没发出去')
  }
  if (reply.status === 'timeout' && reply.content.trim() === '') {
    throw new ApiError(504, reply.message ?? '网页那边太久没回')
  }

  return {
    content: reply.content,
    // 网页版的「深度思考」折叠块会一起带回来；抓不到就是空串，不影响正文。
    reasoning: (reply.reasoning ?? '').trim(),
    // 网页账号没有 function-calling，工具恒为空。
    toolCalls: [],
    truncatedToolCallIds: [],
    aborted: signal?.aborted === true,
  }
}

/**
 * 把对话压成一段可读的文本交给网页版。
 *
 * 网页版是多轮会话：线程建好后它自己记得上下文，所以这里**只发最后一条用户消息**，
 * 不再重放历史（重放会撑长输入、也容易和网页侧记的上下文打架）。
 *
 * 人设与记忆单独走 `webContext`（人设 + 常驻记忆的稳定块）：HTTP 模式由主进程
 * 在网页线程首轮拼进去（见 web-chat 的 systemPrompt 参数），DOM 遥控则由中继脚本
 * 的 setContext 负责。两边都不在这里拼，避免重复灌入。
 */
/** 取最后一条用户消息里的图片附件（contentForApi 已把图片变成 image_url data URL）。 */
function lastUserImages(messages: ChatRequestMessage[]): { dataUrl: string; name: string }[] {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  if (lastUser === undefined || typeof lastUser.content === 'string') return []
  const out: { dataUrl: string; name: string }[] = []
  let index = 0
  for (const part of lastUser.content) {
    if (part.type !== 'image_url') continue
    index += 1
    out.push({ dataUrl: part.image_url.url, name: `image-${index}.png` })
  }
  return out
}

function buildWebChatPrompt(messages: ChatRequestMessage[]): string {  const textOf = (content: ChatRequestMessage['content']): string => {
    if (typeof content === 'string') return content
    return content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter((part) => part !== '')
      .join('\n')
  }

  const dialogue = messages.filter((message) => message.role === 'user' || message.role === 'assistant')
  if (dialogue.length === 0) return ''

  // 只要最后一条用户消息：网页服务端已经保存了前面几轮。
  const lastUser = [...dialogue].reverse().find((message) => message.role === 'user')
  if (lastUser === undefined) return ''
  return textOf(lastUser.content).trim()
}

interface FinalizedTools {
  calls: ToolCall[]
  /** 参数不是完整 JSON 的调用 id —— 仍在 calls 里，但引擎不许执行（见 StreamResult）。 */
  truncatedIds: string[]
}

/**
 * 把工具草稿定稿成完整调用。
 *
 * 流被中断 / 长度切断时 `arguments` 常常只剩半截（写到一半的文件内容）。
 * 半截 JSON 绝不能当成真实调用交给引擎 —— workspace.ts 的 write_file 会拿这份
 * 残缺内容覆盖工坊里原本好好的文件。所以这里校验一次：解析不了的标出来，
 * 由引擎回一条「参数被截断，请重新调用」的 tool 结果（执行闸门在 engine.ts）。
 *
 * 仍然留在 calls 里而不是直接丢掉：对话历史里 tool 消息必须和 assistant 的
 * tool_calls 配对，供应商会拒孤儿 tool 消息。
 */
function finalizeTools(drafts: Map<number, ToolAccumulator>, handlers?: StreamHandlers): FinalizedTools {
  const calls: ToolCall[] = []
  const truncatedIds: string[] = []
  // 顺序（按块 / 分片序号）由协议层统一排，省得两家公司各排一次队。
  finalizedToolDrafts(drafts).forEach((draft, index) => {
    if (draft.name === '') return
    const args = draft.arguments || '{}'
    const call: ToolCall = {
      id: draft.id || `call_${index}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: draft.name, arguments: args },
    }
    calls.push(call)
    if (!isCompleteToolArguments(args)) {
      truncatedIds.push(call.id)
      return
    }
    handlers?.onToolCall?.(call)
  })
  return { calls, truncatedIds }
}

/** One non-streaming JSON completion, used by memory extraction. */
export async function completeJson(options: {
  settings: Settings
  system: string
  user: string
  maxTokens?: number
  signal?: AbortSignal
}): Promise<unknown> {
  const { settings, system, user, signal } = options
  if (!hasKey(settings)) throw new ApiError(401, 'missing key')
  const provider = currentProvider(settings)
  const protocol = provider.protocol
  const model = settings.memoryModel || settings.model
  const jsonMode = protocol === 'openai'

  const buildBody = (): Record<string, unknown> => {
    const messages: ChatRequestMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]
    if (protocol === 'openai') {
      return {
        model,
        messages,
        temperature: 0.2,
        max_tokens: options.maxTokens ?? 900,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }
    }
    if (protocol === 'anthropic') {
      // 用 user 消息里明确要求只输出 JSON，Anthropic 没有 response_format。
      return buildAnthropicBody({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `${user}\n\n只输出 JSON，不要任何解释或代码块标记。` },
        ],
        temperature: 0.2,
        maxTokens: options.maxTokens ?? 900,
        stream: false,
      })
    }
    return buildGoogleBody({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${user}\n\n只输出 JSON，不要任何解释或代码块标记。` },
      ],
      temperature: 0.2,
      maxTokens: options.maxTokens ?? 900,
    })
  }

  const send = async (): Promise<NetResponse> =>
    netRequest({
      url: requestUrl(provider, model, false),
      method: 'POST',
      headers: headers(settings),
      signal,
      body: JSON.stringify(buildBody()),
    })

  let response = await send()
  if (protocol === 'openai' && response.status === 400) {
    const detail = errorDetailText(response.text)
    if (detail.includes('response_format')) {
      // 有些中转站不认 response_format，去掉再试一次。
      response = await netRequest({
        url: requestUrl(provider, model, false),
        method: 'POST',
        headers: headers(settings),
        signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
          max_tokens: options.maxTokens ?? 900,
        }),
      })
    } else {
      throw new ApiError(400, detail)
    }
  }
  if (response.status >= 400) throw new ApiError(response.status, errorDetailText(response.text))
  let json: unknown
  try {
    json = JSON.parse(response.text) as unknown
  } catch {
    throw new Error('模型返回的不是 JSON')
  }
  const raw = parseCompleteContent(protocol, json)
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    throw new Error('模型没有返回可解析的 JSON')
  }
}

/** Cheap key/endpoint check; costs one token at most. */
export async function testConnection(settings: Settings): Promise<void> {
  if (!hasKey(settings)) throw new ApiError(401, 'missing key')
  const provider = currentProvider(settings)
  // 网页账号模式没有开放接口可测：只看登录态是否可用。
  // 注意这里**不能**要求网页窗开着——HTTP 模式下窗口关掉照样能聊。
  if (isWebChatProvider(settings)) {
    if (!webChatAvailable()) throw new ApiError(400, '这个版本不支持网页账号；请用安装版')
    if (!(await webChatLoggedIn())) {
      throw new ApiError(400, '网页账号还没登录，或登录已过期；请在设置里重新登录一次')
    }
    return
  }
  const body = provider.protocol === 'openai'
    ? {
      model: settings.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }
    : provider.protocol === 'anthropic'
      ? buildAnthropicBody({
        model: settings.model,
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0.2,
        maxTokens: 1,
        stream: false,
      })
      : buildGoogleBody({
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0.2,
        maxTokens: 1,
      })
  const response = await netRequest({
    url: requestUrl(provider, settings.model, false),
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify(body),
  })
  if (response.status >= 400) throw new ApiError(response.status, errorDetailText(response.text))
}
