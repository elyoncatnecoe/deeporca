import { useEffect, useState } from 'react'
import { Modal } from './ui'

/**
 * App 内深色确认框，用来替换所有 window.confirm。
 *
 * 为什么必须替换：Android WebView 的 window.confirm 是**系统原生对话框**，用的是
 * WebView 所在 Context 的默认主题（白底 + Material 蓝色按钮），网页 CSS 和 App 的
 * 深色主题都管不到。用户在任何删除/清空/覆盖操作时都会看到一块白色弹窗 + 蓝色色块，
 * 跟深海皮肤完全不搭。
 *
 * 用法：
 *   const ok = await confirmDialog({ title: '删除这段对话？', message: '...', danger: true })
 *   if (!ok) return
 *
 * 全局只挂一个 <ConfirmHost />（App.tsx 里），用模块级队列串行处理。
 */
export type ConfirmOptions = {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  /** true 时确认按钮用红色（删除/清空等破坏性操作）。 */
  danger?: boolean
}

type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void }

let pendingConfirm: PendingConfirm | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** 打开一个 App 内确认框，返回用户选择（true=确认，false=取消）。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 如果已有弹窗（极端并发），先把旧的按取消处理，避免悬挂 Promise。
    if (pendingConfirm !== null) {
      const previous = pendingConfirm
      pendingConfirm = null
      previous.resolve(false)
    }
    pendingConfirm = { ...options, resolve }
    notify()
  })
}

export function ConfirmHost() {
  const [state, setState] = useState<PendingConfirm | null>(pendingConfirm)

  useEffect(() => {
    const update = (): void => setState(pendingConfirm)
    listeners.add(update)
    update()
    return () => {
      listeners.delete(update)
    }
  }, [])

  const close = (ok: boolean): void => {
    const current = pendingConfirm
    pendingConfirm = null
    notify()
    if (current !== null) current.resolve(ok)
  }

  if (state === null) return null

  return (
    <Modal
      open
      onClose={() => close(false)}
      title={state.title}
      footer={(
        <>
          <button type="button" className="ghost-button" onClick={() => close(false)}>
            {state.cancelText ?? '取消'}
          </button>
          <button
            type="button"
            className={state.danger === true ? 'primary-button is-danger' : 'primary-button'}
            onClick={() => close(true)}
          >
            {state.confirmText ?? '确定'}
          </button>
        </>
      )}
    >
      {state.message !== undefined && <p className="confirm-message">{state.message}</p>}
    </Modal>
  )
}