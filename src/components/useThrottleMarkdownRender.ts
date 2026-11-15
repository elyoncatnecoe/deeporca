import { useEffect, useRef, useState } from 'react'

/** 两次更新的最长间隔（毫秒）。 */
export const MARKDOWN_MAX_WAIT_MS = 2000
/** 上一次渲染耗时的倍数：渲染越慢，下一次允许更新得越晚。 */
export const MARKDOWN_TIME_RATE = 2

/**
 * 计算「下一次允许更新的时间点」。
 *
 * 流式输出时每来一个 token 就全量重排 Markdown + 重新做代码高亮，长回答在低端机
 * （例如 Android WebView 91）会持续掉帧。这里按上一次渲染的耗时自适应节流：
 * 渲染一次花了 T 毫秒，就至少等 T×RATE 毫秒再渲染下一次，封顶 MAX_WAIT。
 *
 * 抽成纯函数是为了能单测（用例见 test/markdown-throttle.test.ts）；把它删掉或
 * 改坏，测试应当立刻变红。
 */
export function nextUpdatableAt(renderStartedAt: number, renderFinishedAt: number): number {
  const elapsed = Math.max(0, renderFinishedAt - renderStartedAt)
  return renderFinishedAt + Math.min(MARKDOWN_MAX_WAIT_MS, elapsed * MARKDOWN_TIME_RATE)
}

/**
 * 流式过程中按渲染耗时节流 Markdown 内容（参考 deepseek-ai/chat-demo 的
 * `useThrottleMarkdownRender`）。
 *
 * 连续到达的内容会合并成「最新内容」在到期时渲染一次，中间帧不渲染。`enable`
 * 为 false（非流式：历史消息、最终状态）时**直接返回最新内容**，不做任何延迟。
 */
export function useThrottleMarkdownRender(content: string, enable: boolean): string {
  // 首次渲染从挂载时开始计时。
  const startRef = useRef(performance.now())
  const updatableAtRef = useRef(0)
  const [output, setOutput] = useState(content)

  useEffect(() => {
    // 这次 output 已经渲染完成：记录下一次允许更新的时间点。
    updatableAtRef.current = nextUpdatableAt(startRef.current, performance.now())
  }, [output])

  useEffect(() => {
    if (!enable) {
      return
    }
    const update = (): void => {
      startRef.current = performance.now()
      setOutput(content)
    }
    const delay = updatableAtRef.current - performance.now()
    if (delay <= 0) {
      update()
      return
    }
    const timer = setTimeout(update, delay)
    return () => clearTimeout(timer)
  }, [content, enable])

  return enable ? output : content
}
