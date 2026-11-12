/**
 * 「发送之后要不要清空输入框」的决策器。
 *
 * 背景有两层：
 *   1. UI 反馈 #4 —— 以前等 `await sendMessage()` 返回才清空，而它内部要等整轮回复
 *      生成完，于是「正在回应」的整段时间输入框都留着刚发出去的那句话；
 *   2. 审查意见 P1 —— 改成 onAccepted 之后，`send()` 结尾那句兜底清空仍然会执行，
 *      用户在生成期间重新敲了**一模一样**的文本时，兜底会把这份新输入误删。
 *
 * 规则（与审查意见逐条对应）：
 *   - `onAccepted()` 是「主清空」，由 engine 在用户消息落库那一刻调用；
 *   - 主清空**只要触发过**就记下来，不管当时有没有真的清（输入框可能已被改动），
 *     发送结束时都**不再**兜底 —— 这就是 P1-1/P1-2/P1-3；
 *   - `settle()` 的兜底只服务「即时成功」路径（本地指令 / 离线回复），它们不会触发
 *     onAccepted —— 这就是 P1-4；
 *   - 任何一次清空都要求「文本与附件都还是发送时那份」，避免误删用户新加的东西。
 *
 * 这里刻意做成纯逻辑 + 注入读写，不碰 React：只有这样才能写真正的异步行为测试
 * （发送 → 回调清空 → 用户重新输入 → 发送结束），而不是又去断言源码结构。
 */

export interface ComposerSnapshot {
  /** 输入框里的文本（已 trim，和 Chat 里的判定口径一致）。 */
  text: string
  /** 当前附件个数。 */
  attachments: number
}

export interface ComposerClearOptions {
  /** 点击发送那一刻的快照。 */
  sent: ComposerSnapshot
  /** 读「此刻」的输入框与附件数。必须读实时值，不能用渲染时闭包里的那份。 */
  read: () => ComposerSnapshot
  /** 真正执行清空（清文本 + 清附件 + 贴底）。 */
  clear: () => void
}

export interface ComposerClearHandle {
  /** engine 回调：用户消息已经落库。 */
  onAccepted: () => void
  /** `sendMessage()` / `sendGroupMessage()` 返回之后调用。 */
  settle: (accepted: boolean) => void
  /** 主清空是否触发过（测试与调试用）。 */
  acceptedFired: () => boolean
}

export function createComposerClear(options: ComposerClearOptions): ComposerClearHandle {
  let fired = false

  const attempt = (): void => {
    const now = options.read()
    if (now.text !== options.sent.text) return
    if (now.attachments !== options.sent.attachments) return
    options.clear()
  }

  return {
    onAccepted(): void {
      /*
       * 先置位、再判断。
       *
       * 顺序很重要：如果这一秒输入框已经被用户改过（本次不清），
       * 但标记仍然要落下 —— 否则 settle 会在生成结束时再试一次，
       * 那时用户新敲的字正好和上一条相同的话，就会被删掉（审查意见 P1-3）。
       */
      fired = true
      attempt()
    },
    settle(accepted: boolean): void {
      // 主清空已经走过这条路，兜底不许再插手（P1-2）。
      if (fired) return
      // 没被接受（没落库）就没什么可清的。
      if (!accepted) return
      attempt()
    },
    acceptedFired(): boolean {
      return fired
    },
  }
}
