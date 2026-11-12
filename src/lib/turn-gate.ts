/**
 * 「一轮发送」的占位与释放。
 *
 * 抽成独立模块有两个原因：
 *   1. busy / activeAbort 这对状态以前是 engine 里的两个散变量，谁都能改，
 *      于是出过「检查与置位之间夹 await → 双击开两轮」「旧轮 finally 清掉新轮
 *      controller → 新轮停不下来」（BUG-REVIEW T-08）；
 *   2. engine.ts 依赖 IndexedDB 与 Capacitor，node 里跑不起来，**没法写行为测试**。
 *      把这段纯状态机搬出来后，占位/释放/归属判断都能拿真实异步跑一遍。
 *
 * 语义就三条：
 *   - `begin()`：已经有一轮在跑就返回 null；否则**同步**占位并建这一轮的 controller。
 *   - `end(turn)`：只有这一轮仍然是当前轮才复位，返回 true；旧轮晚到的收尾返回 false，
 *     一个字段都不许动。
 *   - `abortCurrent()`：给「停止」按钮用；没有活动请求时返回 false，由调用方走兜底。
 */

export interface Turn {
  abort: AbortController
}

export interface TurnGate {
  /** 占住「正在发送」。返回 null 表示已经有一轮在跑。 */
  begin: () => Turn | null
  /** 只在这一轮仍然是当前轮时复位；返回 true 表示确实复位了。 */
  end: (turn: Turn) => boolean
  isBusy: () => boolean
  current: () => AbortController | null
  /** 中止当前这一轮。返回 false 表示当前没有活动请求。 */
  abortCurrent: () => boolean
  /** 兜底强制复位（停止键在没有活动请求时被按到）。 */
  reset: () => void
}

export function createTurnGate(): TurnGate {
  let activeAbort: AbortController | null = null
  let busy = false

  return {
    begin(): Turn | null {
      if (busy) return null
      busy = true
      const abort = new AbortController()
      activeAbort = abort
      return { abort }
    },

    end(turn: Turn): boolean {
      // 归属判断：旧轮晚到的 finally 不许把新轮的 controller 清成 null。
      if (activeAbort !== turn.abort) return false
      activeAbort = null
      busy = false
      return true
    },

    isBusy(): boolean {
      return busy
    },

    current(): AbortController | null {
      return activeAbort
    },

    abortCurrent(): boolean {
      if (activeAbort === null) return false
      activeAbort.abort()
      return true
    },

    reset(): void {
      activeAbort = null
      busy = false
    },
  }
}
