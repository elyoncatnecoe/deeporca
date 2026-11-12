import { completeJson } from '../deepseek'
import { listMessages } from '../db'
import { upsertMemoryCandidates } from '../memory'
import { normalizeType } from '../memory-core'
import { hasApiKey } from '../providers'
import { estimateTokens } from '../tokens'
import type { MemoryCandidate, Settings } from '../types'

/**
 * 导入后的「记忆摘要」：用 settings.memoryModel 对刚导入的对话分批抽取长期记忆。
 *
 * 为什么单独一个文件：抽取要调模型（deepseek.completeJson）+ 写记忆库（memory.upsert），
 * 是有副作用的一层；把它和纯解析分开，解析层就能在无 Key、无网络的环境里单测。
 *
 * 落库直接复用 memory.ts 的 upsertMemoryCandidates，于是「准入 / 去重 / 矛盾登记」
 * 与平时聊天时记忆写入走的是同一套逻辑（memory-core 的 planUpsert 等），不会两套标准。
 */

/** 默认最多处理 200 条消息。长对话一次全抽既慢又贵，且早期内容对「稳定事实」贡献很低。 */
export const DEFAULT_MAX_SUMMARY_MESSAGES = 200

/** 单批送入模型的正文 token 上限；超过就切下一批。 */
const BATCH_TOKEN_LIMIT = 2600
/** 单批最多几条消息，防止一堆超短句把请求数撑爆。 */
const BATCH_MAX_MESSAGES = 40

const SUMMARY_SYSTEM = [
  '你是长期记忆抽取器。读一段用户与助手的对话，只挑出「跨会话仍然成立、值得长期记住」的稳定事实。',
  '',
  '规则：',
  '- 只写用户本人的身份、稳定偏好、正在做或维护的项目、与助手/他人的相处方式。',
  '- 不要记：一次性任务（帮我查/搜/翻译/算一下）、寒暄、临时情绪、任何密钥/密码/证件/验证码。',
  '- 每条一句话、能独立读懂、带主语，80 字以内；同一件事合并成一条，别拆碎。',
  '- 拿不准就不写，宁缺毋滥。',
  '',
  '输出 JSON：{"memories":[{"text":"...","type":"profile|preference|project|relationship|other","importance":0}]}',
  'importance 取 0~5 的整数；没有值得记的就输出 {"memories":[]}。',
].join('\n')

export interface SummaryProgress {
  doneBatches: number
  totalBatches: number
  processedMessages: number
  totalMessages: number
  added: number
  updated: number
  pending: number
  skipped: number
}

export interface SummaryResult {
  added: number
  updated: number
  pending: number
  skipped: number
  processedMessages: number
  batches: number
  cancelled: boolean
}

export interface SummaryRequest {
  settings: Settings
  conversationIds: string[]
  /** 最多处理多少条消息（硬上限）；默认 DEFAULT_MAX_SUMMARY_MESSAGES。 */
  maxMessages?: number
  signal?: AbortSignal
  onProgress?: (progress: SummaryProgress) => void
}

interface FlatMessage {
  role: string
  content: string
}

/** 预估要消耗的 token：只算被 cap 到的前 N 条，UI 在开始前就能给个数字。 */
export function estimateSummaryTokens(messages: readonly { content: string }[], maxMessages = DEFAULT_MAX_SUMMARY_MESSAGES): number {
  const capped = messages.slice(0, Math.max(0, maxMessages))
  return capped.reduce((sum, message) => sum + estimateTokens(message.content), 0)
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

async function collectMessages(conversationIds: readonly string[], maxMessages: number): Promise<FlatMessage[]> {
  const out: FlatMessage[] = []
  for (const id of conversationIds) {
    const messages = await listMessages(id)
    for (const message of messages) {
      if (message.content.trim() === '') continue
      out.push({ role: message.role, content: message.content })
      if (out.length >= maxMessages) return out
    }
  }
  return out
}

function buildBatches(messages: readonly FlatMessage[]): FlatMessage[][] {
  const batches: FlatMessage[][] = []
  let current: FlatMessage[] = []
  let tokens = 0
  for (const message of messages) {
    const cost = estimateTokens(message.content)
    if (current.length > 0 && (tokens + cost > BATCH_TOKEN_LIMIT || current.length >= BATCH_MAX_MESSAGES)) {
      batches.push(current)
      current = []
      tokens = 0
    }
    current.push(message)
    tokens += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function asCandidate(value: unknown): MemoryCandidate | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.text !== 'string' || record.text.trim() === '') return null
  return {
    text: record.text.trim().slice(0, 200),
    type: normalizeType(record.type),
    ...(typeof record.importance === 'number' && Number.isFinite(record.importance)
      ? { importance: record.importance }
      : {}),
  }
}

/**
 * 生成记忆摘要。任何一批失败都只记跳过、继续下一批 —— 不能因为一批 400 就整段白跑。
 * 取消（signal）在批与批之间生效：当前请求会被 completeJson 里的 signal 打断。
 */
export async function generateMemorySummary(request: SummaryRequest): Promise<SummaryResult> {
  if (!hasApiKey(request.settings)) {
    throw new Error('还没有配好模型 API Key，无法生成摘要')
  }
  const maxMessages = Math.max(1, request.maxMessages ?? DEFAULT_MAX_SUMMARY_MESSAGES)
  const messages = await collectMessages(request.conversationIds, maxMessages)
  const batches = buildBatches(messages)
  const result: SummaryResult = {
    added: 0,
    updated: 0,
    pending: 0,
    skipped: 0,
    processedMessages: 0,
    batches: batches.length,
    cancelled: false,
  }

  for (const [index, batch] of batches.entries()) {
    if (isAborted(request.signal)) {
      result.cancelled = true
      break
    }
    const transcript = batch
      .map((message) => `[${message.role === 'user' ? '用户' : '助手'}] ${message.content}`)
      .join('\n\n')
    const user = `对话片段（第 ${index + 1}/${batches.length} 段）：\n${transcript}`

    let raw: unknown
    try {
      raw = await completeJson({ settings: request.settings, system: SUMMARY_SYSTEM, user, maxTokens: 700, signal: request.signal })
    } catch (error) {
      if (isAborted(request.signal)) {
        result.cancelled = true
        break
      }
      // 单批失败不影响其余批次；跳过数会体现在结果里。
      result.skipped += batch.length
      request.onProgress?.({
        doneBatches: index + 1,
        totalBatches: batches.length,
        processedMessages: result.processedMessages + batch.length,
        totalMessages: messages.length,
        added: result.added,
        updated: result.updated,
        pending: result.pending,
        skipped: result.skipped,
      })
      result.processedMessages += batch.length
      continue
    }

    const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const candidates = Array.isArray(record.memories)
      ? record.memories.map(asCandidate).filter((item): item is MemoryCandidate => item !== null)
      : []

    if (candidates.length > 0) {
      try {
        const outcome = await upsertMemoryCandidates(candidates, {}, { scope: 'global' }, { allowPending: true })
        result.added += outcome.added
        result.updated += outcome.updated
        result.pending += outcome.pending
        // 注意：outcome.skipped 是「候选被去重/准入挡掉」的数量，不是「消息没处理成」，
        // 不并进 result.skipped（那是给「整批失败、消息没读到」计数的），否则界面上会
        // 出现「有 N 条消息没抽取成功」的误导提示。
      } catch {
        // 写记忆失败（库异常）也只跳过这批，不中断整个导入后的流程。
        result.skipped += candidates.length
      }
    }

    result.processedMessages += batch.length
    request.onProgress?.({
      doneBatches: index + 1,
      totalBatches: batches.length,
      processedMessages: result.processedMessages,
      totalMessages: messages.length,
      added: result.added,
      updated: result.updated,
      pending: result.pending,
      skipped: result.skipped,
    })
  }

  return result
}
