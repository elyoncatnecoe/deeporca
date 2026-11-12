import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, Download, History, Pin, Plus, Search, Trash2, Upload } from 'lucide-react'
import { nanoid } from 'nanoid'
import { appVersion, saveTextFile } from '../lib/platform'
import { backupFileName, buildBackup } from '../lib/backup'
import { resolveAssistantConfig } from '../lib/assistant'
import { CONFLICT_THRESHOLD, containment, jaccard, memoryTier, selectForPrompt, tokenize } from '../lib/memory-core'
import { memoryTypeTitle, useAppStore } from '../lib/store'
import { formatTokens } from '../lib/tokens'
import {
  LARGE_FILE_BYTES,
  ImportCancelled,
  applyImport,
  parseImport,
  previewOf,
  readImportFile,
  type ImportPreview,
  type ImportStats,
  type ParsedImport,
} from '../lib/import'
import {
  DEFAULT_MAX_SUMMARY_MESSAGES,
  estimateSummaryTokens,
  generateMemorySummary,
  type SummaryProgress,
  type SummaryResult,
} from '../lib/import/extract'
import type { MemoryEntry, MemoryType } from '../lib/types'
import { Chip, EmptyState, IconButton, Modal, ScreenHeader, Select, Switch } from './ui'
import { confirmDialog } from './ConfirmDialog'
import '../styles-import.css'

const FILTERS: Array<{ id: 'all' | MemoryType; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'profile', label: '关于你' },
  { id: 'preference', label: '偏好' },
  { id: 'project', label: '项目' },
  { id: 'relationship', label: '相处' },
  { id: 'other', label: '其他' },
]

const TYPES: Array<{ id: MemoryType; label: string }> = [
  { id: 'profile', label: '关于你' },
  { id: 'preference', label: '偏好' },
  { id: 'project', label: '项目' },
  { id: 'relationship', label: '相处' },
  { id: 'other', label: '其他' },
]

function dateLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(timestamp)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 这条会以什么方式进对话：常驻 / 相关才带 / 永不注入（置顶可提级）。 */
function tierLabel(memory: MemoryEntry): string {
  const tier = memoryTier(memory.type, memory.pinned)
  if (tier === 0) return '常驻'
  if (tier === 1) return '相关才带'
  return '不注入'
}

export function MemoryScreen() {
  const memories = useAppStore((state) => state.memories)
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | MemoryType>('all')
  const [editing, setEditing] = useState<MemoryEntry | null>(null)
  const [historyOf, setHistoryOf] = useState<MemoryEntry | null>(null)
  const [open, setOpen] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [draftType, setDraftType] = useState<MemoryType>('profile')
  const [draftImportance, setDraftImportance] = useState(2)
  const [draftPinned, setDraftPinned] = useState(false)
  const [draftScope, setDraftScope] = useState<MemoryEntry['scope']>('global')
  const [draftCharacterId, setDraftCharacterId] = useState('')

  /* ---------------- 导入 / 摘要 相关状态 ---------------- */
  const fileRef = useRef<HTMLInputElement | null>(null)
  // 解析结果先放着不写库：预览弹层拿它渲染，用户点「添加/覆盖」才 applyImport。
  const [importParsed, setImportParsed] = useState<ParsedImport | null>(null)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [importError, setImportError] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  // 覆盖是破坏性操作：单独一个弹层，必须先导出备份才能点「继续」。
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [backupState, setBackupState] = useState<{ status: 'idle' | 'busy' | 'done' | 'error'; message: string }>({ status: 'idle', message: '' })
  const [importStage, setImportStage] = useState<'idle' | 'writing'>('idle')
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const importAbortRef = useRef<AbortController | null>(null)
  const [importStats, setImportStats] = useState<ImportStats | null>(null)
  const [importedConvIds, setImportedConvIds] = useState<string[]>([])
  // 摘要：idle → running → done / error；result 有值就展示结果。
  const [summaryPhase, setSummaryPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [summaryProgress, setSummaryProgress] = useState<SummaryProgress | null>(null)
  const [summaryResult, setSummaryResult] = useState<SummaryResult | null>(null)
  const [summaryError, setSummaryError] = useState('')
  const [summaryMax, setSummaryMax] = useState(DEFAULT_MAX_SUMMARY_MESSAGES)
  const summaryAbortRef = useRef<AbortController | null>(null)

  const currentAssistant = settings.assistants.find((item) => item.id === settings.assistantId)
    ?? settings.assistants[0]
  const currentId = currentAssistant?.id ?? ''
  const memoryOn = settings.memoryEnabled && (currentAssistant?.memoryEnabled ?? true)
  const budget = settings.memoryTokenBudget

  // 进页面时拉一次最新数据：刚才别的对话里可能刚记下/改过东西。
  useEffect(() => {
    void actions.refreshMemories()
  }, [actions])

  // 页面上显示的预算占用和引擎用的是同一套算法，避免「页面说带了、其实没带」。
  const selection = useMemo(
    () => selectForPrompt({ memories, characterId: currentId, budget }),
    [memories, currentId, budget],
  )
  const situational = useMemo(
    () => memories.filter((memory) => memory.pending !== true && memoryTier(memory.type, memory.pinned) === 2).length,
    [memories],
  )

  const matches = (memory: MemoryEntry): boolean => {
    if (filter !== 'all' && memory.type !== filter) return false
    const needle = query.trim().toLowerCase()
    if (needle === '') return true
    return memory.text.toLowerCase().includes(needle)
      || memory.tags.some((tag) => tag.toLowerCase().includes(needle))
  }

  const pending = useMemo(
    () => memories.filter((memory) => memory.pending === true && matches(memory)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memories, filter, query],
  )
  const groups = useMemo(() => {
    const visible = memories.filter((memory) => memory.pending !== true && matches(memory))
    const sort = (items: MemoryEntry[]): MemoryEntry[] => [...items].sort(
      (a, b) => memoryTier(a.type, a.pinned) - memoryTier(b.type, b.pinned) || b.importance - a.importance,
    )
    return [
      {
        id: 'global',
        title: '全局',
        hint: '所有助手共享',
        items: sort(visible.filter((memory) => memory.scope === 'global')),
      },
      {
        id: 'mine',
        title: currentAssistant?.name ?? '当前助手',
        hint: '只在这个助手的对话里注入',
        items: sort(visible.filter(
          (memory) => memory.scope === 'character' && memory.characterId === currentId,
        )),
      },
      {
        id: 'others',
        title: '其他助手的记忆',
        hint: '属于别的助手，不会进当前对话',
        items: sort(visible.filter(
          (memory) => memory.scope === 'character' && memory.characterId !== currentId,
        )),
      },
    ].filter((group) => group.items.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memories, filter, query, currentId, currentAssistant?.name])

  const startCreate = (): void => {
    setEditing(null)
    setDraftText('')
    setDraftType('profile')
    setDraftImportance(2)
    setDraftPinned(false)
    setDraftScope('global')
    setDraftCharacterId(currentId)
    setOpen(true)
  }

  const startEdit = (memory: MemoryEntry): void => {
    setEditing(memory)
    setDraftText(memory.text)
    setDraftType(memory.type)
    setDraftImportance(memory.importance)
    setDraftPinned(memory.pinned)
    setDraftScope(memory.scope)
    setDraftCharacterId(memory.characterId ?? currentId)
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    const text = draftText.trim()
    if (text.length < 2) {
      actions.showToast('写点什么再保存')
      return
    }
    const now = Date.now()
    const scope = draftScope
    const characterId = scope === 'character' ? draftCharacterId : undefined
    const memory: MemoryEntry = editing === null
      ? {
          id: `mem_${nanoid(10)}`,
          text,
          type: draftType,
          tags: [],
          importance: draftImportance,
          scope,
          characterId,
          createdAt: now,
          updatedAt: now,
          pinned: draftPinned,
        }
      : {
          ...editing,
          text,
          type: draftType,
          importance: draftImportance,
          scope,
          characterId,
          // 手动改过内容，旧文本也留一版，能回滚。
          history: text !== editing.text
            ? [...(editing.history ?? []), editing.text].slice(-10)
            : editing.history,
          // 用户亲手保存过，就不再是「待确认」。
          pending: false,
          updatedAt: now,
          pinned: draftPinned,
        }
    await actions.saveMemoryEntry(memory)
    setOpen(false)
    actions.showToast(editing === null ? '已记住' : '已更新')
  }

  const restore = async (memory: MemoryEntry, version: string): Promise<void> => {
    await actions.saveMemoryEntry({
      ...memory,
      text: version,
      history: [...(memory.history ?? []).filter((item) => item !== version), memory.text].slice(-10),
      pending: false,
      updatedAt: Date.now(),
    })
    setHistoryOf(null)
    actions.showToast('已恢复旧版本')
  }

  /** 接受一条待确认记忆＝用它替换掉同一桶里最像的那条，旧文本进 history 可回滚。 */
  const resolvePending = async (memory: MemoryEntry, accept: boolean): Promise<void> => {
    if (!accept) {
      await actions.deleteMemoryEntry(memory.id)
      actions.showToast('丢掉了')
      return
    }
    const tokens = tokenize(memory.text)
    let rival: MemoryEntry | undefined
    let best = 0
    for (const item of memories) {
      if (item.id === memory.id || item.pending === true) continue
      if (item.scope !== memory.scope || item.type !== memory.type) continue
      if (item.scope === 'character' && item.characterId !== memory.characterId) continue
      const score = Math.max(
        jaccard(tokens, tokenize(item.text)),
        containment(tokens, tokenize(item.text)),
      )
      if (score > best) {
        best = score
        rival = item
      }
    }
    if (rival !== undefined && best >= CONFLICT_THRESHOLD) {
      await actions.saveMemoryEntry({
        ...rival,
        text: memory.text,
        history: [...(rival.history ?? []), rival.text].slice(-10),
        importance: Math.max(rival.importance, memory.importance),
        updatedAt: Date.now(),
      })
      await actions.deleteMemoryEntry(memory.id)
      actions.showToast('已经用它替换旧的那条')
      return
    }
    await actions.saveMemoryEntry({ ...memory, pending: false, updatedAt: Date.now() })
    actions.showToast('已经收下这条')
  }

  const togglePin = async (memory: MemoryEntry): Promise<void> => {
    await actions.saveMemoryEntry({ ...memory, pinned: !memory.pinned, updatedAt: Date.now() })
  }

  const remove = async (memory: MemoryEntry): Promise<void> => {
    const ok = await confirmDialog({
      title: '删掉这条记忆？',
      message: '以后就不会再想起它了。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await actions.deleteMemoryEntry(memory.id)
  }

  const exportAll = async (): Promise<void> => {
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      memories,
    }, null, 2)
    await saveTextFile(`deepsea-memories-${new Date().toISOString().slice(0, 10)}.json`, payload, 'application/json')
  }

  /* ------------------------------------------------ 导入 */

  /** 点「导入」→ 打开隐藏的 file input。 */
  const pickImportFile = (): void => {
    if (importBusy) return
    fileRef.current?.click()
  }

  /** 选中文件后：先解析成预览，一行都还没写库。 */
  const onImportFile = async (file: File): Promise<void> => {
    setImportError('')
    setImportParsed(null)
    setImportPreview(null)
    setImportStats(null)
    setSummaryPhase('idle')
    setSummaryResult(null)
    setSummaryProgress(null)
    // 大文件（尤其上百 MB 的 .db）先让用户知道要等，避免以为卡死。
    if (file.size > LARGE_FILE_BYTES) {
      const ok = await confirmDialog({
        title: '这是个不小的文件',
        message: `文件有 ${formatBytes(file.size)}，解析可能要一会儿，期间请不要关闭页面。继续吗？`,
        confirmText: '继续解析',
      })
      if (!ok) return
    }
    setImportBusy(true)
    try {
      const input = await readImportFile(file)
      const parsed = await parseImport(input)
      const preview = previewOf(parsed)
      if (preview.conversations === 0) {
        setImportError(preview.warnings[0] ?? '这个文件里没有可导入的对话')
        actions.showToast('没有认出可导入的内容')
        return
      }
      setImportParsed(parsed)
      setImportPreview(preview)
      setPreviewOpen(true)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
      actions.showToast('这个文件读不出来')
    } finally {
      setImportBusy(false)
      // 清空 input，允许再次选择同一个文件。
      if (fileRef.current !== null) fileRef.current.value = ''
    }
  }

  /** 真正写库。merge=追加，replace=先清空（清空动作在 applyImport 里做）。 */
  const runImport = async (mode: 'merge' | 'replace'): Promise<void> => {
    if (importParsed === null) return
    const assistant = currentAssistant
    if (assistant === undefined) {
      actions.showToast('还没有可用的助手，先去设置里加一个')
      return
    }
    setPreviewOpen(false)
    setReplaceOpen(false)
    setImportBusy(true)
    setImportStage('writing')
    setImportProgress({ done: 0, total: 0 })
    setImportStats(null)
    const controller = new AbortController()
    importAbortRef.current = controller
    try {
      const config = resolveAssistantConfig(settings, assistant)
      const stats = await applyImport(
        importParsed,
        { mode, assistantId: assistant.id, config, fallbackModel: settings.model },
        { signal: controller.signal, onProgress: (progress) => setImportProgress({ done: progress.done, total: progress.total }) },
      )
      await Promise.all([actions.refreshConversations(), actions.refreshMemories()])
      setImportStats(stats)
      setImportedConvIds(stats.conversationIds)
      setSummaryPhase('idle')
      setSummaryResult(null)
      setSummaryProgress(null)
      actions.showToast(`已导入 ${stats.conversations} 段对话、${stats.messages} 条消息`)
    } catch (error) {
      if (error instanceof ImportCancelled) {
        actions.showToast('已取消导入（已写入的部分会保留）')
      } else {
        actions.showToast(error instanceof Error ? error.message : '导入失败')
      }
    } finally {
      importAbortRef.current = null
      setImportBusy(false)
      setImportStage('idle')
    }
  }

  const cancelImport = (): void => {
    importAbortRef.current?.abort()
  }

  /** 覆盖前先导出当前备份。复用 Settings 里的 buildBackup，逻辑与「导出备份」完全一致。 */
  const exportCurrentBackup = async (): Promise<void> => {
    if (backupState.status === 'busy') return
    setBackupState({ status: 'busy', message: '正在打包当前数据…' })
    try {
      const version = await appVersion()
      // 对话底图是 dataURL，体积大且不进备份（与 Settings 的导出保持一致）。
      const { chatBackdrop: _backdrop, ...exportable } = settings
      const snapshot = { ...exportable, apiKey: '' } as unknown as Record<string, unknown>
      const payload = await buildBackup(version, snapshot)
      const saved = await saveTextFile(backupFileName(), JSON.stringify(payload, null, 2), 'application/json')
      if (saved) {
        setBackupState({
          status: 'done',
          message: `已导出 ${payload.counts.conversations} 段对话、${payload.counts.messages} 条消息、${payload.counts.memories} 条记忆`,
        })
        actions.showToast('备份已导出，现在可以覆盖导入了')
      } else {
        setBackupState({ status: 'error', message: '导出被取消，请先完成备份再继续' })
      }
    } catch (error) {
      setBackupState({ status: 'error', message: `导出失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  /* ------------------------------------------------ 记忆摘要 */

  const startSummary = async (): Promise<void> => {
    if (summaryPhase === 'running') return
    setSummaryPhase('running')
    setSummaryError('')
    setSummaryResult(null)
    setSummaryProgress(null)
    const controller = new AbortController()
    summaryAbortRef.current = controller
    try {
      const result = await generateMemorySummary({
        settings,
        conversationIds: importedConvIds,
        maxMessages: summaryMax,
        signal: controller.signal,
        onProgress: setSummaryProgress,
      })
      setSummaryResult(result)
      setSummaryPhase('done')
      await actions.refreshMemories()
      if (result.cancelled) actions.showToast('摘要生成已取消')
      else if (result.added + result.updated + result.pending > 0) {
        actions.showToast(`从对话里新记下 ${result.added + result.updated + result.pending} 条记忆`)
      } else {
        actions.showToast('没有抽取到新的记忆')
      }
    } catch (error) {
      setSummaryPhase('error')
      setSummaryError(error instanceof Error ? error.message : String(error))
      actions.showToast('生成摘要失败')
    } finally {
      summaryAbortRef.current = null
    }
  }

  const cancelSummary = (): void => {
    summaryAbortRef.current?.abort()
  }

  const closeImportResult = (): void => {
    setImportStats(null)
    setImportedConvIds([])
    setImportParsed(null)
    setImportPreview(null)
    setSummaryPhase('idle')
    setSummaryProgress(null)
    setSummaryResult(null)
  }

  // 摘要预估 token：只按被 cap 到的前 N 条算，跟真正会被处理的范围一致。
  const summaryEstimate = useMemo(() => {
    if (importParsed === null) return 0
    const flat = importParsed.conversations.flatMap((conversation) => conversation.messages)
    return estimateSummaryTokens(flat, summaryMax)
  }, [importParsed, summaryMax])

  const totalImportedMessages = importStats?.messages ?? 0


  const renderCard = (memory: MemoryEntry) => {
    const tier = memoryTier(memory.type, memory.pinned)
    return (
      <article key={memory.id} className={`memory-card ${memory.pinned ? 'is-pinned' : ''}`}>
        <header>
          <span className={`memory-type type-${memory.type}`}>{memoryTypeTitle(memory.type)}</span>
          <span className={`memory-badge tier-${tier}`}>{tierLabel(memory)}</span>
          {memory.scope === 'character' && (
            <span className="memory-badge">
              {settings.assistants.find((item) => item.id === memory.characterId)?.name ?? '助手'}
            </span>
          )}
          <span className="memory-date">{dateLabel(memory.updatedAt)}</span>
          <span className="memory-spacer" />
          <IconButton label={memory.pinned ? '取消置顶' : '置顶（提到常驻）'} onClick={() => void togglePin(memory)}>
            <Pin size={14} className={memory.pinned ? 'is-active' : ''} />
          </IconButton>
        </header>
        <p>{memory.text}</p>
        <footer>
          {memory.tags.map((tag) => (
            <span key={tag} className="memory-tag">#{tag}</span>
          ))}
          <span className="memory-spacer" />
          {(memory.history?.length ?? 0) > 0 && (
            <button type="button" className="text-button" onClick={() => setHistoryOf(memory)}>
              <History size={13} /> 历史 {memory.history?.length}
            </button>
          )}
          <button type="button" className="text-button" onClick={() => startEdit(memory)}>编辑</button>
          <button type="button" className="text-button is-danger" onClick={() => void remove(memory)}>
            <Trash2 size={13} /> 删除
          </button>
        </footer>
      </article>
    )
  }

  return (
    <div className="screen memory-screen">
      <input
        ref={fileRef}
        type="file"
        className="import-file-input"
        accept=".json,.zip,.db,.sqlite,.sqlite3,application/json,application/zip"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file !== undefined) void onImportFile(file)
        }}
      />
      <div className="screen-panel">
        <ScreenHeader
          title="记忆"
          subtitle={`${memories.length} 条 · 只在本机`}
          onBack={() => actions.setScreen('home')}
          actions={
            <>
              <IconButton label="导入对话" onClick={pickImportFile}>
                <Upload size={18} />
              </IconButton>
              <IconButton label="导出记忆" onClick={() => void exportAll()}>
                <Download size={18} />
              </IconButton>
              <IconButton label="新增记忆" onClick={startCreate}>
                <Plus size={18} />
              </IconButton>
            </>
          }
        />

        <div className="screen-toolbar">
          <label className="search-field">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜记忆…"
              type="search"
            />
          </label>
          <div className="filter-row">
            {FILTERS.map((item) => (
              <Chip key={item.id} active={filter === item.id} onClick={() => setFilter(item.id)}>
                {item.label}
              </Chip>
            ))}
          </div>
        </div>

        <div className="screen-body">
          {pending.length > 0 && (
            <section className="memory-pending">
              <header>
                <strong>待确认 {pending.length} 条</strong>
                <small>和已有的记忆对不上，我先没覆盖</small>
              </header>
              {pending.map((memory) => (
                <div key={memory.id} className="memory-pending-row">
                  <p>{memory.text}</p>
                  <div className="memory-pending-actions">
                    <button type="button" className="text-button" onClick={() => void resolvePending(memory, true)}>
                      用它替换
                    </button>
                    <button type="button" className="text-button is-danger" onClick={() => void resolvePending(memory, false)}>
                      丢掉
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {groups.length === 0 && pending.length === 0 ? (
            <EmptyState
              icon={<Brain size={26} />}
              title={memories.length === 0 ? '记忆还是空的' : '没有匹配的记忆'}
              body={memories.length === 0 ? '聊着聊着我会自己记下值得长期知道的事；也可以手动加一条。' : '换个关键词试试。'}
              action={
                <button type="button" className="primary-button" onClick={startCreate}>
                  <Plus size={16} /> 手动记住一件
                </button>
              }
            />
          ) : (
            groups.map((group) => (
              <section key={group.id} className="memory-group">
                <header className="memory-group-head">
                  <strong>{group.title}</strong>
                  <small>{group.hint} · {group.items.length} 条</small>
                </header>
                <div className="memory-grid">
                  {group.items.map(renderCard)}
                </div>
              </section>
            ))
          )}
        </div>

        <footer className="screen-footnote">
          <span className={memoryOn ? 'dot is-on' : 'dot'} />
          {settings.memoryEnabled
            ? (memoryOn
              ? `记忆已开 · 常驻占用 ${formatTokens(selection.usedTokens)}/${formatTokens(budget)} tokens`
              : '全局已开，但这个助手不读记忆')
            : '记忆已关，不读也不写'}
          {selection.hidden > 0 && (
            <>
              <span>·</span>
              {`还有 ${selection.hidden} 条没进对话（超出预算）`}
            </>
          )}
          {situational > 0 && (
            <>
              <span>·</span>
              {`情景 ${situational} 条不注入，置顶可提级`}
            </>
          )}
        </footer>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing === null ? '记住一件事' : '编辑记忆'}
        footer={
          <>
            <button type="button" className="ghost-button" onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="primary-button" onClick={() => void save()}>保存</button>
          </>
        }
      >
        <label className="field">
          <span>内容</span>
          <textarea
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            rows={4}
            placeholder="例如：用户叫小林，常用 TypeScript，讨厌客套话。"
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>类型</span>
            <Select
              ariaLabel="类型"
              value={draftType}
              onChange={(value) => setDraftType(value as MemoryType)}
              options={TYPES.map((type) => ({ value: type.id, label: type.label }))}
            />
          </label>
          <label className="field">
            <span>重要度 {draftImportance}</span>
            <input
              type="range"
              min={0}
              max={5}
              step={1}
              value={draftImportance}
              onChange={(event) => setDraftImportance(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>可见范围</span>
            <Select
              ariaLabel="可见范围"
              value={draftScope}
              onChange={(value) => setDraftScope(value as MemoryEntry['scope'])}
              options={[
                { value: 'global', label: '全局（所有助手）' },
                { value: 'character', label: '仅限一个助手' },
              ]}
            />
          </label>
          {draftScope === 'character' && (
            <label className="field">
              <span>归属助手</span>
              <Select
                ariaLabel="归属助手"
                value={draftCharacterId}
                onChange={(value) => setDraftCharacterId(value)}
                // 助手列表理论上不会为空，空了就靠组件的「没有可选项」兜底。
                options={settings.assistants.map((assistant) => ({
                  value: assistant.id,
                  label: assistant.name,
                }))}
              />
            </label>
          )}
        </div>
        <div className="switch-row">
          <span>置顶（提到常驻，按需求也会带上）</span>
          <Switch checked={draftPinned} onChange={setDraftPinned} label="置顶" />
        </div>
      </Modal>

      <Modal
        open={historyOf !== null}
        onClose={() => setHistoryOf(null)}
        title="历史版本"
        footer={<button type="button" className="ghost-button" onClick={() => setHistoryOf(null)}>关闭</button>}
      >
        <div className="memory-history">
          {historyOf?.text !== undefined && (
            <div className="memory-history-row is-current">
              <small>当前</small>
              <p>{historyOf.text}</p>
            </div>
          )}
          {[...(historyOf?.history ?? [])].reverse().map((version, index) => (
            <div key={`${version}-${index}`} className="memory-history-row">
              <p>{version}</p>
              <button
                type="button"
                className="text-button"
                onClick={() => historyOf !== null && void restore(historyOf, version)}
              >
                恢复这版
              </button>
            </div>
          ))}
        </div>
      </Modal>

      {/* 导入预览：识别格式 + 数量 + 字段映射，确认后才写库 */}
      <Modal
        open={previewOpen && importPreview !== null}
        onClose={() => setPreviewOpen(false)}
        title="导入预览"
        wide
        footer={
          <>
            <button type="button" className="ghost-button" onClick={() => setPreviewOpen(false)}>取消</button>
            <button type="button" className="primary-button" disabled={importBusy} onClick={() => void runImport('merge')}>
              添加导入
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={importBusy}
              onClick={() => {
                setBackupState({ status: 'idle', message: '' })
                setReplaceOpen(true)
              }}
            >
              覆盖导入
            </button>
          </>
        }
      >
        {importPreview !== null && (
          <div className="import-summary">
            <div className="import-kv"><span>识别格式</span><strong>{importPreview.formatLabel}</strong></div>
            <div className="import-kv"><span>对话</span><strong>{importPreview.conversations} 段</strong></div>
            <div className="import-kv"><span>消息</span><strong>{importPreview.messages} 条</strong></div>
            {importPreview.skipped > 0 && (
              <div className="import-kv"><span>跳过</span><strong>{importPreview.skipped} 条（无正文/工具节点）</strong></div>
            )}
            {importPreview.memories > 0 && (
              <div className="import-kv"><span>记忆</span><strong>{importPreview.memories} 条</strong></div>
            )}
            <div>
              <p className="import-hint">字段映射：</p>
              <ul className="import-mapping">
                {importPreview.mapping.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
            {importPreview.warnings.length > 0 && (
              <div className="import-warnings">
                {importPreview.warnings.map((line) => <p key={line}>{line}</p>)}
              </div>
            )}
            <p className="import-hint">「添加」= 追加到现有数据；「覆盖」= 先清空现有对话与记忆再写入。</p>
          </div>
        )}
      </Modal>

      {/* 覆盖确认：强制先导出备份，导出成功才能继续 */}
      <Modal
        open={replaceOpen}
        onClose={() => setReplaceOpen(false)}
        title="覆盖导入确认"
        wide
        footer={
          <>
            <button type="button" className="ghost-button" onClick={() => setReplaceOpen(false)}>取消</button>
            <button
              type="button"
              className="ghost-button"
              disabled={backupState.status === 'busy'}
              onClick={() => void exportCurrentBackup()}
            >
              {backupState.status === 'busy' ? '正在导出…' : backupState.status === 'done' ? '重新导出备份' : '先导出当前备份'}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={backupState.status !== 'done' || importBusy}
              onClick={() => void runImport('replace')}
            >
              继续覆盖导入
            </button>
          </>
        }
      >
        <div className="import-danger-note">
          这会<strong>清空本机现有的全部对话与记忆</strong>，再写入这个文件的内容。清空后无法撤销。
        </div>
        <p className="import-hint">为避免误操作，必须先导出一份当前备份；导出成功后「继续覆盖导入」才会亮起。</p>
        {backupState.message !== '' && (
          <p className={`import-backup is-${backupState.status}`}>{backupState.message}</p>
        )}
        {importPreview !== null && (
          <ul className="import-mapping">
            <li>将写入 {importPreview.conversations} 段对话</li>
            <li>将写入 {importPreview.messages} 条消息</li>
            {importPreview.memories > 0 && <li>将写入 {importPreview.memories} 条记忆</li>}
          </ul>
        )}
      </Modal>

      {/* 写入进度（可取消） */}
      <Modal open={importBusy && importStage === 'writing'} onClose={() => undefined} title="正在导入">
        <p>正在把对话写进本机数据库…</p>
        <div className="import-progress">
          <i style={{ width: `${importProgress !== null && importProgress.total > 0 ? Math.round((importProgress.done / importProgress.total) * 100) : 0}%` }} />
        </div>
        <p className="import-hint">{importProgress?.done ?? 0} / {importProgress?.total ?? 0} 条</p>
        <div className="import-actions">
          <button type="button" className="ghost-button" onClick={cancelImport}>取消</button>
        </div>
      </Modal>

      {/* 导入完成 + 询问是否生成记忆摘要 */}
      <Modal
        open={importStats !== null}
        onClose={closeImportResult}
        title="导入完成"
        wide
        footer={<button type="button" className="ghost-button" onClick={closeImportResult}>关闭</button>}
      >
        {importStats !== null && (
          <div className="import-summary">
            <div className="import-kv"><span>对话</span><strong>{importStats.conversations} 段</strong></div>
            <div className="import-kv"><span>消息</span><strong>{importStats.messages} 条</strong></div>
            {importStats.skipped > 0 && <div className="import-kv"><span>跳过</span><strong>{importStats.skipped} 条</strong></div>}
            {importStats.memories > 0 && <div className="import-kv"><span>记忆</span><strong>{importStats.memories} 条</strong></div>}

            {summaryPhase === 'idle' && summaryResult === null && (
              <section className="import-summary-ask">
                <p>要不要根据这些对话生成记忆摘要？会用记忆模型分批抽取，可能花几分钟和少量 token。</p>
                <label className="field">
                  <span>最多处理多少条消息（默认 {DEFAULT_MAX_SUMMARY_MESSAGES} 条）</span>
                  <input
                    type="number"
                    min={20}
                    max={5000}
                    step={10}
                    value={summaryMax}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      setSummaryMax(Number.isFinite(next) ? Math.max(20, Math.min(5000, Math.round(next))) : DEFAULT_MAX_SUMMARY_MESSAGES)
                    }}
                  />
                </label>
                <p className="import-hint">
                  预估消耗约 {summaryEstimate} tokens（最多 {Math.min(summaryMax, totalImportedMessages)} 条消息）
                </p>
                <div className="import-actions">
                  <button type="button" className="primary-button" onClick={() => void startSummary()}>生成摘要</button>
                  <button type="button" className="ghost-button" onClick={closeImportResult}>暂不</button>
                </div>
              </section>
            )}

            {summaryPhase === 'running' && (
              <section className="import-summary-ask">
                <p>正在生成记忆摘要… {summaryProgress !== null ? `${summaryProgress.doneBatches}/${summaryProgress.totalBatches} 批` : ''}</p>
                <div className="import-progress">
                  <i style={{ width: `${summaryProgress !== null && summaryProgress.totalBatches > 0 ? Math.round((summaryProgress.doneBatches / summaryProgress.totalBatches) * 100) : 0}%` }} />
                </div>
                <p className="import-hint">
                  已处理 {summaryProgress?.processedMessages ?? 0}/{summaryProgress?.totalMessages ?? 0} 条 · 新记 {summaryProgress?.added ?? 0} 条
                </p>
                <div className="import-actions">
                  <button type="button" className="ghost-button" onClick={cancelSummary}>取消生成</button>
                </div>
              </section>
            )}

            {summaryPhase === 'done' && summaryResult !== null && (
              <section className="import-summary-ask">
                <p>
                  摘要完成：新增 {summaryResult.added} 条、更新 {summaryResult.updated} 条、待确认 {summaryResult.pending} 条
                  {summaryResult.cancelled ? '（已取消，部分完成）' : ''}。
                </p>
                {summaryResult.skipped > 0 && <p className="import-hint">有 {summaryResult.skipped} 条消息所在的批次没抽取成功，已跳过。</p>}
              </section>
            )}

            {summaryPhase === 'error' && (
              <p className="import-backup is-error">{summaryError}</p>
            )}
          </div>
        )}
      </Modal>

      {/* 解析失败提示 */}
      <Modal
        open={importError !== ''}
        onClose={() => setImportError('')}
        title="导入失败"
        footer={<button type="button" className="ghost-button" onClick={() => setImportError('')}>知道了</button>}
      >
        <p>{importError}</p>
      </Modal>
    </div>
  )
}
