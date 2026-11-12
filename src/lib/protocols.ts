import type { ChatRequestMessage, ProviderProtocol, TokenUsage, ToolCall } from './types'

/**
 * 三种协议的差异都收在这里：怎么拼请求体、怎么把流式事件读成统一增量。
 * 上层（deepseek.ts / engine.ts）只看见「文本 / 思考 / 工具调用 / 用量」四样东西。
 */

export interface StreamDelta {
  text?: string
  reasoning?: string
  /** 完整的一次工具调用（Google 是整块给出，OpenAI 是分片累积）。 */
  toolCall?: { id?: string; name: string; arguments: string }
  /**
   * Anthropic 的工具调用**不是一条完整 JSON**：先 content_block_start 报
   * 「这里有个 tool_use」，再按块序号滴 input_json_delta.partial_json，块结束才齐。
   * 所以这里给增量，由 mergeToolDelta 按 block index 累积。
   *
   * 以前的写法是在 content_block_start 就发 `arguments: JSON.stringify(block.input ?? {})`
   * —— 那一刻 input 恒为空对象，于是每个 write_file 都带着一对空参数真的跑进执行器，
   * 工坊必然抛「content 必须是字符串」：看起来「工具调用了但什么都没写」。
   */
  toolCallDelta?: { index?: number; id?: string; name?: string; partial?: string }
  usage?: TokenUsage
  finishReason?: string
  /** 收到这个就可以收尾了。 */
  done?: boolean
}

/** 一条工具调用的草稿（分片累积用；OpenAI 与 Anthropic 归到同一个形状）。 */
export interface ToolDraft {
  id: string
  name: string
  arguments: string
}

/**
 * 把一段工具增量并进 drafts。
 *
 * 名字与参数都是**追加**而不是覆盖：两家都会把一段参数拆成很多片滴完。
 * id 只在出现时替换（Anthropic 在开块时给全，OpenAI 一般只在第一片给）。
 */
export function mergeToolDelta(
  drafts: Map<number, ToolDraft>,
  part: { index?: number; id?: string; name?: string; arguments?: string; partial?: string },
): void {
  const index = part.index ?? 0
  const current = drafts.get(index) ?? { id: '', name: '', arguments: '' }
  if (part.id !== undefined && part.id !== '') current.id = part.id
  if (part.name !== undefined) current.name += part.name
  if (part.arguments !== undefined) current.arguments += part.arguments
  if (part.partial !== undefined) current.arguments += part.partial
  drafts.set(index, current)
}

/** 按块序号取出草稿（定稿与参数校验在 deepseek.ts 的 finalizeTools，那里统一管两家）。 */
export function finalizedToolDrafts(drafts: Map<number, ToolDraft>): ToolDraft[] {
  return [...drafts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1])
}

/**
 * 「自动」（正文预算填 0）时 Anthropic 用的输出上限。
 *
 * Anthropic 的 max_tokens 是必填字段，不能像另两家那样干脆不发，
 * 只能给一个尽量大的值 —— 上游也是这个做法（ClaudeProvider.kt 默认 64_000，
 * 我们保守一档，免得中转站嫌大）。
 */
export const ANTHROPIC_AUTO_MAX_TOKENS = 32768

/**
 * OpenAI 兼容协议：我们的原生格式，也是内部统一的中间表示。
 *
 * `maxTokens` 可空 = **不发这个字段**（对齐上游「留空表示无限制」）：
 * 推理模型的 max_tokens 限的是整段输出（思考 + 正文共用），一个偏小的固定值
 * 会把正文和工具调用一起砍没，所以「不限制」必须能真的表达出来。
 */
export function buildOpenAiBody(options: {
  model: string
  messages: ChatRequestMessage[]
  temperature: number
  maxTokens?: number
  tools?: unknown[]
  stream: boolean
  includeUsage?: boolean
  thinking?: Record<string, unknown>
  reasoningEffort?: string
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    temperature: options.temperature,
  }
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stream) body.stream = true
  if (options.includeUsage === true) body.stream_options = { include_usage: true }
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools
    body.tool_choice = 'auto'
  }
  if (options.thinking !== undefined) body.thinking = options.thinking
  if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort
  return body
}

/* ------------------------------------------------------------- Anthropic */

/**
 * 拆内联数据 URL：`data:image/png;base64,AAAA` → `{ mime, base64 }`。
 *
 * 三种协议的图片块都要这两样，所以只写一份。mime 后面可能还挂参数段
 * （`;charset=utf-8`），容忍掉；非 base64（http 外链、脏串）返回 null，
 * 由调用方退回文字占位 —— 我们没有任何能力替用户去下载外链。
 */
export function splitDataUrl(url: string): { mime: string; base64: string } | null {
  const matched = /^data:([^;,]+)[^,]*;base64,([\s\S]+)$/.exec(url)
  if (matched === null) return null
  const mime = matched[1].trim()
  const base64 = matched[2].trim()
  if (mime === '' || base64 === '') return null
  return { mime, base64 }
}

/**
 * 捏出一条消息的正文与图片。
 *
 * `withImages` 只有 user 轮传 true：Anthropic 不允许 assistant 发图片块，Google 也
 * 没必要，其余轮次（含 tool 结果）照旧把图片压成 `[图片]` 文字。
 *
 * 注意纯文本对话的结果：`segments` 逐段收文本、用 `\n` 连接，与改动前那行
 * `.map(part => part.type === 'text' ? part.text : '[图片]').join('\n')`
 * 在没有图片时**逐字节一致** —— 有单测锁这一点，免得修图片顺手改了普通对话。
 */
function splitMessageContent(
  message: ChatRequestMessage,
  withImages: boolean,
): { text: string; images: Array<{ mime: string; base64: string }> } {
  if (typeof message.content === 'string') return { text: message.content, images: [] }
  const segments: string[] = []
  const images: Array<{ mime: string; base64: string }> = []
  for (const part of message.content) {
    if (part.type === 'text') {
      segments.push(part.text)
      continue
    }
    const parsed = withImages ? splitDataUrl(part.image_url.url) : null
    if (parsed === null) {
      // 解不出 base64 才占位；这是「发不出去」而不是「模型不能看」。
      segments.push('[图片]')
      continue
    }
    images.push(parsed)
  }
  return { text: segments.join('\n'), images }
}

interface AnthropicBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
}

/** Anthropic 把 system 提到顶层，messages 里只能有 user/assistant。 */
function toAnthropicMessages(messages: ChatRequestMessage[]): {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }>
} {
  const systemParts: string[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = []

  for (const message of messages) {
    const isUser = message.role === 'user'
    const { text, images } = splitMessageContent(message, isUser)

    if (message.role === 'system') {
      systemParts.push(text)
      continue
    }
    if (message.role === 'tool') {
      // Anthropic 的工具结果是一条 user 消息里的 tool_result 块。
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id ?? '',
          content: text,
        }],
      })
      continue
    }
    if (message.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = []
      if (text !== '') blocks.push({ type: 'text', text })
      for (const call of message.tool_calls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(call.function.arguments || '{}') } catch { input = {} }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text }] })
      continue
    }
    const blocks: Array<Record<string, unknown>> = []
    // 只有真的一张图都没有时才留那个空文本块（纯文本对话要跟改动前逐字节一致）；
    // 带图时不塞空 text 块，Anthropic 会嫌它多余。
    if (text !== '' || images.length === 0) blocks.push({ type: 'text', text })
    for (const image of images) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mime, data: image.base64 },
      })
    }
    out.push({ role: 'user', content: blocks })
  }
  return { system: systemParts.join('\n\n'), messages: out }
}

export function buildAnthropicBody(options: {
  model: string
  messages: ChatRequestMessage[]
  temperature: number
  maxTokens?: number
  tools?: unknown[]
  stream: boolean
  thinkingBudget?: number
}): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(options.messages)
  // max_tokens 必填：没给就退到「尽量大」那一档（见 ANTHROPIC_AUTO_MAX_TOKENS）。
  const maxTokens = options.maxTokens ?? ANTHROPIC_AUTO_MAX_TOKENS
  // Anthropic 要求 `thinking.budget_tokens` **严格小于** max_tokens。
  // 以前这里 budget 4096 与 max_tokens 4096 一起发，直接 400；而 deepseek.ts 的
  // 400 退避只会剥 stream_options / thinking / reasoning_effort / reasoning_content，
  // 修不好这个搭配 —— 接 Anthropic 中转的用户是「每次必失败」。
  // 规则留在这里（协议层），调用方只管把「正文预算 + 思考预留」的数字递进来。
  let thinkingBudget = options.thinkingBudget
  if (thinkingBudget !== undefined) {
    thinkingBudget = Math.min(thinkingBudget, maxTokens - 1024)
    // 连 1024 都放不下就干脆不开思考：半开的请求体只会换来一个看不懂的 400。
    if (thinkingBudget < 1024) thinkingBudget = undefined
  }
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: maxTokens,
    // 开着推理时**不发** temperature（Anthropic 要求恒为 1，带着 0.7 就是必 400；
    // 上游 ClaudeProvider.kt:447 也是「开推理就不发」）。位置留在 messages 前面，
    // 纯文本、不开思考的请求体因此与改动前逐字节一致。
    ...(thinkingBudget === undefined ? { temperature: options.temperature } : {}),
    messages,
  }
  if (system !== '') body.system = system
  if (options.stream) body.stream = true
  if (thinkingBudget !== undefined) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget }
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    // 把 OpenAI 的函数定义翻成 Anthropic 的 input_schema 形状。
    body.tools = options.tools.map((raw) => {
      const tool = raw as { function?: { name?: string; description?: string; parameters?: unknown } }
      return {
        name: tool.function?.name ?? 'tool',
        description: tool.function?.description ?? '',
        input_schema: tool.function?.parameters ?? { type: 'object', properties: {} },
      }
    })
  }
  return body
}

/** 解析 Anthropic 的一个 SSE data 负载。 */
export function parseAnthropicEvent(payload: string): StreamDelta | null {
  if (payload === '[DONE]') return { done: true }
  let parsed: unknown
  try { parsed = JSON.parse(payload) } catch { return null }
  const event = parsed as {
    type?: string
    index?: number
    delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string; partial_json?: string }
    content_block?: AnthropicBlock
    usage?: { input_tokens?: number; output_tokens?: number }
    message?: { usage?: { input_tokens?: number; output_tokens?: number } }
    error?: { message?: string }
  }
  if (event.error?.message) throw new Error(event.error.message)

  const usageOf = (u?: { input_tokens?: number; output_tokens?: number }): TokenUsage | undefined => {
    if (u === undefined) return undefined
    const input = u.input_tokens ?? 0
    const output = u.output_tokens ?? 0
    return { inputTokens: input, outputTokens: output, totalTokens: input + output }
  }

  switch (event.type) {
    case 'message_start':
      return { usage: usageOf(event.message?.usage) }
    case 'content_block_delta': {
      const delta = event.delta
      if (delta?.type === 'text_delta' && delta.text !== undefined) return { text: delta.text }
      if (delta?.type === 'thinking_delta' && delta.thinking !== undefined) return { reasoning: delta.thinking }
      // 工具参数是一段一段滴下来的 partial_json（键名在 delta 里，值不带引号转义），
      // 按 content_block 的序号累积 —— 这个分支以前不存在，参数于是全丢。
      if (delta?.type === 'input_json_delta') {
        const partial = delta.partial_json
        if (partial !== undefined) return { toolCallDelta: { index: event.index, partial } }
      }
      return null
    }
    case 'content_block_start': {
      const block = event.content_block
      if (block?.type === 'tool_use') {
        // 只报「这里开了一个 tool_use 块」。**不许**在这里交参数：
        // 此刻 block.input 恒为 {}，发出去就是一个空参 write_file。
        return { toolCallDelta: { index: event.index, id: block.id, name: block.name ?? 'tool' } }
      }
      return null
    }
    case 'message_delta':
      return { usage: usageOf(event.usage), finishReason: event.delta?.stop_reason }
    case 'message_stop':
      return { done: true }
    default:
      return null
  }
}

/* ---------------------------------------------------------------- Google */

function toGoogleContents(messages: ChatRequestMessage[]): {
  systemInstruction: { parts: Array<{ text: string }> } | undefined
  contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }>
} {
  const systemParts: string[] = []
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = []

  for (const message of messages) {
    const isUser = message.role === 'user'
    const { text, images } = splitMessageContent(message, isUser)
    if (message.role === 'system') { systemParts.push(text); continue }
    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: message.name ?? 'tool', response: { result: text } } }],
      })
      continue
    }
    const role = message.role === 'assistant' ? 'model' : 'user'
    const parts: Array<Record<string, unknown>> = []
    // Gemini 的内联图片就是 `{ inlineData: { mimeType, data } }`，和 text 平级放在
    // 同一个 parts 数组里。同样只在 user 轮发，理由见 splitMessageContent。
    if (text !== '' || images.length === 0) parts.push({ text })
    for (const image of images) {
      parts.push({ inlineData: { mimeType: image.mime, data: image.base64 } })
    }
    contents.push({ role, parts })
  }
  return {
    systemInstruction: systemParts.length > 0 ? { parts: systemParts.map((text) => ({ text })) } : undefined,
    contents,
  }
}

export function buildGoogleBody(options: {
  messages: ChatRequestMessage[]
  temperature: number
  maxTokens?: number
  thinkingBudget?: number
  /**
   * 工坊工具。以前这个签名里**没有 tools**，engine 递进来的四个工坊工具在
   * Gemini 下静默消失 —— 症状和「模型懒得调用工具」一模一样，日志里一个字都没有
   * （BUG-REVIEW P1-11）。
   */
  tools?: unknown[]
}): Record<string, unknown> {
  const { systemInstruction, contents } = toGoogleContents(options.messages)
  const generationConfig: Record<string, unknown> = { temperature: options.temperature }
  // 可空 = 不发这个字段（正文预算填 0 就是「自动」，见 budget.ts）。
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens
  if (options.thinkingBudget !== undefined) {
    // 与 Anthropic 同一条纪律：思考预算要小于输出上限。上限不够就削到「留 1 个给正文」，
    // 宁可不思考也别发一个必被拒的搭配。
    let budget = options.thinkingBudget
    const limit = options.maxTokens
    if (limit !== undefined && budget >= limit) budget = Math.max(0, limit - 1)
    generationConfig.thinkingConfig = { thinkingBudget: budget }
  }
  const body: Record<string, unknown> = {
    contents,
    generationConfig,
  }
  if (systemInstruction !== undefined) body.systemInstruction = systemInstruction
  if (options.tools !== undefined && options.tools.length > 0) {
    // OpenAI 的函数定义翻成 Gemini 的 functionDeclarations：只有 name / description /
    // parameters，且 parameters 要有 type:'object' 兜底，否则整条声明被服务端丢掉。
    body.tools = [{
      functionDeclarations: options.tools.map((raw) => {
        const tool = raw as { function?: { name?: string; description?: string; parameters?: unknown } }
        const declaration: Record<string, unknown> = {
          name: tool.function?.name ?? 'tool',
          parameters: tool.function?.parameters ?? { type: 'object', properties: {} },
        }
        if (tool.function?.description !== undefined) declaration.description = tool.function.description
        return declaration
      }),
    }]
    // AUTO = 模型自己决定要不要调；要强制并行/必调时才改 functionCallingConfig.mode。
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
  }
  return body
}

/** 解析 Gemini 的一个 SSE data 负载。 */
export function parseGoogleEvent(payload: string): StreamDelta | null {
  if (payload === '[DONE]') return { done: true }
  let parsed: unknown
  try { parsed = JSON.parse(payload) } catch { return null }
  const chunk = parsed as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown } }> }
      finishReason?: string
    }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    error?: { message?: string }
  }
  if (chunk.error?.message) throw new Error(chunk.error.message)

  const delta: StreamDelta = {}
  if (chunk.usageMetadata !== undefined) {
    const u = chunk.usageMetadata
    delta.usage = {
      inputTokens: u.promptTokenCount,
      outputTokens: u.candidatesTokenCount,
      totalTokens: u.totalTokenCount,
    }
  }
  const candidate = chunk.candidates?.[0]
  if (candidate !== undefined) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text !== undefined) {
        // thought: true 的那部分是思考内容。
        if (part.thought === true) delta.reasoning = (delta.reasoning ?? '') + part.text
        else delta.text = (delta.text ?? '') + part.text
      }
      if (part.functionCall !== undefined) {
        delta.toolCall = {
          name: part.functionCall.name ?? 'tool',
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        }
      }
    }
    if (candidate.finishReason !== undefined) {
      delta.finishReason = candidate.finishReason
      if (candidate.finishReason === 'STOP') delta.done = true
    }
  }
  return Object.keys(delta).length > 0 ? delta : null
}

/** 一次性（非流式）回复里取正文，逐协议解。 */
export function parseCompleteContent(protocol: ProviderProtocol, json: unknown): string {
  if (protocol === 'anthropic') {
    const res = json as { content?: Array<{ type?: string; text?: string }> }
    return (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  }
  if (protocol === 'google') {
    const res = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    return (res.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
  }
  const res = json as { choices?: Array<{ message?: { content?: string } }> }
  return res.choices?.[0]?.message?.content ?? ''
}

/** Gemini 的模型名在路径里：/v1beta/models/{model}:streamGenerateContent?alt=sse */
export function googleStreamUrl(base: string, model: string, streaming: boolean): string {
  const root = base.replace(/\/+$/, '')
  const action = streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'
  return `${root}/v1beta/models/${encodeURIComponent(model)}:${action}`
}