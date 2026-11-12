import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { PhotoBytes } from './photo-store'
import {
  DEFAULT_WORKSPACE,
  type ChatMessage,
  type Conversation,
  type MediaRecord,
  type MemoryEntry,
  type Note,
  type SummaryRecord,
  type WakeSchedule,
  type WorkspaceFile,
} from './types'
import { queryTokens, tokenize } from './search'

// 常量定义在 types.ts（settings 也要用，不能反过来依赖 db）。
export { DEFAULT_WORKSPACE }

const DB_NAME = 'deepsea'
// v3：加 photos 表（布置屏照片的大图字节）。以前照片整个塞 localStorage，
// 8 张全尺寸 dataURL 轻松超过 WebView 约 5MB 的配额，而写失败是被 catch {} 吞掉的
// —— 用户视角就是「拍完照重启就没了」。见 src/orca/photo.ts 的持久化注释。
// v4：加 media 表（对话里生成的图片/语音字节）。消息只存引用，避免二进制进消息列表。
// v5：加 notes（日历便签）与 wakeSchedules（助手主动唤醒排期）两张表。
const DB_VERSION = 5

interface DeepSeaDB extends DBSchema {
  conversations: {
    key: string
    value: Conversation
    indexes: { 'by-updated': number }
  }
  messages: {
    key: string
    value: ChatMessage
    indexes: { 'by-conversation': string; 'by-created': number }
  }
  memories: {
    key: string
    value: MemoryEntry
    indexes: { 'by-updated': number }
  }
  summaries: {
    key: string
    value: SummaryRecord
  }
  files: {
    key: string
    value: WorkspaceFile
    indexes: { 'by-workspace': string; 'by-path': string }
  }
  settings: {
    key: string
    value: { key: string; value: unknown }
  }
  usage: {
    key: string
    value: {
      id: string
      conversationId: string
      model: string
      inputTokens: number
      outputTokens: number
      createdAt: number
    }
    indexes: { 'by-created': number }
  }
  /** 消息全文倒排索引：一条消息一行，tokens 是多值索引。 */
  search: {
    key: string
    value: SearchDoc
    indexes: { 'by-token': string; 'by-conversation': string }
  }
  /**
   * 布置屏照片的大图字节（id -> dataURL）。
   * 元数据和缩略图仍在 localStorage（量小、必须同步可读），这里只放最肥的那一份，
   * 这样 8 张照片不再挤爆配额，写失败也能被感知（见 src/lib/photo-store.ts）。
   */
  photos: {
    key: string
    value: PhotoBytes
  }
  /** 对话内生成媒体（生图/语音）的字节。消息里存 MessageMediaRef，真字节在这里。 */
  media: {
    key: string
    value: MediaRecord
    indexes: { 'by-conversation': string; 'by-message': string }
  }
  /** 日历便签。 */
  notes: {
    key: string
    value: Note
    indexes: { 'by-due': number; 'by-updated': number }
  }
  /** 助手主动唤醒的排期。 */
  wakeSchedules: {
    key: string
    value: WakeSchedule
    indexes: { 'by-at': number }
  }
}

export interface SearchDoc {
  /** 等于消息 id。 */
  id: string
  conversationId: string
  role: string
  createdAt: number
  /** 原始正文，用于出摘要与高亮（不必再回查 messages）。 */
  text: string
  tokens: string[]
}

let dbPromise: Promise<IDBPDatabase<DeepSeaDB>> | null = null

export function db(): Promise<IDBPDatabase<DeepSeaDB>> {
  dbPromise ??= openDB<DeepSeaDB>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      // v1 → v2：加一张倒排索引表，给会话内全文搜索用。
      // 已有的 store 在 oldVersion >= 1 时都已存在，不能再 createObjectStore。
      if (oldVersion < 1) {
        const conversations = database.createObjectStore('conversations', { keyPath: 'id' })
        conversations.createIndex('by-updated', 'updatedAt')
        const messages = database.createObjectStore('messages', { keyPath: 'id' })
        messages.createIndex('by-conversation', 'conversationId')
        messages.createIndex('by-created', 'createdAt')
        const memories = database.createObjectStore('memories', { keyPath: 'id' })
        memories.createIndex('by-updated', 'updatedAt')
        database.createObjectStore('summaries', { keyPath: 'conversationId' })
        const files = database.createObjectStore('files', { keyPath: 'id' })
        files.createIndex('by-workspace', 'workspaceId')
        files.createIndex('by-path', 'path')
        database.createObjectStore('settings', { keyPath: 'key' })
        const usage = database.createObjectStore('usage', { keyPath: 'id' })
        usage.createIndex('by-created', 'createdAt')
      }
      if (oldVersion < 2) {
        const search = database.createObjectStore('search', { keyPath: 'id' })
        search.createIndex('by-token', 'tokens', { multiEntry: true })
        search.createIndex('by-conversation', 'conversationId')
      }
      // v2 → v3：布置屏照片的大图字节。照片以前整份躺在 localStorage 里，
      // 8 张全尺寸 dataURL 就把约 5MB 的配额顶穿了，而写失败被 catch {} 吞掉 ——
      // 用户的感受是「照片存不下来」。这里只存 id + dataURL，元数据仍在 localStorage
      // （引擎要能同步读到）。
      if (oldVersion < 3) {
        database.createObjectStore('photos', { keyPath: 'id' })
      }
      // v3 → v4：对话内生成媒体。photos 只管布置屏拍立得，media 管对话里的
      // 生图和语音；两者不要混用（生命周期和展示位置都不同）。
      if (oldVersion < 4) {
        const media = database.createObjectStore('media', { keyPath: 'id' })
        media.createIndex('by-conversation', 'conversationId')
        media.createIndex('by-message', 'messageId')
      }
      // v4 → v5：日历便签 + 助手主动唤醒排期。只加表，不动任何老表。
      if (oldVersion < 5) {
        const notes = database.createObjectStore('notes', { keyPath: 'id' })
        notes.createIndex('by-due', 'dueAt')
        notes.createIndex('by-updated', 'updatedAt')
        const wake = database.createObjectStore('wakeSchedules', { keyPath: 'id' })
        wake.createIndex('by-at', 'at')
      }
    },
  })
  return dbPromise
}

export async function listConversations(): Promise<Conversation[]> {
  const all = await (await db()).getAll('conversations')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  return (await db()).get('conversations', id)
}

export async function putConversation(conversation: Conversation): Promise<void> {
  await (await db()).put('conversations', conversation)
}

export async function deleteConversation(id: string): Promise<void> {
  const database = await db()
  const tx = database.transaction(['conversations', 'messages', 'summaries', 'search', 'media'], 'readwrite')
  await tx.objectStore('conversations').delete(id)
  const messages = tx.objectStore('messages')
  const keys = await messages.index('by-conversation').getAllKeys(id)
  for (const key of keys) await messages.delete(key)
  await tx.objectStore('summaries').delete(id)
  // 全文索引也必须跟着删：以前漏了这一步，被删掉的对话正文会一直躺在 search 里，
  // 用户以为删干净了，其实还在库里（BUG-REVIEW P1-30）。
  const search = tx.objectStore('search')
  const docs = await search.index('by-conversation').getAllKeys(id)
  for (const key of docs) await search.delete(key)
  // 生成媒体（图片/语音）的字节也要跟着走，否则会成为永远打不开的孤儿数据。
  const media = tx.objectStore('media')
  const mediaKeys = await media.index('by-conversation').getAllKeys(id)
  for (const key of mediaKeys) await media.delete(key)
  await tx.done
}

export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
  const all = await (await db()).getAllFromIndex('messages', 'by-conversation', conversationId)
  return all
    .filter((message) => message.active !== false)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 这条消息所属节点的全部候选（按落地时间排序），用于分支切换。 */
export async function listMessageSiblings(conversationId: string, nodeId: string): Promise<ChatMessage[]> {
  const all = await (await db()).getAllFromIndex('messages', 'by-conversation', conversationId)
  return all
    .filter((message) => (message.nodeId ?? message.id) === nodeId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function putMessage(message: ChatMessage): Promise<void> {
  await (await db()).put('messages', message)
  await indexMessage(message)
}

export async function patchMessage(id: string, patch: Partial<ChatMessage>): Promise<void> {
  const database = await db()
  const current = await database.get('messages', id)
  if (current === undefined) return
  const next = { ...current, ...patch }
  await database.put('messages', next)
  await indexMessage(next)
}

export async function deleteMessages(ids: readonly string[]): Promise<void> {
  const database = await db()
  const tx = database.transaction(['messages', 'media'], 'readwrite')
  const messages = tx.objectStore('messages')
  const media = tx.objectStore('media')
  for (const id of ids) {
    await messages.delete(id)
    const mediaKeys = await media.index('by-message').getAllKeys(id)
    for (const key of mediaKeys) await media.delete(key)
  }
  await tx.done
  await unindexMessages(ids)
}

/**
 * 改一条消息，并删掉它之后的全部消息 —— 同一个事务里做完。
 *
 * 「编辑重发」以前是先 put 再 delete 两次独立写入：中间一旦抛错，
 * 就会出现「正文改了、后面的消息还在」的半截状态。放进一个事务，
 * 要么都成，要么都不成。
 */
export async function rewriteMessageAndTruncate(
  message: ChatMessage,
  dropIds: readonly string[],
): Promise<void> {
  const database = await db()
  const tx = database.transaction(['messages', 'media'], 'readwrite')
  await tx.objectStore('messages').put(message)
  const media = tx.objectStore('media')
  for (const id of dropIds) {
    await tx.objectStore('messages').delete(id)
    const mediaKeys = await media.index('by-message').getAllKeys(id)
    for (const key of mediaKeys) await media.delete(key)
  }
  await tx.done
  await indexMessage(message)
  await unindexMessages(dropIds)
}

/**
 * 删掉一个节点：连同它的所有候选一起删。
 * 返回被删掉的全部消息 id，调用方据此更新内存里的列表。
 */
export async function deleteMessageNode(conversationId: string, nodeId: string): Promise<string[]> {
  const siblings = await listMessageSiblings(conversationId, nodeId)
  const ids = siblings.map((message) => message.id)
  if (ids.length > 0) await deleteMessages(ids)
  return ids
}

/**
 * 把 `upToMessageId`（含）之前的对话原样复制成一个新对话，用于「从此分叉」。
 * 只复制当前选中的分支（active），分支候选不跟过去——新对话从这一刻重新长。
 * 返回新对话 id 与复制了多少条消息。
 */
export async function forkConversationUpTo(
  sourceId: string,
  upToMessageId: string,
  title: string,
  model: string,
): Promise<{ id: string; copied: number }> {
  const database = await db()
  const source = await database.get('conversations', sourceId)
  if (source === undefined) throw new Error('要分叉的对话不在了')

  const messages = await listMessages(sourceId)
  const cutIndex = messages.findIndex((message) => message.id === upToMessageId)
  if (cutIndex === -1) throw new Error('这条消息不在这段对话里')
  const slice = messages.slice(0, cutIndex + 1)

  const id = `conv_${Math.random().toString(36).slice(2, 12)}`
  const now = Date.now()
  const conversation: Conversation = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    model,
    // 分叉出来的对话沿用源对话当时的助手与配置快照。
    assistantId: source.assistantId,
    config: source.config,
    // 项目也跟着源对话走，分叉后写文件仍然落在同一个项目里。
    workspaceId: source.workspaceId,
  }

  const tx = database.transaction(['conversations', 'messages', 'search', 'media'], 'readwrite')
  await tx.objectStore('conversations').put(conversation)
  const store = tx.objectStore('messages')
  const searchStore = tx.objectStore('search')
  const mediaStore = tx.objectStore('media')
  for (const [index, message] of slice.entries()) {
    // 节点 id 重新发号：新对话是独立的一条线，不能和原对话共用节点标识。
    const nodeId = message.nodeId === undefined ? undefined : `node_${id.slice(5)}_${index}`
    const copied: ChatMessage = {
      ...message,
      id: `msg_${id.slice(5)}_${index}`,
      conversationId: id,
      nodeId,
      active: undefined,
      media: undefined,
    }
    // 媒体行跟着消息复制：否则分叉后的对话里图片/语音引用指向原对话，
    // 原对话一删就全变成「已不在本机」。
    const mediaRows = message.media === undefined ? [] : await mediaStore.index('by-message').getAll(message.id)
    if (mediaRows.length > 0) {
      const refs: NonNullable<ChatMessage['media']> = []
      for (const [mediaIndex, row] of mediaRows.entries()) {
        const nextId = `media_${id.slice(5)}_${index}_${mediaIndex}`
        await mediaStore.put({ ...row, id: nextId, conversationId: id, messageId: copied.id })
        refs.push({
          id: nextId,
          kind: row.kind,
          mime: row.mime,
          ...(row.width !== undefined ? { width: row.width } : {}),
          ...(row.height !== undefined ? { height: row.height } : {}),
          ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
          ...(row.alt !== undefined ? { alt: row.alt } : {}),
        })
      }
      copied.media = refs
    }
    await store.put(copied)
    const text = `${copied.content}\n${copied.reasoning ?? ''}`.trim()
    if (text !== '') {
      await searchStore.put({
        id: copied.id,
        conversationId: id,
        role: copied.role,
        createdAt: copied.createdAt,
        text,
        tokens: tokenize(text),
      })
    }
  }
  await tx.done
  return { id, copied: slice.length }
}

/* ------------------------------------------------------- 全文搜索索引 */

/** 把一条消息写进（或更新进）倒排索引。 */
export async function indexMessage(message: ChatMessage): Promise<void> {
  const text = `${message.content}\n${message.reasoning ?? ''}`.trim()
  if (text === '') {
    await (await db()).delete('search', message.id)
    return
  }
  const doc: SearchDoc = {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    createdAt: message.createdAt,
    text,
    tokens: tokenize(text),
  }
  await (await db()).put('search', doc)
}

/** 从索引里删除一条消息。 */
export async function unindexMessages(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const database = await db()
  const tx = database.transaction('search', 'readwrite')
  for (const id of ids) await tx.store.delete(id)
  await tx.done
}

/**
 * 搜索。所有 query token 都必须命中（AND 语义），只返回指定对话里的结果。
 * 返回按时间倒序（新的在前）。
 */
export async function searchMessages(conversationId: string, query: string, limit = 50): Promise<SearchDoc[]> {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []
  const database = await db()
  const index = database.transaction('search').store.index('by-token')

  // 先按第一个 token 拿到候选，再用剩下的 token 过滤，避免全表扫描。
  const first = tokens[0] as string
  const candidates = await index.getAll(first)
  const need = tokens.slice(1)
  const hits = candidates.filter((doc) =>
    doc.conversationId === conversationId && need.every((token) => doc.tokens.includes(token)),
  )
  return hits.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

/**
 * 给整个库补建索引（升级到 v2 时老消息还没有索引）。
 * 顺便清掉孤儿条目：消息已经删了、索引还留着的那些 ——
 * 老版本删对话不清索引，库里可能躺着已删除对话的正文。
 * 只处理需要动的行，可重复调用。
 */
export async function rebuildSearchIndex(): Promise<number> {
  const database = await db()
  const [messages, docs] = await Promise.all([
    database.getAll('messages'),
    database.getAll('search'),
  ])
  const live = new Set(messages.map((message) => message.id))
  const orphans = docs.filter((doc) => !live.has(doc.id)).map((doc) => doc.id)
  if (orphans.length > 0) {
    const cleanup = database.transaction('search', 'readwrite')
    for (const id of orphans) await cleanup.store.delete(id)
    await cleanup.done
  }
  const indexed = new Set(docs.map((doc) => doc.id))
  const pending = messages.filter((message) => !indexed.has(message.id))
  if (pending.length === 0) return 0
  const tx = database.transaction('search', 'readwrite')
  for (const message of pending) {
    const text = `${message.content}\n${message.reasoning ?? ''}`.trim()
    if (text === '') continue
    await tx.store.put({
      id: message.id,
      conversationId: message.conversationId,
      role: message.role,
      createdAt: message.createdAt,
      text,
      tokens: tokenize(text),
    })
  }
  await tx.done
  return pending.length
}

export async function listMemories(): Promise<MemoryEntry[]> {  const all = await (await db()).getAll('memories')
  return all.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}

export async function putMemory(memory: MemoryEntry): Promise<void> {
  await (await db()).put('memories', memory)
}

export async function deleteMemory(id: string): Promise<void> {
  await (await db()).delete('memories', id)
}

export async function clearMemories(): Promise<void> {
  await (await db()).clear('memories')
}

export async function getSummary(conversationId: string): Promise<SummaryRecord | undefined> {
  return (await db()).get('summaries', conversationId)
}

export async function putSummary(summary: SummaryRecord): Promise<void> {
  await (await db()).put('summaries', summary)
}

export async function deleteSummary(conversationId: string): Promise<void> {
  await (await db()).delete('summaries', conversationId)
}

export async function listFiles(workspaceId = DEFAULT_WORKSPACE): Promise<WorkspaceFile[]> {
  const all = await (await db()).getAllFromIndex('files', 'by-workspace', workspaceId)
  return all.sort((a, b) => a.path.localeCompare(b.path))
}

/** 所有项目的文件（备份用，不按项目过滤）。 */
export async function listAllFiles(): Promise<WorkspaceFile[]> {
  return (await db()).getAll('files')
}

export async function getFile(path: string, workspaceId = DEFAULT_WORKSPACE): Promise<WorkspaceFile | undefined> {
  const all = await (await db()).getAllFromIndex('files', 'by-workspace', workspaceId)
  return all.find((file) => file.path === path)
}

export async function putFile(file: WorkspaceFile): Promise<void> {
  await (await db()).put('files', file)
}

export async function deleteFile(id: string): Promise<void> {
  await (await db()).delete('files', id)
}

/** 删掉一个项目里的所有文件（删除项目时用）。 */
export async function deleteFilesByWorkspace(workspaceId: string): Promise<number> {
  const database = await db()
  const files = await database.getAllFromIndex('files', 'by-workspace', workspaceId)
  for (const file of files) await database.delete('files', file.id)
  return files.length
}

export async function clearFiles(): Promise<void> {
  await (await db()).clear('files')
}

export async function clearConversations(): Promise<void> {
  const database = await db()
  await database.clear('conversations')
  await database.clear('messages')
  await database.clear('summaries')
  await database.clear('usage')
  await database.clear('media')
  // 同上：清空对话时全文索引也要清，否则「已清空」的正文还能被搜出来。
  await database.clear('search')
}

export async function addUsage(record: {
  conversationId: string
  model: string
  inputTokens: number
  outputTokens: number
}): Promise<void> {
  await (await db()).put('usage', {
    ...record,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  })
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const records = await (await db()).getAll('settings')
  return Object.fromEntries(records.map((record) => [record.key, record.value]))
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  await (await db()).put('settings', { key, value })
}

/* ------------------------------------------------------------ 相册字节 */

/**
 * 布置屏照片的大图字节。和 conversations/messages 那几张表分开看：
 * 这里只有 id + dataURL，标签/日期/缩略图在 localStorage 的元数据里
 * （引擎要同步读到，见 src/orca/photo.ts 的 loadPhotos）。
 */
export async function putPhotoRows(rows: readonly PhotoBytes[]): Promise<void> {
  if (rows.length === 0) return
  const database = await db()
  const tx = database.transaction('photos', 'readwrite')
  for (const row of rows) await tx.store.put(row)
  await tx.done
}

export async function listPhotoRows(): Promise<PhotoBytes[]> {
  return (await db()).getAll('photos')
}

export async function deletePhotoRows(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const database = await db()
  const tx = database.transaction('photos', 'readwrite')
  for (const id of ids) await tx.store.delete(id)
  await tx.done
}

/* ------------------------------------------------------------ 对话媒体 */

/** 写入一条生成媒体（图片/语音）。 */
export async function putMedia(record: MediaRecord): Promise<void> {
  await (await db()).put('media', record)
}

/** 按 id 取媒体；界面加载消息时用。 */
export async function getMedia(id: string): Promise<MediaRecord | undefined> {
  return (await db()).get('media', id)
}

/** 一条消息的全部媒体（正常情况 1~4 条）。 */
export async function listMediaByMessage(messageId: string): Promise<MediaRecord[]> {
  const rows = await (await db()).getAllFromIndex('media', 'by-message', messageId)
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export async function listMediaByConversation(conversationId: string): Promise<MediaRecord[]> {
  return (await db()).getAllFromIndex('media', 'by-conversation', conversationId)
}

export async function deleteMediaByMessage(messageId: string): Promise<void> {
  const database = await db()
  const tx = database.transaction('media', 'readwrite')
  const keys = await tx.store.index('by-message').getAllKeys(messageId)
  for (const key of keys) await tx.store.delete(key)
  await tx.done
}

export async function clearMedia(): Promise<void> {
  await (await db()).clear('media')
}

/* ---------------------------------------------------------------- 便签 */

export async function listNotes(): Promise<Note[]> {
  const all = await (await db()).getAll('notes')
  return all.sort((a, b) => a.updatedAt - b.updatedAt)
}

export async function putNote(note: Note): Promise<void> {
  await (await db()).put('notes', note)
}

export async function deleteNote(id: string): Promise<void> {
  await (await db()).delete('notes', id)
}

export async function clearNotes(): Promise<void> {
  await (await db()).clear('notes')
}

/* ------------------------------------------------------- 主动唤醒排期 */

export async function listWakeSchedules(): Promise<WakeSchedule[]> {
  const all = await (await db()).getAll('wakeSchedules')
  return all.sort((a, b) => a.at - b.at)
}

export async function putWakeSchedule(item: WakeSchedule): Promise<void> {
  await (await db()).put('wakeSchedules', item)
}

export async function deleteWakeSchedule(id: string): Promise<void> {
  await (await db()).delete('wakeSchedules', id)
}

export async function clearWakeSchedules(): Promise<void> {
  await (await db()).clear('wakeSchedules')
}
