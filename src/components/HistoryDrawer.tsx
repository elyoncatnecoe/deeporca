import { useEffect, useState } from 'react'
import { ChevronDown, FileText, MessageCircle, Plus, Trash2, X } from 'lucide-react'
import { useAppStore } from '../lib/store'
import { deleteSummary, getSummary, putSummary } from '../lib/db'
import { Avatar, assistantAvatarProps } from './Avatar'
import { IconButton, Select } from './ui'
import { confirmDialog } from './ConfirmDialog'

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)
}

interface CompressedSummary {
  text: string
  foldedCount?: number
}

export function HistoryDrawer() {
  const conversations = useAppStore((state) => state.conversations)
  const activeId = useAppStore((state) => state.activeId)
  const autoCompress = useAppStore((state) => state.settings.autoCompress)
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [openId, setOpenId] = useState<string | null>(null)
  /** 按助手筛选：'' = 全部；否则只看这个助手参与过的对话。 */
  const [filterId, setFilterId] = useState('')
  const [digest, setDigest] = useState<CompressedSummary | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const participantIds = (conversation: typeof conversations[number]): string[] => {
    if (conversation.kind === 'group') return conversation.members ?? []
    return conversation.assistantId !== undefined ? [conversation.assistantId] : []
  }

  const visible = filterId === ''
    ? conversations
    : conversations.filter((conversation) => participantIds(conversation).includes(filterId))

  useEffect(() => {
    if (openId === null) {
      setDigest(null)
      return
    }
    let alive = true
    void getSummary(openId).then((record) => {
      if (!alive) return
      setDigest(record === undefined ? null : { text: record.text, foldedCount: record.foldedCount })
    })
    return () => {
      alive = false
    }
  }, [openId])

  const remove = async (id: string): Promise<void> => {
    const ok = await confirmDialog({
      title: '删除这段对话？',
      message: '记忆里的事实不会跟着删。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await actions.removeConversation(id)
  }

  const toggleDigest = (id: string): void => {
    setEditing(false)
    setOpenId((current) => (current === id ? null : id))
  }

  const saveDigest = async (id: string): Promise<void> => {
    const text = draft.trim()
    if (text === '') return
    const record = await getSummary(id)
    await putSummary({
      conversationId: id,
      text,
      updatedAt: Date.now(),
      coveredUntilId: record?.coveredUntilId,
      coveredUntilAt: record?.coveredUntilAt,
      foldedCount: record?.foldedCount,
    })
    setDigest({ text, foldedCount: record?.foldedCount })
    setEditing(false)
  }

  const deleteDigest = async (id: string): Promise<void> => {
    const ok = await confirmDialog({
      title: '删掉这段压缩摘要？',
      message: '删了就等于「现在彻底不记得这段了」。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await deleteSummary(id)
    setDigest(null)
    setEditing(false)
  }

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) actions.setHistoryOpen(false)
      }}
    >
      <aside className="drawer" aria-label="历史对话">
        <header className="drawer-head">
          <div>
            <strong>对话</strong>
            <span>{visible.length} 段</span>
          </div>
          <div className="drawer-head-actions">
            <IconButton label="新对话" onClick={() => actions.setNewChatOpen(true)}>
              <Plus size={18} />
            </IconButton>
            <IconButton label="关闭" onClick={() => actions.setHistoryOpen(false)}>
              <X size={18} />
            </IconButton>
          </div>
        </header>
        {/* 按助手筛选：群聊一多，光看标题很难找回「和 Clawd 聊过的那段」。
            用自绘的 Select，不用原生 <select>：Android WebView 的原生弹层不吃
            color-scheme，会渲染成白底、选项文字看不见（UI 反馈 #1）。 */}
        <div className="drawer-filter">
          <Select
            value={filterId}
            onChange={setFilterId}
            ariaLabel="按助手筛选"
            options={[
              { value: '', label: '全部助手' },
              ...settings.assistants.map((item) => ({ value: item.id, label: item.name })),
            ]}
          />
        </div>
        <div className="drawer-list">
          {visible.length === 0 && (
            <div className="drawer-empty">
              <MessageCircle size={22} />
              <p>{conversations.length === 0 ? '还没有对话。海面很安静。' : '这个助手还没有对话。'}</p>
            </div>
          )}
          {visible.map((conversation) => {
            const expanded = conversation.id === openId
            const members = participantIds(conversation)
            return (
              <div key={conversation.id} className={`drawer-item ${conversation.id === activeId ? 'is-active' : ''}`}>
                <button
                  type="button"
                  className={`drawer-row ${conversation.id === activeId ? 'is-active' : ''}`}
                  onClick={() => void actions.openConversation(conversation.id)}
                >
                  <span className="drawer-row-main">
                    <strong>{conversation.title}</strong>
                    <small className="drawer-row-who">
                      {members.slice(0, 3).map((id) => {
                        const assistant = settings.assistants.find((item) => item.id === id)
                        if (assistant === undefined) return null
                        const avatar = assistantAvatarProps(assistant)
                        return <Avatar key={id} role="assistant" size={14} avatarSrc={avatar.avatarSrc} emoji={avatar.emoji} />
                      })}
                      {conversation.kind === 'group' && <em>群聊 · {members.length} 人</em>}
                    </small>
                    {/* 预览：最后一条回复的前 180 字，不是压缩摘要 */}
                    <small>{conversation.summary ?? '还没有摘要'}</small>
                  </span>
                  <span className="drawer-row-side">
                    <time>{dayLabel(conversation.updatedAt)}</time>
                    <span
                      role="button"
                      tabIndex={0}
                      className="drawer-delete"
                      aria-label="删除对话"
                      onClick={(event) => {
                        event.stopPropagation()
                        void remove(conversation.id)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.stopPropagation()
                          void remove(conversation.id)
                        }
                      }}
                    >
                      <Trash2 size={15} />
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="drawer-digest-toggle"
                  aria-expanded={expanded}
                  onClick={() => toggleDigest(conversation.id)}
                >
                  <FileText size={13} />
                  <span>压缩摘要</span>
                  <ChevronDown size={13} data-open={expanded ? 'true' : 'false'} />
                </button>
                {expanded && (
                  <div className="drawer-digest">
                    <p className="drawer-digest-meta">
                      自动压缩：{autoCompress ? '开' : '关'}
                      {autoCompress ? '' : '（已关，只能点对话页顶部的「压缩上下文」手动压）'}
                    </p>
                    {digest === null ? (
                      <p className="drawer-digest-empty">这段还没有压缩摘要。</p>
                    ) : editing ? (
                      <>
                        <textarea
                          className="drawer-digest-input"
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                        />
                        <div className="drawer-digest-actions">
                          <button type="button" onClick={() => setEditing(false)}>取消</button>
                          <button type="button" onClick={() => void saveDigest(conversation.id)}>保存</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="drawer-digest-text">{digest.text}</p>
                        <div className="drawer-digest-meta">
                          {digest.foldedCount !== undefined ? `已折进 ${digest.foldedCount} 条消息` : ''}
                        </div>
                        <div className="drawer-digest-actions">
                          <button
                            type="button"
                            onClick={() => {
                              setDraft(digest.text)
                              setEditing(true)
                            }}
                          >
                            编辑
                          </button>
                          <button type="button" onClick={() => void deleteDigest(conversation.id)}>删除</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <footer className="drawer-foot">
          <p>对话和记忆都只在本机。换设备前记得在设置里导出。</p>
        </footer>
      </aside>
    </div>
  )
}
