/**
 * 设置项收敛用的小工具。
 *
 * 单独放一个纯模块：settings.ts 会连带 import db / platform（IndexedDB、Capacitor），
 * 在 node 里跑不起来；把「怎么判定、怎么夹紧」抽出来，这几条规则才测得到。
 */

import { WEB_CHAT_MODEL } from './models.ts'
import { PROTOCOLS } from './providers.ts'
import type { ProviderProtocol } from './types.ts'

/**
 * 合法的协议 id，直接取自 providers.ts 的那一份清单。
 *
 * 以前 settings.ts 另抄了一行 ['openai','anthropic','google']，漏掉 'deepseek-web'，
 * 于是「网页账号（免 Key）」供应商每次冷启动都被判成脏数据、改写成 openai 再存回去
 * —— 免 Key 的说明消失、界面冒出 Key 输入框（BUG-REVIEW P1-12）。
 */
const PROTOCOL_IDS: ReadonlySet<string> = new Set(PROTOCOLS.map((item) => item.id))

/** 这个协议 id 我们认识吗。 */
export function isKnownProtocol(value: unknown): value is ProviderProtocol {
  return typeof value === 'string' && PROTOCOL_IDS.has(value)
}

/**
 * 数值兜底：只有「根本不是数字」时才用默认值。
 *
 * 不能写 `Number(x) || fallback` —— 那会把合法的 0 一起吞掉：
 * temperature=0 本来是「尽量确定性」，却被悄悄改成 0.7（BUG-REVIEW P1-14）。
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

/**
 * 决定一个供应商该用哪个协议。
 *
 * 除了「认识的协议就保留、不认识的回落 openai」，还顺手修历史数据：
 * 老版本不认 'deepseek-web'，会把它改写成 'openai' 再落库；这种被改坏的供应商
 * 有一个明确特征 —— 模型列表里只有网页模型。认出来就还原成网页账号，
 * 否则用户那边永远停在一个「要填 Key 的网页账号」上（BUG-REVIEW P1-12）。
 */
export function resolveProtocol(raw: unknown, models: readonly string[]): ProviderProtocol {
  const looksLikeWeb = models.includes(WEB_CHAT_MODEL)
  if (looksLikeWeb && (raw === undefined || raw === null || raw === 'openai')) return 'deepseek-web'
  if (isKnownProtocol(raw)) return raw
  return 'openai'
}