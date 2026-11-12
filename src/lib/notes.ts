import { nanoid } from 'nanoid'
import {
  deleteNote as dbDeleteNote,
  listNotes as dbListNotes,
  putNote as dbPutNote,
} from './db'
import type { Note } from './types'

/**
 * 便签业务层（日历屏 + 助手工具 + 到点提醒共用）。
 *
 * 为什么不把这套逻辑直接塞进 CalendarScreen：
 * - 界面、reminders.ts 的轮询、calendar-tools.ts 的工具调用三方都要「按天查 / 查到期的 /
 *   标记完成」，规则必须只有一份，否则会出现「界面说到点了、轮询说没到」这种分裂；
 * - db.ts 只做最朴素的增删查（v5 那几张表），不认识「本地日」「重复规则」这些业务概念。
 *
 * 时间一律用毫秒时间戳；「某一天」的口径是**本地时区的自然日**，不是 UTC 日
 * —— 用户看到「今天」就该是手机上的今天。
 */

export type NoteKind = Note['kind']
export type NoteRepeat = Note['repeat']

export interface NewNoteInput {
  title: string
  body?: string
  kind?: NoteKind
  dueAt?: number | null
  repeat?: NoteRepeat
  /** 谁写的：手动新建默认 user，助手工具调用传 assistant。 */
  authorRole?: Note['authorRole']
  authorId?: string
  conversationId?: string
  tags?: string[]
}

const REPEATS: readonly NoteRepeat[] = ['none', 'daily', 'weekly', 'monthly']
const KINDS: readonly NoteKind[] = ['memo', 'reminder', 'todo']

export function normalizeKind(value: unknown, fallback: NoteKind = 'memo'): NoteKind {
  return KINDS.includes(value as NoteKind) ? (value as NoteKind) : fallback
}

export function normalizeRepeat(value: unknown, fallback: NoteRepeat = 'none'): NoteRepeat {
  return REPEATS.includes(value as NoteRepeat) ? (value as NoteRepeat) : fallback
}

/** 本地时区某一天 00:00 的时间戳。 */
export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 本地时区下一天 00:00 的时间戳（用日历加法，跨月/夏令时也正确）。 */
export function startOfNextDay(timestamp: number): number {
  const date = new Date(startOfDay(timestamp))
  date.setDate(date.getDate() + 1)
  return date.getTime()
}

/** 两个时间戳是否落在本地同一个自然日。 */
export function isSameLocalDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b)
}

/**
 * 由输入构造一条完整 Note（不落库）。
 * 单独导出是为了测试与工具/界面复用同一套默认值。
 */
export function buildNote(input: NewNoteInput, now = Date.now()): Note {
  const title = input.title.trim()
  return {
    id: `note_${nanoid(10)}`,
    title,
    body: input.body ?? '',
    kind: normalizeKind(input.kind, input.dueAt != null ? 'reminder' : 'memo'),
    dueAt: input.dueAt ?? null,
    repeat: normalizeRepeat(input.repeat),
    done: false,
    authorRole: input.authorRole ?? 'user',
    ...(input.authorId !== undefined ? { authorId: input.authorId } : {}),
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== ''),
    createdAt: now,
    updatedAt: now,
  }
}

export async function createNote(input: NewNoteInput): Promise<Note> {
  const note = buildNote(input)
  await dbPutNote(note)
  return note
}

/**
 * 局部更新（合并式）。找不到这条时返回 undefined，调用方自己决定要不要提示。
 * 不允许改 id / createdAt；其余字段都可以动。
 */
export async function updateNote(
  id: string,
  patch: Partial<Omit<Note, 'id' | 'createdAt'>>,
): Promise<Note | undefined> {
  const all = await dbListNotes()
  const current = all.find((note) => note.id === id)
  if (current === undefined) return undefined
  const next: Note = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: Date.now() }
  await dbPutNote(next)
  return next
}

export async function removeNote(id: string): Promise<void> {
  await dbDeleteNote(id)
}

/** 全部便签，按「有没有时间」+ 时间先后排好序（没时间的排最后）。 */
export async function getAllNotes(): Promise<Note[]> {
  const all = await dbListNotes()
  return sortNotes(all)
}

function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    // 有 dueAt 的排前面，按时间升序；都没时间的按更新时间倒序。
    if (a.dueAt !== null && b.dueAt !== null) return a.dueAt - b.dueAt || b.updatedAt - a.updatedAt
    if (a.dueAt !== null) return -1
    if (b.dueAt !== null) return 1
    return b.updatedAt - a.updatedAt
  })
}

/** 本地某一天的便签（按 dueAt 归属那天）。 */
export async function getNotesByDay(dayTimestamp: number): Promise<Note[]> {
  const start = startOfDay(dayTimestamp)
  const end = startOfNextDay(dayTimestamp)
  const all = await dbListNotes()
  return sortNotes(all.filter((note) => note.dueAt !== null && note.dueAt >= start && note.dueAt < end))
}

/** 未完成的便签（不看时间）。 */
export async function getUndoneNotes(): Promise<Note[]> {
  const all = await dbListNotes()
  return sortNotes(all.filter((note) => !note.done))
}

/** 今天（本地自然日）的便签。 */
export async function getTodayNotes(now = Date.now()): Promise<Note[]> {
  return getNotesByDay(now)
}

/**
 * 已到点、还没提醒过、且未完成的便签。
 *
 * 三条缺一不可：
 * - dueAt 已到（<= now）；
 * - done === false（做完的事不该再吵人）；
 * - notifiedAt 为空（提醒过一次就记下，避免每 30 秒重复弹）。
 */
export async function getDueNotes(now = Date.now()): Promise<Note[]> {
  const all = await dbListNotes()
  return all
    .filter((note) => note.dueAt !== null && note.dueAt <= now && !note.done && note.notifiedAt === undefined)
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
}

/** 设置完成状态。 */
export async function setNoteDone(note: Note, done: boolean): Promise<Note | undefined> {
  return updateNote(note.id, { done })
}

/** 切换完成状态，返回更新后的便签。 */
export async function toggleNoteDone(note: Note): Promise<Note | undefined> {
  return updateNote(note.id, { done: !note.done })
}

/**
 * 计算下一次重复时间（严格晚于 now 的那一次）。
 * 返回 null 表示不重复。
 */
export function nextRepeatDue(from: number, repeat: NoteRepeat, now = Date.now()): number | null {
  if (repeat === 'none') return null
  const date = new Date(from)
  // 最多往前推 400 次，防止脏数据（比如 1970 年的 daily）把循环卡死。
  for (let guard = 0; guard < 400; guard += 1) {
    if (repeat === 'daily') date.setDate(date.getDate() + 1)
    else if (repeat === 'weekly') date.setDate(date.getDate() + 7)
    else date.setMonth(date.getMonth() + 1)
    if (date.getTime() > now) return date.getTime()
  }
  return date.getTime()
}

/**
 * 一条便签刚提醒完：写下「提醒过」的时间。
 *
 * - 一次性便签：记 notifiedAt，以后不再弹；
 * - 重复便签：把 dueAt 推到下一次并清空 notifiedAt，让它下个周期还能再提醒。
 */
export async function markNoteReminded(note: Note, now = Date.now()): Promise<Note | undefined> {
  if (note.repeat !== 'none') {
    const base = note.dueAt ?? now
    const next = nextRepeatDue(base, note.repeat, now)
    if (next !== null) {
      return updateNote(note.id, { dueAt: next, notifiedAt: undefined })
    }
  }
  return updateNote(note.id, { notifiedAt: now })
}

/** 把便签渲染成一行给人看的文案（工具结果、提醒标题都能用）。 */
export function describeNote(note: Note): string {
  const when = note.dueAt === null ? '' : ` · ${formatDueLabel(note.dueAt)}`
  const mark = note.done ? '（已完成）' : ''
  return `${note.title}${when}${mark}`
}

/** 本地时间的中文短标签：「今天 14:30」「03-05 09:00」这种。 */
export function formatDueLabel(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = startOfDay(now)
  if (startOfDay(timestamp) === today) return `今天 ${time}`
  const tomorrow = startOfNextDay(now)
  if (startOfDay(timestamp) === tomorrow) return `明天 ${time}`
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day} ${time}`
}
