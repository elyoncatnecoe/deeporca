import { getSummary, listMessages, putSummary } from './db'
import { completeJson } from './deepseek'
import { estimateTokens } from './prompt'
import { useAppStore } from './store'
import { hasApiKey } from './providers'
import { resolveCutIndex, shouldCompress } from './compress-plan'
import type { ChatMessage, Settings, SummaryRecord } from './types'

export { COMPRESS_TRIGGER_RATIO, COMPRESS_KEEP_RATIO } from './compress-plan'

/** 一次至少折进这么多条才值得调一次模型，避免频繁小压。 */
const MIN_FOLD_MESSAGES = 4

const inFlight = new Set<string>()

const COMPRESS_SYSTEM_PROMPT = [
  '你在为一段仍在进行的对话维护「滚动摘要」。你的输出会被放回同一段对话的 system prompt，',
  '让模型在看不到早期原文的情况下也知道这段对话发生过什么。',
  '',
  '必须遵守：',
  '- 只写这段对话本身发生了什么：在聊什么、聊到哪、用户在意什么、有哪些还没解决的问题。',
  '- 禁止写长期事实（名字、住址、偏好、身份这类）——那些归记忆库，写进来会两边重复甚至打架。',
  '- 尽量保留用户原话里的关键短语，不要改写成你的措辞。',
  '- 不完整的就写不完整，不要补全、不要编。',
  '',
  '输出 JSON：{"summary": "...", "lost": ["因为压缩而丢掉的、值得说一声的细节", "..."]}。',
  'lost 没有就给空数组。',
].join('\n')

function messageText(message: ChatMessage): string {
  return `${message.content}\n${message.reasoning ?? ''}`
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

/** 手动压缩时用户可以额外提要求，拼在 system prompt 末尾。 */
function withExtraPrompt(system: string, extra?: string): string {
  const trimmed = (extra ?? '').trim()
  if (trimmed === '') return system
  return `${system}\n\n这次压缩的额外要求：${trimmed}（有冲突时以这条为准）`
}

export interface CompressOptions {
  /** 跳过「已用超过 70%」这道门槛。手动压缩时为 true。 */
  force?: boolean
  /** 强制保留最近这么多条原文，覆盖按预算推算的保留窗口。 */
  keepRecentMessages?: number
  /** 用户额外要求，例如「人名和结论要留准」。 */
  extraPrompt?: string
}

export type CompressResult =
  | { ok: true; foldedCount: number }
  | { ok: false; reason: string }

/**
 * 把「已有摘要 + 这一段原文」交给便宜模型，输出新的摘要。
 * 任何失败都向上抛，由调用方决定怎么告诉用户。
 */
async function summarizeSegment(
  settings: Settings,
  previous: SummaryRecord | undefined,
  segment: readonly ChatMessage[],
  extraPrompt?: string,
): Promise<{ summary: string; lost: string[] }> {
  const transcript = segment
    .map((message) => {
      const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : message.role
      const text = messageText(message).trim()
      return `[${role}] ${text}`
    })
    .join('\n\n')

  const user = [
    previous !== undefined && previous.text.trim() !== ''
      ? `已有摘要（更早的部分）：\n${previous.text.trim()}`
      : '已有摘要：无（这是第一次压缩）。',
    '',
    '要并入摘要的新增原文：',
    transcript,
  ].join('\n')

  const raw = await completeJson({
    settings,
    system: withExtraPrompt(COMPRESS_SYSTEM_PROMPT, extraPrompt),
    user,
    maxTokens: 800,
  })

  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  if (summary === '') throw new Error('摘要为空')
  return { summary, lost: asStringArray(record.lost) }
}

/**
 * 压缩的实现本体。自动与手动都走这里，差别只在 options：
 * - 自动：force 为假，先过 70% 门槛；
 * - 手动：force 为真，跳过门槛，但仍要满足「至少 4 条」与保留窗口。
 * 失败不静默：写一条 notice，UI 会显示。
 */
async function runCompress(
  conversationId: string,
  settings: Settings,
  options: CompressOptions = {},
): Promise<CompressResult> {
  if (!hasApiKey(settings)) return { ok: false, reason: '还没有配 Key' }
  if (inFlight.has(conversationId)) return { ok: false, reason: '正在压，等一下' }

  const messages = await listMessages(conversationId)
  if (messages.length === 0) return { ok: false, reason: '这里还没有对话' }

  const previous = await getSummary(conversationId)

  const used = messages.reduce(
    (total, message) => total + estimateTokens(message.content) + estimateTokens(message.reasoning ?? ''),
    0,
  )
  const budget = settings.contextBudget - settings.maxTokens
  if (budget <= 0) return { ok: false, reason: '上下文预算太小了' }
  if (!shouldCompress(used, budget, options.force === true)) {
    return { ok: false, reason: '这段还不算长，先不用压' }
  }

  // 保留窗口：手动指定优先，否则按「预算的 30%」从新到旧推（纯逻辑见 compress-plan.ts）。
  const cutIndex = resolveCutIndex(messages, budget, options.keepRecentMessages)

  const coveredUntilAt = previous?.coveredUntilAt ?? 0
  const segment = messages
    .slice(0, cutIndex)
    .filter((message) => message.createdAt > coveredUntilAt)
  if (segment.length < MIN_FOLD_MESSAGES) {
    return { ok: false, reason: '这段还不够长，先不用压' }
  }

  const last = segment[segment.length - 1] as ChatMessage
  const foldedCount = (previous?.foldedCount ?? 0) + segment.length

  inFlight.add(conversationId)
  try {
    const { summary, lost } = await summarizeSegment(settings, previous, segment, options.extraPrompt)
    const record: SummaryRecord = {
      conversationId,
      text: summary,
      updatedAt: Date.now(),
      coveredUntilId: last.id,
      coveredUntilAt: last.createdAt,
      foldedCount,
    }
    await putSummary(record)
    if (lost.length > 0) {
      useAppStore.getState().actions.setNotice(`这次压缩我丢了一些细节：${lost.slice(0, 3).join('；')}`)
    }
    return { ok: true, foldedCount }
  } catch (error) {
    console.warn('[compress] skipped', error)
    // 一次网络错误不能变成一次无声的记忆缺失。
    useAppStore.getState().actions.setNotice('这次没压成，前面那段我丢了')
    return { ok: false, reason: '这次没压成，前面那段我丢了' }
  } finally {
    inFlight.delete(conversationId)
  }
}

/**
 * 在后台看情况压缩这段对话的历史。自动触发用，行为与之前完全一致。
 */
export async function maybeCompress(conversationId: string, settings: Settings): Promise<void> {
  await runCompress(conversationId, settings)
}

/**
 * 用户主动要求压缩：跳过门槛，成功后写一条 notice 告诉用户折了多少条。
 */
export async function compressNow(
  conversationId: string,
  settings: Settings,
  options: CompressOptions = {},
): Promise<CompressResult> {
  const result = await runCompress(conversationId, settings, { ...options, force: true })
  if (result.ok) {
    useAppStore.getState().actions.setNotice(`前面的 ${result.foldedCount} 条已经折成摘要了，接着聊`)
  } else {
    useAppStore.getState().actions.setNotice(result.reason)
  }
  return result
}

/** 给 system prompt 用的摘要文本；没有就是空串。 */
export async function conversationDigest(conversationId: string): Promise<string> {
  return (await getSummary(conversationId))?.text ?? ''
}
