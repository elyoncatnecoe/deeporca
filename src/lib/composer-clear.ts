/**
 * 「发送之后要不要清空输入框」的决策器。
 *
 * 背景有三层：
 *   1. UI 反馈 #4 —— 以前等 `await sendMessage()` 返回才清空，而它内部要等整轮回复
 *      生成完，于是「正在回应」的整段时间输入框都留着刚发出去的那句话；
 *   2. 审查意见 P1（一审）—— 改成 onAccepted 之后，`send()` 结尾那句兜底清空仍然会
 *      执行，用户在生成期间重新敲了**一模一样**的文本时，兜底会把这份新输入误删；
 *   3. 审查意见 P1（二审）—— 只比附件**数量**不够：发送时挂图片 A，落库前删掉 A
 *      换成 B，数量仍是 1，会被误判成「没变」，把 B 一起清掉。
 *
 * 规则：
 *   - `onAccepted()` 是「主清空」，由 engine 在用户消息落库那一刻调用；
 *   - 主清空**只要触发过**就记下来，不管当时有没有真的清（输入框可能已被改动），
 *     发送结束时都**不再**兜底；
 *   - `settle()` 的兜底只服务「即时成功」路径（本地指令 / 离线回复），它们不会触发
 *     onAccepted；
 *   - 任何一次清空都要求「文本一致 + 附件身份列表逐项一致」。
 *
 * 附件身份用的是 `Attachment.id`（`src/lib/types.ts` 里本来就有，创建附件时生成，
 * 整个生命周期不变），不是数量、不是文件名、也不是数组下标 —— 后三者都会在
 * 「删一张再添一张」时撞车。
 *
 * 这里刻意做成纯逻辑 + 注入读写，不碰 React：只有这样才能写真正的异步行为测试
 * （发送 → 回调清空 → 用户重新输入 / 换附件 → 发送结束），而不是又去断言源码结构。
 */

export interface ComposerSnapshot {
  /** 输入框里的文本（已 trim，和 Chat 里的判定口径一致）。 */
  text: string
  /**
   * 附件身份：**按顺序**的 `Attachment.id` 列表。
   *
   * 顺序敏感是刻意的：`attachments` 数组的顺序就是它们挂到消息上的顺序
   * （界面展示顺序、以及发给模型的 content 顺序都跟着它走）。
   * 两张图对调 = 用户改了这条消息的内容，不能当成「没变」。
   */
  attachmentIds: readonly string[]
}

export interface ComposerClearOptions {
  /** 点击发送那一刻的快照。 */
  sent: ComposerSnapshot
  /** 读「此刻」的输入框与附件身份。必须读实时值，不能用渲染时闭包里的那份。 */
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

/** 逐项比较附件身份。只比长度会把「删 A 换 B」误判成没变。 */
export function sameAttachmentIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function createComposerClear(options: ComposerClearOptions): ComposerClearHandle {
  let fired = false

  const attempt = (): void => {
    const now = options.read()
    if (now.text !== options.sent.text) return
    if (!sameAttachmentIds(now.attachmentIds, options.sent.attachmentIds)) return
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
      // 主清空已经走过这条路，兜底不许再插手。
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
