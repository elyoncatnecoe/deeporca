/**
 * 取消与超时的小工具。
 *
 * 为什么不用 AbortSignal.timeout / AbortSignal.any：Android 上的老 WebView 没有
 * 它们（我们的最低目标是 Chromium 87），而且超时之后要能跟用户说一句人话，
 * 所以这里自己记一下「到底是谁断的」。
 */

export interface LinkedAbort {
  /** 合成了「外部取消 + 超时」的信号，直接传给 fetch。 */
  signal: AbortSignal
  /** 是不是被超时断的（而不是用户按了停止）。 */
  timedOut: () => boolean
  /** 用完必须调，否则定时器和监听器会留着。 */
  dispose: () => void
}

/** 把「用户按停止」和「等太久了」合成一个信号。 */
export function linkAbort(signal: AbortSignal | undefined, timeoutMs: number): LinkedAbort {
  const controller = new AbortController()
  let timeoutHit = false
  const timer = setTimeout(() => {
    timeoutHit = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => controller.abort()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timeoutHit,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * 让「没有 signal 参数」的 Promise（典型是 IPC / 原生插件往返）也能被取消。
 *
 * 注意：这只会让渲染进程不再干等；对面（主进程、Java 侧）该收尾的还得自己收，
 * 所以调用方通常还要顺手通知对面一声「我不要了」。
 */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(new Error('已停止'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('已停止'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}