import {
  db,
  listAllFiles,
  listConversations,
  listMemories,
  listMessages,
  putConversation,
  putMemory,
  type SearchDoc,
} from './db'
import { tokenize } from './search'
import { dropRedactedHeaders, redactHeaders } from './redact'
import { readGameSave, writeGameSave } from './game-save'
import type { ChatMessage, Conversation, MemoryEntry, SummaryRecord, WorkspaceFile } from './types'

/**
 * 备份格式。设计原则：
 * - 纯 JSON，人能读、能手动改、能进 git；
 * - 带 `format` 和 `formatVersion`，以后改结构能识别；
 * - 不带 apiKey（那是机密，换设备要重填）；
 * - 未知字段在导入时忽略，不报错。
 */

export const BACKUP_FORMAT = 'deepsea-backup'
/**
 * v3 起带上水族馆进度（`game`）。
 *
 * 加字段是向后兼容的：老程序读到不认识的键会忽略，老备份没有这个键就是
 * "没有进度可恢复"，不需要迁移代码。所以这里只升版本号用于提示，不写迁移。
 */
export const BACKUP_FORMAT_VERSION = 3

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  formatVersion: number
  appVersion: string
  exportedAt: string
  counts: {
    conversations: number
    messages: number
    memories: number
    summaries: number
    files: number
  }
  /** 设置快照；apiKey 永远为空。 */
  settings: Record<string, unknown> | null
  conversations: Array<Conversation & { messages: ChatMessage[] }>
  memories: MemoryEntry[]
  summaries: SummaryRecord[]
  files: WorkspaceFile[]
  /**
   * 水族馆进度（投喂数 / 体型 / 装饰 / 伙伴 / 皮肤 / 动作速度）。
   *
   * 原样搬运引擎的存档 blob，不在这里解析结构；**不含照片**（dataURL 太大）。
   * 老备份没有这个键 → null。
   */
  game: Record<string, unknown> | null
}

export interface ImportResult {
  conversations: number
  messages: number
  memories: number
  summaries: number
  files: number
  skipped: number
  settingsApplied: boolean
}

export interface ImportOptions {
  /** merge = 只添加缺的；replace = 清空现有数据再导入。 */
  mode: 'merge' | 'replace'
  /** 是否导入设置（含助手、供应商；不含 apiKey）。 */
  applySettings: boolean
}

/* ---------------------------------------------------------------- 导出 */

/**
 * 把设置里的所有密钥抹掉再进备份。
 *
 * 只清 `settings.apiKey` 是不够的 —— 多供应商之后每个 provider 里也各存一份 key，
 * 而且 `providers[].headers` / `mcpServers[].headers` 里常常直接放
 * `Authorization: Bearer …`（代码自己也是这么建议的）。漏掉就会把明文密钥
 * 写进备份文件，而备份被设计成「能进 git、可分享」（BUG-REVIEW P0-1）。
 */
export function stripSecrets(settings: Record<string, unknown> | null): Record<string, unknown> | null {
  if (settings === null) return null
  const copy: Record<string, unknown> = { ...settings, apiKey: '' }
  if (Array.isArray(copy.providers)) {
    copy.providers = (copy.providers as unknown[]).map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const provider = { ...(item as Record<string, unknown>) }
      delete provider.apiKey
      if (provider.headers !== undefined) provider.headers = redactHeaders(provider.headers)
      return provider
    })
  }
  if (Array.isArray(copy.mcpServers)) {
    copy.mcpServers = (copy.mcpServers as unknown[]).map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const server = { ...(item as Record<string, unknown>) }
      if (server.headers !== undefined) server.headers = redactHeaders(server.headers)
      return server
    })
  }
  // 生图/语音是独立 API：Key 与自定义头也要脱敏，否则同样会随「可分享备份」泄漏。
  for (const key of ['imageApi', 'speechApi'] as const) {
    const item = copy[key]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const config: Record<string, unknown> = { ...(item as Record<string, unknown>), apiKey: '' }
    if (config.extraHeaders !== undefined) config.extraHeaders = redactHeaders(config.extraHeaders)
    copy[key] = config
  }
  return copy
}

export async function buildBackup(appVersion: string, settings: Record<string, unknown> | null): Promise<BackupFile> {
  const database = await db()
  const [conversations, memories, files, summaries, messages] = await Promise.all([
    listConversations(),
    listMemories(),
    // 所有项目的文件都要备份，否则恢复后用户自建项目里的东西就没了。
    listAllFiles(),
    database.getAll('summaries'),
    database.getAll('messages'),
  ])

  // 按对话归组，避免每条对话单独查一次。
  const byConversation = new Map<string, ChatMessage[]>()
  for (const message of messages) {
    const list = byConversation.get(message.conversationId)
    if (list === undefined) byConversation.set(message.conversationId, [message])
    else list.push(message)
  }
  for (const list of byConversation.values()) list.sort((a, b) => a.createdAt - b.createdAt)

  const safeSettings = stripSecrets(settings)

  const payload: BackupFile = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    counts: {
      conversations: conversations.length,
      messages: messages.length,
      memories: memories.length,
      summaries: summaries.length,
      files: files.length,
    },
    settings: safeSettings,
    conversations: conversations.map((conversation) => ({
      ...conversation,
      messages: byConversation.get(conversation.id) ?? [],
    })),
    memories,
    summaries,
    files,
    game: readGameSave(),
  }
  return payload
}

export function backupFileName(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `deepsea-backup-${stamp}.json`
}

/* ---------------------------------------------------------------- 导入 */

export interface ParsedBackup {
  ok: true
  data: BackupFile
  /** 兼容旧版本时记下的提示。 */
  warnings: string[]
}

export type ParseResult = ParsedBackup | { ok: false; error: string }

/**
 * 导入时把备份里的 `<redacted>` 请求头丢掉。
 * 那是导出时留下的占位符，不是真的密钥；留着会被当成请求头发出去。
 */
function dropRedactedSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...settings }
  const scrub = (list: unknown): unknown => (Array.isArray(list)
    ? list.map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const record = { ...(item as Record<string, unknown>) }
      if (record.headers !== undefined) record.headers = dropRedactedHeaders(record.headers)
      return record
    })
    : list)
  copy.providers = scrub(copy.providers)
  copy.mcpServers = scrub(copy.mcpServers)
  for (const key of ['imageApi', 'speechApi'] as const) {
    const item = copy[key]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const config = { ...(item as Record<string, unknown>) }
    if (config.extraHeaders !== undefined) config.extraHeaders = dropRedactedHeaders(config.extraHeaders)
    copy[key] = config
  }
  return copy
}

/** 解析并校验一个备份文件。所有字段都做类型检查，脏数据不会进库。 */
export function parseBackup(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: '不是有效的 JSON 文件' }
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '备份内容不是一个对象' }

  const obj = raw as Record<string, unknown>
  const warnings: string[] = []

  // 兼容 v1：老备份没有 format / formatVersion，但有 conversations 数组。
  const isLegacy = obj.format === undefined && Array.isArray(obj.conversations)
  if (!isLegacy && obj.format !== BACKUP_FORMAT) {
    return { ok: false, error: '这不像深鲸的备份文件' }
  }
  const formatVersion = typeof obj.formatVersion === 'number' ? obj.formatVersion : 1
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    warnings.push(`备份格式版本 ${formatVersion} 比当前程序新，可能有字段读不出来`)
  }
  if (isLegacy) warnings.push('这是旧版备份，已按兼容模式读取')

  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const conversations: BackupFile['conversations'] = []
  for (const item of asArray(obj.conversations)) {
    if (typeof item !== 'object' || item === null) continue
    const conversation = item as Record<string, unknown>
    if (typeof conversation.id !== 'string') continue
    const messages = asArray(conversation.messages)
      .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
      .filter((m) => typeof m.id === 'string' && typeof m.content === 'string')
      .map((m) => ({
        ...(m as unknown as ChatMessage),
        conversationId: conversation.id as string,
      }))
    conversations.push({
      ...(conversation as unknown as Conversation),
      messages,
    })
  }

  const memories = asArray(obj.memories)
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .filter((m) => typeof m.id === 'string' && typeof m.text === 'string')
    .map((m) => m as unknown as MemoryEntry)

  const summaries = asArray(obj.summaries)
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .filter((s) => typeof s.conversationId === 'string' && typeof s.text === 'string')
    .map((s) => s as unknown as SummaryRecord)

  const files = asArray(obj.files)
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .filter((f) => typeof f.id === 'string' && typeof f.path === 'string')
    .map((f) => f as unknown as WorkspaceFile)

  const settings = typeof obj.settings === 'object' && obj.settings !== null
    ? dropRedactedSettings(obj.settings as Record<string, unknown>)
    : null

  // 水族馆进度：只认对象，脏数据当作没有。字段级校验交给引擎自己的 loadSave，
  // 那边已经有完整的 clamp / 迁移逻辑，这里再抄一遍只会两边不一致。
  const game = typeof obj.game === 'object' && obj.game !== null && !Array.isArray(obj.game)
    ? (obj.game as Record<string, unknown>)
    : null

  const messageCount = conversations.reduce((total, conversation) => total + conversation.messages.length, 0)
  const counts = {
    conversations: conversations.length,
    messages: messageCount,
    memories: memories.length,
    summaries: summaries.length,
    files: files.length,
  }

  if (counts.conversations === 0 && counts.memories === 0 && counts.files === 0 && game === null) {
    return { ok: false, error: '备份里没有可导入的内容' }
  }

  return {
    ok: true,
    warnings,
    data: {
      format: BACKUP_FORMAT,
      formatVersion,
      appVersion: typeof obj.appVersion === 'string' ? obj.appVersion : 'unknown',
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
      counts,
      settings,
      conversations,
      memories,
      summaries,
      files,
      game,
    },
  }
}

/** 把备份写进库。整批放在同一个事务里，中途失败不会留下半份数据。 */
export async function applyBackup(data: BackupFile, options: ImportOptions): Promise<ImportResult> {
  const database = await db()
  const stores = ['conversations', 'messages', 'memories', 'summaries', 'files', 'search', 'media'] as const
  const tx = database.transaction(stores, 'readwrite')

  let skipped = 0
  if (options.mode === 'replace') {
    await tx.objectStore('conversations').clear()
    await tx.objectStore('messages').clear()
    await tx.objectStore('memories').clear()
    await tx.objectStore('summaries').clear()
    await tx.objectStore('files').clear()
    await tx.objectStore('search').clear()
    // 媒体字节不随备份导入；覆盖导入时必须清掉旧媒体，否则会留下打不开的孤儿行。
    await tx.objectStore('media').clear()
  }

  const messageStore = tx.objectStore('messages')
  const searchStore = tx.objectStore('search')
  let conversations = 0
  let messages = 0

  for (const conversation of data.conversations) {
    const { messages: list, ...rest } = conversation
    await tx.objectStore('conversations').put(rest as Conversation)
    conversations += 1
    for (const message of list) {
      await messageStore.put(message)
      // 导入的消息要重建倒排索引，否则搜不到。
      const text = `${message.content}\n${message.reasoning ?? ''}`.trim()
      if (text !== '') {
        const doc: SearchDoc = {
          id: message.id,
          conversationId: message.conversationId,
          role: message.role,
          createdAt: message.createdAt,
          text,
          tokens: tokenize(text),
        }
        await searchStore.put(doc)
      }
      messages += 1
    }
  }

  let memories = 0
  for (const memory of data.memories) {
    await tx.objectStore('memories').put(memory)
    memories += 1
  }

  let summaries = 0
  for (const summary of data.summaries) {
    await tx.objectStore('summaries').put(summary)
    summaries += 1
  }

  let files = 0
  for (const file of data.files) {
    await tx.objectStore('files').put(file)
    files += 1
  }

  await tx.done

  // 水族馆进度不在 IndexedDB 里，它是引擎自己的 localStorage 存档，所以放在
  // 事务外面写。写失败也只是丢进度，不影响上面已经落库的对话和记忆。
  if (data.game !== null) writeGameSave(data.game)

  return {
    conversations,
    messages,
    memories,
    summaries,
    files,
    skipped,
    settingsApplied: options.applySettings && data.settings !== null,
  }
}