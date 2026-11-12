import test from 'node:test'
import assert from 'node:assert/strict'
import { createComposerClear, sameAttachmentIds } from '../src/lib/composer-clear.ts'

/**
 * 「发送后清空输入框」的行为测试。
 *
 * 一审 P1：发送结束时的兜底又清了一次，把用户重新输入的同样文本抹掉。
 * 二审 P1：只比附件**数量**不够 —— 删掉图 A 换成图 B，数量仍是 1，
 *         会被误判成「没变」，把 B 一起清掉。
 *
 * 这里跑的是真异步时序，不是断言源码结构。
 */

interface Harness {
  state: { text: string; attachmentIds: string[] }
  handle: ReturnType<typeof createComposerClear>
  clearCount: () => number
  /** 用户敲字（模拟 input 事件） */
  type: (text: string) => void
  /** 用户把附件换成这一批（模拟删除 / 新增 / 替换 / 重排） */
  setAttachments: (ids: string[]) => void
  /** 让出事件循环，模拟「生成正在进行」 */
  tick: () => Promise<void>
}

function setup(sentText: string, sentIds: string[] = []): Harness {
  const state = { text: sentText, attachmentIds: [...sentIds] }
  let clears = 0
  const handle = createComposerClear({
    sent: { text: sentText, attachmentIds: sentIds },
    read: () => ({ text: state.text, attachmentIds: state.attachmentIds }),
    clear: () => {
      clears += 1
      state.text = ''
      state.attachmentIds = []
    },
  })
  return {
    state,
    handle,
    clearCount: () => clears,
    type: (text: string) => {
      state.text = text
    },
    setAttachments: (ids: string[]) => {
      state.attachmentIds = [...ids]
    },
    tick: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
  }
}

/* ------------------------------------------------------------------ */
/* 主路径                                                              */
/* ------------------------------------------------------------------ */

test('P1：用户消息落库那一刻清空输入框（UI 反馈 #4 的主路径）', () => {
  const h = setup('你好', ['a'])
  h.handle.onAccepted()
  assert.equal(h.state.text, '', '落库后应当立刻清空，而不是等整轮生成结束')
  assert.deepEqual(h.state.attachmentIds, [], '附件也要跟着清')
  assert.equal(h.clearCount(), 1)
  assert.equal(h.handle.acceptedFired(), true)
})

/* ------------------------------------------------------------------ */
/* 一审回归：回调之后不许再兜底清一次                                    */
/* ------------------------------------------------------------------ */

test('P1：生成期间重新输入同样的文本，发送结束后必须保留', async () => {
  const h = setup('你好')

  h.handle.onAccepted()
  assert.equal(h.state.text, '')

  await h.tick()
  h.type('你好')

  await h.tick()
  h.handle.settle(true)

  assert.equal(h.state.text, '你好', '兜底清空不许再执行 —— 否则这里会被误删')
  assert.equal(h.clearCount(), 1, '整轮只该清一次')
})

test('P1：回调时输入框已被改动，后续也不许再尝试清空', async () => {
  const h = setup('你好')

  h.type('新的一段')
  h.handle.onAccepted()
  assert.equal(h.state.text, '新的一段', '内容不一致就不该清')
  assert.equal(h.clearCount(), 0)

  h.type('你好')
  await h.tick()
  h.handle.settle(true)
  assert.equal(h.state.text, '你好', 'settle 不能因为「现在内容又对上了」就补一刀')
  assert.equal(h.clearCount(), 0)
})

test('P1：没触发 onAccepted 时，兜底只对「即时成功」路径生效', () => {
  const h = setup('转个圈')
  h.handle.settle(true)
  assert.equal(h.state.text, '', '即时成功路径要由兜底清空')
  assert.equal(h.clearCount(), 1)
})

test('P1：没被接受（accepted=false）时不清空', () => {
  const h = setup('你好')
  h.handle.settle(false)
  assert.equal(h.state.text, '你好', '没落库就说明没发出去，输入必须留着')
  assert.equal(h.clearCount(), 0)
})

/* ------------------------------------------------------------------ */
/* 二审 P1：附件身份                                                     */
/* ------------------------------------------------------------------ */

test('二审 P1：删掉 A 换成 B（数量不变）必须保留 B', async () => {
  const h = setup('你好', ['A'])

  // 发送之后、落库之前：用户删掉 A、加进 B
  await h.tick()
  h.setAttachments(['B'])

  h.handle.onAccepted()

  assert.deepEqual(h.state.attachmentIds, ['B'], '数量都是 1，但身份不同 —— B 不能被清掉')
  assert.equal(h.state.text, '你好', '附件没对上时文本也不该清')
  assert.equal(h.clearCount(), 0)
})

test('二审 P1：删掉 A 之后（没有任何附件）必须保留当前状态', async () => {
  const h = setup('你好', ['A'])

  await h.tick()
  h.setAttachments([])

  h.handle.onAccepted()
  assert.deepEqual(h.state.attachmentIds, [], '本来就是空的')
  assert.equal(h.state.text, '你好', '附件列表变了就不该清文本')
  assert.equal(h.clearCount(), 0)
})

test('二审 P1：在 A 之外新增 B 必须保留 B', async () => {
  const h = setup('你好', ['A'])

  await h.tick()
  h.setAttachments(['A', 'B'])

  h.handle.onAccepted()
  assert.deepEqual(h.state.attachmentIds, ['A', 'B'], '新加的 B 不能被清掉')
  assert.equal(h.clearCount(), 0)
})

test('二审 P1：附件完全没变时正常清空', () => {
  const h = setup('你好', ['A', 'B'])
  h.handle.onAccepted()
  assert.equal(h.state.text, '')
  assert.deepEqual(h.state.attachmentIds, [])
  assert.equal(h.clearCount(), 1)
})

test('二审 P1：两张附件交换顺序视为「变了」（顺序就是挂到消息上的顺序）', () => {
  const h = setup('你好', ['A', 'B'])

  h.setAttachments(['B', 'A'])
  h.handle.onAccepted()

  assert.deepEqual(h.state.attachmentIds, ['B', 'A'], '重排是用户改了这条消息，不能当成没变')
  assert.equal(h.clearCount(), 0)
})

test('二审 P1：同一张图重新挂上（id 相同）仍算没变', () => {
  const h = setup('你好', ['A'])
  h.setAttachments(['A'])
  h.handle.onAccepted()
  assert.equal(h.clearCount(), 1, 'id 一致就说明还是那一批，正常清空')
})

test('二审 P1：兜底路径同样按身份判断，数量相同但换过附件也不清', () => {
  const h = setup('你好', ['A'])
  h.setAttachments(['B'])
  h.handle.settle(true)
  assert.deepEqual(h.state.attachmentIds, ['B'])
  assert.equal(h.clearCount(), 0)
})

test('sameAttachmentIds：逐项比较，不是比长度', () => {
  assert.equal(sameAttachmentIds(['A'], ['A']), true)
  assert.equal(sameAttachmentIds(['A'], ['B']), false)
  assert.equal(sameAttachmentIds(['A', 'B'], ['B', 'A']), false, '顺序敏感')
  assert.equal(sameAttachmentIds([], []), true)
  assert.equal(sameAttachmentIds(['A'], ['A', 'B']), false)
  assert.equal(sameAttachmentIds(['A', 'B'], ['A']), false)
})
