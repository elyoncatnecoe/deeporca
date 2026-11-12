import { ensureWebChatLogin } from './web-login-step.ts'
import type { Turn } from './turn-gate.ts'

/**
 * 一轮「单聊发送」的业务编排。
 *
 * 为什么单独有这个文件：`engine.ts` 依赖 IndexedDB 与 Capacitor，node 里根本跑不起来，
 * 于是前两轮的测试只能在测试文件里**自己实现一遍**发送流程，再拿它当「集成测试」——
 * 那种测试证明的是测试代码，不是生产代码。三审直接点破了这一点。
 *
 * 所以把「占位 → 准备（本地指令 / 离线回复 / 网页登录）→ 取消闸门 → 提交」这条
 * 真实业务链抽出来：生产代码（engine.sendMessage）和测试调用的是**同一个函数**，
 * 区别只在注入的依赖 —— 生产注入真实的 store / 网络调用，测试注入假的并记录副作用。
 *
 * 取消语义（三审 P1）：
 *   - `webChatReady()` 等待期间被取消 → 不再发起登录；
 *   - `loginWebChat()` 等待期间被取消 → 不再继续发送；
 *   - 进入 `commit()`（建会话 / 落库 / onAccepted / 起模型请求）之前还有一道闸；
 *   - 取消**不是失败**：不调 notify，不弹任何错误提示。
 *
 * 释放：无论成功、失败、异常还是取消，都只由本函数的 `finally` 负责，
 * 且 `end()`（engine 传的是 endTurn）带归属判断 —— 旧轮晚到的收尾不会动新轮的 controller。
 */

export interface RunSendDeps {
  /** 占位（engine 传 beginTurn）。返回 null 表示已经有一轮在跑。 */
  begin: () => Turn | null
  /** 释放（engine 传 endTurn，里面带归属判断与 turnNodeId 清理）。 */
  end: (turn: Turn) => void

  /** 本地指令（「转个圈」这类）。返回 true 表示这一轮已经被本地处理完。 */
  runLocalCommand: (signal: AbortSignal) => Promise<boolean>
  /** 没接 Key 时的本地回复。 */
  runOfflineReply: (signal: AbortSignal) => Promise<boolean>
  hasApiKey: boolean
  isWebChatProvider: boolean
  webChatReady: () => Promise<boolean>
  loginWebChat: () => Promise<{ ok: boolean; message?: string }>

  /** 给用户看的提示（登录失败、刚登录成功等）。 */
  notify: (message: string) => void

  /**
   * 真正落库并开始生成：建会话、写用户消息、触发 onAccepted、启动模型请求。
   * 返回「用户消息是否已落库」（决定输入框要不要清空）。
   */
  commit: (turn: Turn) => Promise<boolean>

  /** 不管成败都要做的界面收尾（setSending(false) / endLive()）。 */
  settle: () => void
}

export interface SendOutcome {
  /** 有没有抢到这一轮（false = 已经有一轮在跑）。 */
  started: boolean
  /** 用户消息是否已落库。 */
  accepted: boolean
  /** 这一轮是不是因为用户点了停止而结束的。 */
  cancelled: boolean
}

const CANCELLED: SendOutcome = { started: true, accepted: false, cancelled: true }

export async function runSend(deps: RunSendDeps): Promise<SendOutcome> {
  const turn = deps.begin()
  if (turn === null) return { started: false, accepted: false, cancelled: false }
  const signal = turn.abort.signal

  try {
    // ---- 准备阶段 ----

    // 本地指令：认出来就当场做完，不碰 API。
    if (await deps.runLocalCommand(signal)) {
      return { started: true, accepted: true, cancelled: signal.aborted }
    }
    // 本地指令执行期间也可能被停掉。
    if (signal.aborted) return CANCELLED

    // 没接 Key：消息照常落库，回一句本地短话。
    if (!deps.hasApiKey) {
      const accepted = await deps.runOfflineReply(signal)
      return { started: true, accepted, cancelled: signal.aborted }
    }

    // 网页账号：先确认登录态。两个 await 之后都由 ensureWebChatLogin 复查 signal。
    if (deps.isWebChatProvider) {
      const outcome = await ensureWebChatLogin({
        signal,
        webChatReady: deps.webChatReady,
        loginWebChat: deps.loginWebChat,
      })
      if (outcome.kind === 'cancelled') return CANCELLED
      if (outcome.kind === 'blocked') {
        // 这是真的失败（登录没成），要说原因；和「取消」不是一回事。
        deps.notify(outcome.message)
        return { started: true, accepted: false, cancelled: false }
      }
      if (outcome.justLoggedIn) deps.notify('网页账号已连接；以后不用再登录了')
    }

    /*
     * 提交前的最后一道闸。
     *
     * 走到这里说明准备阶段都过了；但用户可能就在最后一刻按了停止。
     * 过了这道闸才允许建会话 / 写用户消息 / 触发 onAccepted / 起模型请求 ——
     * 这四条副作用一旦发生，用户看到的就是「明明点了停止，消息还是发出去了」。
     */
    if (signal.aborted) return CANCELLED

    const accepted = await deps.commit(turn)
    return { started: true, accepted, cancelled: signal.aborted }
  } finally {
    deps.end(turn)
    deps.settle()
  }
}
