import { useMemo, useState } from 'react'
import { FileText, Share2 } from 'lucide-react'
import { Modal, Switch } from './ui'
import { useAppStore } from '../lib/store'
import { conversationConfig } from '../lib/assistant'
import {
  conversationToMarkdown,
  exportableMessages,
  markdownFileName,
  resolveExportTitle,
} from '../lib/export-markdown'
import { shareMarkdown } from '../lib/platform'

/**
 * 「导出格式」弹层：选格式 + 选消息 + 选带什么。
 *
 * 为什么外壳关闭时直接返回 null（而不是把 open 传给 Modal 了事）：
 *   内层组件只在打开时挂载，于是每次重新打开，`useState` 的初始值天然就是这一轮
 *   的默认值（思维过程开、带元信息、不预览、按 preselectIds 或全选）。以前是在
 *   effect 里重置，会先渲染一帧「一条都没选」的禁用态再跳成正常状态，弹层刚淡入
 *   就闪一下，很难看。
 *
 * 为什么没有「导出为图片 / PNG」：
 *   用户明确不需要，永久不做。目前只有 Markdown 一种格式，卡片就一张；但结构仍按
 *   「格式卡片列表」写，以后真要加格式只是多一张卡，不用重排。
 */
export function ExportDialog(props: {
  open: boolean
  onClose: () => void
  /**
   * 消息多选模式带过来的默认勾选。
   * 未传 / 为空数组 = 全选；传了但一条都不合法 = 退回全选（见 defaultSelection）。
   */
  preselectIds?: string[]
}) {
  if (!props.open) return null
  return <ExportDialogBody onClose={props.onClose} preselectIds={props.preselectIds} />
}

function ExportDialogBody(props: { onClose: () => void; preselectIds?: string[] }) {
  const messages = useAppStore((state) => state.messages)
  const conversations = useAppStore((state) => state.conversations)
  const activeId = useAppStore((state) => state.activeId)
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)

  const conversation = conversations.find((item) => item.id === activeId)
  const config = conversationConfig(settings, conversation)
  const exportable = useMemo(() => exportableMessages(messages), [messages])
  const title = resolveExportTitle(conversation, messages)
  const reasoningCount = exportable.filter((message) => (message.reasoning ?? '').trim() !== '').length

  /**
   * 默认勾选：preselectIds 里「确实存在且本来就可导出」的那些，否则全选。
   *
   * 为什么要过滤：多选模式勾的是气泡，里面可能混着工具卡片、报错消息、被分叉挤掉
   * 的候选 —— 这些本来就不导出。不过滤的话会出现「已选 5 条，导出出来只有 3 条」
   * 这种没法解释的落差。
   * 为什么全落空时退回全选：那种情况下弹层一进来就是「先勾选要导出的消息」的禁用
   * 态，用户只会觉得坏了；宁可退回全选，让他自己取消。
   */
  const defaultSelection = (preselectIds: string[] | undefined): Set<string> => {
    const wanted = new Set(preselectIds ?? [])
    if (wanted.size === 0) return new Set(exportable.map((message) => message.id))
    const kept = exportable.filter((message) => wanted.has(message.id))
    return new Set((kept.length > 0 ? kept : exportable).map((message) => message.id))
  }

  // 默认值：思维过程默认「开」—— 现在的对话大多靠它才看得懂，分享出去更完整，
  // 嫌乱的人自己关掉就行；元信息默认开（自己留档有用）；预览默认关（太占地方）。
  const [includeReasoning, setIncludeReasoning] = useState(true)
  const [withMeta, setWithMeta] = useState(true)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelection(props.preselectIds))

  // 预选值如果晚一步才送到（父组件分两次 setState / 先开弹层再传 id），也要生效。
  // 用渲染期调整状态而不是 effect：effect 会先画一帧旧勾选，再跳成新勾选。
  const preselectKey = (props.preselectIds ?? []).join('\u0001')
  const [appliedKey, setAppliedKey] = useState(preselectKey)
  if (appliedKey !== preselectKey) {
    setAppliedKey(preselectKey)
    setSelected(defaultSelection(props.preselectIds))
  }

  const chosen = useMemo(
    () => exportable.filter((message) => selected.has(message.id)),
    [exportable, selected],
  )

  const markdown = useMemo(() => conversationToMarkdown(chosen, {
    title,
    assistantName: config.name,
    model: config.model,
    includeReasoning,
    includeMeta: withMeta,
  }), [chosen, title, config.name, config.model, includeReasoning, withMeta])

  const toggle = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const pick = (filter: (role: string) => boolean): void => {
    setSelected(new Set(exportable.filter((message) => filter(message.role)).map((message) => message.id)))
  }

  /** 真正执行导出：存成 .md 文件，或者交给系统分享（shareMarkdown 内部决定）。 */
  const run = async (): Promise<void> => {
    if (busy || chosen.length === 0) return
    setBusy(true)
    try {
      const name = markdownFileName(title)
      const result = await shareMarkdown(name, markdown, title)
      if (result === 'saved') actions.showToast(`已保存 ${name}`)
      else if (result === 'shared') actions.showToast('已打开分享')
      else actions.showToast('已取消')
      if (result !== 'cancelled') props.onClose()
    } catch (error) {
      // 失败文案要能看懂：带上底层原因，但别把一句英文的 TypeError 直接甩给用户。
      const reason = error instanceof Error && error.message.trim() !== '' ? error.message.trim() : '未知原因'
      actions.showToast(`导出失败：${reason}`)
    } finally {
      setBusy(false)
    }
  }

  const empty = exportable.length === 0
  const nothingChosen = chosen.length === 0

  return (
    <Modal open onClose={() => { if (!busy) props.onClose() }} title="导出格式" wide>
      <div className="export-summary">
        <strong>{title}</strong>
        <small>
          {exportable.length} 条消息，已选 {chosen.length} 条
          {reasoningCount > 0 ? `，其中 ${reasoningCount} 条带思考过程` : ''}
        </small>
      </div>

      {/* 格式卡片：点卡片 = 直接导出。没有图片格式，用户明确不要。 */}
      <div className="export-format">
        <button
          type="button"
          className="export-format-card"
          onClick={() => void run()}
          disabled={busy || nothingChosen}
          aria-busy={busy}
          title={empty ? '这段对话还没有可以导出的内容' : nothingChosen ? '先勾选要导出的消息' : '导出为 Markdown 文件'}
        >
          <span className="export-format-icon"><FileText size={18} /></span>
          <span className="export-format-head">Markdown</span>
          <span className="export-format-hint">
            {busy ? '正在导出…' : '将对话导出为 markdown 文件'}
          </span>
        </button>
      </div>

      <div className="switch-row">
        <div>
          <strong>导出思维过程</strong>
          <small>
            {reasoningCount > 0
              ? '折进可折叠块里，正文不受影响'
              : '这段对话没有记录思考过程'}
          </small>
        </div>
        <Switch
          checked={includeReasoning}
          onChange={setIncludeReasoning}
          label="导出思维过程"
        />
      </div>

      <div className="switch-row">
        <div>
          <strong>带上导出时间和模型</strong>
          <small>在文末加一行说明，自己留档时有用</small>
        </div>
        <Switch checked={withMeta} onChange={setWithMeta} label="带上导出时间和模型" />
      </div>

      <div className="switch-row">
        <div>
          <strong>预览</strong>
          <small>先看看将要导出的内容，再决定保存还是分享</small>
        </div>
        <Switch checked={preview} onChange={setPreview} label="预览" />
      </div>

      {!empty && (
        <>
          <div className="export-toolbar">
            <button type="button" className="text-button" onClick={() => setSelected(new Set(exportable.map((message) => message.id)))}>全选</button>
            <button type="button" className="text-button" onClick={() => setSelected(new Set())}>全不选</button>
            <button type="button" className="text-button" onClick={() => pick((role) => role === 'user')}>只要提问</button>
            <button type="button" className="text-button" onClick={() => pick((role) => role === 'assistant')}>只要回答</button>
          </div>

          <div className="export-select-list" role="group" aria-label="选择要导出的消息">
            {exportable.map((message) => {
              const checked = selected.has(message.id)
              const snippet = message.content.replace(/\s+/g, ' ').trim().slice(0, 70)
              // 只有图 / 只有文件的消息正文是空的，列表里光显示「（空）」会让人不敢勾。
              const attachmentName = message.attachments?.[0]?.name
              const label = snippet !== ''
                ? snippet
                : attachmentName !== undefined ? `[附件] ${attachmentName}` : '（空）'
              return (
                <label key={message.id} className={`export-select-row ${checked ? 'is-on' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(message.id)} />
                  <span className="export-role">{message.role === 'user' ? '我' : config.name}</span>
                  <span className="export-snippet">{label}</span>
                </label>
              )
            })}
          </div>
        </>
      )}

      {preview && !nothingChosen && (
        <pre className="export-preview">{markdown}</pre>
      )}

      {empty && <p className="settings-hint">这段对话还没有可以导出的内容。</p>}
      {!empty && nothingChosen && <p className="settings-hint">先勾选要导出的消息</p>}

      <div className="inline-actions">
        <button type="button" className="ghost-button" onClick={props.onClose} disabled={busy}>取消</button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void run()}
          disabled={busy || nothingChosen}
        >
          {busy ? '正在导出…' : (<><Share2 size={14} /> 分享 / 保存{chosen.length > 0 ? `（${chosen.length} 条）` : ''}</>)}
        </button>
      </div>
    </Modal>
  )
}
