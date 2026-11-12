import { findAssistant } from './assistant.ts'
import { contentForApi, estimateAttachmentTokens } from './attachments.ts'
import { resolveOutputCap } from './budget.ts'
import { currentProvider } from './providers.ts'
import { memoryPromptBlock } from './memory-core.ts'
import { estimateTokens, formatTokens } from './tokens.ts'
import type {
  ChatMessage,
  ChatRequestMessage,
  MemoryEntry,
  Settings,
} from './types'

// token 估算挪到 tokens.ts，好让记忆模块也能用而不产生循环依赖。
export { estimateTokens, formatTokens }

function recapBlock(recap: string): string {
  if (recap.trim() === '') return ''
  return `<recent_chats>\n${recap}\n</recent_chats>`
}

function digestBlock(digest: string): string {
  if (digest.trim() === '') return ''
  return [
    '<earlier_in_this_conversation>',
    '这是同一段对话较早部分的摘要，细节已经丢失；不确定的地方就说不确定，不要补全。',
    digest,
    '</earlier_in_this_conversation>',
  ].join('\n')
}

function timeBlock(settings: Settings): string {
  if (!settings.timeReminder) return ''
  const now = new Date()
  const formatted = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'full',
    timeStyle: 'short',
    hour12: false,
  }).format(now)
  return `<time>现在是 ${formatted}。</time>`
}

export interface PromptInput {
  settings: Settings
  memories: readonly MemoryEntry[]
  recap: string
  /** Rolling summary of earlier turns in this same conversation. */
  digest?: string
  /** Live first-person body state and the control-tag instructions. */
  body?: string
  /** 助手人设覆盖；留空则用内置的深鲸人设。 */
  persona?: string
  /** 助手的显示名，用于人设首句。 */
  assistantName?: string
  /** 当前可用的媒体工具（只对已配置的能力写纪律）。 */
  media?: { image: boolean; speech: boolean }
}

/**
 * 人设首段：助手自定义优先，留空退回内置的深鲸人设。
 *
 * 网页账号模式也用这一段（见 web-context.ts）。网页接口没有 system 角色，
 * 身份只能靠这段文字带过去，所以两边必须是同一个身份、同一份文字。
 */
export function personaOpening(
  settings: Settings,
  persona: string | undefined,
  assistantName: string | undefined,
): string {
  const custom = persona?.trim() ?? ''
  if (custom !== '') return custom
  const name = assistantName?.trim() !== '' && assistantName !== undefined
    ? assistantName.trim()
    : (findAssistant(settings, undefined).name || '深鲸')
  return `你是「${name}」，一只住在用户设备深海里的虎鲸 AI 伙伴。你不是客服，也不是搜索引擎；你是一个会思考、会写代码、会记住事情的同伴。`
}

export function buildSystemPrompt(input: PromptInput): string {
  const { settings, memories, recap, digest, body, persona, assistantName, media } = input
  // 助手功能关闭 = 纯净模式：不注入任何人设、记忆、最近对话、时间与身体状态。
  // 工具说明（工坊/生图/语音）仍然保留 —— 那是能力，不是人格。
  const assistantOff = settings.assistantsEnabled !== true
  const opening = assistantOff
    ? '你是一个直接、可靠的 AI 助手。'
    : personaOpening(settings, persona, assistantName)
  const parts = [
    opening,
    '',
    '交流方式：',
    '- 默认用中文；用户换语言时跟随。',
    '- 直接、温暖、具体。不要客套开场，不要堆砌比喻，不要反复确认。',
    '- 需要分点时用短列表；代码放在带语言标记的 fenced block 里。',
    '- 不确定就说不确定，不要编造事实、链接或运行结果。',
    '- 不要声称自己执行过代码或访问过网页，除非工具结果或用户明确提供了这些信息。',
    '',
    '工具与工坊：',
    '- 你有多个互相隔离的本地项目（工作区）。用 list_projects 查看所有项目的 id 与名字，用 create_project 新建一个空项目（返回新 id）。',
    '- 文件工具是 list_files、read_file、write_file、delete_file；它们都接受可选的 project 参数（填项目 id 或名字），不填就写进这段对话当前绑定的项目。',
    '- 用户要做一个**新的**应用 / 网页 / 小游戏时，**先调用 create_project 建一个独立项目**，再对那个项目调用 write_file（带 project 指向新 id）；别把新代码覆盖进老项目的 index.html，也别让新旧代码混在一起。',
    // 纪律要写死：模型很容易「想完就说完了」，只在聊天里贴一大段代码，工坊里一个字都没有。
    // 用户那边的症状就是「工坊根本没被调用」。
    '- 用户要页面 / 小游戏 / 小工具 / 改代码时，**必须先真的调用 write_file 把文件写出来**，再在聊天里说明。只在思考里想好、或者只在聊天里贴代码，等于没做完。',
    '- 一次 write_file 只写**一个完整文件**（index.html、style.css、script.js 分开三次调用）。不要把三个文件的内容塞进一个参数里，那也会被输出上限切断。',
    '- 单个文件很长（几百行以上）时，**分几次写**：第一次正常 write_file 写前半，之后用 `write_file` 带 `mode:"append"` 把剩下的追加到同一个文件。不要为了「一次写完」硬顶输出上限，那会被截断。',
    '- 输出上限是正文与思考共用的：内容长就拆成多次调用，别在一次回复里写完所有东西。',
    '- 写完用一两句话说明改了什么；客户端会在工坊里自动预览，不要谎称“我已经运行了”。',
    '- 不要删除用户没有要求删除的文件；覆盖文件前先 read_file 确认。',
    '',
    '记忆：',
    '- 不要假装记得没被告知过的细节。',
  ]

  if (media?.image === true) {
    parts.push(
      '',
      '图片工具：',
      '- **只有用户明确要求画图/生成图片/设计/修改图片时**才调用 generate_image。用户只是上传图片、描述画面、进行角色扮演或普通聊天时，绝对不要主动生图。',
      '- 用户明确要求修改或参考他当前消息里的图片时，调用 generate_image 并传 `reference: "last_user_images"`；没有附件就不要用这个参数。',
      '- 生成结果会由客户端展示，不要输出 Markdown 图片链接或伪造 URL。',
      '- 提示词要具体：主体、风格、光线、构图；一次最多 4 张。',
    )
  }
  if (media?.speech === true) {
    parts.push(
      '',
      '语音工具：',
      '- 只有用户明确要求朗读、语音回复或音频时才调用 speak；普通回复不要自动配音。',
      '- 单次朗读最多 2000 字，超长就分成几段调用。',
      '- 语音会由客户端显示播放器并等待用户点击播放，不要在正文里贴音频链接。',
    )
  }

  // 以下都是「人格与长期记忆」层面的注入，助手关闭时一律不给。
  if (!assistantOff) {
    if (body !== undefined && body.trim() !== '') parts.push('', body)
    const memory = memoryPromptBlock(memories)
    if (memory !== '') parts.push('', memory)
    const recapText = recapBlock(recap)
    if (recapText !== '') parts.push('', recapText)
    const digestText = digestBlock(digest ?? '')
    if (digestText !== '') parts.push('', digestText)
    const time = timeBlock(settings)
    if (time !== '') parts.push('', time)
  }

  return parts.join('\n')
}

function toRequestMessage(message: ChatMessage, includeReasoning: boolean): ChatRequestMessage | null {
  if (message.status === 'error') return null
  if (message.role === 'assistant') {
    const request: ChatRequestMessage = {
      role: 'assistant',
      content: message.content,
    }
    const hasTools = message.toolCalls !== undefined && message.toolCalls.length > 0
    if (message.reasoning !== undefined && message.reasoning.trim() !== '') {
      // DeepSeek rejects a tool loop when the thinking turn's reasoning_content
      // is omitted, so echo it back with the assistant message.
      //
      // 但「每条 assistant 历史都无条件带上思考全文」是上下文吃紧的元凶之一：
      // 一次长思考就七八千字，每轮都重放。所以现在只有两种情况带 ——
      // 这条 assistant 带着 tool_calls（DeepSeek 的硬要求），
      // 或者这个供应商自己开了 includeHistoryReasoning（把思考存服务端的中转站要带着）。
      if (hasTools || includeReasoning) request.reasoning_content = message.reasoning
    }
    if (hasTools) {
      request.tool_calls = message.toolCalls
      request.content = message.content || ''
    }
    if (request.content === '' && request.tool_calls === undefined) return null
    return request
  }
  if (message.role === 'tool') {
    if (message.toolCallId === undefined) return null
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
      ...(message.toolName !== undefined ? { name: message.toolName } : {}),
    }
  }
  if (message.role === 'user') {
    const hasAttachments = (message.attachments?.length ?? 0) > 0
    if (message.content.trim() === '' && !hasAttachments) return null
    return { role: 'user', content: contentForApi(message.content, message.attachments) }
  }
  return null
}

function messageCost(message: ChatMessage): number {
  return (
    estimateTokens(message.content)
    + estimateTokens(message.reasoning ?? '')
    + estimateAttachmentTokens(message.attachments)
    + 8
  )
}

/**
 * Keep the newest messages that fit the budget, and drop tool results whose
 * assistant tool-call was trimmed away (providers reject orphan tool messages).
 */
export function trimHistoryDetailed(
  messages: readonly ChatMessage[],
  tokenBudget: number,
): { kept: ChatMessage[]; dropped: number } {
  const kept: ChatMessage[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as ChatMessage
    const cost = messageCost(message)
    if (kept.length > 0 && used + cost > tokenBudget) break
    kept.push(message)
    used += cost
  }
  kept.reverse()

  const keptToolIds = new Set<string>()
  for (const message of kept) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) keptToolIds.add(call.id)
    }
  }
  const filtered = kept.filter((message) => message.role !== 'tool' || (message.toolCallId !== undefined && keptToolIds.has(message.toolCallId)))
  return { kept: filtered, dropped: messages.length - kept.length }
}

/** Backwards-compatible wrapper: returns only the kept messages. */
export function trimHistory(messages: readonly ChatMessage[], tokenBudget: number): ChatMessage[] {
  return trimHistoryDetailed(messages, tokenBudget).kept
}

export function buildRequestMessagesDetailed(options: {
  settings: Settings
  system: string
  history: readonly ChatMessage[]
}): { messages: ChatRequestMessage[]; dropped: number } {
  const { settings, system, history } = options
  const provider = currentProvider(settings)
  const includeReasoning = provider.includeHistoryReasoning === true
  const systemTokens = estimateTokens(system)
  // 留出「这一轮要生成的那部分」。用 budget.ts 算出的同一个上限（正文预算 + 思考预留），
  // 而不是 settings.maxTokens —— 后者只是正文那一半，实际发出去的大得多。
  // 留少了会怎样：历史填满窗口，服务端整条请求被拒，用户看到的是「发不出去」。
  // 填「自动」（不发上限）时至少给思考留它这一档的额度。
  const cap = resolveOutputCap(settings, provider)
  const outputAllowance = cap.cap ?? Math.max(cap.body, cap.reserve)
  const budget = Math.max(2000, settings.contextBudget - outputAllowance - systemTokens - 400)
  const { kept: trimmed, dropped } = trimHistoryDetailed(history, budget)
  const converted = trimmed
    .map((message) => toRequestMessage(message, includeReasoning))
    .filter((message): message is ChatRequestMessage => message !== null)
  return { messages: [{ role: 'system', content: system }, ...converted], dropped }
}

export function buildRequestMessages(options: {
  settings: Settings
  system: string
  history: readonly ChatMessage[]
}): ChatRequestMessage[] {
  return buildRequestMessagesDetailed(options).messages
}
