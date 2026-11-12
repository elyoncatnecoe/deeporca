/**
 * 备份脱敏：把请求头里像密钥的东西换成占位符。
 *
 * 为什么单独一个模块：backup.ts 会连带 import db（IndexedDB），在 node 里跑不起来；
 * 脱敏规则是最该被测到的部分，抽出来才测得到。
 *
 * 背景（BUG-REVIEW P0-1）：备份被设计成「能进 git、可分享」，但旧实现只清
 * `settings.apiKey` 与 `providers[].apiKey`，`providers[].headers` 与
 * `mcpServers[].headers` 原样进文件 —— 而代码本身鼓励把密钥放 header。
 */

/** 备份里代替密钥的占位符。导入时会把它丢掉，绝不会当成真请求头发出去。 */
export const REDACTED = '<redacted>'

/** 头名看着就像密钥的。 */
const SECRET_HEADER_NAME = /authorization|api[-_]?key|token|secret|password|passwd|cookie|session|signature|credential/i

/** 值看着像密钥的：Bearer/Basic 前缀、sk-…、JWT、长随机串。 */
export function looksLikeSecret(value: string): boolean {
  const text = value.trim()
  if (text === '') return false
  if (/^(bearer|basic|token|digest)\s+/i.test(text)) return true
  if (/^sk-[A-Za-z0-9_-]{8,}$/.test(text)) return true
  // JWT：三段 base64url，第一段通常以 ey 开头。
  if (/^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\./.test(text)) return true
  // 长且没有空格的可打印串（常见于各种自定义 token）。
  if (/^[A-Za-z0-9_\-+/=.:]{32,}$/.test(text)) return true
  return false
}

/**
 * 把请求头里像密钥的值换成占位符，**保留头名**。
 * 保留头名是有意的：用户翻备份时还能看出「我配过 Authorization」，
 * 只是值不该跟着文件走。
 */
export function redactHeaders(headers: unknown): unknown {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return headers
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      out[name] = value
      continue
    }
    out[name] = SECRET_HEADER_NAME.test(name) || looksLikeSecret(value) ? REDACTED : value
  }
  return out
}

/** 导入时把占位符丢掉：备份里的 `<redacted>` 不是真的请求头。 */
export function dropRedactedHeaders(headers: unknown): unknown {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return headers
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === REDACTED) continue
    out[name] = value
  }
  return out
}