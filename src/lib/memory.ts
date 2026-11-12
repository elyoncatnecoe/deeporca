import { nanoid } from 'nanoid'
import { listConversations, listMemories, putMemory } from './db'
import {
  admitMemory,
  inferMemoryType,
  looksLikeRepeat,
  normalizeCandidate,
  normalizeText,
  normalizeType,
  planUpsert,
  sanitizeExtras,
  selectForPrompt,
} from './memory-core'
import type { ChatMessage, MemoryCandidate, MemoryEntry, Settings } from './types'

// 纯逻辑住在 memory-core（无 DB 依赖、可单测），这里只负责「读库、写库、闸门」。
export { memoryPromptBlock, memoryReadEnabled, memoryTypeLabel, tokenize } from './memory-core'
export type { MemorySelection } from './memory-core'

export const REMEMBER_TOOL_NAME = 'remember'

export const REMEMBER_TOOL = {
  type: 'function',
  function: {
    name: REMEMBER_TOOL_NAME,
    description:
      '把一条值得跨会话记住的稳定事实写进长期记忆。用户明确要求记住，或你得知了长期有效的身份、偏好、项目时调用；一次性任务、寒暄、猜测、凭证不要调用。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '一句能独立读懂的事实，带主语，80 字以内。',
        },
        type: {
          type: 'string',
          enum: ['profile', 'preference', 'project', 'relationship', 'other'],
          description: 'profile 身份信息，preference 长期偏好，project 正在做的事，relationship 相处方式，other 其它。',
        },
        importance: {
          type: 'number',
          description: '0 到 5，越长期越重要越高；默认 1。',
        },
      },
      required: ['text', 'type'],
    },
  },
} as const

export interface UpsertResult {
  added: number
  updated: number
  pending: number
  skipped: number
}

function emptyResult(): UpsertResult {
  return { added: 0, updated: 0, pending: 0, skipped: 0 }
}

function replaceInList(list: MemoryEntry[], next: MemoryEntry): void {
  const index = list.findIndex((item) => item.id === next.id)
  if (index === -1) list.push(next)
  else list[index] = next
}

export interface UpsertSource {
  conversationId?: string
  messageId?: string
}

export interface UpsertTarget {
  scope: MemoryEntry['scope']
  characterId?: string
}

/**
 * 三条写入来源共用的落库入口：先过准入，再按 scope+type 判重/判冲突。
 * 相似就更新旧条（旧文本进 history），矛盾只登记 pending，绝不覆盖。
 */
export async function upsertMemoryCandidates(
  candidates: readonly MemoryCandidate[],
  source: UpsertSource,
  target: UpsertTarget = { scope: 'global' },
  options: { allowPending?: boolean } = {},
): Promise<UpsertResult> {
  const result = emptyResult()
  if (candidates.length === 0) return result
  const allowPending = options.allowPending ?? true
  const existing = await listMemories()

  for (const candidate of candidates) {
    const admitted = admitMemory(candidate.text ?? '')
    if (!admitted.ok) {
      result.skipped += 1
      continue
    }
    const merged = normalizeCandidate(candidate, target)
    if (merged.scope === 'character' && (merged.characterId ?? '') === '') {
      // 归属不明的私聊记忆没有意义，宁可丢掉。
      result.skipped += 1
      continue
    }
    const extras = sanitizeExtras(candidate)
    const plan = planUpsert(merged, existing)
    const now = Date.now()

    if (plan.action === 'skip') {
      result.skipped += 1
      continue
    }
    if (plan.action === 'update') {
      const current = existing.find((item) => item.id === plan.targetId)
      if (current === undefined) {
        result.skipped += 1
        continue
      }
      const next: MemoryEntry = {
        ...current,
        text: merged.text,
        history: [...(current.history ?? []), current.text].slice(-10),
        tags: [...new Set([...current.tags, ...extras.tags])].slice(0, 8),
        importance: Math.max(current.importance, extras.importance),
        pending: false,
        sourceConversationId: source.conversationId ?? current.sourceConversationId,
        sourceMessageId: source.messageId ?? current.sourceMessageId,
        updatedAt: now,
      }
      await putMemory(next)
      replaceInList(existing, next)
      result.updated += 1
      continue
    }
    if (plan.action === 'pending' && !allowPending) {
      // 重复检测是宽松通道：拿不准就先不记，别拿 pending 烦用户。
      result.skipped += 1
      continue
    }

    const entry: MemoryEntry = {
      id: `mem_${nanoid(10)}`,
      text: merged.text,
      type: merged.type,
      tags: extras.tags,
      importance: extras.importance,
      scope: merged.scope,
      characterId: merged.characterId,
      pending: plan.action === 'pending' ? true : undefined,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.messageId,
      createdAt: now,
      updatedAt: now,
      pinned: false,
    }
    await putMemory(entry)
    existing.push(entry)
    if (plan.action === 'pending') result.pending += 1
    else result.added += 1
  }
  return result
}

/** 同一次对话里主动写入的上限；去重表分开两份，免得重复检测挤掉工具写入的额度。 */
const SESSION_WRITE_LIMIT = 5
const toolWrites = new Map<string, Set<string>>()
const repeatMarks = new Map<string, Set<string>>()

function sessionSet(store: Map<string, Set<string>>, conversationId: string): Set<string> {
  let set = store.get(conversationId)
  if (set === undefined) {
    set = new Set()
    store.set(conversationId, set)
    if (store.size > 64) {
      const oldest = store.keys().next().value
      if (oldest !== undefined) store.delete(oldest)
    }
  }
  return set
}

export interface RememberOptions {
  conversationId: string
  messageId?: string
  scope?: MemoryEntry['scope']
  characterId?: string
}

/**
 * 模型工具入口。后台静默写入：失败不抛、不弹提示，绝不影响这一轮对话。
 * 返回的话很短，也提醒模型别把记下来的事复述给用户。
 */
export async function remember(
  input: { text?: unknown; type?: unknown; importance?: unknown },
  options: RememberOptions,
): Promise<{ ok: boolean; reply: string; changed: number }> {
  const failed = { ok: false, reply: '这次没记住，继续吧。', changed: 0 }
  try {
    if (typeof input.text !== 'string') return failed
    const admitted = admitMemory(input.text)
    if (!admitted.ok) return { ...failed, reply: '这条不用长期记，继续吧。' }

    const seen = sessionSet(toolWrites, options.conversationId)
    const key = admitted.text.toLowerCase()
    if (seen.has(key)) return { ok: true, reply: '已经记下了，继续。', changed: 0 }
    if (seen.size >= SESSION_WRITE_LIMIT) return { ...failed, reply: '这轮记的够多了，先继续。' }

    const outcome = await upsertMemoryCandidates(
      [{
        text: admitted.text,
        type: normalizeType(input.type),
        importance: typeof input.importance === 'number' ? input.importance : 1,
      }],
      { conversationId: options.conversationId, messageId: options.messageId },
      { scope: options.scope ?? 'global', characterId: options.characterId },
      { allowPending: true },
    )
    const changed = outcome.added + outcome.updated + outcome.pending
    if (changed > 0) seen.add(key)
    return { ok: true, reply: '记好了，继续；不用向用户复述。', changed }
  } catch (error) {
    console.warn('[memory] write skipped', error)
    return failed
  }
}

/**
 * 回复后的重复检测：同一话题用户第二次提到、且不与已有记忆冲突，就收下。
 * 这是「用户自己反复说」的兜底，比定时抽取省一条 LLM 调用。
 */
export async function detectRepeatedMemories(options: {
  conversationId: string
  messages: readonly ChatMessage[]
  settings: Settings
  scope?: MemoryEntry['scope']
  characterId?: string
}): Promise<UpsertResult> {
  const empty = emptyResult()
  try {
    if (!options.settings.memoryEnabled) return empty
    const userTexts = options.messages
      .filter((message) => message.role === 'user' && message.content.trim() !== '')
      .map((message) => message.content)
    if (userTexts.length < 2) return empty
    const current = userTexts[userTexts.length - 1]
    if (!looksLikeRepeat(current, userTexts.slice(0, -1))) return empty

    const repeat = admitMemory(current.slice(0, 200))
    if (!repeat.ok) return empty
    const seen = sessionSet(repeatMarks, options.conversationId)
    const key = repeat.text.toLowerCase()
    if (seen.has(key)) return empty

    const outcome = await upsertMemoryCandidates(
      [{ text: repeat.text, type: inferMemoryType(repeat.text), importance: 2 }],
      { conversationId: options.conversationId },
      { scope: options.scope ?? 'global', characterId: options.characterId },
      { allowPending: false },
    )
    if (outcome.added + outcome.updated > 0) seen.add(key)
    return outcome
  } catch (error) {
    console.warn('[memory] repeat detect skipped', error)
    return empty
  }
}

export interface PromptMemory {
  active: MemoryEntry[]
  hidden: number
  usedTokens: number
  budget: number
}

async function touch(memories: readonly MemoryEntry[]): Promise<void> {
  const now = Date.now()
  for (const memory of memories) {
    if (memory.lastUsedAt !== undefined && now - memory.lastUsedAt < 3_600_000) continue
    try {
      await putMemory({ ...memory, lastUsedAt: now })
    } catch {
      // 记「最近用过」失败不该影响这一轮对话。
    }
  }
}

/**
 * 注入用的选条：分层 + 预算 + 助手过滤。读失败就当没有记忆，绝不影响对话。
 */
export async function memoryForPrompt(options: {
  settings: Settings
  characterId: string
  hint?: string
}): Promise<PromptMemory> {
  const budget = Math.max(0, options.settings.memoryTokenBudget ?? 800)
  try {
    const memories = await listMemories()
    const selection = selectForPrompt({
      memories,
      characterId: options.characterId,
      budget,
      hint: options.hint,
    })
    void touch(selection.active)
    return { ...selection, budget }
  } catch (error) {
    console.warn('[memory] read skipped', error)
    return { active: [], hidden: 0, usedTokens: 0, budget }
  }
}

export async function recentRecap(activeConversationId: string | null): Promise<string> {
  const conversations = (await listConversations())
    .filter((conversation) => conversation.id !== activeConversationId)
    .slice(0, 3)
  if (conversations.length === 0) return ''
  return conversations.map((conversation) => {
    const summary = conversation.summary?.trim()
    return `- ${conversation.title}${summary ? `：${summary.slice(0, 80)}` : ''}`
  }).join('\n')
}

export async function memoryCount(): Promise<number> {
  return (await listMemories()).length
}
