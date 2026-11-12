import type { ImportedConversation, ImportedMessage, ParsedImport } from './types'
import { normalizeRole, textOfContent, toTimestamp } from './types'

/**
 * jszip 只在真的遇到 .zip 时才加载（见 parseChatboxZip 里的动态 import）：
 * 它是几十 KB 的独立依赖，JSON 导入用不上，没必要拖进首屏。
 */
interface ZipEntry {
  name: string
  dir: boolean
  async: (type: 'string') => Promise<string>
}
interface ZipArchive {
  files: Record<string, ZipEntry>
}

/**
 * Chatbox 会话导入。
 *
 * 两个版本：
 * - 旧版：单个 JSON，顶层是 { sessions: [...] } 或直接是会话数组；
 * - 新版：一个 ZIP，里面有 manifest.json（描述 session 列表）+ 每会话一个 JSON 文件。
 *
 * 一个 session 的形状≈ { id, name/title, messages: [{ id, role, content }], createdAt, updatedAt }。
 * 这里对字段名做宽松兼容，不依赖某个具体小版本。
 */

function sessionMessages(value: Record<string, unknown>, base: number): ImportedMessage[] {
  const raw = value.messages
  if (!Array.isArray(raw)) return []
  const messages: ImportedMessage[] = []
  let lastTime = 0
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== 'object') continue
    const message = item as Record<string, unknown>
    const role = normalizeRole(message.role)
    const content = textOfContent(message.content ?? message.text ?? message.parts)
    if (role === null || content.trim() === '') continue
    let createdAt = toTimestamp(message.createdAt ?? message.created_at ?? message.timestamp ?? message.time, base + index * 1000)
    if (createdAt <= lastTime) createdAt = lastTime + 1
    lastTime = createdAt
    messages.push({ role, content, createdAt })
  }
  return messages
}

function normalizeSession(value: unknown, fallbackTitle: string): ImportedConversation | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const createdAtFallback = toTimestamp(record.createdAt ?? record.created_at, Date.now())
  const messages = sessionMessages(record, createdAtFallback)
  if (messages.length === 0) return null
  const title = [record.name, record.title, record.topic]
    .find((item): item is string => typeof item === 'string' && item.trim() !== '')
    ?.trim() ?? fallbackTitle
  const createdAt = toTimestamp(record.createdAt ?? record.created_at, messages[0]?.createdAt ?? createdAtFallback)
  const updatedAt = toTimestamp(record.updatedAt ?? record.updated_at, messages[messages.length - 1]?.createdAt ?? createdAt)
  return { title, createdAt, updatedAt, messages }
}

const MAPPING = [
  'session.name / title → 对话标题',
  'session.messages[] → 消息列表',
  'message.role → 用户 / 助手',
  'message.content（字符串或 parts）→ 正文',
  'message.timestamp / createdAt → 时间',
]

/** 旧版/单文件 Chatbox JSON；不是 Chatbox 形状返回 null，交给兜底。 */
export function parseChatboxJson(raw: unknown): ParsedImport | null {
  const conversations: ImportedConversation[] = []
  let skipped = 0

  const take = (value: unknown, index: number): void => {
    const conversation = normalizeSession(value, `导入对话 ${index + 1}`)
    if (conversation === null) skipped += 1
    else conversations.push(conversation)
  }

  if (Array.isArray(raw)) {
    // 纯数组：要求像会话（有 messages），否则不是 Chatbox。
    if (raw.length === 0 || raw.every((item) => item === null || typeof item !== 'object')) return null
    raw.forEach(take)
  } else if (raw !== null && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    if (Array.isArray(record.sessions)) {
      record.sessions.forEach(take)
    } else if (Array.isArray(record.messages)) {
      // 单会话文件也接受。
      take(record, 0)
    } else {
      return null
    }
  } else {
    return null
  }

  if (conversations.length === 0) return null
  return { format: 'chatbox', conversations, memories: [], skipped, mapping: MAPPING, warnings: [] }
}

function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

export async function parseChatboxZip(bytes: Uint8Array): Promise<ParsedImport> {
  let zip: ZipArchive
  try {
    // 动态 import：只有真的导入 ZIP 时才拉 jszip，普通 JSON 导入不付这份体积。
    const JSZip = (await import('jszip')).default
    zip = (await JSZip.loadAsync(bytes)) as unknown as ZipArchive
  } catch (error) {
    throw new Error(`这个 ZIP 解不开：${error instanceof Error ? error.message : String(error)}`)
  }

  const files: Record<string, ZipEntry> = zip.files
  const jsonPaths = Object.keys(files).filter(
    (path) => !files[path]?.dir && path.toLowerCase().endsWith('.json'),
  )
  const findFile = (candidate: string): ZipEntry | undefined => {
    if (files[candidate] !== undefined) return files[candidate]
    const byBase = jsonPaths.find((path) => baseName(path).toLowerCase() === candidate.toLowerCase())
    return byBase !== undefined ? files[byBase] : undefined
  }

  const conversations: ImportedConversation[] = []
  let skipped = 0
  const warnings: string[] = []

  const manifestFile = findFile('manifest.json')
  let usedFiles = new Set<string>()

  if (manifestFile !== undefined) {
    usedFiles.add('manifest.json')
    let manifest: unknown
    try {
      manifest = JSON.parse(await manifestFile.async('string')) as unknown
    } catch {
      manifest = null
    }
    const record = manifest !== null && typeof manifest === 'object' ? (manifest as Record<string, unknown>) : {}
    const sessions = Array.isArray(record.sessions) ? record.sessions : []
    for (const [index, entry] of sessions.entries()) {
      if (entry === null || typeof entry !== 'object') {
        skipped += 1
        continue
      }
      const session = entry as Record<string, unknown>
      // manifest 里直接内联了 messages 的，省得再找文件。
      if (Array.isArray(session.messages)) {
        const conversation = normalizeSession(session, `导入对话 ${index + 1}`)
        if (conversation === null) skipped += 1
        else conversations.push(conversation)
        continue
      }
      const id = typeof session.id === 'string' ? session.id : ''
      const candidates: string[] = []
      for (const key of ['file', 'fileName', 'path'] as const) {
        if (typeof session[key] === 'string' && (session[key] as string).trim() !== '') candidates.push(session[key] as string)
      }
      if (id !== '') {
        candidates.push(`${id}.json`, `sessions/${id}.json`, `chats/${id}.json`)
      }
      const target = candidates.map(findFile).find((file): file is ZipEntry => file !== undefined)
      if (target === undefined) {
        skipped += 1
        continue
      }
      usedFiles.add(target.name)
      let parsed: unknown
      try {
        parsed = JSON.parse(await target.async('string')) as unknown
      } catch {
        skipped += 1
        continue
      }
      const conversation = normalizeSession(parsed, `导入对话 ${index + 1}`)
      if (conversation === null) skipped += 1
      else conversations.push(conversation)
    }
  }

  // 没有 manifest（或 manifest 没覆盖到）时，把剩下的 .json 逐个当成会话读。
  if (conversations.length === 0) {
    for (const path of jsonPaths) {
      if (usedFiles.has(path) || baseName(path).toLowerCase() === 'manifest.json') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(await files[path].async('string')) as unknown
      } catch {
        skipped += 1
        continue
      }
      // 有的导出会再包一层 { sessions: [...] }。
      if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).sessions)) {
        for (const entry of (parsed as Record<string, unknown>).sessions as unknown[]) {
          const conversation = normalizeSession(entry, '导入对话')
          if (conversation === null) skipped += 1
          else conversations.push(conversation)
        }
      } else {
        const conversation = normalizeSession(parsed, '导入对话')
        if (conversation === null) skipped += 1
        else conversations.push(conversation)
      }
    }
  }

  if (conversations.length === 0) {
    throw new Error('ZIP 里没有找到可导入的 Chatbox 会话（没认出 manifest.json 或会话 JSON）')
  }
  if (skipped > 0) warnings.push(`${skipped} 个会话文件没有可读消息，已跳过`)

  return {
    format: 'chatbox',
    conversations,
    memories: [],
    skipped,
    mapping: [...MAPPING, '新版 ZIP：manifest.json + 每会话 JSON', '旧版：单个 JSON（sessions[] 或会话数组）'],
    warnings,
  }
}
