import { useState } from 'react'
import { Users } from 'lucide-react'
import { useAppStore } from '../lib/store'
import { assistantAvatarProps, Avatar } from './Avatar'
import { Modal, Switch } from './ui'
import './styles-groupchat.css'

/**
 * 新建对话：先选「单聊」还是「群聊」，再选人。
 *
 * 为什么单开一个弹层而不是直接建对话：群聊要选多个助手、还要定发言节奏，
 * 这些参数在「新建那一刻」定最自然。单聊保留原来的默认行为（一键直通）。
 */
export function NewChatSheet(props: { open: boolean; onClose: () => void }) {
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [mode, setMode] = useState<'single' | 'group'>('single')
  const [selected, setSelected] = useState<string[]>([settings.assistantId])
  const [gapMs, setGapMs] = useState(1500)
  const [allowChatter, setAllowChatter] = useState(false)
  const [maxTurns, setMaxTurns] = useState(3)
  const [busy, setBusy] = useState(false)

  const assistants = settings.assistants
  const singleId = selected[0] ?? settings.assistantId

  const toggle = (id: string): void => {
    if (mode === 'single') {
      setSelected([id])
      return
    }
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (mode === 'group') {
        const members = selected.length > 0 ? selected : [settings.assistantId]
        if (members.length < 2) {
          // 只选了一个就等于单聊，别硬建一个「1 人群」。
          await actions.selectAssistant(members[0])
          await actions.createConversation()
        } else {
          await actions.createConversation('新的对话', {
            kind: 'group',
            members,
            groupSettings: { gapMs, allowChatter, maxTurnsPerRound: maxTurns },
          })
        }
      } else {
        await actions.selectAssistant(singleId)
        await actions.createConversation()
      }
      props.onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="新建对话"
      footer={(
        <div className="newchat-foot">
          <button type="button" className="ghost-button" onClick={props.onClose}>取消</button>
          <button type="button" className="primary-button" onClick={() => void create()} disabled={busy}>
            {busy ? '创建中…' : mode === 'group' ? `开始群聊（${Math.max(selected.length, 1)} 人）` : '开始对话'}
          </button>
        </div>
      )}
    >
      <div className="newchat-mode">
        <button
          type="button"
          className={`newchat-mode-btn ${mode === 'single' ? 'is-active' : ''}`}
          onClick={() => {
            setMode('single')
            setSelected([settings.assistantId])
          }}
        >
          单个助手
        </button>
        <button
          type="button"
          className={`newchat-mode-btn ${mode === 'group' ? 'is-active' : ''}`}
          onClick={() => {
            setMode('group')
            setSelected((current) => (current.length >= 2 ? current : [...new Set([settings.assistantId, current[0] ?? settings.assistantId])].slice(0, 2)))
          }}
        >
          <Users size={14} /> 群聊
        </button>
      </div>

      <div className="newchat-list">
        {assistants.map((item) => {
          const avatar = assistantAvatarProps(item)
          const on = selected.includes(item.id)
          return (
            <button
              key={item.id}
              type="button"
              className={`newchat-item ${on ? 'is-on' : ''}`}
              onClick={() => toggle(item.id)}
            >
              <Avatar role="assistant" size={30} avatarSrc={avatar.avatarSrc} emoji={avatar.emoji} />
              <span className="newchat-item-name">{item.name}</span>
              {on && <span className="newchat-item-tick">✓</span>}
            </button>
          )
        })}
      </div>

      {mode === 'group' && (
        <div className="newchat-group">
          <p className="newchat-warn">
            群聊里每个助手各回一次，<strong>token 消耗会随人数成倍增加</strong>。可以让某个助手少说话，或直接喊它的名字。
          </p>
          <label className="newchat-field">
            <span>发言间隔</span>
            <input
              type="range"
              min={300}
              max={5000}
              step={100}
              value={gapMs}
              onChange={(event) => setGapMs(Number(event.target.value))}
            />
            <em>{(gapMs / 1000).toFixed(1)}s</em>
          </label>
          <label className="newchat-field">
            <span>一轮最多几个助手发言</span>
            <input
              type="number"
              min={1}
              max={6}
              value={maxTurns}
              onChange={(event) => setMaxTurns(Math.max(1, Math.min(6, Number(event.target.value))))}
            />
          </label>
          <div className="newchat-switch">
            <div>
              <strong>允许助手之间互相接话</strong>
              <small>关掉更省 token：只有你和被点名的助手说话，其他人不主动插话</small>
            </div>
            <Switch checked={allowChatter} onChange={setAllowChatter} label="互相接话" />
          </div>
        </div>
      )}
    </Modal>
  )
}
