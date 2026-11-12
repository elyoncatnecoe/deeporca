import { estimateTokens } from './tokens.ts'
import type { ChatMessage } from './types.ts'

/**
 * 压缩的「纯决策」逻辑：什么时候压、保留哪一段。
 *
 * 单独放在这里（不 import db / store / 网络）是为了能被单测直接覆盖——
 * compress.ts 本体带 IndexedDB 与模型调用，很难在 node 里剥开测。
 */

/** 已用 token 超过「预算 × 这个比例」才考虑自动压缩。 */
export const COMPRESS_TRIGGER_RATIO = 0.7

/** 最近这部分预算的消息保留原文，不折进摘要。 */
export const COMPRESS_KEEP_RATIO = 0.3

/** 一条消息除了正文/思考，还有角色、分隔等固定开销，按 8 token 估。 */
const MESSAGE_OVERHEAD = 8

/**
 * 是否满足压缩条件。
 * - 手动压缩（force = true）永远视为满足，由调用方再校验「至少 4 条」。
 * - 自动压缩只在「已用 > 预算 × 0.7」时为真。
 */
export function shouldCompress(used: number, budget: number, force = false): boolean {
  if (!Number.isFinite(budget) || budget <= 0) return false
  if (force) return true
  return used > budget * COMPRESS_TRIGGER_RATIO
}

/**
 * 计算「保留窗口」的切点：返回一个下标，`messages[0..cutIndex)` 会被折进摘要，
 * 其余保留原文。
 *
 * - 手动指定了 `keepRecentMessages` 就严格保留最近这么多条；
 * - 否则按「预算的 30%」从新到旧累加，装不下就停。
 */
export function resolveCutIndex(
  messages: readonly ChatMessage[],
  budget: number,
  keepRecentMessages?: number,
): number {
  if (messages.length === 0) return 0
  if (keepRecentMessages !== undefined && Number.isFinite(keepRecentMessages) && keepRecentMessages > 0) {
    return Math.max(0, messages.length - Math.floor(keepRecentMessages))
  }
  const keepBudget = Math.floor(budget * COMPRESS_KEEP_RATIO)
  let acc = 0
  let index = messages.length
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as ChatMessage
    const cost = estimateTokens(message.content) + estimateTokens(message.reasoning ?? '') + MESSAGE_OVERHEAD
    if (index !== messages.length && acc + cost > keepBudget) break
    acc += cost
    index = i
  }
  return index
}
