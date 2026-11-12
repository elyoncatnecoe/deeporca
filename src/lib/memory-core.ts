import { estimateTokens } from './tokens.ts'
import type { Assistant, MemoryEntry, MemoryType, Settings } from './types'

export const MEMORY_TYPES: readonly MemoryType[] = ['profile', 'preference', 'project', 'relationship', 'other']

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '与', '就', '都', '也', '很', '不',
  '有', '这', '那', '一个', '什么', '怎么', 'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or',
  'in', 'on', 'for', 'with', 'that', 'this', 'it', 'be', 'as', 'at', 'by', 'from', 'we', 'you', 'i',
])

/** 太泛、几乎每条记忆和每个标题里都会出现的词，不拿来判断「相关」。 */
const HINT_IGNORE = new Set(['用户', '项目', '使用', '一个', '这个', '那个', '我们', '他们', '现在', '然后', '可以', '需要'])

/** P0 常驻：稳定的身份与偏好。 */
const P0_TYPES: readonly MemoryType[] = ['profile', 'preference']
/** P1 项目：只在相关对话里带。 */
const P1_TYPES: readonly MemoryType[] = ['project']

/** 包含度：短的那条有多少被长的那条覆盖。用来认「同一条的细化/补充」。 */
export function containment(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let overlap = 0
  for (const value of setA) if (setB.has(value)) overlap += 1
  return overlap / Math.min(setA.size, setB.size)
}

/** 一条被另一条完全覆盖到这个程度，就算同一条的新版本（改了措辞/补了细节）。 */
export const SIMILAR_THRESHOLD = 0.88
/** 相似到三成以上又不同，视为疑似矛盾，只登记待确认，不覆盖。 */
export const CONFLICT_THRESHOLD = 0.35
/** 用户再次提到同一话题的宽松阈值。 */
export const REPEAT_THRESHOLD = 0.3

export const MEMORY_HEADER = '## 长期上下文（你应默认知道的事实，自然运用即可）'
export const MEMORY_FOOTER = '请自然回应；除非用户明确询问，否则不要主动提及这些来自「记忆」。'

let segmenter: Intl.Segmenter | null = null
try {
  segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' })
} catch {
  segmenter = null
}

function bigrams(text: string): string[] {
  const chars = [...text.replace(/[\s\p{P}\p{S}]+/gu, '')]
  const grams: string[] = []
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.push(`${chars[index]}${chars[index + 1]}`)
  }
  return grams
}

export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase()
  const tokens = new Set<string>()
  if (segmenter !== null) {
    for (const part of segmenter.segment(normalized)) {
      const word = part.segment.trim()
      if (word.length > 1 && !STOP_WORDS.has(word)) tokens.add(word)
    }
  } else {
    for (const word of normalized.split(/[\s\p{P}\p{S}]+/gu)) {
      if (word.length > 1 && !STOP_WORDS.has(word)) tokens.add(word)
    }
  }
  for (const gram of bigrams(normalized)) {
    if (!STOP_WORDS.has(gram)) tokens.add(gram)
  }
  return [...tokens]
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let overlap = 0
  for (const value of setA) if (setB.has(value)) overlap += 1
  return overlap / (setA.size + setB.size - overlap)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function normalizeType(value: unknown): MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value)
    ? (value as MemoryType)
    : 'other'
}

export function memoryTypeLabel(type: MemoryType): string {
  switch (type) {
    case 'profile': return '关于你'
    case 'preference': return '偏好'
    case 'project': return '项目'
    case 'relationship': return '相处'
    default: return '其他'
  }
}

/** 0 = 常驻注入，1 = 相关对话才带，2 = 不注入。置顶可把后者提级。 */
export type MemoryTier = 0 | 1 | 2

export function memoryTier(type: MemoryType, pinned = false): MemoryTier {
  if (pinned) return 0
  if (P0_TYPES.includes(type)) return 0
  if (P1_TYPES.includes(type)) return 1
  return 2
}

/**
 * 这条记忆能不能被某个助手读到：global 跨助手共享，
 * character 只归它的主人。pending 的条目不注入。
 */
export function memoryVisibleTo(memory: MemoryEntry, characterId: string): boolean {
  if (memory.pending === true) return false
  if (memory.scope === 'global') return true
  return memory.scope === 'character' && memory.characterId === characterId
}

export type RejectionReason = 'length' | 'sensitive' | 'greeting' | 'transient'

export interface Admission {
  ok: boolean
  reason?: RejectionReason
  text: string
}

const SENSITIVE = /(api[\s_-]?key|access[\s_-]?token|secret|passw(?:or)?d|密码|口令|身份证|银行卡|信用卡|验证码|sk-[a-zA-Z0-9]{8,})/i
const GREETING = /^(你好|您好|嗨|哈喽|hi|hello|hey|在吗|在不在|早|早安|午安|晚安|谢谢|多谢|thanks|thank you)[\s!！。.~～]*$/i
const TRANSIENT = /(帮我(查|搜|看|找|写|翻|算|列|读)|查一下|搜一下|翻译一下|算一下|列一下|今天(天气|几号|星期)|现在几点|临时|一次性|随便问)/

/**
 * 「该不该记」的唯一入口：稳定事实放过，寒暄、一次性任务、凭证挡掉。
 * 主动工具和重复检测都走这里，所以准入只有一处定义。
 */
export function admitMemory(text: string): Admission {
  const normalized = normalizeText(text)
  if (normalized.length < 3 || normalized.length > 200) return { ok: false, reason: 'length', text: normalized }
  if (SENSITIVE.test(normalized)) return { ok: false, reason: 'sensitive', text: normalized }
  if (GREETING.test(normalized)) return { ok: false, reason: 'greeting', text: normalized }
  if (TRANSIENT.test(normalized)) return { ok: false, reason: 'transient', text: normalized }
  return { ok: true, text: normalized }
}

/** 那句用户原话更像哪一类记忆，给重复检测兜底用。 */
export function inferMemoryType(text: string): MemoryType {
  if (/(喜欢|偏好|习惯|讨厌|不喜欢|更愿意|希望|以后都)/.test(text)) return 'preference'
  if (/(在做|正在做|开发|项目|维护|重构|发布)/.test(text)) return 'project'
  if (/(名字|叫|住在|来自|生日|是.{0,6}(工程师|学生|设计师|开发者|老师|医生))/.test(text)) return 'profile'
  if (/(关系|称呼|叫我|朋友|伴侣|家人)/.test(text)) return 'relationship'
  return 'other'
}

export interface UpsertCandidate {
  text: string
  type: MemoryType
  scope: MemoryEntry['scope']
  characterId?: string
}

export type UpsertPlan =
  | { action: 'add' }
  | { action: 'update'; targetId: string; similarity: number }
  | { action: 'pending' }
  | { action: 'skip'; targetId: string }

function sameBucket(memory: MemoryEntry, candidate: UpsertCandidate): boolean {
  if (memory.scope !== candidate.scope) return false
  if (memory.type !== candidate.type) return false
  if (candidate.scope === 'character') return memory.characterId === candidate.characterId
  return true
}

/**
 * 落库前先决定怎么做：一模一样的跳过，高度相似就更新旧条，
 * 半像不像的当矛盾收下但标 pending，等用户在记忆页裁决。
 */
export function planUpsert(candidate: UpsertCandidate, existing: readonly MemoryEntry[]): UpsertPlan {
  const text = normalizeText(candidate.text)
  const tokens = tokenize(text)
  let best: MemoryEntry | undefined
  let bestScore = 0
  let bestCover = 0
  for (const memory of existing) {
    if (!sameBucket(memory, candidate)) continue
    if (normalizeText(memory.text) === text) return { action: 'skip', targetId: memory.id }
    // 待确认的条目只是占位，不参与相似度竞争，避免反复堆积 pending。
    if (memory.pending === true) continue
    const other = tokenize(memory.text)
    const score = jaccard(tokens, other)
    const cover = containment(tokens, other)
    // 短句被长句包含时 Jaccard 会被长句稀释，所以用「谁更像」= 两者的较大值排序，
    // 再分别用包含度认更新、用 Jaccard 认矛盾。
    if (Math.max(score, cover) > bestScore) {
      bestScore = Math.max(score, cover)
      bestCover = cover
      best = memory
    }
  }
  if (best !== undefined && bestCover >= SIMILAR_THRESHOLD) {
    return { action: 'update', targetId: best.id, similarity: bestCover }
  }
  if (best !== undefined && bestScore >= CONFLICT_THRESHOLD) return { action: 'pending' }
  return { action: 'add' }
}

/** 用户这次说的话，和之前某次说的是不是同一件事（宽松）。 */
export function looksLikeRepeat(text: string, previous: readonly string[]): boolean {
  const tokens = tokenize(text)
  if (tokens.length === 0) return false
  return previous.some((item) => jaccard(tokens, tokenize(item)) >= REPEAT_THRESHOLD)
}

/** 粗匹配：标题或首条消息里出现同一个有意义的词，就算这条项目记忆相关。 */
export function matchesHint(text: string, hint: string): boolean {
  const hintTokens = tokenize(hint).filter((token) => !HINT_IGNORE.has(token))
  if (hintTokens.length === 0) return false
  const wanted = new Set(hintTokens)
  return tokenize(text).some((token) => !HINT_IGNORE.has(token) && wanted.has(token))
}

export interface MemorySelectionInput {
  memories: readonly MemoryEntry[]
  characterId: string
  /** P0 的 token 硬上限。 */
  budget: number
  /** 当前对话的标题 + 首条用户消息，用来决定 P1 带不带。 */
  hint?: string
}

export interface MemorySelection {
  active: MemoryEntry[]
  usedTokens: number
  /** 本来该带、却被预算截掉的条数，记忆页要显示「未启用 N 条」。 */
  hidden: number
}

function rank(a: MemoryEntry, b: MemoryEntry): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (a.importance !== b.importance) return b.importance - a.importance
  return b.updatedAt - a.updatedAt
}

/**
 * 分层注入：P0 全量压进预算，P1 只在相关对话里带，P2 永不注入（置顶可提级）。
 * 不做关键词检索——库只有几十条，全量比打分更省也更稳。
 */
export function selectForPrompt(input: MemorySelectionInput): MemorySelection {
  const { memories, characterId, budget, hint } = input
  const eligible = memories.filter((memory) => memoryVisibleTo(memory, characterId))
  const p0 = eligible.filter((memory) => memoryTier(memory.type, memory.pinned) === 0).sort(rank)
  const p1 = eligible
    .filter((memory) => memoryTier(memory.type, memory.pinned) === 1)
    .sort(rank)
    .filter((memory) => hint !== undefined && hint !== '' && matchesHint(memory.text, hint))

  const limit = Math.max(0, budget)
  const active: MemoryEntry[] = []
  let usedTokens = 0
  for (const memory of [...p0, ...p1]) {
    const cost = estimateTokens(memory.text)
    if (usedTokens + cost > limit) continue
    active.push(memory)
    usedTokens += cost
  }
  return { active, usedTokens, hidden: p0.length + p1.length - active.length }
}

/**
 * 注入块刻意写成「默认前提」而不是待背诵的清单：不给编号，不报类型，
 * 也明确要求不要主动提起，这样模型该用的时候用，不该显摆的时候不显摆。
 */
export function memoryPromptBlock(memories: readonly MemoryEntry[]): string {
  if (memories.length === 0) return ''
  return [
    MEMORY_HEADER,
    ...memories.map((memory) => `- ${memory.text}`),
    MEMORY_FOOTER,
  ].join('\n')
}

export interface MemoryCandidateInput {
  text: string
  type?: unknown
  tags?: readonly unknown[]
  importance?: unknown
  scope?: unknown
  characterId?: unknown
}

/** 把模型丢来的原始参数收敛成一条可落库的候选。 */
export function normalizeCandidate(
  raw: MemoryCandidateInput,
  fallback: { scope: MemoryEntry['scope']; characterId?: string },
): UpsertCandidate {
  const scope: MemoryEntry['scope'] = raw.scope === 'character' ? 'character' : fallback.scope
  const characterId = scope === 'character'
    ? (typeof raw.characterId === 'string' && raw.characterId !== '' ? raw.characterId : fallback.characterId)
    : undefined
  return {
    text: normalizeText(raw.text),
    type: normalizeType(raw.type),
    scope,
    characterId,
  }
}

/**
 * 读闸门：全局关掉就全停；助手没表态（null）就跟随全局。
 * 只管「读不读」，写入永远照常。
 */
export function memoryReadEnabled(settings: Settings, assistant: Assistant | undefined): boolean {
  // 助手总开关关掉时，整个记忆系统都不参与（不读也不写），回到纯净对话。
  if (settings.assistantsEnabled !== true) return false
  if (!settings.memoryEnabled) return false
  return assistant?.memoryEnabled ?? true
}

/** 把候选里的 tags/importance 收敛到安全范围。 */
export function sanitizeExtras(raw: MemoryCandidateInput): { tags: string[]; importance: number } {
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 6)
    : []
  const importance = typeof raw.importance === 'number' && Number.isFinite(raw.importance)
    ? clamp(Math.round(raw.importance), 0, 5)
    : 1
  return { tags, importance }
}
