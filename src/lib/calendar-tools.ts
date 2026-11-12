import { nanoid } from 'nanoid'
import { putWakeSchedule } from './db'
import {
  createNote,
  describeNote,
  formatDueLabel,
  getAllNotes,
  getNotesByDay,
  getTodayNotes,
  getUndoneNotes,
  normalizeKind,
  normalizeRepeat,
} from './notes'
import type { WakeSchedule } from './types'

/**
 * 助手可调用的三个「日历/便签」工具。
 *
 * 写法对齐 media-tools.ts：这里只导出定义 + 执行函数，**不碰 engine.ts**。
 * 由 Lead 在 engine 里把 calendarToolDefinitions 挂到工具列表、把 isCalendarToolName 命中的
 * 调用转给 runCalendarTool 即可（见交付说明里的签名）。
 *
 * 为什么不把这三个工具并到 workspace.ts：那个模块的 executeTool 签名被历史测试锁着，
 * 也没有 conversationId/assistantId 这类会话上下文，而便签需要记「哪个助手、哪段对话写的」。
 */

export const ADD_NOTE_TOOL_NAME = 'add_note'
export const LIST_NOTES_TOOL_NAME = 'list_notes'
export const SCHEDULE_WAKE_TOOL_NAME = 'schedule_wake'

export const ADD_NOTE_TOOL = {
  type: 'function',
  function: {
    name: ADD_NOTE_TOOL_NAME,
    description: [
      'Create a calendar note / reminder / to-do for the user and save it on their device.',
      'Use it when the user asks you to remember an event, set a reminder, or add a to-do ("提醒我…", "记一下…", "明天三点叫我…").',
      'When the user gives a specific date/time, convert it to a concrete dueAt (ISO 8601 like 2026-03-05T14:30:00, or a millisecond timestamp).',
      'If the user gives no time, still create the note with kind="memo" and no dueAt.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title of the note. Required.' },
        body: { type: 'string', description: 'Optional details / description.' },
        kind: {
          type: 'string',
          enum: ['memo', 'reminder', 'todo'],
          description: 'memo = plain note; reminder = will notify at dueAt; todo = a checkable task.',
        },
        dueAt: {
          type: 'string',
          description: 'When it is due: ISO 8601 local time (e.g. 2026-03-05T14:30:00) or a millisecond timestamp. Omit if there is no specific time.',
        },
        repeat: {
          type: 'string',
          enum: ['none', 'daily', 'weekly', 'monthly'],
          description: 'Repeat rule when dueAt is set. Default none.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags.',
        },
      },
      required: ['title'],
    },
  },
} as const

export const LIST_NOTES_TOOL = {
  type: 'function',
  function: {
    name: LIST_NOTES_TOOL_NAME,
    description: [
      'List the user\'s calendar notes / reminders / to-dos.',
      'Use it before answering questions about what is scheduled, what is due, or what is left to do.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'undone', 'today', 'date'],
          description: 'Which notes to list. "all" = everything, "undone" = not completed, "today" = today only, "date" = the day given by date. Default all.',
        },
        date: {
          type: 'string',
          description: 'Only used when filter="date": a date like 2026-03-05.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max number of notes to return, default 20.',
        },
      },
    },
  },
} as const

export const SCHEDULE_WAKE_TOOL = {
  type: 'function',
  function: {
    name: SCHEDULE_WAKE_TOOL_NAME,
    description: [
      'Schedule a future moment when you (the assistant) want to proactively reach out to the user.',
      'Use it only when the user asks you to check back / remind them later, or when it clearly helps to speak up at a specific time.',
      'The client will deliver your reason as a notification at that time. Do not call it for ordinary replies.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        at: {
          type: 'string',
          description: 'When to wake: ISO 8601 local time (e.g. 2026-03-05T14:30:00) or a millisecond timestamp. Must be in the future.',
        },
        reason: {
          type: 'string',
          description: 'Short message shown to the user at that time, explaining why you are speaking up.',
        },
      },
      required: ['at', 'reason'],
    },
  },
} as const

/**
 * 当前应交给模型的日历工具（目前恒定三个；保留函数形式是为了和 media-tools 的
 * `mediaToolDefinitions(settings)` 接线方式保持一致，engine 里直接 spread 即可）。
 * 参数留成可选且不读取：将来若按设置开关裁剪工具，不必改调用点。
 */
export function calendarToolDefinitions(_settings?: unknown): unknown[] {
  return [{ ...ADD_NOTE_TOOL }, { ...LIST_NOTES_TOOL }, { ...SCHEDULE_WAKE_TOOL }]
}

export function isCalendarToolName(name: string): boolean {
  return name === ADD_NOTE_TOOL_NAME || name === LIST_NOTES_TOOL_NAME || name === SCHEDULE_WAKE_TOOL_NAME
}

/** engine 执行工具时能提供的会话上下文。两个字段都可选，缺省就不记归属。 */
export interface CalendarToolContext {
  conversationId?: string
  assistantId?: string
}

export interface CalendarToolOutcome {
  resultText: string
}

function parseArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 把模型给的「时间」解析成毫秒时间戳。
 * 接受：毫秒时间戳、10 位秒级时间戳、ISO/常见日期时间字符串。
 */
export function parseWhen(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  if (/^\d+(\.\d+)?$/.test(text)) {
    const num = Number(text)
    if (!Number.isFinite(num)) return null
    return num < 1e12 ? Math.round(num * 1000) : Math.round(num)
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

/** 只解析「哪一天」（YYYY-MM-DD），按本地时区构造，避免 UTC 偏移把日期挪一天。 */
function parseDay(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (match === null) return parseWhen(value)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  return Number.isFinite(date.getTime()) ? date.getTime() : null
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

async function runAddNote(args: Record<string, unknown>, context: CalendarToolContext): Promise<CalendarToolOutcome> {
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (title === '') return { resultText: 'add_note 缺少 title 参数。' }

  const hasDue = args.dueAt !== undefined && args.dueAt !== null && String(args.dueAt).trim() !== ''
  const dueAt = hasDue ? parseWhen(args.dueAt) : null
  if (hasDue && dueAt === null) {
    return { resultText: 'dueAt 格式看不懂。请传 ISO 8601 时间（如 2026-03-05T14:30:00）或毫秒时间戳。' }
  }

  const body = typeof args.body === 'string' ? args.body : ''
  const kind = normalizeKind(args.kind, dueAt !== null ? 'reminder' : 'memo')
  const repeat = normalizeRepeat(args.repeat)
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((tag): tag is string => typeof tag === 'string')
    : []

  const note = await createNote({
    title,
    body,
    kind,
    dueAt,
    repeat,
    authorRole: 'assistant',
    ...(context.assistantId !== undefined ? { authorId: context.assistantId } : {}),
    ...(context.conversationId !== undefined ? { conversationId: context.conversationId } : {}),
    tags,
  })

  const when = note.dueAt === null ? '没有设定时间' : `时间 ${formatDueLabel(note.dueAt)}`
  const repeatText = note.repeat === 'none' ? '' : `，重复 ${note.repeat}`
  return {
    resultText: `已记下便签「${note.title}」（${kind}，${when}${repeatText}）。用户能在日历屏看到，到点会提醒。`,
  }
}

async function runListNotes(args: Record<string, unknown>): Promise<CalendarToolOutcome> {
  const filter = typeof args.filter === 'string' ? args.filter : 'all'
  const limit = clampInt(args.limit, 1, 50, 20)

  let notes
  if (filter === 'undone') notes = await getUndoneNotes()
  else if (filter === 'today') notes = await getTodayNotes()
  else if (filter === 'date') {
    const day = parseDay(args.date)
    if (day === null) return { resultText: 'list_notes 的 date 参数无效，请用 2026-03-05 这种格式。' }
    notes = await getNotesByDay(day)
  } else notes = await getAllNotes()

  if (notes.length === 0) return { resultText: '没有符合条件的便签。' }

  const shown = notes.slice(0, limit)
  const lines = shown.map((note, index) => `${index + 1}. ${describeNote(note)}`)
  const more = notes.length > shown.length ? `\n（还有 ${notes.length - shown.length} 条没列出，可加大 limit）` : ''
  return { resultText: `共 ${notes.length} 条便签：\n${lines.join('\n')}${more}` }
}

async function runScheduleWake(args: Record<string, unknown>, context: CalendarToolContext): Promise<CalendarToolOutcome> {
  const at = parseWhen(args.at)
  if (at === null) return { resultText: 'schedule_wake 的 at 参数无效，请传 ISO 8601 时间或毫秒时间戳。' }
  const now = Date.now()
  if (at <= now) return { resultText: 'schedule_wake 的时间必须在未来。' }
  const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
  if (reason === '') return { resultText: 'schedule_wake 缺少 reason 参数（到点要展示给用户的说明）。' }

  const item: WakeSchedule = {
    id: `wake_${nanoid(10)}`,
    at,
    reason: reason.slice(0, 200),
    assistantId: context.assistantId ?? '',
    ...(context.conversationId !== undefined ? { conversationId: context.conversationId } : {}),
    fired: false,
    createdAt: now,
  }
  await putWakeSchedule(item)
  return { resultText: `已安排 ${formatDueLabel(at)} 主动找用户，事由：${item.reason}` }
}

/**
 * 执行一个日历工具。
 *
 * 签名约定（供 engine 接线）：
 *   runCalendarTool(name: string, rawArgs: string, context?: CalendarToolContext): Promise<CalendarToolOutcome>
 * - rawArgs 是模型返回的原始 JSON 字符串（和 runMediaTool 一样，先 parseArgs 容错）；
 * - context 携带 conversationId / assistantId，用于给便签署名；
 * - 永不抛错：任何失败都以 resultText 说明，避免把整轮对话打断。
 */
export async function runCalendarTool(
  name: string,
  rawArgs: string,
  context: CalendarToolContext = {},
): Promise<CalendarToolOutcome> {
  const args = parseArgs(rawArgs)
  try {
    if (name === ADD_NOTE_TOOL_NAME) return await runAddNote(args, context)
    if (name === LIST_NOTES_TOOL_NAME) return await runListNotes(args)
    if (name === SCHEDULE_WAKE_TOOL_NAME) return await runScheduleWake(args, context)
    return { resultText: `未知的日历工具：${name}` }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { resultText: `日历工具执行失败：${detail}` }
  }
}
