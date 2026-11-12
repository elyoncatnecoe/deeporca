import { useState } from 'react'
import { Modal } from './ui'
import { useAppStore } from '../lib/store'
import { compressNow } from '../lib/compress'

/**
 * 手动压缩对话历史。
 * 照 RikkaHub 的形状：额外要求 + 保留最近条数，两个都由用户决定。
 */
export function CompressDialog(props: { open: boolean; onClose: () => void }) {
  const settings = useAppStore((state) => state.settings)
  const activeId = useAppStore((state) => state.activeId)
  const sending = useAppStore((state) => state.sending)
  const actions = useAppStore((state) => state.actions)

  const [extra, setExtra] = useState('')
  const [keep, setKeep] = useState(8)
  const [busy, setBusy] = useState(false)

  const close = (): void => {
    if (busy) return
    props.onClose()
  }

  const submit = async (): Promise<void> => {
    if (activeId === null || busy) return
    setBusy(true)
    try {
      await compressNow(activeId, settings, {
        extraPrompt: extra,
        keepRecentMessages: keep,
      })
      void actions.refreshConversations()
      props.onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={props.open} onClose={close} title="压缩这段对话">
      <label className="field">
        <span>额外要求（可留空）</span>
        <textarea
          className="compress-extra"
          rows={3}
          placeholder="比如：人名和结论要留准"
          value={extra}
          onChange={(event) => setExtra(event.target.value)}
          disabled={busy}
        />
      </label>
      <label className="field">
        <span>保留最近消息：{keep} 条</span>
        <input
          type="range"
          min={4}
          max={30}
          step={1}
          value={keep}
          onChange={(event) => setKeep(Number(event.target.value))}
          disabled={busy}
        />
        <small className="settings-hint">更早的内容才会被折进摘要。</small>
      </label>
      {sending && <p className="settings-hint">还在生成回复，等它说完再压。</p>}
      <div className="inline-actions">
        <button type="button" className="ghost-button" onClick={close} disabled={busy}>取消</button>
        <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy || sending || activeId === null}>
          {busy ? '正在压缩…' : '压缩'}
        </button>
      </div>
    </Modal>
  )
}