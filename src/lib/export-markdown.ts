import type { ChatMessage, Conversation } from './types'

/**
 * 把对话导出成 Markdown。
 *
 * 纯函数，不碰 DOM / 存储，方便 Node 单测。三条原则：
 * - 只导「看得见的东西」：跳过工具消息、error 状态、空内容、以及被分叉挤掉的候选。
 * - 保留原文：助手的正则替换只影响显示，导出走 message.content 原文。
 * - 思考过程由调用方决定：这里 `includeReasoning` 缺省是「不带」（这是库的默认，
 *   保证老的调用点行为不变）；但界面上「导出格式」弹层和单条分享的默认值是
 *   **带**（弹层里开关默认开），所以默认体验是完整的。传 true 时用 <details>
 *   折起来，不打断正文。
 */

export interface ExportOptions {
  /** 对话标题，用作一级标题。留空则只输出正文。 */
  title?: string
  /** 助手名，作为「谁在说话」的署名。 */
  assistantName?: string
  /** 是否带上思考过程（库默认不带，界面默认带；见文件头注释）。 */
  includeReasoning?: boolean
  /** 是否在文末附上导出时间和模型名（默认带）。 */
  includeMeta?: boolean
  /** 模型名，用于文末元信息。 */
  model?: string
}

/** 一条消息是否该出现在导出里。 */
function exportable(message: ChatMessage): boolean {
  if (message.role === 'tool') return false
  if (message.status === 'error') return false
  // 分叉里没被选中的候选不导，否则同一处会重复出现好几版。
  if (message.active === false) return false
  const hasContent = message.content.trim() !== ''
  const hasReasoning = (message.reasoning ?? '').trim() !== ''
  // 只有图 / 只有文件、正文一个字都没打的消息也要导：气泡里明明看得见，
  // 以前会因为 content 为空被整条丢掉（用户发一张图导出后什么都没有）。
  const hasAttachments = (message.attachments?.length ?? 0) > 0
  return hasContent || hasReasoning || hasAttachments
}

/** 把消息的附件折成一行说明；data: 内联图在 markdown 里又长又没用。 */
function attachmentLines(message: ChatMessage): string[] {
  const attachments = message.attachments ?? []
  return attachments.map((item) => `> [附件] ${item.name}`)
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** 单条消息 → markdown 片段。 */
export function messageToMarkdown(message: ChatMessage, options: ExportOptions = {}): string {
  const assistantName = (options.assistantName ?? '').trim() || '助手'
  const isUser = message.role === 'user'
  const who = isUser ? '我' : assistantName
  const parts: string[] = [`### ${who}`, '']

  const reasoning = (message.reasoning ?? '').trim()
  if (options.includeReasoning === true && reasoning !== '') {
    parts.push('<details><summary>思考过程</summary>', '', quote(reasoning), '', '</details>', '')
  }

  const content = message.content.trim()
  if (content !== '') parts.push(content, '')

  const attachments = attachmentLines(message)
  if (attachments.length > 0) parts.push(...attachments, '')

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

/** 整段对话 → 一份完整的 markdown 文档。 */
export function conversationToMarkdown(
  messages: readonly ChatMessage[],
  options: ExportOptions = {},
): string {
  const title = (options.title ?? '').trim()
  const blocks: string[] = []
  if (title !== '') blocks.push(`# ${title}`, '')

  const body = messages
    .filter(exportable)
    .map((message) => messageToMarkdown(message, options))
    .filter((block) => block !== '')
  // 每块之间留一个空行，否则「我」和「深鲸」两节会粘在一起。
  if (body.length > 0) blocks.push(body.join('\n\n'), '')

  if (options.includeMeta !== false) {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
    const model = (options.model ?? '').trim()
    const meta = model !== '' ? `> ${stamp} · ${model}` : `> ${stamp}`
    blocks.push('---', '', meta)
  }

  return `${blocks.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** 从对话里挑出可导出的消息（给调用方判断要不要显示按钮）。 */
export function exportableMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter(exportable)
}

/**
 * 导出用的文件名：标题清洗成安全字符，带上日期。
 * 中文保留（Windows / Android 都支持），只去掉路径分隔符和非法字符。
 */
export function markdownFileName(title: string, at = new Date()): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  const date = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`
  return `${cleaned === '' ? '对话' : cleaned}-${date}.md`
}

/** 单条消息的导出标题：用角色 + 片段，方便在文件管理器里认。 */
export function messageMarkdownFileName(message: ChatMessage, assistantName: string, at = new Date()): string {
  const snippet = message.content
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
  const who = message.role === 'user' ? '我' : assistantName
  return markdownFileName(`${who}-${snippet}`, at)
}

/** 给「整段导出」用的标题：对话标题，没有就用第一句用户消息。 */
export function resolveExportTitle(conversation: Conversation | undefined, messages: readonly ChatMessage[]): string {
  const fromConversation = (conversation?.title ?? '').trim()
  if (fromConversation !== '' && fromConversation !== '新的对话') return fromConversation
  const firstUser = messages.find((message) => message.role === 'user' && message.content.trim() !== '')
  return (firstUser?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 30) || '对话'
}