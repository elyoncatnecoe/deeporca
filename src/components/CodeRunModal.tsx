import { useEffect, useRef, useState } from 'react'
import { Play, RotateCw } from 'lucide-react'
import { Modal } from './ui'
import { sandboxUrl } from '../lib/sandbox'

/** 沙箱里跑多久算超时。到点直接卸载 iframe，脚本跟着一起死。 */
const RUN_TIMEOUT_MS = 4000
/**
 * ES module 代码要联网拉依赖（three.js 这类），4 秒根本不够下载 + 求值，
 * 单独给一个更长的上限。
 */
const RUN_TIMEOUT_MODULE_MS = 12000

/** 和沙箱页里 looksLikeModule 保持同一套判据。 */
function looksLikeModule(code: string): boolean {
  return /(^|\n)\s*(import\s|export\s)/.test(code)
}

/**
 * 「运行代码」。
 *
 * 以前 JS 分支是 `new Worker(blobURL)`：Worker 继承应用**同源**，里面能开
 * indexedDB、读 localStorage、同源 fetch —— 一段代码就能把全部对话/记忆/工坊
 * 读走再发出去，而界面还写着「不会读取你的 API Key 或文件」（BUG-REVIEW P0-4）。
 *
 * 现在统一跑在 `sandbox="allow-scripts"`（**不给** allow-same-origin）的 iframe 里：
 * 它是不透明源，拿不到本站的存储与 Cookie，也摸不到父页面。
 * 代码通过 postMessage 送进去，日志通过 postMessage 送回来；超时就卸载 iframe。
 */
export function CodeRunModal(props: {
  code: string
  lang: string
  open: boolean
  onClose: () => void
}) {
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  /** 非 null 表示 JS 沙箱 iframe 正在挂着；seq 变化会强制重载它。 */
  const [run, setRun] = useState<{ seq: number; code: string } | null>(null)
  /** 同上，HTML 预览用。 */
  const [preview, setPreview] = useState<{ seq: number; html: string } | null>(null)
  const jsFrameRef = useRef<HTMLIFrameElement | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const isHtml = props.lang === 'html'

  function stopTimer(): void {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = undefined
  }

  /** 收工：停表、卸载 iframe（等于掐掉还在跑的脚本）。 */
  function finish(text: string): void {
    stopTimer()
    setRunning(false)
    setRun(null)
    setOutput(text)
  }

  function runJs(): void {
    stopTimer()
    setRunning(true)
    setOutput('')
    setRun((previous) => ({ seq: (previous?.seq ?? 0) + 1, code: props.code }))
    const limit = looksLikeModule(props.code) ? RUN_TIMEOUT_MODULE_MS : RUN_TIMEOUT_MS
    timerRef.current = window.setTimeout(() => {
      finish(`⏱ 运行超过 ${Math.round(limit / 1000)} 秒，已停止`)
    }, limit)
  }

  useEffect(() => {
    if (!props.open) {
      stopTimer()
      setRun(null)
      setPreview(null)
      setRunning(false)
      return
    }
    if (isHtml) {
      setPreview((previous) => ({ seq: (previous?.seq ?? 0) + 1, html: props.code }))
      return
    }
    runJs()
    return () => {
      stopTimer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.code, props.lang])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { deepseaRunLogs?: unknown } | null
      if (typeof data !== 'object' || data === null || data.deepseaRunLogs === undefined) return
      // 只认自己那个沙箱发回来的日志，别被页面里别的 frame 冒名。
      const current = jsFrameRef.current
      if (current !== null && event.source !== current.contentWindow) return
      const logs = Array.isArray(data.deepseaRunLogs)
        ? data.deepseaRunLogs.filter((item): item is string => typeof item === 'string')
        : []
      finish(logs.length === 0 ? '（没有输出）' : logs.join('\n'))
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      stopTimer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const frameUrl = sandboxUrl()

  return (
    <Modal open={props.open} onClose={props.onClose} title={isHtml ? '运行 HTML' : '运行 JavaScript'} wide>
      {isHtml ? (
        <>
          {preview !== null && (
            <iframe
              key={preview.seq}
              className="run-frame"
              title="预览"
              // 不给 allow-same-origin：预览页是不透明源，读不到 App 的数据。
              sandbox="allow-scripts allow-forms allow-modals"
              src={frameUrl}
              onLoad={(event) => {
                // 文档自己的脚本已经跑完了，这时候把 HTML 送进去最稳。
                event.currentTarget.contentWindow?.postMessage({ deepseaRunHtml: preview.html }, '*')
              }}
            />
          )}
        </>
      ) : (
        <>
          <div className="run-toolbar">
            <span>{running ? '运行中…' : '输出'}</span>
            <button type="button" className="ghost-button" onClick={runJs} disabled={running}>
              <RotateCw size={15} />
              再运行
            </button>
          </div>
          <pre className="run-output">{output}</pre>
          {run !== null && (
            <iframe
              key={run.seq}
              ref={jsFrameRef}
              title="运行沙箱"
              sandbox="allow-scripts"
              src={frameUrl}
              style={{ display: 'none' }}
              onLoad={(event) => {
                event.currentTarget.contentWindow?.postMessage({ deepseaRunJs: run.code }, '*')
              }}
            />
          )}
        </>
      )}
      <p className="run-hint">
        <Play size={13} /> 代码跑在一个独立沙箱里：读不到 App 的对话、记忆和 API Key，只能访问网络。
      </p>
    </Modal>
  )
}