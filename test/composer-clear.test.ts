import test from 'node:test'
import assert from 'node:assert/strict'
import { createComposerClear } from '../src/lib/composer-clear.ts'

/**
 * 「发送后清空输入框」的行为测试（审查意见 P1）。
 *
 * 这里是**真的跑异步时序**，不是断言源码结构：
 * 发送 → engine 回调清空 → 用户趁生成期间重新输入 → 发送结束。
 * 之前那条 P1 的 bug 就是「发送结束时的兜底又清了一次」，把用户新输入抹掉。
 */

interface Harness {
  state: { text: string; attachments: number }
  handle: ReturnType<typeof createComposerClear>
  clearCount: () => number
  /** 用户敲字（模拟 input 事件） */
  type: (text: string) => void
  /** 用户重新加附件 */
  attach: (count: number) => void
  /** 让出事件循环，模拟「生成正在进行」 */
  tick: () => Promise<void>
}

function setup(sentText: string, sentAttachments = 0): Harness {
  const state = { text: sentText, attachments: sentAttachments }
  let clears = 0
  const handle = createComposerClear({
    sent: { text: sentText, attachments: sentAttachments },
    read: () => ({ text: state.text, attachments: state.attachments }),
    clear: () => {
      clears += 1
      state.text = ''
      state.attachments = 0
    },
  })
  return {
    state,
    handle,
    clearCount: () => clears,
    type: (text: string) => {
      state.text = text
    },
    attach: (count: number) => {
      state.attachments = count
    },
    tick: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
  }
}

/* ------------------------------------------------------------------ */
/* 主路径：onAccepted 立刻清空                                          */
/* ------------------------------------------------------------------ */

test('P1：用户消息落库那一刻清空输入框（UI 反馈 #4 的主路径）', async () => {
  const h = setup('你好')
  h.handle.onAccepted()
  assert.equal(h.state.text, '', '落库后应当立刻清空，而不是等整轮生成结束')
  assert.equal(h.clearCount(), 1)
  assert.equal(h.handle.acceptedFired(), true)
})

/* ------------------------------------------------------------------ */
/* 核心回归：回调之后不许再兜底清一次                                    */
/* ------------------------------------------------------------------ */

test('P1：生成期间重新输入同样的文本，发送结束后必须保留', async () => {
  const h = setup('你好')

  // 1) 用户消息落库 → engine 回调 → 输入框清空
  h.handle.onAccepted()
  assert.equal(h.state.text, '')

  // 2) 生成还在跑，用户又敲了一模一样的一句话
  await h.tick()
  h.type('你好')

  // 3) 整轮生成结束，sendMessage 返回
  await h.tick()
  h.handle.settle(true)

  assert.equal(h.state.text, '你好', '兜底清空不许再执行 —— 否则这里会被误删')
  assert.equal(h.clearCount(), 1, '整轮只该清一次')
})

test('P1：回调时输入框已被改动，后续也不许再尝试清空', async () => {
  const h = setup('你好')

  // 用户在回调之前就抢先输入了新内容
  h.type('新的一段')
  h.handle.onAccepted()
  assert.equal(h.state.text, '新的一段', '内容不一致就不该清')
  assert.equal(h.clearCount(), 0)

  // 之后用户又把内容改回和上一条相同 —— 也不许清（标记已经落下）
  h.type('你好')
  await h.tick()
  h.handle.settle(true)
  assert.equal(h.state.text, '你好', 'settle 不能因为「现在内容又对上了」就补一刀')
  assert.equal(h.clearCount(), 0)
})

test('P1：没触发 onAccepted 时，兜底只对「即时成功」路径生效', async () => {
  // 本地指令 / 离线回复：不走 onAccepted，但 accepted=true
  const h = setup('转个圈')
  h.handle.settle(true)
  assert.equal(h.state.text, '', '即时成功路径要由兜底清空')
  assert.equal(h.clearCount(), 1)
})

test('P1：没被接受（accepted=false）时不清空', async () => {
  const h = setup('你好')
  h.handle.settle(false)
  assert.equal(h.state.text, '你好', '没落库就说明没发出去，输入必须留着')
  assert.equal(h.clearCount(), 0)
})

/* ------------------------------------------------------------------ */
/* 附件：旧轮结束不许清掉新附件                                          */
/* ------------------------------------------------------------------ */

test('P1：生成期间重新添加的附件，不会被旧轮结束清掉', async () => {
  const h = setup('你好')
  h.handle.onAccepted()
  assert.equal(h.state.attachments, 0)

  // 用户在生成期间又挂了一张图
  await h.tick()
  h.attach(1)
  h.type('你好')

  await h.tick()
  h.handle.settle(true)

  assert.equal(h.state.attachments, 1, '新附件必须留着')
  assert.equal(h.state.text, '你好')
})

test('P1：兜底路径下附件数变了也不清（避免误删新附件）', async () => {
  const h = setup('你好')
  // 即时成功路径（没触发 onAccepted），但用户在结束前又加了附件
  h.attach(1)
  h.handle.settle(true)
  assert.equal(h.state.attachments, 1, '附件对不上就不该清')
  assert.equal(h.clearCount(), 0)
})

test('P1：兜底路径下文本没变、附件没变，照常清空', async () => {
  const h = setup('你好')
  h.handle.settle(true)
  assert.equal(h.state.text, '')
  assert.equal(h.state.attachments, 0)
  assert.equal(h.clearCount(), 1)
})
