import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, CalendarDays, Check, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  createNote,
  formatDueLabel,
  getAllNotes,
  removeNote,
  startOfDay,
  toggleNoteDone,
  updateNote,
  type NoteKind,
  type NoteRepeat,
} from '../lib/notes'
import { ensureNotificationPermission, NOTES_FIRED_EVENT, startReminderPolling } from '../lib/reminders'
import { isAndroid } from '../lib/platform'
import { useAppStore } from '../lib/store'
import type { Note } from '../lib/types'
import { confirmDialog } from './ConfirmDialog'
import { Chip, EmptyState, IconButton, Modal, ScreenHeader, Select } from './ui'
import '../styles-calendar.css'

/**
 * 日历便签屏。
 *
 * 三个视图入口共用一份 note 数据（getAllNotes）；月历的「打点」、列表的筛选、
 * 当天的清单都是在前端从同一份数组里算出来的，避免多次读写库导致界面和数据对不上。
 *
 * 到点提醒不在这里自己做定时器：交给 reminders.ts 的 startReminderPolling（引用计数、
 * 全局共用），它到点会 toast 并广播 NOTES_FIRED_EVENT，本屏监听后刷新列表。
 */

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

const KIND_LABELS: Record<NoteKind, string> = { memo: '随手记', reminder: '提醒', todo: '待办' }
const REPEAT_LABELS: Record<NoteRepeat, string> = { none: '不重复', daily: '每天', weekly: '每周', monthly: '每月' }

const KIND_OPTIONS = [
  { value: 'memo', label: '随手记', hint: '不提醒' },
  { value: 'reminder', label: '提醒', hint: '到点弹' },
  { value: 'todo', label: '待办', hint: '可勾完成' },
]

const REPEAT_OPTIONS = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
]

/** 时间戳 → `<input type="datetime-local">` 需要的本地时间字符串。 */
function toLocalInput(timestamp: number | null): string {
  if (timestamp === null) return ''
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `<input type="datetime-local">` 的值 → 时间戳（空串 = 没有具体时间）。 */
function fromLocalInput(text: string): number | null {
  if (text.trim() === '') return null
  const timestamp = new Date(text).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

/** 月历格子：前面补空、后面补齐到 7 的倍数。null 表示空白格。 */
function buildMonthCells(year: number, month: number): Array<number | null> {
  const lead = new Date(year, month, 1).getDay()
  const days = new Date(year, month + 1, 0).getDate()
  const cells: Array<number | null> = []
  for (let index = 0; index < lead; index += 1) cells.push(null)
  for (let day = 1; day <= days; day += 1) cells.push(day)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

function formatDayTitle(timestamp: number, today: number): string {
  const date = new Date(timestamp)
  const weekday = WEEKDAYS[date.getDay()]
  const base = `${date.getMonth() + 1}月${date.getDate()}日 · 周${weekday}`
  if (startOfDay(timestamp) === today) return `今天 · ${base}`
  return base
}

export function CalendarScreen() {
  const actions = useAppStore((state) => state.actions)
  const [notes, setNotes] = useState<Note[]>([])
  const [view, setView] = useState<'month' | 'list'>('month')
  const [today] = useState(() => startOfDay(Date.now()))
  const [cursor, setCursor] = useState(() => {
    const date = new Date()
    return { year: date.getFullYear(), month: date.getMonth() }
  })
  const [selectedDay, setSelectedDay] = useState(() => startOfDay(Date.now()))
  const [filter, setFilter] = useState<'all' | 'undone' | 'today'>('all')

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Note | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [draftKind, setDraftKind] = useState<NoteKind>('memo')
  const [draftDue, setDraftDue] = useState('')
  const [draftRepeat, setDraftRepeat] = useState<NoteRepeat>('none')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setNotes(await getAllNotes())
    } catch (error) {
      console.warn('[calendar] 读取便签失败', error)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 前台到点轮询：进入本屏就开始、离开就停（引用计数，别的入口也开着的话不会被误停）。
  useEffect(() => startReminderPolling(), [])

  // 提醒触发后 reminders 会广播事件（重复便签的 dueAt 被推到了下一次），这里刷新显示。
  useEffect(() => {
    const onFired = (): void => {
      void refresh()
    }
    window.addEventListener(NOTES_FIRED_EVENT, onFired)
    return () => window.removeEventListener(NOTES_FIRED_EVENT, onFired)
  }, [refresh])

  // 助手可能在别的对话里刚写了便签，定期轻量刷新一次，保证本屏不是「一打开就凝固」。
  useEffect(() => {
    const timer = setInterval(() => {
      void refresh()
    }, 20_000)
    return () => clearInterval(timer)
  }, [refresh])

  /** 每个本地自然日 -> 当天的便签（用于月历打点）。 */
  const notesByDay = useMemo(() => {
    const map = new Map<number, Note[]>()
    for (const note of notes) {
      if (note.dueAt === null) continue
      const key = startOfDay(note.dueAt)
      const bucket = map.get(key)
      if (bucket === undefined) map.set(key, [note])
      else bucket.push(note)
    }
    return map
  }, [notes])

  const selectedNotes = useMemo(
    () => notesByDay.get(selectedDay) ?? [],
    [notesByDay, selectedDay],
  )

  const listNotes = useMemo(() => {
    if (filter === 'undone') return notes.filter((note) => !note.done)
    if (filter === 'today') return notes.filter((note) => note.dueAt !== null && startOfDay(note.dueAt) === today)
    return notes
  }, [notes, filter, today])

  const cells = useMemo(() => buildMonthCells(cursor.year, cursor.month), [cursor])

  const changeMonth = (delta: number): void => {
    const date = new Date(cursor.year, cursor.month + delta, 1)
    setCursor({ year: date.getFullYear(), month: date.getMonth() })
    // 翻月后把选中日落到新月份的 1 号，避免下方清单还挂着上一个月的日子。
    setSelectedDay(startOfDay(date.getTime()))
  }

  const goToday = (): void => {
    const date = new Date()
    setCursor({ year: date.getFullYear(), month: date.getMonth() })
    setSelectedDay(startOfDay(date.getTime()))
  }

  const openCreate = (): void => {
    setEditing(null)
    setDraftTitle('')
    setDraftBody('')
    setDraftKind('memo')
    setDraftRepeat('none')
    // 在月历里新建时，默认把时间落到选中那天的 09:00 —— 少一步选择；可清空。
    const base = new Date(selectedDay)
    base.setHours(9, 0, 0, 0)
    setDraftDue(view === 'month' ? toLocalInput(base.getTime()) : '')
    setEditorOpen(true)
  }

  const openEdit = (note: Note): void => {
    setEditing(note)
    setDraftTitle(note.title)
    setDraftBody(note.body)
    setDraftKind(note.kind)
    setDraftRepeat(note.repeat)
    setDraftDue(toLocalInput(note.dueAt))
    setEditorOpen(true)
  }

  const save = async (): Promise<void> => {
    const title = draftTitle.trim()
    if (title === '') {
      actions.showToast('给便签起个标题吧')
      return
    }
    const dueAt = fromLocalInput(draftDue)
    try {
      if (editing === null) {
        await createNote({
          title,
          body: draftBody.trim(),
          kind: draftKind,
          dueAt,
          repeat: draftRepeat,
          authorRole: 'user',
        })
      } else {
        await updateNote(editing.id, {
          title,
          body: draftBody.trim(),
          kind: draftKind,
          dueAt,
          repeat: draftRepeat,
        })
      }
      setEditorOpen(false)
      await refresh()
      actions.showToast(editing === null ? '已新建便签' : '已更新便签')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '保存失败')
    }
  }

  const onToggle = async (note: Note): Promise<void> => {
    await toggleNoteDone(note)
    await refresh()
  }

  const onDelete = async (note: Note): Promise<void> => {
    const ok = await confirmDialog({
      title: '删掉这条便签？',
      message: `「${note.title}」删掉就找不回来了。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await removeNote(note.id)
    await refresh()
    actions.showToast('已删除')
  }

  const requestNotify = async (): Promise<void> => {
    const granted = await ensureNotificationPermission()
    actions.showToast(granted ? '系统通知已开启' : '没拿到通知权限；App 内仍会提醒')
  }

  const renderNoteRow = (note: Note) => (
    <article key={note.id} className={`calendar-note ${note.done ? 'is-done' : ''}`}>
      <button
        type="button"
        className={`calendar-check ${note.done ? 'is-done' : ''}`}
        aria-label={note.done ? '标为未完成' : '标为完成'}
        onClick={() => void onToggle(note)}
      >
        {note.done && <Check size={13} />}
      </button>
      <div className="calendar-note-main">
        <div className="calendar-note-title">{note.title}</div>
        {note.body.trim() !== '' && <p className="calendar-note-body">{note.body}</p>}
        <div className="calendar-note-meta">
          <span className={`calendar-kind-badge kind-${note.kind}`}>{KIND_LABELS[note.kind]}</span>
          {note.dueAt !== null && (
            <span className="calendar-time">
              <Bell size={11} />
              {formatDueLabel(note.dueAt)}
            </span>
          )}
          {note.repeat !== 'none' && <span className="calendar-repeat">↻ {REPEAT_LABELS[note.repeat]}</span>}
          {note.authorRole === 'assistant' && <span className="calendar-author">助手写</span>}
        </div>
      </div>
      <div className="calendar-note-actions">
        <IconButton label="编辑" onClick={() => openEdit(note)}>
          <Pencil size={14} />
        </IconButton>
        <IconButton label="删除" onClick={() => void onDelete(note)}>
          <Trash2 size={14} />
        </IconButton>
      </div>
    </article>
  )

  return (
    <div className="screen calendar-screen">
      <div className="screen-panel">
        <ScreenHeader
          title="日历便签"
          subtitle={`${notes.length} 条便签 · 到点会提醒`}
          onBack={() => actions.setScreen('home')}
          actions={
            <IconButton label="新建便签" onClick={openCreate}>
              <Plus size={18} />
            </IconButton>
          }
        />

        <div className="screen-toolbar calendar-toolbar">
          <div className="calendar-view-toggle">
            <Chip active={view === 'month'} onClick={() => setView('month')}>月历</Chip>
            <Chip active={view === 'list'} onClick={() => setView('list')}>列表</Chip>
          </div>
          {view === 'list' && (
            <div className="filter-row">
              <Chip active={filter === 'all'} onClick={() => setFilter('all')}>全部</Chip>
              <Chip active={filter === 'undone'} onClick={() => setFilter('undone')}>未完成</Chip>
              <Chip active={filter === 'today'} onClick={() => setFilter('today')}>今天</Chip>
            </div>
          )}
        </div>

        <div className="screen-body">
          {view === 'month' ? (
            <div className="calendar-month">
              <div className="calendar-month-head">
                <IconButton label="上个月" onClick={() => changeMonth(-1)}>
                  <ChevronLeft size={18} />
                </IconButton>
                <strong>{cursor.year} 年 {cursor.month + 1} 月</strong>
                <IconButton label="下个月" onClick={() => changeMonth(1)}>
                  <ChevronRight size={18} />
                </IconButton>
                <span className="calendar-spacer" />
                <button type="button" className="text-button" onClick={goToday}>回到今天</button>
              </div>

              <div className="calendar-weekdays">
                {WEEKDAYS.map((label) => <span key={label}>{label}</span>)}
              </div>

              <div className="calendar-grid">
                {cells.map((day, index) => {
                  if (day === null) return <span key={`blank-${index}`} className="calendar-cell is-empty" />
                  const dayStart = new Date(cursor.year, cursor.month, day).getTime()
                  const dayNotes = notesByDay.get(dayStart) ?? []
                  /*
                   * 类名直接写在属性里，不用中间变量：CSS 守卫（test/css-class-audit.test.ts）
                   * 只能静态分析属性表达式，`className={classes}` 它读不出任何类名，
                   * 会按「无法解析」报出来。写开之后 is-today / is-selected / has-notes
                   * 都能逐条核对；空串留下的多余空格对 classList 没有影响。
                   */
                  return (
                    <button
                      key={day}
                      type="button"
                      className={`calendar-cell ${dayStart === today ? 'is-today' : ''} ${dayStart === selectedDay ? 'is-selected' : ''} ${dayNotes.length > 0 ? 'has-notes' : ''}`}
                      onClick={() => setSelectedDay(dayStart)}
                    >
                      <span className="calendar-cell-day">{day}</span>
                      {dayNotes.length > 0 && (
                        <span className="calendar-dots">
                          {dayNotes.slice(0, 3).map((note) => (
                            <i key={note.id} className={`calendar-dot kind-${note.kind}`} />
                          ))}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              <div className="calendar-day-panel">
                <header>
                  <strong>{formatDayTitle(selectedDay, today)}</strong>
                  <small>{selectedNotes.length} 条便签</small>
                </header>
                {selectedNotes.length === 0 ? (
                  <p className="calendar-empty-line">这一天还没有便签。点右上角「+」加一条。</p>
                ) : (
                  <div className="calendar-notes">{selectedNotes.map(renderNoteRow)}</div>
                )}
              </div>
            </div>
          ) : (
            <div className="calendar-list">
              {listNotes.length === 0 ? (
                <EmptyState
                  icon={<CalendarDays size={26} />}
                  title={filter === 'today' ? '今天没有便签' : filter === 'undone' ? '没有未完成的便签' : '还没有便签'}
                  body="记一件小事、设一个到点提醒，或者让助手帮你记。"
                  action={
                    <button type="button" className="primary-button" onClick={openCreate}>
                      <Plus size={16} /> 新建便签
                    </button>
                  }
                />
              ) : (
                <div className="calendar-notes">{listNotes.map(renderNoteRow)}</div>
              )}
            </div>
          )}
        </div>

        <footer className="screen-footnote">
          <span className="dot is-on" />
          前台每 30 秒检查一次到点便签
          {isAndroid ? (
            <button type="button" className="text-button calendar-notify-button" onClick={() => void requestNotify()}>
              开启系统通知
            </button>
          ) : (
            <span>· 桌面/网页端只有应用内提示</span>
          )}
        </footer>
      </div>

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editing === null ? '新建便签' : '编辑便签'}
        footer={
          <>
            <button type="button" className="ghost-button" onClick={() => setEditorOpen(false)}>取消</button>
            <button type="button" className="primary-button" onClick={() => void save()}>保存</button>
          </>
        }
      >
        <label className="field">
          <span>标题</span>
          <input
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            placeholder="要做什么？"
            autoFocus
          />
        </label>
        <label className="field">
          <span>内容</span>
          <textarea
            rows={3}
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            placeholder="补充说明（可选）"
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>类型</span>
            <Select
              ariaLabel="类型"
              value={draftKind}
              onChange={(value) => setDraftKind(value as NoteKind)}
              options={KIND_OPTIONS}
            />
          </label>
          <label className="field">
            <span>重复</span>
            <Select
              ariaLabel="重复"
              value={draftRepeat}
              onChange={(value) => setDraftRepeat(value as NoteRepeat)}
              options={REPEAT_OPTIONS}
            />
          </label>
        </div>
        <label className="field">
          <span>时间（可选，留空就是没有具体时间）</span>
          <input
            type="datetime-local"
            value={draftDue}
            onChange={(event) => setDraftDue(event.target.value)}
          />
        </label>
        {draftDue !== '' && (
          <button type="button" className="text-button" onClick={() => setDraftDue('')}>
            清除时间
          </button>
        )}
      </Modal>
    </div>
  )
}
