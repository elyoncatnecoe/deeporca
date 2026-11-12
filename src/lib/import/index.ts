import { nanoid } from 'nanoid'
import {
  clearConversations,
  clearMemories,
  db,
  putConversation,
  putMemory,
  type SearchDoc,
} from '../db'
import { parseBackup } from '../backup'
import { tokenize } from '../search'
import { estimateTokens } from '../tokens'
import { DEFAULT_WORKSPACE, type ChatMessage, type Conversation } from '../types'
import { parseChatboxJson, parseChatboxZip } from './chatbox'
import { parseDeepseek } from './deepseek'
import { parseGeneric } from './generic'
import { parseRikkahub } from './rikkahub-loader'
import {
  FORMAT_LABELS,
  ImportCancelled,
  yieldToUI,
  type ImportFormat,
  type ImportHooks,
  type ImportInput,
  type ImportOptions,
  type ImportStats,
  type ParsedImport,
} from './types'

export type { ImportFormat, ImportHooks, ImportInput, ImportOptions, ImportStats, ParsedImport }
export { FORMAT_LABELS, ImportCancelled }
// 纯解析器也导出，方便脚本/测试用真实样本单独验证映射（不经过 UI 与落库）。
export { parseDeepseek }
export { parseRikkaRows } from './rikkahub'
export { parseChatboxJson }

/** 文件大小提示阈值：超过就由 UI 先提醒「要解析一会儿」（DB 常见上百 MB）。 */
export const LARGE_FILE_BYTES = 40 * 1024 * 1024

/* --------------------------------------------------------------- 识别 */

function startsWith(bytes: Uint8Array | undefined, signature: number[]): boolean {
  if (bytes === undefined || bytes.length < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

function isZipInput(input: ImportInput): boolean {
  if (input.bytes !== undefined && startsWith(input.bytes, [0x50, 0x4b, 0x03, 0x04])) return true
  return input.name.toLowerCase().endsWith('.zip')
}

function isSqliteInput(input: ImportInput): boolean {
  // 'SQLite format 3\0'
  if (input.bytes !== undefined && startsWith(input.bytes, [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])) {
    return true
  }
  const lower = input.name.toLowerCase()
  return lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('.sqlite3')
}

function parseJson(input: ImportInput): unknown {
  if (input.text === undefined) throw new Error('这个文件不是文本格式，读不出 JSON')
  try {
    return JSON.parse(input.text) as unknown
  } catch {
    throw new Error('不是有效的 JSON 文件（可能选错了文件，或者文件被截断）')
  }
}

function isDeepseaShape(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const record = raw as Record<string, unknown>
  if (record.format === 'deepsea-backup') return true
  // 兼容老版本：没有 format，但有 conversations 数组且每段带 messages 数组。
  return record.format === undefined
    && Array.isArray(record.conversations)
    && record.conversations.length > 0
    && Array.isArray((record.conversations[0] as Record<string, unknown> | null)?.messages)
}

export function detectFormat(input: ImportInput): ImportFormat {
  if (isSqliteInput(input)) return 'rikkahub'
  if (isZipInput(input)) return 'chatbox'
  const lower = input.name.toLowerCase()
  if (lower.endsWith('.db') || lower.endsWith('.sqlite')) return 'rikkahub'

  let raw: unknown
  try {
    raw = parseJson(input)
  } catch {
    return 'generic'
  }
  if (isDeepseaShape(raw)) return 'deepsea'
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0]
    if (first !== null && typeof first === 'object') {
      const record = first as Record<string, unknown>
      if (record.mapping !== null && typeof record.mapping === 'object') return 'deepseek'
      if (Array.isArray(record.messages)) return 'chatbox'
    }
  }
  if (raw !== null && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).sessions)) {
    return 'chatbox'
  }
  return 'generic'
}

/* --------------------------------------------------------------- 解析 */

function convertBackup(text: string): ParsedImport {
  const parsed = parseBackup(text)
  if (!parsed.ok) throw new Error(parsed.error)
  const data = parsed.data

  let skipped = 0
  const conversations = data.conversations.map((conversation) => {
    let last = 0
    const messages = conversation.messages.flatMap((message) => {
      const content = typeof message.content === 'string' ? message.content : ''
      const reasoning = typeof message.reasoning === 'string' ? message.reasoning : ''
      // 只有正文和思考都空才丢；纯思考的助手消息要保留（与其它格式一致）。
      if (content.trim() === '' && reasoning.trim() === '') {
        skipped += 1
        return []
      }
      let createdAt = typeof message.createdAt === 'number' && message.createdAt > 0 ? message.createdAt : conversation.createdAt
      if (createdAt <= last) createdAt = last + 1
      last = createdAt
      return [{
        role: message.role,
        content,
        ...(reasoning !== '' ? { reasoning } : {}),
        createdAt,
      }]
    })
    return {
      title: typeof conversation.title === 'string' && conversation.title.trim() !== '' ? conversation.title.trim() : '未命名对话',
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      model: conversation.model,
      messages,
    }
  }).filter((conversation) => conversation.messages.length > 0)

  const warnings = [...parsed.warnings]
  if (data.files.length > 0) warnings.push(`备份里还有 ${data.files.length} 个工坊文件，本页不导入（设置页→从备份恢复可完整还原）`)
  if (data.summaries.length > 0) warnings.push(`备份里还有 ${data.summaries.length} 条对话摘要，本页不导入`)

  return {
    format: 'deepsea',
    conversations,
    memories: data.memories,
    skipped,
    mapping: ['format = deepsea-backup → 深鲸原生备份', 'conversations[].messages[] → 对话与消息', 'memories[] → 记忆库'],
    warnings,
  }
}

/** 解析输入但不写库。先给预览。 */
export async function parseImport(input: ImportInput): Promise<ParsedImport> {
  const format = detectFormat(input)

  if (format === 'rikkahub') {
    if (input.bytes === undefined) throw new Error('读不到数据库文件内容')
    return parseRikkahub(input.bytes)
  }

  if (format === 'chatbox' && isZipInput(input)) {
    if (input.bytes === undefined) throw new Error('读不到 ZIP 文件内容')
    return parseChatboxZip(input.bytes)
  }

  const raw = parseJson(input)
  if (format === 'deepsea') return convertBackup(input.text ?? '')
  if (format === 'deepseek') return parseDeepseek(raw)
  if (format === 'chatbox') {
    const parsed = parseChatboxJson(raw)
    if (parsed !== null) return parsed
  }
  return parseGeneric(raw, input.name)
}

/* --------------------------------------------------------------- 预览 */

export interface ImportPreview {
  format: ImportFormat
  formatLabel: string
  conversations: number
  messages: number
  skipped: number
  memories: number
  mapping: string[]
  warnings: string[]
}

export function previewOf(parsed: ParsedImport): ImportPreview {
  return {
    format: parsed.format,
    formatLabel: FORMAT_LABELS[parsed.format],
    conversations: parsed.conversations.length,
    messages: parsed.conversations.reduce((total, conversation) => total + conversation.messages.length, 0),
    skipped: parsed.skipped,
    memories: parsed.memories.length,
    mapping: parsed.mapping,
    warnings: parsed.warnings,
  }
}

/* --------------------------------------------------------------- 落库 */

/** 分块大小：400 条一个事务，兼顾吞吐与「取消及时响应/进度条不卡」。 */
const WRITE_CHUNK = 400

function makeSearchDoc(message: ChatMessage): SearchDoc | null {
  const text = `${message.content}\n${message.reasoning ?? ''}`.trim()
  if (text === '') return null
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    createdAt: message.createdAt,
    text,
    tokens: tokenize(text),
  }
}

/**
 * 把解析结果真正写进 IndexedDB。
 *
 * 性能：几千条消息逐条 putMessage 会开几千个事务，慢到肉眼可见。这里按对话 + 400 条一块
 * 批量写 messages / search 索引，块之间 await 一帧让出主线程 —— 进度条能画、取消能生效。
 * 取消或失败时已提交的块会保留（IndexedDB 无法跨事务回滚），UI 会如实提示。
 */
export async function applyImport(
  parsed: ParsedImport,
  options: ImportOptions,
  hooks: ImportHooks = {},
): Promise<ImportStats> {
  const database = await db()

  if (options.mode === 'replace') {
    // 覆盖 = 回到干净状态：对话连同消息/摘要/媒体/搜索索引一起清，记忆库也清。
    // 这正是覆盖前必须让用户先导备份的原因。
    await clearConversations()
    await clearMemories()
  }

  const total = parsed.conversations.reduce(
    (sum, conversation) => sum + conversation.messages.filter(
      // 只丢掉「既无正文也无思考」的空消息；纯思考（content 空、reasoning 有）要保留。
      (message) => message.content.trim() !== '' || (message.reasoning ?? '').trim() !== '',
    ).length,
    0,
  )
  let done = 0
  let messagesWritten = 0
  let tokens = 0
  const conversationIds: string[] = []

  for (const imported of parsed.conversations) {
    const id = `conv_${nanoid(10)}`
    const list: ChatMessage[] = []
    let lastTime = 0
    for (const message of imported.messages) {
      if (message.content.trim() === '' && (message.reasoning ?? '').trim() === '') continue
      let createdAt = message.createdAt
      if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = imported.createdAt + list.length
      if (createdAt <= lastTime) createdAt = lastTime + 1
      lastTime = createdAt
      tokens += estimateTokens(message.content) + (message.reasoning !== undefined ? estimateTokens(message.reasoning) : 0)
      list.push({
        id: `msg_${nanoid(12)}`,
        conversationId: id,
        role: message.role,
        content: message.content,
        ...(message.reasoning !== undefined && message.reasoning !== '' ? { reasoning: message.reasoning } : {}),
        createdAt,
        status: 'done',
      })
    }
    if (list.length === 0) continue

    const conversation: Conversation = {
      id,
      title: imported.title.trim() !== '' ? imported.title.trim() : '未命名对话',
      createdAt: imported.createdAt > 0 ? imported.createdAt : list[0].createdAt,
      updatedAt: imported.updatedAt > 0 ? imported.updatedAt : list[list.length - 1].createdAt,
      model: (imported.model ?? '').trim() !== '' ? (imported.model as string) : (options.config.model || options.fallbackModel),
      assistantId: options.assistantId,
      config: options.config,
      workspaceId: DEFAULT_WORKSPACE,
    }
    await putConversation(conversation)
    conversationIds.push(id)

    for (let start = 0; start < list.length; start += WRITE_CHUNK) {
      const slice = list.slice(start, start + WRITE_CHUNK)
      const tx = database.transaction(['messages', 'search'], 'readwrite')
      const messageStore = tx.objectStore('messages')
      const searchStore = tx.objectStore('search')
      for (const message of slice) {
        await messageStore.put(message)
        // 导入的消息必须重建倒排索引，否则搜索里找不到它们（与 applyBackup 同理）。
        const doc = makeSearchDoc(message)
        if (doc !== null) await searchStore.put(doc)
      }
      await tx.done
      done += slice.length
      messagesWritten += slice.length
      hooks.onProgress?.({ phase: 'write', done, total })
      await yieldToUI()
      if (hooks.signal?.aborted === true) throw new ImportCancelled()
    }
  }

  let memories = 0
  for (const memory of parsed.memories) {
    await putMemory(memory)
    memories += 1
  }

  return { conversations: conversationIds.length, messages: messagesWritten, skipped: parsed.skipped, memories, conversationIds, tokens }
}

/** 统一入口：解析 + 落库一步到位（不需要分阶段预览时用）。 */
export async function importConversations(
  input: ImportInput,
  options: ImportOptions,
  hooks: ImportHooks = {},
): Promise<ImportStats> {
  const parsed = await parseImport(input)
  return applyImport(parsed, options, hooks)
}

/* --------------------------------------------------------------- 读文件 */

/**
 * 把用户选中的 File 读成解析输入。
 * 只对 .json/.txt 解码文本（.db/.zip 是二进制，硬当 UTF-8 会得到一堆乱码）；
 * 二进制永远保留 bytes，交给 sql.js / jszip。
 */
export async function readImportFile(file: File): Promise<ImportInput> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const lower = file.name.toLowerCase()
  const isText = lower.endsWith('.json') || lower.endsWith('.txt')
  const input: ImportInput = { name: file.name, bytes }
  if (isText) input.text = new TextDecoder('utf-8').decode(bytes)
  return input
}
