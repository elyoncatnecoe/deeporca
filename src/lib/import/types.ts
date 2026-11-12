import type { ConversationConfig, MemoryEntry, Role } from '../types'

/**
 * 支持的导入来源。识别顺序见 index.ts 的 detectFormat：
 * deepsea（自家备份）→ deepseek（官方导出）→ rikkahub（SQLite）→ chatbox（ZIP/JSON）→ generic（兜底）。
 */
export type ImportFormat = 'deepsea' | 'deepseek' | 'rikkahub' | 'chatbox' | 'generic'

export const FORMAT_LABELS: Record<ImportFormat, string> = {
  deepsea: '深鲸备份 (deepsea-backup)',
  deepseek: 'DeepSeek 官方导出',
  rikkahub: 'rikkahub 数据库',
  chatbox: 'Chatbox 会话',
  generic: '通用 JSON（兜底识别）',
}

/** 解析后、尚未落库的一条消息。时间与 role 已收敛成 ChatMessage 能直接用的形态。 */
export interface ImportedMessage {
  role: Role
  content: string
  reasoning?: string
  createdAt: number
}

/** 解析后、尚未落库的一段对话。model 可能缺失，落库时用当前助手/全局设置补。 */
export interface ImportedConversation {
  title: string
  createdAt: number
  updatedAt: number
  model?: string
  messages: ImportedMessage[]
}

/**
 * 解析结果 = 预览所需的全部信息，但**一行都还没写库**。
 * 调用方先拿它渲染预览弹层，用户确认后再交给 applyImport。
 */
export interface ParsedImport {
  format: ImportFormat
  conversations: ImportedConversation[]
  /** 深鲸备份里自带的记忆，原样带过去（覆盖导入时不能把它们丢掉）。 */
  memories: MemoryEntry[]
  /** 没有映射成功、被跳过的消息/节点数（预览里要如实显示）。 */
  skipped: number
  /** 字段映射摘要，给用户看清「哪一列变成了什么」。 */
  mapping: string[]
  /** 软提示：例如「忽略了 3 个工具节点」「备份里的工坊文件未导入」。 */
  warnings: string[]
}

/** 待解析的输入：二进制（SQLite/ZIP）走 bytes，JSON 走 text。 */
export interface ImportInput {
  name: string
  text?: string
  bytes?: Uint8Array
}

export interface ImportOptions {
  /** merge = 追加；replace = 先清空本机对话与记忆再写入。 */
  mode: 'merge' | 'replace'
  /** 导入的对话统一归到「当前选中的助手」。 */
  assistantId: string
  /** 该助手的配置快照（由 resolveAssistantConfig 现算，导入的对话沿用同一套人设/模型）。 */
  config: ConversationConfig
  /** 助手与全局都没模型时的兜底串，避免 Conversation.model 为空。 */
  fallbackModel: string
}

export interface ImportStats {
  conversations: number
  messages: number
  /** 跳过的消息/节点数（解析阶段就丢弃的）。 */
  skipped: number
  memories: number
  /** 这次新落库的对话 id，供「生成记忆摘要」按需回查消息。 */
  conversationIds: string[]
  /** 导入消息的 token 估算（摘要预估用）。 */
  tokens: number
}

/** 进度回调：write 阶段按块推进，UI 用 done/total 画进度条。 */
export interface ImportHooks {
  signal?: AbortSignal
  onProgress?: (progress: { phase: 'write'; done: number; total: number }) => void
}

/** 用户中途取消。已写入的块会保留（IndexedDB 事务按块提交，无法整批回滚）。 */
export class ImportCancelled extends Error {
  constructor() {
    super('导入已取消')
    this.name = 'ImportCancelled'
  }
}

export function nowMs(): number {
  return Date.now()
}

/**
 * 把各种各样来源的时间收敛成毫秒时间戳。
 * 数字按毫秒（rikkahub 的 create_at 就是 ms）；字符串交给 Date.parse（ISO 带不带时区都能吃）。
 * 解析不出来就用 fallback，绝不返回 NaN —— NaN 会让排序与「最近对话」整段错乱。
 */
export function toTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

/**
 * 把消息正文收敛成纯文本。
 * 各家导出的 content 可能是字符串、OpenAI 式 [{type:'text',text}] 数组、或 rikkahub 的 parts。
 * 这里只拼 text 部分；图片等二进制内容不带（导入只负责「记忆」，图片没有对应宿主）。
 */
export function textOfContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item)
        continue
      }
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (typeof record.text === 'string') parts.push(record.text)
      else if (typeof record.content === 'string') parts.push(record.content)
    }
    return parts.join('\n')
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
  }
  return ''
}

/** 各家 role 大小写/别名不一，统一收敛到本项目四种 role；认不出返回 null 表示丢弃。 */
export function normalizeRole(value: unknown): Role | null {
  if (typeof value !== 'string') return null
  const role = value.trim().toLowerCase()
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') return role
  if (role === 'human') return 'user'
  if (role === 'ai' || role === 'bot' || role === 'model') return 'assistant'
  return null
}

/** 让出一帧，避免几千条消息一次性同步写把界面卡死（进度条与取消才有机会响应）。 */
export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 0)
    }
  })
}
