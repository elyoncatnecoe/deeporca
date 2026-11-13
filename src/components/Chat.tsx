import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Brain,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Cpu,
  FileDown,
  FileText,
  Gauge,
  GitBranch,
  History,
  Lightbulb,
  Minimize2,
  MoreHorizontal,
  MousePointerClick,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Share2,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { MAX_ATTACHMENTS, attachmentKindLabel, formatFileSize, prepareAttachments } from '../lib/attachments'
import { continueTurn, editAndResend, regenerateAtMessage, sendGroupMessage, sendMessage, stopSending } from '../lib/engine'
import { WEB_CHAT_MODEL_INFO, isWebChatModel, modelInfo } from '../lib/models'
import { webChatModelVisible } from '../lib/web-gate'
import { visionOf, type VisionVerdict } from '../lib/capability'
import { useAppStore, branchInfo, type SheetSize } from '../lib/store'
import { currentProvider, hasApiKey, providerModels } from '../lib/providers'
import { conversationConfig, applyRegexes, findAssistant } from '../lib/assistant'
import type { AssistantRegex } from '../lib/types'
import {
  exportableMessages,
  messageMarkdownFileName,
  messageToMarkdown,
} from '../lib/export-markdown'
import { shareMarkdown, writeClipboardText } from '../lib/platform'
import { createComposerClear } from '../lib/composer-clear'
import { webChatAvailable } from '../lib/web-chat'
import { ExportDialog } from './ExportDialog'
import { SaveToWorkshopDialog, type SnippetDraft } from './SaveToWorkshop'
import type { Attachment, ChatMessage, Settings, ThinkingEffort } from '../lib/types'
import { CodeRunModal } from './CodeRunModal'
import { CompressDialog } from './CompressDialog'
import { SearchPanel } from './SearchPanel'
import { MediaToolCard } from './MediaToolCard'
import { SpeechButton } from './SpeechButton'
import { TurnNavigator } from './TurnNavigator'
import { QuickCommands } from './QuickCommands'
import { buildTurns } from '../lib/turns'
import { Avatar, assistantAvatarProps, messageAvatarProps } from './Avatar'
import { Markdown } from './Markdown'
import { IconButton, Modal, Spinner } from './ui'
import { confirmDialog } from './ConfirmDialog'

const SUGGESTIONS = [
  { icon: Code2, text: '帮我做一个能直接玩的小网页' },
  { icon: Lightbulb, text: '用三句话讲清楚一个概念' },
  { icon: Brain, text: '记住：我更喜欢简洁的回答' },
  { icon: Wrench, text: '看看工坊里现在有什么' },
]

const SHEET_ORDER: SheetSize[] = ['peek', 'half', 'full']

/**
 * 聊天页模型 popover 的选项来源 = 当前供应商的「模型目录」。
 *
 * 对齐 DeepSeek Harness 的语义：目录为空就**不显示任何模型**（不再拿内置表兜底），
 * 但当前正在用的模型永远保留一行（哪怕它不在目录里）——「目录外 ID 仍可直接发送」。
 * 网页账号模型也始终列出来，否则进了网页模式就切不回 API。
 */
function catalogModelOptions(settings: Settings): { id: string; hint: string; tags: string[] }[] {
  const provider = currentProvider(settings)
  const meta = provider.modelMeta ?? {}
  const options = providerModels(settings).map((id) => {
    const info = modelInfo(id)
    const extra = meta[id]
    const hasName = extra?.name !== undefined && extra.name.trim() !== ''
    // 目录里的模型不一定是内置那四个：modelInfo 对陌生 id 会退化成
    // 「自定义模型名 / 自定义」，放在目录模型上就是错的，这里换掉。
    const hint = hasName ? (extra.name as string) : (info.hint === '自定义模型名' ? '供应商目录里的模型' : info.hint)
    const tags = info.tags.filter((tag) => tag !== '自定义')
    if (typeof extra?.contextWindow === 'number' && extra.contextWindow > 0) {
      tags.push(`${Math.round(extra.contextWindow / 1000)}K`)
    }
    return { id, hint, tags }
  })
  /*
   * 当前模型不在目录里也要能看见、能选（例如手填的自定义模型名）。
   *
   * 网页账号模型不在此列：它出不出现只由「纸雕虎鲸」开关决定（见 lib/web-gate.ts）。
   * 开关关着时哪怕 settings.model 还指着它（store 会把它切走，但可能有先后），
   * 也不能从这里漏出来。
   */
  if (settings.model !== '' && !isWebChatModel(settings.model) && !options.some((option) => option.id === settings.model)) {
    options.unshift({ id: settings.model, hint: '目录外 ID，仍可直接发送', tags: ['目录外'] })
  }
  // 网页账号模型：跟着纸雕虎鲸开关走，默认不出现。
  if (webChatModelVisible(settings) && !options.some((option) => option.id === WEB_CHAT_MODEL_INFO.id)) {
    options.push({ id: WEB_CHAT_MODEL_INFO.id, hint: WEB_CHAT_MODEL_INFO.hint, tags: [...WEB_CHAT_MODEL_INFO.tags] })
  }
  // 「看图」徽章统一在这里、由 visionOf 贴：判据和附件闸门是同一个函数，
  // 从此不可能出现「这一行写着看图，附件却说它不能看图」（2026-11-03 的 RC2）。
  // 语义是「我会把图发给它」，所以乐观放行的模型也会亮 —— 那是事实，不是猜测。
  for (const option of options) {
    if (visionOf(provider, option.id).sees && !option.tags.includes('看图')) option.tags.push('看图')
  }
  return options
}

/**
 * 「判定为不能看图，但图片照发」那句常驻提示。
 *
 * 必须是 notice 而不是 toast：旧的「当前模型不能看图」用的是 showToast，2800ms
 * 就自己消失了，用户只看见图片没进附件栏、去哪翻开关没人说。分两种依据是因为
 * 「用户自己关的」和「我们判定它不看图」下一步操作完全不同。
 * 提示里刻意不打印判定依据（`模型名` / `内置表` 这类是给配置页用的行话），
 * 也刻意不出现「API Key」，否则会撞上 notice 那条「去填」链接的判据。
 */
function visionNoticeText(modelId: string, verdict: VisionVerdict): string {
  if (verdict.source === 'override') {
    return `你关掉了「${modelId}」的看图，图片这次仍会发过去，它多半会忽略或报错；想恢复就去 设置 → 供应商 → 模型目录 那一行重新打开。`
  }
  return `「${modelId}」我们判定为不接收图片，这次仍会把图发过去、让它自己回答；想稳一点就换 deepseek-flash，或在 设置 → 供应商 → 模型目录 那一行打开「看图」。`
}

/** 第一次切到网页账号模型时弹一次说明；确认过就不再打扰。 */
const WEB_CHAT_RISK_KEY = 'deepsea_webchat_risk_warned'

const EFFORTS: { id: ThinkingEffort; label: string; hint: string }[] = [
  { id: 'off', label: '关闭', hint: '直接回答，最快' },
  { id: 'low', label: '低', hint: '轻量想一下' },
  { id: 'high', label: '高', hint: '默认深度' },
  { id: 'max', label: '极高', hint: '最慢，也最细' },
]

function timeOf(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(ts)
}

function durationLabel(milliseconds: number): string {
  if (milliseconds <= 0) return '思考过程'
  if (milliseconds < 1000) return '思考了不到 1 秒'
  const seconds = milliseconds / 1000
  if (seconds < 60) return `思考了 ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  return `思考了 ${minutes} 分 ${Math.round(seconds % 60)} 秒`
}

function effortLabel(effort: ThinkingEffort): string {
  return EFFORTS.find((item) => item.id === effort)?.label ?? '高'
}

function ReasoningPanel(props: { text: string; thinkingMs?: number; live?: boolean }) {
  const [open, setOpen] = useState(props.live === true)
  const [elapsed, setElapsed] = useState(0)
  const bodyRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    if (props.live !== true) return
    const started = Date.now()
    setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 500)
    return () => window.clearInterval(timer)
  }, [props.live])

  useEffect(() => {
    if (props.live !== true || !open) return
    const body = bodyRef.current
    if (body !== null) body.scrollTop = body.scrollHeight
  }, [props.text, props.live, open])

  const chars = props.text.trim().length
  const liveLabel = chars > 0 ? '正在深度思考' : '正在组织思路'
  const title = props.live === true ? liveLabel : durationLabel(props.thinkingMs ?? 0)

  return (
    <section className="reasoning-panel" data-live={props.live === true ? 'true' : 'false'} data-open={open ? 'true' : 'false'}>
      <button type="button" className="reasoning-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="reasoning-icon">
          <Sparkles size={13} />
        </span>
        <span className="reasoning-title">{title}</span>
        {chars > 0 && <span className="reasoning-meta">{chars} 字</span>}
        {props.live === true && props.thinkingMs === undefined && elapsed > 0 && <span className="reasoning-meta">{Math.floor(elapsed / 1000)}s</span>}
        <ChevronDown size={14} className="reasoning-chevron" />
      </button>
      {open && (
        <pre ref={bodyRef} className="reasoning-body">
          {props.text}
          {props.live === true && <span className="caret" />}
        </pre>
      )}
    </section>
  )
}

function AttachmentStrip(props: { attachments: Attachment[]; onRemove?: (id: string) => void; compact?: boolean }) {
  if (props.attachments.length === 0) return null
  return (
    <div className={`attachment-strip ${props.compact === true ? 'is-compact' : ''}`}>
      {props.attachments.map((attachment) => (
        <div key={attachment.id} className="attachment-item" data-kind={attachment.kind} title={attachment.name}>
          {attachment.kind === 'image' && attachment.dataUrl !== undefined ? (
            <img src={attachment.dataUrl} alt={attachment.name} />
          ) : (
            <span className="attachment-file-icon">
              <FileText size={16} />
            </span>
          )}
          <span className="attachment-copy">
            <strong>{attachment.name}</strong>
            <small>
              {attachmentKindLabel(attachment)}
              {attachment.size > 0 ? ` · ${formatFileSize(attachment.size)}` : ''}
            </small>
          </span>
          {props.onRemove !== undefined && (
            <button type="button" className="attachment-remove" onClick={() => props.onRemove?.(attachment.id)} aria-label={`移除 ${attachment.name}`}>
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function ToolCard({ message }: { message: ChatMessage }) {
  if ((message.media?.length ?? 0) > 0) return <MediaToolCard message={message} />
  return (
    <details className="tool-card">
      <summary>
        <Wrench size={14} />
        <span>{message.toolName ?? '工具'}</span>
        {/* 工具落在哪个项目：多项目下不标出来就分不清新旧代码写去了哪里。 */}
        {message.workspaceName !== undefined && <span className="tool-project">{message.workspaceName}</span>}
        <span className="tool-hint">查看结果</span>
        <ChevronDown size={14} className="tool-chevron" />
      </summary>
      <pre>{message.content}</pre>
    </details>
  )
}

function Bubble(props: {
  message: ChatMessage
  conversationId: string | null
  flash?: boolean
  onRun: (code: string, lang: string) => void
  onSave: (code: string, lang: string) => void
  /** 多选模式：显示勾选圈、点气泡正文切换选中、动作条隐藏。 */
  selecting?: boolean
  selected?: boolean
  onToggleSelect?: (id: string) => void
  /**
   * 「分享」入口：进入多选模式，并预选「从第一条到这一条」。
   * 对齐 RikkaHub —— 分享的是到这条为止的上下文，不是孤立一条。
   */
  onShare?: (id: string) => void
  /** 输出被截断时，点「继续」把这条补完（并进同一气泡）。 */
  onContinue?: (id: string) => void
  /** 这条是上一条的续写：不重复画头像，只加一条细分隔线。 */
  continued?: boolean
}) {
  const { message, conversationId } = props
  const isUser = message.role === 'user'
  const sending = useAppStore((state) => state.sending)
  const actions = useAppStore((state) => state.actions)
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [branch, setBranch] = useState<{ index: number; count: number } | null>(null)
  // 选择器只返回字符串/原始值，避免每次返回新对象把 zustand 逼进无限重渲染。
  const assistantName = useAppStore((state) => {
    const conversation = state.conversations.find((item) => item.id === state.activeId)
    return conversationConfig(state.settings, conversation).name
  })
  // 群聊里每条消息要显示「是哪个助手说的」。这里订阅 assistants 数组本身
  // （引用稳定，只有真的增删改时才会变），避免选择器返回新对象触发无限重渲染。
  const assistants = useAppStore((state) => state.settings.assistants)
  // 取整个 settings 而不是在 selector 里算头像：selector 返回新对象会让 zustand 无限重渲染。
  const settings = useAppStore((state) => state.settings)
  const conversation = useAppStore((state) => state.conversations.find((item) => item.id === props.conversationId))
  const speaker = message.assistantId === undefined
    ? undefined
    : assistants.find((item) => item.id === message.assistantId)
  const speakerName = message.assistantName ?? speaker?.name ?? assistantName
  /*
   * 头像跟着「这条是谁说的」走：消息自带的 assistantId → 这段对话绑定的助手 → 设置级。
   *
   * 以前只按「当前助手」取，用户在同一个对话里换了助手，连历史消息的头像都会被改掉 ——
   * 那些消息明明是上一个助手说的。现在历史用作者，只有正在生成的那条才用当前助手。
   */
  const avatarProps = messageAvatarProps({ settings, conversation, message, assistants })
  const regexesJson = useAppStore((state) => {
    const conversation = state.conversations.find((item) => item.id === state.activeId)
    return JSON.stringify(conversationConfig(state.settings, conversation).regexes)
  })
  // 助手的正则替换只影响显示，不动存下来的原文。
  const displayText = useMemo(() => {
    if (isUser) return message.content
    const rules = JSON.parse(regexesJson) as AssistantRegex[]
    return applyRegexes(message.content, rules)
  }, [message.content, isUser, regexesJson])

  useEffect(() => {
    if (conversationId === null || message.role === 'tool') {
      setBranch(null)
      return
    }
    let alive = true
    void branchInfo(conversationId, message).then((info) => {
      if (alive) setBranch(info)
    })
    return () => {
      alive = false
    }
    // 分支计数在切换、重新生成、重进会话后会变，用这几个值做刷新触发。
  }, [conversationId, message.id, message.nodeId, message.active, sending])

  if (message.role === 'tool') {
    // 记忆写入是后台行为，不在这里显摆成一张工具卡。
    if (message.toolName === 'remember') return null
    return <ToolCard message={message} />
  }
  if (
    message.role === 'assistant'
    && message.content.trim() === ''
    && (message.reasoning ?? '').trim() === ''
    && (message.toolCalls?.length ?? 0) > 0
  ) {
    // 只有 remember 的一轮没有可显示的内容；混着别的工具时也只提别的。
    const shown = message.toolCalls?.filter((call) => call.function.name !== 'remember') ?? []
    if (shown.length === 0) return null
    return (
      <div className="tool-call-line">
        <Wrench size={13} />
        调用 {shown.map((call) => call.function.name).join('、')}
        {message.workspaceName !== undefined && <span> · {message.workspaceName}</span>}
      </div>
    )
  }

  const copy = async (): Promise<void> => {
    /*
     * 必须走 platform.writeClipboardText，不能直接用 navigator.clipboard。
     *
     * 真机上「点复制失败」的根因就在这里：Android WebView 里
     * navigator.clipboard.writeText 经常直接 reject（非安全上下文 / 没有剪贴板权限），
     * 而 writeClipboardText 在安卓上会先走原生 ClipboardManager（DeepSeaClipboard 插件），
     * 失败才落回网页实现。项目里其他复制入口（助手页、选中复制条）早就用的是它。
     */
    const ok = await writeClipboardText(message.content)
    actions.showToast(ok ? '已复制' : '复制失败，可以长按选中再复制')
  }

  const startEdit = (): void => {
    setDraft(message.content)
    setEditing(true)
  }

  const saveEdit = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || text === message.content) {
      setEditing(false)
      return
    }
    setEditing(false)
    if (isUser) {
      try {
        const ok = await editAndResend(message.id, text)
        if (!ok) actions.showToast('这条改不了，可能还在生成')
      } catch (error) {
        actions.showToast(error instanceof Error ? error.message : '这条改不了，稍后再试')
      }
    } else {
      await actions.updateMessage(message.id, { content: text })
      actions.showToast('已保存修改')
    }
  }

  const regenerate = async (): Promise<void> => {
    if (sending) {
      actions.showToast('等这次说完再重新生成')
      return
    }
    try {
      const ok = await regenerateAtMessage(message.id)
      if (!ok) actions.showToast('现在不能重新生成')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '重新生成失败，稍后再试')
    }
  }

  const remove = async (): Promise<void> => {
    if (sending) {
      actions.showToast('请先停止生成再删除消息')
      return
    }
    const ok = await confirmDialog({
      title: '删掉这条消息？',
      message: '同一处的其它分支也会一起删掉。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await actions.deleteMessage(message.id)
  }

  const fork = async (): Promise<void> => {
    if (sending) {
      actions.showToast('等这次说完再分叉')
      return
    }
    await actions.forkFromMessage(message.id)
  }

  const switchBranch = async (delta: number): Promise<void> => {
    await actions.switchBranch(message.id, delta)
  }

  return (
    <article
      className={`bubble ${isUser ? 'bubble-user' : 'bubble-assistant'}${props.continued === true ? ' bubble-continued' : ''}`}
      data-editing={editing ? 'true' : 'false'}
      data-anchor={message.id}
      data-flash={props.flash === true ? 'true' : undefined}
      data-selected={props.selected === true ? 'true' : undefined}
      // 多选用捕获阶段：点在代码块按钮/链接上也算选中，不会触发里面的动作。
      onClickCapture={props.selecting === true
        ? (event) => {
          event.preventDefault()
          event.stopPropagation()
          props.onToggleSelect?.(message.id)
        }
        : undefined}
    >
      {props.selecting === true && (
        <span className="bubble-select" aria-hidden="true">
          <span className="bubble-select-box">{props.selected === true && <Check size={12} />}</span>
        </span>
      )}
      {isUser ? (
        <div className="bubble-author bubble-author-user">
          <Avatar role="user" size={17} />
          <span>你</span>
          <time>{timeOf(message.createdAt)}</time>
        </div>
      ) : props.continued === true ? (
        <div className="bubble-continued-divider" aria-hidden="true"><span>续写</span></div>
      ) : (
        <div className="bubble-author">
          <Avatar role="assistant" size={17} {...(avatarProps ?? {})} />
          <span>{speakerName}</span>
          <time>{timeOf(message.createdAt)}</time>
          {message.status === 'error' && <em>出错</em>}
          {message.status === 'aborted' && <em>已停止</em>}
        </div>
      )}
      <AttachmentStrip attachments={message.attachments ?? []} compact />
      {editing ? (
        <div className="bubble-edit">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(12, Math.max(2, draft.split('\n').length))}
            autoFocus
          />
          <div className="bubble-edit-actions">
            <button type="button" className="text-button" onClick={() => setEditing(false)}>取消</button>
            <button type="button" className="ghost-button" onClick={() => void saveEdit()}>
              {isUser ? '保存并重发' : '保存'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {message.reasoning !== undefined && message.reasoning.trim() !== '' && (
            <ReasoningPanel text={message.reasoning} thinkingMs={message.thinkingMs} />
          )}
          {message.content.trim() !== '' && (
            <div className="bubble-body">
              <Markdown text={displayText} onRun={props.onRun} onSave={props.onSave} />
            </div>
          )}
          {message.error !== undefined && <div className="bubble-error">{message.error}</div>}
          {/*
            用量那一行顺带说「这一条是被输出上限切断的」。
            截断过去完全隐形：界面只停在「想到一半停住」，没人知道要说「继续」，
            也难怪用户以为工坊没被调用（truncated 由 engine 落库，见 engine.ts）。
          */}
          {!isUser && (message.truncated === true || message.usage?.outputTokens !== undefined) && (
            <div className="bubble-usage">
              {message.usage?.outputTokens !== undefined ? `${message.usage.outputTokens} tokens` : ''}
              {message.truncated === true ? ' · 已到输出上限' : ''}
              {message.truncated === true && props.onContinue !== undefined && props.selecting !== true && (
                <button
                  type="button"
                  className="bubble-continue"
                  onClick={() => props.onContinue?.(message.id)}
                  disabled={sending}
                  title="接着上一条继续写（不会新起一条回复）"
                >
                  {sending ? '续写中…' : '继续写'}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {/*
        动作条只留三个：复制 / 重新生成 / ⋯。
        为什么图标化：以前是「多选 复制 分享 编辑 重新生成 分叉 删除」七个中文按钮，
        360px 屏上放不下，按钮被挤成「多/选」「复/制」一字一行（真机截图就是这个样子）。
        其余动作收进「⋯」菜单，分享也从这里进（分享内部才有多选与导出格式）。
      */}
      {!editing && props.selecting !== true && (
        <div className="bubble-actions">
          {branch !== null && (
            <span className="bubble-branch">
              <button type="button" onClick={() => void switchBranch(-1)} aria-label="上一个分支">‹</button>
              <span>{branch.index}/{branch.count}</span>
              <button type="button" onClick={() => void switchBranch(1)} aria-label="下一个分支">›</button>
            </span>
          )}
          <button type="button" className="bubble-act" onClick={() => void copy()} aria-label="复制" title="复制">
            <Copy size={14} />
          </button>
          {!isUser && message.content.trim() !== '' && <SpeechButton message={message} />}
          {!isUser && (
            <button type="button" className="bubble-act" onClick={() => void regenerate()} aria-label="重新生成" title="重新生成">
              <RefreshCw size={14} />
            </button>
          )}
          <button
            type="button"
            className="bubble-act"
            onClick={() => setMenuOpen(true)}
            aria-label="更多"
            aria-haspopup="dialog"
            title="更多"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      )}

      <Modal open={menuOpen} onClose={() => setMenuOpen(false)} title="这条消息">
        <div className="bubble-menu">
          <button
            type="button"
            className="bubble-menu-row"
            onClick={() => {
              setMenuOpen(false)
              props.onShare?.(message.id)
            }}
          >
            <Share2 size={17} />
            <span>
              <strong>分享</strong>
              <small>选好要带的几段，再导出为 Markdown</small>
            </span>
          </button>
          <button type="button" className="bubble-menu-row" onClick={() => { setMenuOpen(false); startEdit() }}>
            <Pencil size={17} />
            <span>
              <strong>{isUser ? '编辑并重发' : '编辑'}</strong>
              <small>{isUser ? '改完会作废后面的回答，重新生成' : '只改显示的文字，不重新生成'}</small>
            </span>
          </button>
          <button type="button" className="bubble-menu-row" onClick={() => { setMenuOpen(false); void fork() }}>
            <GitBranch size={17} />
            <span>
              <strong>分叉</strong>
              <small>从这一条起开一段新对话</small>
            </span>
          </button>
          <button type="button" className="bubble-menu-row is-danger" onClick={() => { setMenuOpen(false); void remove() }}>
            <Trash2 size={17} />
            <span>
              <strong>删除</strong>
              <small>同一处的其它分支也会一起删掉</small>
            </span>
          </button>
        </div>
      </Modal>
    </article>
  )
}

export function Chat() {
  const settings = useAppStore((state) => state.settings)
  const conversations = useAppStore((state) => state.conversations)
  const activeId = useAppStore((state) => state.activeId)
  const messages = useAppStore((state) => state.messages)
  const live = useAppStore((state) => state.live)
  const sending = useAppStore((state) => state.sending)
  const sendingId = useAppStore((state) => state.sendingId)
  const sheet = useAppStore((state) => state.sheet)
  const draft = useAppStore((state) => state.draft)
  const notice = useAppStore((state) => state.notice)
  const actions = useAppStore((state) => state.actions)
  const [compressOpen, setCompressOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [snippetDraft, setSnippetDraft] = useState<SnippetDraft | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [flashId, setFlashId] = useState<string | null>(null)
  const turns = useMemo(() => buildTurns(messages), [messages])
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null)
  const sheetRef = useRef<HTMLElement | null>(null)
  const [dragWidth, setDragWidth] = useState<number | null>(null)

  const [input, setInput] = useState('')
  const [runner, setRunner] = useState<{ code: string; lang: string } | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  /*
   * 附件列表的实时镜像。
   *
   * 清空输入框发生在异步回调里（engine 落库之后 / 整轮生成结束之后），
   * 那时闭包里的 `attachments` 还是点击发送那一次渲染的值 —— 用它做「有没有变化」
   * 的判断永远是「没变」，用户生成期间新加 / 替换的附件就会被一起清掉。
   */
  const attachmentsRef = useRef<Attachment[]>([])
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  const [preparing, setPreparing] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const thinkingRef = useRef<HTMLDivElement | null>(null)
  const modelRef = useRef<HTMLDivElement | null>(null)
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null)
  const dragDepth = useRef(0)
  const conversation = conversations.find((item) => item.id === activeId)
  const activeConfig = conversationConfig(settings, conversation)
  // 群聊成员名，用于标题下方那行「群聊 · 3 人（A、B、C）」。
  const groupMemberNames = (conversation?.members ?? [])
    .map((id) => settings.assistants.find((item) => item.id === id)?.name)
    .filter((name): name is string => name !== undefined)
    .join('、')
  const currentAssistant = settings.assistants.find((item) => item.id === settings.assistantId)
  const quickMessages = currentAssistant?.quickMessages ?? []
  const hasKey = hasApiKey(settings)
  const hasContent = input.trim() !== '' || attachments.length > 0
  const webChatMode = isWebChatModel(settings.model)
  // 模型选项 = 当前供应商的模型目录（对齐 DSH：目录空就不再拿内置表兜底）。
  const modelOptions = catalogModelOptions(settings)
  const catalogEmpty = providerModels(settings).length === 0

  /**
   * 多选模式（对齐 RikkaHub 的消息级多选）：勾若干条消息 → 底部三键
   * 取消 / 全选 / 确定 → 带着选中的消息打开导出弹层。
   */
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [exportIds, setExportIds] = useState<string[] | null>(null)

  /**
   * 分享入口（唯一入口）：点某条消息的「分享」→ 进入多选，并预选「从第一条到这一条」。
   *
   * 为什么不预选单条：分享出来的东西通常是一段上下文，只有一条回答读起来是断的。
   * 这也是 RikkaHub 的做法（它的「分享」就是把 0..当前条全选）。用户可以在多选条上
   * 用「全选」扩到整段，或者点气泡取消掉不要的那几条。
   */
  const shareFromMessage = (id: string): void => {
    const index = messages.findIndex((message) => message.id === id)
    const upto = messages
      .slice(0, index < 0 ? messages.length : index + 1)
      .filter((message) => message.role !== 'tool')
      .map((message) => message.id)
    setSelecting(true)
    setSelectedIds(upto)
    // 输入框可能还带着焦点：那样自绘的文本工具条（SelectionCopyBar）会跟着弹出来，
    // 压在多选条上。进入多选先把焦点交还给页面。
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  const toggleSelect = (id: string): void => {
    setSelectedIds((previous) => (previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]))
  }

  const cancelSelect = (): void => {
    setSelecting(false)
    setSelectedIds([])
  }

  // 工具消息不进导出，所以也不参与全选。
  const selectableIds = messages.filter((message) => message.role !== 'tool').map((message) => message.id)
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.includes(id))

  const toggleSelectAll = (): void => {
    setSelectedIds(allSelected ? [] : selectableIds)
  }

  const confirmSelect = (): void => {
    if (selectedIds.length === 0) return
    setExportIds(selectedIds)
    setSelecting(false)
    setSelectedIds([])
    setExportOpen(true)
  }

  /** 打开导出选项弹窗（是否带思考过程等由用户在弹窗里定）。 */
  function exportConversation(): void {
    if (exportableMessages(messages).length === 0) {
      actions.showToast('这段对话还没有可以导出的内容')
      return
    }
    // null = 由弹窗自己决定（默认全选）。
    setExportIds(null)
    setExportOpen(true)
  }

  /**
   * 快捷指令只负责「填」，不负责「发」：点一条等于替用户在输入框里打好字，
   * 发送仍然要他按一次回车 —— 指令后面往往还要补一句话。
   *
   * 走 store 的 draft 通道（下面那条 effect 负责写进输入框、聚焦并撑高），
   * 这里只管拼文本，免得两条路径各写一套焦点逻辑。
   */
  function insertQuickCommand(text: string): void {
    const current = input.replace(/\s+$/, '')
    useAppStore.getState().actions.setDraft(current === '' ? text : `${current}\n${text}`)
    // draft 的 effect 只 focus、不管光标位置；用户点完就要接着打字，所以把光标放到末尾。
    requestAnimationFrame(() => {
      const element = inputRef.current
      if (element === null) return
      element.focus()
      const end = element.value.length
      element.setSelectionRange(end, end)
      resizeInput()
    })
  }

  // 多选时按 Esc 退出（桌面端习惯；手机上靠左下角的 ✕）。
  useEffect(() => {
    if (!selecting) return
    const onKey = (event: { key: string }): void => {
      if (event.key === 'Escape') cancelSelect()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting])

  // 给 body 打个标记：多选期间把自绘的文本选择条藏起来（CSS 里一条规则），
  // 免得它和多选条叠在同一块地方。
  useEffect(() => {
    if (selecting) document.body.dataset.selecting = 'true'
    else delete document.body.dataset.selecting
    return () => { delete document.body.dataset.selecting }
  }, [selecting])

  useEffect(() => {
    if (draft === '') return
    setInput(draft)
    actions.setDraft('')
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      resizeInput()
    })
  }, [draft, actions])

  /**
   * 用户是不是贴着底部看。
   *
   * 以前每个 token 都无条件 `scrollTop = scrollHeight`，想往上翻根本翻不动 ——
   * 手一松就被拽回底部（BUG-REVIEW P1-19）。现在只在「本来就在底部附近」时
   * 自动跟随；往上翻过就停下，翻回底部自动恢复。
   */
  const stickToBottom = useRef(true)

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const update = (): void => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight
      stickToBottom.current = distance < 80
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    return () => element.removeEventListener('scroll', update)
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    if (!stickToBottom.current) return
    element.scrollTop = element.scrollHeight
  }, [messages.length, live?.content, live?.reasoning, sending])

  /**
   * 软键盘：用 visualViewport 把面板顶到可视区底部。
   * 只用 CSS 的 dvh 在部分环境里不够（键盘弹起时 layout viewport 不变），
   * 这里直接把「键盘占掉的高度」写进 CSS 变量，面板与输入框就始终露出来。
   */
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    const update = (): void => {
      // 键盘高度 = 布局视口高 - 可视视口高 - 滚动偏移。
      const keyboard = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      root.style.setProperty('--keyboard-inset', `${Math.round(keyboard)}px`)
      if (keyboard > 80) {
        // 键盘一弹起就贴底，别让输入框悬在半空。
        const element = scrollRef.current
        if (element !== null) element.scrollTop = element.scrollHeight
      }
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      root.style.removeProperty('--keyboard-inset')
    }
  }, [])

  // 轮次导航：跟着滚动更新「当前看到第几轮」。
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const update = (): void => {
      const top = element.getBoundingClientRect().top
      let current: string | null = null
      for (const turn of turns) {
        const node = element.querySelector(`[data-anchor="${turn.anchorId}"]`)
        if (node === null) continue
        const box = node.getBoundingClientRect()
        // 顶边已经越过视野上沿的第一轮，就是当前轮。
        if (box.top - top <= 24) current = turn.anchorId
        else break
      }
      setActiveAnchor(current ?? turns[0]?.anchorId ?? null)
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    return () => element.removeEventListener('scroll', update)
  }, [turns, messages, sheet])

  const jumpToTurn = (anchorId: string): void => {
    const element = scrollRef.current
    if (element === null) return
    const node = element.querySelector(`[data-anchor="${anchorId}"]`)
    if (node === null) return
    const top = node.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
    element.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' })
  }

  const jumpToEdge = (edge: 'top' | 'bottom'): void => {
    const element = scrollRef.current
    if (element === null) return
    element.scrollTo({ top: edge === 'top' ? 0 : element.scrollHeight, behavior: 'smooth' })
  }

  /** 搜索命中后跳到那条消息，并闪一下让它显眼。 */
  const jumpToMessage = (messageId: string): void => {
    const element = scrollRef.current
    if (element === null) return
    const node = element.querySelector(`[data-anchor="${messageId}"]`)
    if (node === null) return
    const top = node.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
    element.scrollTo({ top: Math.max(0, top - 40), behavior: 'smooth' })
    setFlashId(messageId)
    window.setTimeout(() => setFlashId(null), 1600)
  }

  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!thinkingOpen) return
    const close = (event: PointerEvent): void => {
      const root = thinkingRef.current
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return
      setThinkingOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [thinkingOpen])

  useEffect(() => {
    if (!modelOpen) return
    const close = (event: PointerEvent): void => {
      const root = modelRef.current
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return
      setModelOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [modelOpen])

  useEffect(() => {
    if (!modelOpen) return
    const selected = modelRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
    const frame = requestAnimationFrame(() => selected?.focus())
    return () => cancelAnimationFrame(frame)
  }, [modelOpen])

  function closeModel(refocus = false): void {
    setModelOpen(false)
    if (refocus) requestAnimationFrame(() => modelTriggerRef.current?.focus())
  }

  /**
   * 网页账号模式的真实限制，第一次切过去时说清楚。
   *
   * 取消不记标记、也不切模型；确认过写 localStorage，之后不再弹。
   */
  async function confirmWebChatRisk(): Promise<boolean> {
    try {
      if (window.localStorage.getItem(WEB_CHAT_RISK_KEY) === '1') return true
    } catch (error) {
      /* 存不了 localStorage 就每次都问一遍 */
    }
    const ok = await confirmDialog({
      title: '网页账号模式说明',
      message: [
        '⚠️ 速度取决于网页端，高峰期可能排队',
        '📎 图片附件会先上传到网页账号（需要「登录网页账号」的免窗口模式）；文本附件随消息带上',
        '🧠 人设和常驻记忆会作为一段文字拼进你的消息（在网页版里看得见）',
        '✏️ 编辑重发 / 重新生成会在网页会话里追加一条，旧的删不掉',
        '💡 日常使用建议 API 模式，网页模式适合临时用',
      ].join('\n'),
      confirmText: '知道了，继续',
      cancelText: '先不用',
    })
    if (ok) {
      try {
        window.localStorage.setItem(WEB_CHAT_RISK_KEY, '1')
      } catch (error) {
        /* 忽略 */
      }
    }
    return ok
  }

  async function chooseModel(id: string): Promise<void> {
    if (isWebChatModel(id)) {
      if (!webChatAvailable()) {
        actions.showToast('这个版本不支持网页账号；请用安装版')
        closeModel(true)
        return
      }
      // 先把模型列表收起来，免得弹窗后面还浮着一个下拉。
      closeModel()
      if (!(await confirmWebChatRisk())) {
        closeModel(true)
        return
      }
    }
    /*
     * 助手可以单独覆盖模型（助手编辑里那项「跟随全局模型」）。一旦它被设成某个具体
     * 模型，就会盖住这里选的值 —— 真机上的表现就是「切回网页账号又跳回助手的 API
     * 模型」，然后一路报「还没有填 API Key」。手动选模型是明确意图，所以先把当前
     * 助手的覆盖清掉，让它回到「跟随全局」。
     *
     * 三处都 await：以前是 void，紧接着发送时可能读到还没落盘的旧快照。
     */
    const before = useAppStore.getState()
    const conversation = before.conversations.find((item) => item.id === before.activeId)
    const assistant = findAssistant(before.settings, conversation?.assistantId ?? before.settings.assistantId)
    if (assistant.model !== '') await actions.updateAssistant(assistant.id, { model: '' })
    await actions.setSettings({ model: id })
    // 对话快照也要跟着改，否则引擎下一轮仍用快照里的旧模型（和思考强度同一个坑）。
    await actions.patchConversationConfig({ model: id })
    closeModel(true)
  }

  function onModelKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeModel(true)
      return
    }
    if (!modelOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setModelOpen(true)
      }
      return
    }
    if (event.key === 'Tab') {
      setModelOpen(false)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(modelRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  function resizeInput(): void {
    const element = inputRef.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(160, element.scrollHeight)}px`
  }

  async function addFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files)
    if (list.length === 0) return
    if (!hasKey) {
      actions.showToast('先在设置里填一个 API Key')
      return
    }
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) {
      actions.showToast(`最多同时带 ${MAX_ATTACHMENTS} 个附件`)
      return
    }
    setPreparing(true)
    try {
      const prepared = await prepareAttachments(list.slice(0, room))
      const images = prepared.filter((attachment) => attachment.kind === 'image')
      // 永远保留附件，不再按「能不能看图」筛掉。丢图是静默的（用户以为模型在看，
      // 请求里根本没有图片，日志里也等不到任何供应商报错），照发是响亮的
      // （网关 400 会显示出来，还能归因）—— 2026-11-03 那个 bug 就是这么丢出来的。
      if (prepared.length > 0) {
        setAttachments((current) => [...current, ...prepared].slice(0, MAX_ATTACHMENTS))
      }
      const vision = visionOf(currentProvider(settings), settings.model)
      if (images.length > 0 && !vision.sees) {
        actions.setNotice(visionNoticeText(settings.model, vision))
      }
      if (list.length > room) actions.showToast(`只能带 ${MAX_ATTACHMENTS} 个附件，多出的已忽略`)
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '附件读取失败')
    } finally {
      setPreparing(false)
    }
  }

  function removeAttachment(id: string): void {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  async function send(): Promise<void> {
    const text = input.trim()
    if ((text === '' && attachments.length === 0) || sending || preparing) return
    let accepted = false
    /*
     * 用户消息一旦「成功落库」就立刻清空输入框 —— 这是 UI 反馈 #4 的要点。
     *
     * 以前是等 `await sendMessage()` 返回后才清，而 sendMessage 内部要
     * `await runAssistantTurn()`（整轮回复生成完才返回），于是「正在回应」的
     * 整段时间里，输入框都还留着刚发出去的那句话（截图里那个「暂留」）。
     *
     * 现在改成 engine 在 accepted 那一刻回调 onAccepted；「清不清、还能不能再清」
     * 的决策收在 createComposerClear 里（src/lib/composer-clear.ts）：
     *   - 主清空只要触发过，结尾的兜底就不再执行 —— 否则用户在生成期间重新敲出
     *     同样的文本，兜底会把这份新输入删掉（审查意见 P1）；
     *   - 兜底只服务本地指令 / 离线回复这类不走 onAccepted 的即时成功路径；
     *   - 清空前要求文本与附件都还是发送时那份，不误删用户新加的东西。
     */
    const composer = createComposerClear({
      /*
       * 快照存的是**附件身份**（Attachment.id），不是数量。
       * 只比数量的话，用户「删掉图 A 换成图 B」时数量仍是 1，会被误判成没变，
       * 于是把 B 一起清掉（二审 P1）。
       */
      sent: { text, attachmentIds: attachments.map((item) => item.id) },
      read: () => ({
        text: inputRef.current?.value.trim() ?? '',
        attachmentIds: attachmentsRef.current.map((item) => item.id),
      }),
      clear: () => {
        setInput('')
        setAttachments([])
        // 自己发的消息一定要看到：把「贴底」打开，否则用户之前往上翻过的话，
        // 新消息会安静地落在下面看不见。
        stickToBottom.current = true
        requestAnimationFrame(resizeInput)
      },
    })
    try {
      // 群聊走 sendGroupMessage（一个接一个说）；单聊仍走 sendMessage。
      const active = useAppStore.getState().conversations.find((item) => item.id === useAppStore.getState().activeId)
      accepted = active?.kind === 'group'
        ? await sendGroupMessage(text, attachments, { onAccepted: composer.onAccepted })
        : await sendMessage(text, attachments, { onAccepted: composer.onAccepted })
    } catch (error) {
      // engine 内部已经用 finally 兜住了发送状态；这里只防「连兜底都抛了」的极端情况，
      // 至少要让用户知道这次没发出去，而不是看着输入框发呆。
      actions.showToast(error instanceof Error ? error.message : '没发出去，再试一次')
    }
    // 兜底：只处理没有触发 onAccepted 的即时成功路径（本地指令 / 离线回复）。
    composer.settle(accepted)
  }

  function cycleSheet(): void {
    const index = SHEET_ORDER.indexOf(sheet)
    actions.setSheet(SHEET_ORDER[(index + 1) % SHEET_ORDER.length] as SheetSize)
  }

  /**
   * 抓手上按下并拖动 → 上下拉伸对话面板；只点一下（没拖动）仍然循环切换三档。
   *
   * 两个真机上踩过的坑：
   *   1. **pointercancel 绝不能当成 pointerup**：手势被系统接管时（判定成滚动等）会发
   *      pointercancel，它的 clientY 是 0，位移算出来就成了「往上拖了很远」——于是每次
   *      想往下拉都跳到全屏。用户看到的就是「拖上去之后拖不回来」。
   *   2. 横向为主的手势直接忽略，免得斜着划一下就改了高度。
   */
  function startSheetDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const index = SHEET_ORDER.indexOf(sheet)
    let dragged = false
    let cancelled = false

    const cleanup = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }

    const move = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) dragged = true
    }

    const cancel = (): void => {
      cancelled = true
      cleanup()
    }

    const finish = (upEvent: PointerEvent): void => {
      cleanup()
      if (cancelled) return
      if (!dragged) {
        cycleSheet()
        return
      }
      const dy = upEvent.clientY - startY
      // 一下拉到底就直接全屏，免得小屏上要拖两次。
      if (dy <= -160) {
        actions.setSheet('full')
        return
      }
      if (dy <= -50) {
        actions.setSheet(SHEET_ORDER[Math.min(SHEET_ORDER.length - 1, index + 1)] as SheetSize)
        return
      }
      if (dy >= 50) {
        actions.setSheet(SHEET_ORDER[Math.max(0, index - 1)] as SheetSize)
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
  }

  /**
   * 拖动面板左右边缘改宽度。
   * 面板水平居中，所以拖左边时往左=变宽；拖右边时往右=变宽。
   * 位移要 ×2，因为居中面板两边一起长。
   */
  function startResize(edge: 'left' | 'right') {
    return (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const sheetEl = sheetRef.current
      if (sheetEl === null) return
      const startWidth = sheetEl.getBoundingClientRect().width
      const startX = event.clientX
      const maxWidth = window.innerWidth - 16

      const move = (moveEvent: PointerEvent): void => {
        const dx = moveEvent.clientX - startX
        // 拖右边：向右(+dx)变宽；拖左边：向左(-dx)变宽。
        const signed = edge === 'right' ? dx : -dx
        const next = Math.round(Math.max(360, Math.min(maxWidth, startWidth + signed * 2)))
        setDragWidth(next)
      }

      const finish = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', finish)
        const finalWidth = sheetEl.getBoundingClientRect().width
        setDragWidth(null)
        void actions.setSettings({ sheetWidth: Math.round(finalWidth) })
      }

      // 挂在 window 上：拖动时指针会跑出这个 10px 的热区，挂在元素上会丢事件。
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', finish)
    }
  }

  function resetWidth(): void {
    void actions.setSettings({ sheetWidth: null })
    actions.showToast('对话框宽度已恢复默认')
  }

  async function saveSnippet(code: string, lang: string): Promise<void> {
    // 先问文件名和项目，别直接往工坊里塞一个 snippet-<时间戳>。
    setSnippetDraft({ code, lang })
  }

  const runSnippet = (code: string, lang: string): void => {
    setRunner({ code, lang })
  }

  const title = conversation?.title ?? '新的对话'

  return (
    <div className="chat-screen">
      <section
        className={`chat-sheet sheet-${sheet}`}
        aria-label="对话"
        ref={sheetRef}
        style={dragWidth !== null
          ? { width: `${dragWidth}px`, maxWidth: 'calc(100vw - 16px)' }
          : settings.sheetWidth !== null
            ? { width: `${settings.sheetWidth}px`, maxWidth: 'calc(100vw - 16px)' }
            : undefined}
        data-width={settings.sheetWidth !== null ? 'custom' : 'default'}
      >
        {/*
          自定义对话底图（外观面板里选的）。单独一层垫在面板背景之上、内容之下：
          CSS 里给了 z-index:-1，所以它不会盖住气泡和输入框，也不会被
          .chat-sheet 的玻璃底色压掉；可读性遮罩是这一层的 ::after（见 styles.css）。
        */}
        {settings.chatBackdrop !== null && (
          <div
            className="chat-backdrop"
            aria-hidden="true"
            style={{
              backgroundImage: `url(${settings.chatBackdrop})`,
              opacity: settings.chatBackdropOpacity,
            }}
          />
        )}
        <div
          className="sheet-resize"
          data-edge="left"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整对话宽度"
          onPointerDown={startResize('left')}
          onDoubleClick={resetWidth}
        />
        <div
          className="sheet-resize"
          data-edge="right"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整对话宽度"
          onPointerDown={startResize('right')}
          onDoubleClick={resetWidth}
        />
        <button
          type="button"
          className="sheet-grip"
          aria-label="拖动或点击调整对话高度"
          title="上下拖动：拉高/拉低（拖到底 = 全屏）；点一下：循环切换"
          onPointerDown={startSheetDrag}
        >
          <span />
        </button>

        <header className="chat-head">
          <IconButton label="回到海面" onClick={() => actions.setScreen('home')}>
            <ArrowLeft size={19} />
          </IconButton>
          <div className="chat-title">
            <strong>{title}</strong>
            <span>
              {sending ? (
                <>
                  <Spinner small /> 正在回应…
                </>
              ) : (
                <>
                  {conversation?.kind === 'group' ? (
                    <>
                      群聊 · {(conversation.members ?? []).length} 人
                      {groupMemberNames !== '' ? `（${groupMemberNames}）` : ''}
                    </>
                  ) : (
                    <>
                      {activeConfig.name} · {activeConfig.model}
                      {activeConfig.thinkingEffort !== 'off' ? ` · 深想 ${effortLabel(activeConfig.thinkingEffort)}` : ''}
                    </>
                  )}
                </>
              )}
            </span>
          </div>
          <div className="chat-head-actions">
            <IconButton label="搜索对话" onClick={() => setSearchOpen((open) => !open)}>
              <Search size={18} />
            </IconButton>
            <IconButton label="压缩上下文" onClick={() => setCompressOpen(true)}>
              <Minimize2 size={18} />
            </IconButton>
            {/* 这个位置原来是「分享 / 导出」：导出在消息多选和导出弹窗里都有入口，
                这里让给快捷指令表，输入时不用再靠记忆拼动作词。 */}
            <QuickCommands onInsert={insertQuickCommand} />
            <IconButton label="历史对话" onClick={() => actions.setHistoryOpen(true)}>
              <History size={18} />
            </IconButton>
            <IconButton label="新对话（可选群聊）" onClick={() => actions.setNewChatOpen(true)}>
              <Plus size={18} />
            </IconButton>
          </div>
        </header>

        <div className="chat-scroll" ref={scrollRef} data-selecting={selecting ? 'true' : undefined}>
          {notice !== '' && (
            <div className="chat-notice" role="status">
              <span>{notice}</span>
              {notice.includes('API Key') && (
                <button
                  type="button"
                  className="chat-notice-link"
                  onClick={() => actions.setScreen('settings')}
                >
                  去填
                </button>
              )}
            </div>
          )}
          {messages.length === 0 && live === null && (
            <div className="chat-empty">
              <img src="./deepwhale.png" alt="" />
              <strong>今天想聊点什么？</strong>
              <p>可以问问题、让我写个小网页，也可以丢一张图或一段代码给我。</p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => {
                  const Icon = suggestion.icon
                  return (
                    <button
                      key={suggestion.text}
                      type="button"
                      onClick={() => {
                        setInput(suggestion.text)
                        requestAnimationFrame(() => {
                          inputRef.current?.focus()
                          resizeInput()
                        })
                      }}
                    >
                      <Icon size={15} />
                      {suggestion.text}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <Bubble
              key={message.id}
              message={message}
              conversationId={activeId}
              flash={message.id === flashId}
              onRun={runSnippet}
              onSave={(code, lang) => void saveSnippet(code, lang)}
              selecting={selecting}
              selected={selectedIds.includes(message.id)}
              onToggleSelect={toggleSelect}
              onShare={shareFromMessage}
              onContinue={(id) => void continueTurn(id)}
              continued={message.continuedFrom !== undefined}
            />
          ))}

          {/* 只画属于这段对话的实时气泡：生成中切到别的对话时，
              上一段的半截回复不能跑到这里来（BUG-REVIEW P1-1）。 */}
          {live !== null && live.conversationId === activeId && (
            <article className="bubble bubble-assistant bubble-live">
              <div className="bubble-author">
                {/* 正在生成的那条属于「这段对话现在用的助手」，和上面的名字同源（activeConfig）。 */}
                <Avatar role="assistant" size={17} {...assistantAvatarProps(activeConfig)} />
                {/* 名字跟着当前助手走，别写死「深鲸」——切助手后这里要对得上。 */}
                <span>{activeConfig.name}</span>
                <em className="live-dot">{live.content.trim() !== '' ? '正在输入' : '正在思考'}</em>
              </div>
              {live.reasoning.trim() !== '' && <ReasoningPanel text={live.reasoning} live />}
              {live.content.trim() !== '' ? (
                <div className="bubble-body">
                  <Markdown text={live.content} onRun={runSnippet} onSave={(code, lang) => void saveSnippet(code, lang)} />
                  <span className="caret" />
                </div>
              ) : (
                <div className="typing" aria-label="正在思考">
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </article>
          )}

          {sending && live === null && sendingId === activeId && (
            <article className="bubble bubble-assistant">
              <div className="typing" aria-label="正在使用工具">
                <span />
                <span />
                <span />
              </div>
            </article>
          )}
        </div>

        {/* 多选条：取消 / 全选 / 确定（对齐 RikkaHub 的三键）。 */}
        {selecting && (
          <div className="selection-bar" role="toolbar" aria-label="多选">
            <button type="button" className="selection-bar-btn" aria-label="取消多选" onClick={cancelSelect}>
              <X size={17} />
            </button>
            <button
              type="button"
              className="selection-bar-btn"
              aria-label={allSelected ? '全不选' : '全选'}
              aria-pressed={allSelected}
              onClick={toggleSelectAll}
            >
              <MousePointerClick size={17} />
            </button>
            <span className="selection-bar-count" aria-live="polite">已选 {selectedIds.length} 条</span>
            <button
              type="button"
              className="selection-bar-btn is-primary"
              aria-label="确定"
              disabled={selectedIds.length === 0}
              onClick={confirmSelect}
            >
              <Check size={17} />
            </button>
          </div>
        )}

        <TurnNavigator
          turns={turns}
          activeAnchorId={activeAnchor}
          onLeft={false}
          onJump={jumpToTurn}
          onJumpEdge={jumpToEdge}
        />

        <div
          className="composer-wrap"
          data-drop={dragActive ? 'true' : 'false'}
          onDragEnter={(event) => {
            event.preventDefault()
            dragDepth.current += 1
            setDragActive(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault()
            dragDepth.current = Math.max(0, dragDepth.current - 1)
            if (dragDepth.current === 0) setDragActive(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            dragDepth.current = 0
            setDragActive(false)
            void addFiles(event.dataTransfer.files)
          }}
        >
          <div className="composer">
            <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
            {quickMessages.length > 0 && (
              <div className="composer-quick">
                {quickMessages.map((quick) => (
                  <button
                    key={quick.id}
                    type="button"
                    className="composer-chip composer-quick-chip"
                    title={quick.content}
                    onClick={() => {
                      setInput(quick.content)
                      requestAnimationFrame(() => {
                        inputRef.current?.focus()
                        resizeInput()
                      })
                    }}
                  >
                    {quick.title !== '' ? quick.title : quick.content.slice(0, 8)}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              rows={1}
              placeholder={
                !hasKey
                  ? '先在设置里填一个 API Key'
                  : attachments.length > 0
                    ? '给这些附件加一句话（可选）…'
                    : `和${activeConfig.name}说点什么…`
              }
              onChange={(event) => {
                setInput(event.target.value)
                resizeInput()
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files)
                if (files.length === 0) return
                event.preventDefault()
                void addFiles(files)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className="composer-row">
              <input
                ref={fileRef}
                type="file"
                className="visually-hidden"
                multiple
                accept="image/*,.txt,.md,.markdown,.json,.js,.jsx,.ts,.tsx,.css,.html,.py,.go,.rs,.java,.kt,.c,.cpp,.h,.yml,.yaml,.toml,.csv,.log,.sh,.ps1"
                onChange={(event) => {
                  const files = event.target.files
                  if (files !== null) void addFiles(files)
                  event.target.value = ''
                }}
              />
              <button
                type="button"
                className="composer-chip composer-attach"
                onClick={() => fileRef.current?.click()}
                disabled={preparing || attachments.length >= MAX_ATTACHMENTS}
                aria-label="添加附件"
              >
                {preparing ? <Spinner small /> : <Paperclip size={14} />}
                <span className="composer-chip-text">{attachments.length > 0 ? `${attachments.length}/${MAX_ATTACHMENTS}` : '附件'}</span>
              </button>
              {/*
                「记忆」入口以前也在这里，但和组件自己的记忆页、工坊/设置里的入口重复，
                而且那颗 chip 在窄屏上会被挤成两行（真机反馈 UI 有问题）。直接去掉，
                记忆统一从首页/设置进。
              */}
              <div className="composer-thinking" ref={thinkingRef}>
                <button
                  type="button"
                  className="composer-chip"
                  data-active={activeConfig.thinkingEffort !== 'off' ? 'true' : 'false'}
                  onClick={() => setThinkingOpen((value) => !value)}
                  aria-expanded={thinkingOpen}
                >
                  <Gauge size={14} />
                  <span className="composer-chip-text">思考 {effortLabel(activeConfig.thinkingEffort)}</span>
                </button>
                {thinkingOpen && (
                  <div className="thinking-popover" role="radiogroup" aria-label="思考强度">
                    <p>思考强度</p>
                    {EFFORTS.map((effort) => (
                      <button
                        key={effort.id}
                        type="button"
                        role="radio"
                        aria-checked={activeConfig.thinkingEffort === effort.id}
                        data-active={activeConfig.thinkingEffort === effort.id ? 'true' : 'false'}
                        onClick={() => {
                          // 两处都写：全局作为「新对话的默认」，对话快照作为「这一条立即生效」。
                          // 只写全局正是「关了思考还在想」的根因（引擎读的是快照）。
                          void actions.setSettings({ thinkingEffort: effort.id })
                          void actions.patchConversationConfig({ thinkingEffort: effort.id })
                          setThinkingOpen(false)
                        }}
                      >
                        <span>
                          <strong>{effort.label}</strong>
                          <small>{effort.hint}</small>
                        </span>
                        {activeConfig.thinkingEffort === effort.id && <Check size={14} />}
                      </button>
                    ))}
                    <p className="thinking-note">下一条消息生效</p>
                  </div>
                )}
              </div>
              <div className="composer-model" ref={modelRef} onKeyDown={onModelKeyDown}>
                <button
                  ref={modelTriggerRef}
                  type="button"
                  className="composer-chip"
                  data-active={modelOpen ? 'true' : 'false'}
                  onClick={() => setModelOpen((value) => !value)}
                  aria-haspopup="listbox"
                  aria-expanded={modelOpen}
                  aria-controls="composer-model-options"
                >
                  <Cpu size={14} />
                  <span className="composer-chip-text">{activeConfig.model || '选择模型'}</span>
                  <ChevronDown size={11} className="composer-caret" />
                </button>
                {modelOpen && (
                  <div id="composer-model-options" className="model-popover" role="listbox" aria-label="切换模型">
                    <div className="model-popover-head">
                      <span>切换模型</span>
                      <small>下一条生效</small>
                    </div>
                    {catalogEmpty && (
                      <p className="model-popover-note">
                        这个供应商的模型目录是空的。去「模型与 API 设置」里点「获取可用模型」，或直接手填模型名发送。
                      </p>
                    )}
                    {modelOptions.map((option) => {
                      const active = activeConfig.model === option.id
                      return (
                        <button
                          key={option.id}
                          type="button"
                          role="option"
                          aria-selected={active}
                          className="model-option"
                          data-active={active ? 'true' : 'false'}
                          data-model={option.id}
                          onClick={() => { void chooseModel(option.id) }}
                        >
                          <span className="model-glyph"><Cpu size={13} /></span>
                          <span className="model-copy">
                            <span className="model-name">{option.id}</span>
                            <span className="model-hint">{option.hint}</span>
                          </span>
                          <span className="model-tags">
                            {option.tags.map((tag) => <span key={tag}>{tag}</span>)}
                          </span>
                          {active && <Check size={14} className="model-check" />}
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      className="model-manage"
                      onClick={() => {
                        closeModel()
                        actions.setScreen('settings')
                      }}
                    >
                      <Settings2 size={12} />
                      模型与 API 设置
                      <ArrowUpRight size={12} />
                    </button>
                  </div>
                )}
              </div>
              <span className="composer-spacer" />
              {sending ? (
                <button type="button" className="send-button is-stop" onClick={() => stopSending()} aria-label="停止">
                  <Square size={17} />
                </button>
              ) : (
                <button type="button" className="send-button" onClick={() => void send()} disabled={!hasContent || preparing} aria-label="发送">
                  <Send size={18} />
                </button>
              )}
            </div>
          </div>
          {dragActive && (
            <div className="composer-drop" aria-hidden="true">
              <Paperclip size={18} />
              松开加入附件
            </div>
          )}
        </div>

        {searchOpen && (
          <SearchPanel
            conversationId={activeId}
            onClose={() => setSearchOpen(false)}
            onJump={jumpToMessage}
          />
        )}
      </section>

      <CodeRunModal
        open={runner !== null}
        code={runner?.code ?? ''}
        lang={runner?.lang ?? 'js'}
        onClose={() => setRunner(null)}
      />

      <CompressDialog open={compressOpen} onClose={() => setCompressOpen(false)} />
      <ExportDialog
        open={exportOpen}
        onClose={() => {
          setExportOpen(false)
          setExportIds(null)
        }}
        preselectIds={exportIds ?? undefined}
      />
      <SaveToWorkshopDialog draft={snippetDraft} onClose={() => setSnippetDraft(null)} />
    </div>
  )
}