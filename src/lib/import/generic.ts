import type { ImportedConversation, ImportedMessage, ParsedImport } from './types'
import { normalizeRole, textOfContent, toTimestamp } from './types'

/**
 * 兜底解析：认不出的 JSON 就递归找「像消息数组」的数组。
 *
 * 判定标准：数组里至少有一项是对象，且带 role 字段并带 content/text/parts 之一。
 * 找到的每个这样的数组当成一段对话；文件名当标题。宁可多认一点，也别让用户拿到空手。
 */

function looksLikeMessages(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.some((item) => {
    if (item === null || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    const hasRole = typeof record.role === 'string'
    const hasBody = record.content !== undefined || record.text !== undefined || record.parts !== undefined
    return hasRole && hasBody
  })
}

function collectMessageArrays(value: unknown, out: unknown[][], depth: number): void {
  if (depth > 8 || value === null || typeof value !== 'object') return
  if (looksLikeMessages(value)) {
    out.push(value)
    return
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  for (const entry of entries) collectMessageArrays(entry, out, depth + 1)
}

function toConversation(messagesRaw: unknown[], title: string): ImportedConversation | null {
  const messages: ImportedMessage[] = []
  const base = Date.now()
  let lastTime = 0
  for (const [index, item] of messagesRaw.entries()) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const role = normalizeRole(record.role)
    const content = textOfContent(record.content ?? record.text ?? record.parts)
    if (role === null || content.trim() === '') continue
    let createdAt = toTimestamp(record.createdAt ?? record.created_at ?? record.timestamp ?? record.time, base + index * 1000)
    if (createdAt <= lastTime) createdAt = lastTime + 1
    lastTime = createdAt
    messages.push({ role, content, createdAt })
  }
  if (messages.length === 0) return null
  return { title, createdAt: messages[0]?.createdAt ?? base, updatedAt: messages[messages.length - 1]?.createdAt ?? base, messages }
}

export function parseGeneric(raw: unknown, fileName: string): ParsedImport {
  const arrays: unknown[][] = []
  collectMessageArrays(raw, arrays, 0)

  const baseTitle = fileName.replace(/\.[^.]+$/, '').trim() || '导入对话'
  const conversations: ImportedConversation[] = []
  let skipped = 0
  for (const [index, array] of arrays.entries()) {
    const title = arrays.length > 1 ? `${baseTitle} #${index + 1}` : baseTitle
    const conversation = toConversation(array, title)
    if (conversation === null) skipped += 1
    else conversations.push(conversation)
  }

  const warnings = conversations.length === 0
    ? ['没有在文件里找到「role + content」形状的消息数组，无法导入']
    : []

  return {
    format: 'generic',
    conversations,
    memories: [],
    skipped,
    mapping: [
      '递归查找 role + (content|text|parts) 的数组',
      '数组 → 一段对话；role/content → 消息',
      '文件名 → 对话标题',
    ],
    warnings,
  }
}
