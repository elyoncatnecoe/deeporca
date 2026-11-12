/**
 * 会话内全文搜索的分词。
 *
 * IndexedDB 没有 FTS5，所以自己做一层倒排索引。中文没有空格分词，
 * 这里用「英文按词 + 中文按双字组（bigram）」的混合切法：
 * - 英文/数字：连续字母数字算一个词，转小写；
 * - 中文/日文/韩文：相邻两个字组成一个 token，单字兜底；
 * - 其它字符当分隔符。
 * 查询时对关键词做同样的切分，取所有 token 的交集。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
const WORD = /[a-z0-9_]+/g

/** 把一段文本切成索引用的 token 集合（已去重）。 */
export function tokenize(text: string): string[] {
  const out = new Set<string>()
  if (text === '') return []
  const lower = text.toLowerCase()

  for (const match of lower.matchAll(WORD)) {
    const word = match[0]
    if (word.length >= 2) out.add(word)
  }

  // 中文按双字组切；单字的也留一个，保证单字查询能命中。
  const chars = [...lower]
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string
    if (!CJK.test(ch)) continue
    const next = chars[i + 1]
    if (next !== undefined && CJK.test(next)) out.add(ch + next)
    else out.add(ch)
  }
  return [...out]
}

/**
 * 查询词切分。数组里每一项都必须命中（AND）。
 *
 * 注意：查询**不能**直接复用 tokenize 的单字兜底逻辑。
 * 建索引时「虎鲸是…」会切成 虎鲸/鲸是/…，没有单独的「鲸」；
 * 但 tokenize('虎鲸') 会给出 ['虎鲸','鲸']，要求两个都命中就永远搜不到。
 * 所以中文连续段只切 bigram，只有整段长度是 1 时才退化成单字。
 */
export function queryTokens(query: string): string[] {
  const trimmed = query.trim().toLowerCase()
  if (trimmed === '') return []
  const out = new Set<string>()

  for (const match of trimmed.matchAll(WORD)) {
    const word = match[0]
    if (word.length >= 2) out.add(word)
  }

  // 把连续的中文字段各自切 bigram。
  const segments: string[][] = []
  let current: string[] = []
  for (const ch of trimmed) {
    if (CJK.test(ch)) {
      current.push(ch)
    } else if (current.length > 0) {
      segments.push(current)
      current = []
    }
  }
  if (current.length > 0) segments.push(current)

  for (const segment of segments) {
    if (segment.length === 1) {
      out.add(segment[0] as string)
      continue
    }
    for (let i = 0; i < segment.length - 1; i += 1) {
      out.add(`${segment[i]}${segment[i + 1]}`)
    }
  }
  return [...out]
}

/** 高亮用：把 query 里的词在原文中找出来（大小写不敏感）。 */
export function snippetAround(text: string, query: string, radius = 40): string {
  const q = query.trim()
  if (q === '') return text.slice(0, radius * 2)
  const index = text.toLowerCase().indexOf(q.toLowerCase())
  if (index === -1) return text.slice(0, radius * 2)
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + q.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}