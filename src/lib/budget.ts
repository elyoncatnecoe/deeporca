import type { Provider, Settings, ThinkingEffort } from './types'

/**
 * 输出预算的单一来源。
 *
 * DeepSeek 这类推理模型的 max_tokens 限的是**整段输出** —— reasoning_content 与
 * content 共用同一个额度，不是「正文上限」。以前我们把 settings.maxTokens 原样发出去，
 * 长思考（3D 场景动辄七八千字）把额度全吃光，服务端就回 finish_reason:'length'，
 * 正文是空的、tool_calls 也是空的 —— 引擎据此「没有工具」直接结束，
 * 用户看到的症状是「工坊一次都没被调用」，其实是一次都没轮到。
 * 所以这里把设置里那个数当作**正文预算**，另按思考强度加一段预留。
 *
 * 单独成模块的原因：请求体（deepseek.ts）、上下文预算（prompt.ts）、界面文案（Settings）
 * 都要用同一个算法，而且它必须能在 node 里直接跑测试 —— 这里不碰 DOM、不碰 IndexedDB。
 */

/** 各档思考强度的预留（token）。off 不发思考，所以留 0。 */
export const REASONING_RESERVE: Record<ThinkingEffort, number> = {
  off: 0,
  low: 4096,
  high: 8192,
  max: 16384,
}

/**
 * 「撞顶」的几种写法：OpenAI 兼容回 length，Anthropic 回 max_tokens，
 * Gemini 回 MAX_TOKENS。三家字段名不同，含义相同。
 */
const TRUNCATION_FINISH_REASONS: readonly string[] = ['length', 'max_tokens', 'MAX_TOKENS']

/** 这一轮的输出是不是被长度上限切断了。 */
export function isTruncatedFinish(reason: string | undefined): boolean {
  return reason !== undefined && TRUNCATION_FINISH_REASONS.indexOf(reason) !== -1
}

export interface OutputCap {
  /** 正文预算（设置里的那个数；0 = 不限制）。 */
  body: number
  /** 这一档思考强度的预留。 */
  reserve: number
  /** 真正要发给服务的 max_tokens；null 表示**不发这个字段**（对齐上游「留空表示无限制」）。 */
  cap: number | null
  /** 模型目录声明的最大输出；没有条目就是 undefined（不参与收顶）。 */
  modelMax: number | undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * 算出这一轮该发的 max_tokens。
 *
 * 规则（按 docs/REVIEW-20261103.md §四-B1）：
 *   cap = 正文预算 + 思考预留，再用模型目录声明的输出上限收一次顶；
 *   但**永不低于正文预算** —— 模型声明比用户要的还小时，用户要的优先，
 *   否则一个填错的目录数据会把正文砍到几百字。
 *   正文预算填 0 = 自动 = 干脆不发 max_tokens。
 */
export function resolveOutputCap(
  settings: Settings,
  provider: Provider | undefined,
  effort?: ThinkingEffort,
): OutputCap {
  const body = positiveInt(settings.maxTokens) ?? 0
  const level = effort ?? settings.thinkingEffort
  const reserve = REASONING_RESERVE[level] ?? 0
  const modelMax = positiveInt(provider?.modelMeta?.[settings.model]?.maxTokens)
  if (body === 0) return { body: 0, reserve, cap: null, modelMax }
  const want = body + reserve
  const clamped = modelMax === undefined ? want : Math.max(body, Math.min(want, modelMax))
  return { body, reserve, cap: clamped, modelMax }
}

/**
 * 撞顶后「原地重试一次」要用的上限；null 表示不值得重试。
 *
 * 两种不值得：正文预算填 0（本来就没发 max_tokens，翻倍也无从翻起），
 * 或者已经贴着模型声明的输出上限（再翻只会让中转站回一个 400）。
 */
export function retryCap(cap: OutputCap): number | null {
  const current = cap.cap
  if (current === null) return null
  const target = cap.modelMax === undefined ? current * 2 : Math.min(current * 2, cap.modelMax)
  return target > current ? target : null
}

/**
 * 工具参数是不是完整 JSON。
 *
 * 流被切断时 arguments 常常只剩半截（写到一半的文件内容）。半截 JSON 绝不能
 * 当成真实调用执行 —— 那会拿一份残缺内容覆盖工坊里原本好好的文件。
 */
export function isCompleteToolArguments(raw: string | undefined): boolean {
  if (raw === undefined) return false
  try {
    JSON.parse(raw === '' ? '{}' : raw)
    return true
  } catch {
    return false
  }
}
