import type { ImportedConversation, ImportedMessage, ParsedImport } from './types'
import { normalizeRole, textOfContent, toTimestamp } from './types'

/**
 * rikkahub（Android 上的开源聊天客户端）的 SQLite 结构。
 *
 * - ConversationEntity：一段对话一行，create_at / update_at 是毫秒时间戳。
 * - message_node：**一个节点 = 一条消息的一个位置**，node_index 在对话内递增；
 *   messages 是「这个位置的全部候选分支」的 JSON 数组，select_index 指向当前激活的那条。
 *   重新生成不会新增节点，而是把候选追加进同一节点的数组并把 select_index 指过去。
 *
 * 浏览器不能直接读 SQLite，所以真正的读库放在 rikkahub-loader.ts（sql.js）。
 * 这里只做纯数据映射，方便单测/脚本用真实样本验证。
 */

export interface RikkaConversationRow {
  id: string
  title: string | null
  create_at: number | null
  update_at: number | null
}

export interface RikkaNodeRow {
  id: string
  conversation_id: string
  node_index: number | null
  messages: string | null
  select_index: number | null
}

interface RikkaPart {
  type?: string
  text?: string
}

interface RikkaMessage {
  role?: string
  parts?: RikkaPart[]
  content?: unknown
  createdAt?: string
  modelId?: string
}

function parseMessages(raw: string | null): RikkaMessage[] {
  if (raw === null || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is RikkaMessage => item !== null && typeof item === 'object')
  } catch {
    return []
  }
}

/** parts 里只取 text 段；图片/语音等没有可导入的宿主，跳过。 */
function partsText(parts: RikkaPart[] | undefined): string {
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}

export function parseRikkaRows(
  conversationsRaw: RikkaConversationRow[],
  nodesRaw: RikkaNodeRow[],
): ParsedImport {
  const warnings: string[] = []
  let skipped = 0

  // 按对话归组，再按 node_index 升序 —— 节点顺序就是时间顺序。
  const nodesByConversation = new Map<string, RikkaNodeRow[]>()
  for (const node of nodesRaw) {
    const list = nodesByConversation.get(node.conversation_id)
    if (list === undefined) nodesByConversation.set(node.conversation_id, [node])
    else list.push(node)
  }
  for (const list of nodesByConversation.values()) {
    list.sort((a, b) => (a.node_index ?? 0) - (b.node_index ?? 0))
  }

  const conversations: ImportedConversation[] = []
  let emptyTitle = 0

  for (const conversation of conversationsRaw) {
    const nodes = nodesByConversation.get(conversation.id) ?? []
    const messages: ImportedMessage[] = []
    let model: string | undefined
    const base = toTimestamp(conversation.create_at, Date.now())
    let lastTime = 0

    for (const node of nodes) {
      const candidates = parseMessages(node.messages)
      if (candidates.length === 0) {
        skipped += 1
        continue
      }
      // select_index 越界（旧数据/脏数据）时退回 0，而不是丢掉整条。
      const rawIndex = typeof node.select_index === 'number' ? node.select_index : 0
      const index = Math.min(Math.max(rawIndex, 0), candidates.length - 1)
      const chosen = candidates[index]
      if (chosen === undefined) {
        skipped += 1
        continue
      }

      const role = normalizeRole(chosen.role)
      const content = partsText(chosen.parts) || textOfContent(chosen.content)
      if (role === null || content.trim() === '') {
        skipped += 1
        continue
      }

      let createdAt = toTimestamp(chosen.createdAt, base + (node.node_index ?? 0) * 1000)
      if (createdAt <= lastTime) createdAt = lastTime + 1
      lastTime = createdAt

      if (typeof chosen.modelId === 'string' && chosen.modelId !== '' && model === undefined) {
        model = chosen.modelId
      }
      messages.push({ role, content, createdAt })
    }

    if (messages.length === 0) {
      skipped += 1
      continue
    }

    let title = typeof conversation.title === 'string' ? conversation.title.trim() : ''
    if (title === '') {
      title = '未命名对话'
      emptyTitle += 1
    }
    const updatedAt = toTimestamp(conversation.update_at, messages[messages.length - 1]?.createdAt ?? base)
    conversations.push({ title, createdAt: base, updatedAt, ...(model !== undefined ? { model } : {}), messages })
  }

  if (emptyTitle > 0) warnings.push(`${emptyTitle} 段对话标题为空，已命名为「未命名对话」`)

  return {
    format: 'rikkahub',
    conversations,
    memories: [],
    skipped,
    mapping: [
      'ConversationEntity.title → 对话标题',
      'ConversationEntity.create_at / update_at → 创建/更新时间',
      'message_node 按 node_index 升序 → 消息顺序',
      'messages[select_index] → 当前激活的那条候选',
      'parts[type=text] → 消息正文',
      'modelId → 对话模型',
    ],
    warnings,
  }
}
