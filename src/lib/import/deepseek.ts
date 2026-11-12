import type { ImportedConversation, ImportedMessage, ParsedImport } from './types'
import { nowMs, textOfContent, toTimestamp } from './types'

/**
 * DeepSeek 官方聊天记录导出（conversations.json）。
 *
 * 结构：顶层数组，每元素一段对话；对话里的 mapping 是一棵树（key=节点 id），
 * 节点挂着自己的 message，message.fragments 才是真正的内容。role 不直接给，
 * 要靠 fragment.type 反推：
 *   REQUEST  = 用户这一问
 *   RESPONSE = 助手正文
 *   THINK    = 助手思考（映射成 reasoning）
 *   SEARCH / FILE / TOOL_* = 联网/文件/工具，属于展示性附件，正文里不展开
 * 根节点 key 固定叫 'root' 且 message 为 null。
 */

interface DeepseekFragment {
  type?: string
  content?: unknown
}

interface DeepseekMessage {
  model?: string
  inserted_at?: string
  fragments?: DeepseekFragment[]
}

interface DeepseekNode {
  id?: string
  parent?: string | null
  children?: string[]
  message?: DeepseekMessage | null
}

/** 只认「数组 + 每项有 mapping 对象」，避免把别的 JSON 误判成官方导出。 */
export function isDeepseekShape(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length === 0) return false
  const first = raw[0]
  if (first === null || typeof first !== 'object') return false
  const mapping = (first as Record<string, unknown>).mapping
  return mapping !== null && typeof mapping === 'object' && !Array.isArray(mapping)
}

/**
 * 从 root 沿 children 走出一条主线。
 *
 * 为什么取「最后一个 child」：同一条消息被重新生成时，mapping 会分叉出多个 child，
 * 官方把最新一次生成挂在 children 数组末尾。取最后一个 = 得到用户当下看到的那条时间线，
 * 而不是被丢弃的旧候选。遇到环（脏数据）用 seen 兜底，防止死循环。
 */
function walkMainline(mapping: Record<string, unknown>): DeepseekNode[] {
  const path: DeepseekNode[] = []
  const seen = new Set<string>()
  let key: string | null = 'root'
  while (key !== null && key !== '' && !seen.has(key)) {
    seen.add(key)
    const raw = mapping[key]
    if (raw === null || typeof raw !== 'object') break
    const node = raw as DeepseekNode
    if (node.message !== undefined && node.message !== null) path.push(node)
    const children = Array.isArray(node.children) ? node.children : []
    const next = children.length > 0 ? children[children.length - 1] : undefined
    key = typeof next === 'string' ? next : null
  }
  return path
}

function fragmentsOf(node: DeepseekNode): DeepseekFragment[] {
  const fragments = node.message?.fragments
  return Array.isArray(fragments) ? fragments : []
}

function joinFragmentText(fragments: DeepseekFragment[], type: string): string {
  return fragments
    .filter((fragment) => fragment.type === type)
    .map((fragment) => textOfContent(fragment.content))
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}

export function parseDeepseek(raw: unknown): ParsedImport {
  const conversations: ImportedConversation[] = []
  const warnings: string[] = []
  let skipped = 0

  if (!Array.isArray(raw)) {
    return {
      format: 'deepseek',
      conversations,
      memories: [],
      skipped,
      mapping: [],
      warnings: ['这不是 DeepSeek 官方导出的顶层数组'],
    }
  }

  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const mapping = record.mapping
    if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) continue

    const path = walkMainline(mapping as Record<string, unknown>)
    const fallbackBase = toTimestamp(record.inserted_at, nowMs())
    const messages: ImportedMessage[] = []
    let model: string | undefined
    // 某些节点缺 inserted_at，用「上一条 +1」保证同一对话内时间严格递增，
    // 否则列表页和搜索结果的稳定顺序会被打乱。
    let lastTime = 0

    for (const [index, node] of path.entries()) {
      const fragments = fragmentsOf(node)
      const requestText = joinFragmentText(fragments, 'REQUEST')
      const responseText = joinFragmentText(fragments, 'RESPONSE')
      const thinkText = joinFragmentText(fragments, 'THINK')

      const role = requestText !== '' ? 'user' : (responseText !== '' || thinkText !== '') ? 'assistant' : null
      const content = role === 'user' ? requestText : responseText
      const reasoning = role === 'assistant' && thinkText !== '' ? thinkText : undefined

      // 只带 SEARCH/FILE/TOOL_* 的节点没有可读正文：跳过，但计数让用户知道有东西没进来。
      if (role === null || (content.trim() === '' && (reasoning ?? '').trim() === '')) {
        skipped += 1
        continue
      }

      let createdAt = toTimestamp(node.message?.inserted_at, fallbackBase + index * 1000)
      if (createdAt <= lastTime) createdAt = lastTime + 1
      lastTime = createdAt

      if (typeof node.message?.model === 'string' && node.message.model !== '' && model === undefined) {
        model = node.message.model
      }
      messages.push({ role, content, ...(reasoning !== undefined ? { reasoning } : {}), createdAt })
    }

    if (messages.length === 0) {
      skipped += 1
      continue
    }

    const createdAt = toTimestamp(record.inserted_at, messages[0]?.createdAt ?? nowMs())
    const updatedAt = toTimestamp(record.updated_at, messages[messages.length - 1]?.createdAt ?? createdAt)
    const title = typeof record.title === 'string' && record.title.trim() !== '' ? record.title.trim() : '未命名对话'
    conversations.push({ title, createdAt, updatedAt, ...(model !== undefined ? { model } : {}), messages })
  }

  return {
    format: 'deepseek',
    conversations,
    memories: [],
    skipped,
    mapping: [
      'fragment.type = REQUEST → 用户消息',
      'fragment.type = RESPONSE → 助手正文',
      'fragment.type = THINK → 思考（reasoning）',
      'SEARCH / FILE / TOOL_* 只作附件，正文不展开',
      '分叉节点取 children 的最后一个（最新一次生成）',
    ],
    warnings,
  }
}
