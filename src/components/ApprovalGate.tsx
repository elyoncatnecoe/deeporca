import { useEffect, useState } from 'react'
import { AlertTriangle, ShieldCheck, ShieldQuestion, X } from 'lucide-react'
import {
  listPendingApprovals,
  resolveApproval,
  subscribeApprovals,
  type ApprovalDecision,
  type ApprovalRequest,
} from '../lib/mcp-registry'

/**
 * MCP 工具调用的确认弹窗。
 *
 * 同一时刻可能排了好几个请求（模型一轮里连调多次），所以按队列逐个展示。
 * 超时按拒绝处理，避免对话卡死。
 */
export function ApprovalGate() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([])

  useEffect(() => {
    const sync = (): void => setQueue(listPendingApprovals())
    sync()
    return subscribeApprovals(sync)
  }, [])

  const current = queue[0]
  if (current === undefined) return null

  const decide = (decision: ApprovalDecision): void => {
    resolveApproval(current.id, decision)
  }

  const argsText = JSON.stringify(current.args, null, 2)

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card approval-card" role="dialog" aria-modal="true" aria-label="确认工具调用">
        <header className="modal-head">
          <h2>
            <ShieldQuestion size={17} /> 工具请求执行
          </h2>
          {queue.length > 1 && <span className="approval-queue">还有 {queue.length - 1} 个在排队</span>}
        </header>
        <div className="modal-body">
          <p className="approval-what">
            <strong>{current.serverName}</strong> 想调用 <code>{current.toolName}</code>
          </p>
          {current.description !== '' && <p className="approval-desc">{current.description}</p>}
          {current.risk !== '' && (
            <p className="approval-risk">
              <AlertTriangle size={14} /> {current.risk}
            </p>
          )}
          {argsText !== '{}' && (
            <>
              <span className="approval-label">它要传的参数</span>
              <pre className="approval-args">{argsText}</pre>
            </>
          )}
          <p className="settings-hint">
            不确定就选「拒绝」。它会收到一条「用户拒绝了」，不会重试。
          </p>
        </div>
        <footer className="approval-actions">
          <button type="button" className="ghost-button is-danger" onClick={() => decide('deny')}>
            <X size={15} /> 拒绝
          </button>
          <button type="button" className="ghost-button" onClick={() => decide('allow')}>
            <ShieldCheck size={15} /> 允许一次
          </button>
          <button type="button" className="primary-button" onClick={() => decide('allow_always')}>
            总是允许 {current.toolName}
          </button>
        </footer>
      </div>
    </div>
  )
}