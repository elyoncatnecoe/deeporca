import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTurnGate } from '../src/lib/turn-gate.ts'
import type { Turn } from '../src/lib/turn-gate.ts'
import { runSend, type RunSendDeps } from '../src/lib/send-orchestrator.ts'

/**
 * 发送取消语义的回归测试 —— 跑的是**生产代码里那一个** runSend。
 *
 * 前两轮的测试在测试文件里自己实现了一遍发送流程（attemptSend），三审指出：
 * 那证明的是测试代码，不是业务接线。所以第三轮把业务编排抽成了
 * `src/lib/send-orchestrator.ts`，engine.sendMessage 直接调它；这里的每一个用例
 * 都是拿假依赖调**同一个** runSend。
 *
 * 关键断言是**副作用**：commit 有没有被调用（它内部才是建会话 / 写用户消息 /
 * onAccepted / 起模型请求），notify 有没有弹提示，而不是只看 turnGate.isBusy()。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 5))

/** commit 内部会做的四件事 —— 用它们代表「消息真的发出去了」。 */
interface CommitEffects {
  createdConversation: number
  appendedUserMessage: number
  accepted: number
  startedGeneration: number
}

interface Harness {
  gate: ReturnType<typeof createTurnGate>
  turns: Turn[]
  effects: CommitEffects
  notices: string[]
  loginCalls: number
  settleCalls: number
  deps: RunSendDeps
}

function harness(overrides: Partial<RunSendDeps> = {}): Harness {
  const gate = createTurnGate()
  const turns: Turn[] = []
  const effects: CommitEffects = {
    createdConversation: 0,
    appendedUserMessage: 0,
    accepted: 0,
    startedGeneration: 0,
  }
  const notices: string[] = []
  const state: Harness = {
    gate,
    turns,
    effects,
    notices,
    loginCalls: 0,
    settleCalls: 0,
    deps: undefined as unknown as RunSendDeps,
  }

  state.deps = {
    begin: () => {
      const turn = gate.begin()
      if (turn !== null) turns.push(turn)
      return turn
    },
    end: (turn) => {
      gate.end(turn)
    },
    runLocalCommand: async () => false,
    runOfflineReply: async () => true,
    hasApiKey: true,
    isWebChatProvider: true,
    webChatReady: async () => true,
    loginWebChat: async () => {
      state.loginCalls += 1
      return { ok: true }
    },
    notify: (message) => {
      notices.push(message)
    },
    commit: async () => {
      // 模拟真实 commit 的副作用顺序：建会话 → 写用户消息 → onAccepted → 起生成
      effects.createdConversation += 1
      effects.appendedUserMessage += 1
      effects.accepted += 1
      effects.startedGeneration += 1
      return true
    },
    settle: () => {
      state.settleCalls += 1
    },
    ...overrides,
  }
  return state
}

function assertNoSendHappened(effects: CommitEffects): void {
  assert.deepEqual(
    effects,
    { createdConversation: 0, appendedUserMessage: 0, accepted: 0, startedGeneration: 0 },
    '取消 / 失败之后不许建会话、写用户消息、触发 onAccepted 或起模型请求',
  )
}

/* ------------------------------------------------------------------ */
/* 正常路径                                                            */
/* ------------------------------------------------------------------ */

test('正常路径：commit 被调用一次，accepted 透传，收尾执行一次', async () => {
  const h = harness()
  const outcome = await runSend(h.deps)

  assert.deepEqual(outcome, { started: true, accepted: true, cancelled: false })
  assert.equal(h.effects.startedGeneration, 1)
  assert.equal(h.settleCalls, 1)
  assert.equal(h.gate.isBusy(), false)
})

test('登录态已就绪时不会多走一次登录', async () => {
  const h = harness({ webChatReady: async () => true })
  await runSend(h.deps)
  assert.equal(h.loginCalls, 0)
  assert.equal(h.effects.startedGeneration, 1)
})

test('登录成功时提示「已连接」，流程继续', async () => {
  const h = harness({ webChatReady: async () => false })
  await runSend(h.deps)
  assert.equal(h.loginCalls, 1)
  assert.deepEqual(h.notices, ['网页账号已连接；以后不用再登录了'])
  assert.equal(h.effects.startedGeneration, 1)
})

/* ------------------------------------------------------------------ */
/* 三审 P1：等待期间取消，不许继续发                                     */
/* ------------------------------------------------------------------ */

test('三审 P1：webChatReady 等待期间被取消 → 不再发起登录，也不发', async () => {
  const ready = deferred<boolean>()
  const h = harness({ webChatReady: () => ready.promise })
  const pending = runSend(h.deps)

  await tick()
  assert.equal(h.gate.isBusy(), true)
  assert.equal(h.gate.abortCurrent(), true, '停止键要能中止这一轮')
  ready.resolve(false)

  const outcome = await pending
  assert.equal(outcome.cancelled, true)
  assert.equal(h.loginCalls, 0, '取消之后不许再弹登录窗')
  assertNoSendHappened(h.effects)
  assert.deepEqual(h.notices, [], '取消不是失败，不许弹错误提示')
  assert.equal(h.gate.isBusy(), false)
})

test('三审 P1：loginWebChat 等待期间被取消 → 登录成功后也不许继续发', async () => {
  const login = deferred<{ ok: boolean }>()
  const h = harness({
    webChatReady: async () => false,
    loginWebChat: () => {
      h.loginCalls += 1
      return login.promise
    },
  })
  const pending = runSend(h.deps)

  await tick()
  assert.equal(h.gate.isBusy(), true)
  assert.equal(h.loginCalls, 1, '登录已经发出去了（原生那边不一定能中断，这是允许的）')
  assert.equal(h.gate.abortCurrent(), true, '用户点了停止')

  // 登录这时才成功返回
  login.resolve({ ok: true })
  const outcome = await pending

  assert.equal(outcome.cancelled, true)
  assert.equal(outcome.accepted, false)
  assertNoSendHappened(h.effects)
  assert.deepEqual(h.notices, [], '取消不是登录失败，不许弹「网页账号还没登录」这类误导提示')
  assert.equal(h.gate.isBusy(), false, '这一轮必须释放')
})

test('三审 P1：本地指令执行期间被取消 → 不进入 commit', async () => {
  const h = harness({
    runLocalCommand: async () => false,
    hasApiKey: false,
    runOfflineReply: async () => true,
  })
  const pending = runSend(h.deps)
  h.gate.abortCurrent()
  const outcome = await pending
  // 离线回复自己会看 signal；这里只确认不会进 commit
  assert.equal(h.effects.startedGeneration, 0)
  assert.equal(outcome.started, true)
})

/* ------------------------------------------------------------------ */
/* 失败路径                                                            */
/* ------------------------------------------------------------------ */

test('登录返回 ok:false：提示原因、正常释放、不发送', async () => {
  const h = harness({
    webChatReady: async () => false,
    loginWebChat: async () => ({ ok: false, message: '登录窗口被关掉了' }),
  })
  const outcome = await runSend(h.deps)

  assert.equal(outcome.accepted, false)
  assert.equal(outcome.cancelled, false)
  assert.deepEqual(h.notices, ['登录窗口被关掉了'])
  assertNoSendHappened(h.effects)
  assert.equal(h.gate.isBusy(), false)
})

test('登录 reject：异常照原样抛出（不被吞），但这一轮仍然释放', async () => {
  const boom = new Error('IPC 断了')
  const h = harness({
    webChatReady: async () => false,
    loginWebChat: async () => {
      throw boom
    },
  })

  await assert.rejects(runSend(h.deps), (error: unknown) => error === boom)
  assertNoSendHappened(h.effects)
  assert.equal(h.gate.isBusy(), false, '异常路径也必须释放，否则发送键永久卡死')
  assert.equal(h.gate.current(), null)
  assert.equal(h.settleCalls, 1)
})

/* ------------------------------------------------------------------ */
/* 取消之后立刻再发 / 归属判断                                          */
/* ------------------------------------------------------------------ */

test('三审 P1：取消之后立刻再发，旧轮收尾不影响新轮', async () => {
  const login = deferred<{ ok: boolean }>()
  const first = harness({
    webChatReady: async () => false,
    loginWebChat: () => login.promise,
  })
  const pending = runSend(first.deps)
  await tick()
  first.gate.abortCurrent()
  login.resolve({ ok: true })
  await pending
  assert.equal(first.gate.isBusy(), false)

  // 同一把 gate 上开第二轮（模拟同一个 engine 模块）
  const secondTurn = first.gate.begin()
  assert.ok(secondTurn !== null, '取消之后必须能立刻再发')

  // 旧轮的收尾（engine 的 endTurn）晚到：不许清新轮
  first.deps.end(first.turns[0]!)
  assert.equal(first.gate.isBusy(), true, '旧轮 finally 不能把新轮状态清掉')
  assert.equal(first.gate.current(), secondTurn?.abort)

  assert.equal(first.gate.end(secondTurn!), true)
  assert.equal(first.gate.isBusy(), false)
})

test('已经有一轮在跑时不会再开一轮', async () => {
  const h = harness()
  const held = h.gate.begin()
  assert.ok(held !== null)
  const outcome = await runSend(h.deps)
  assert.deepEqual(outcome, { started: false, accepted: false, cancelled: false })
  assertNoSendHappened(h.effects)
})

/* ------------------------------------------------------------------ */
/* 接线：engine 真的用的是这个函数                                       */
/* ------------------------------------------------------------------ */

test('接线：sendMessage 调用 runSend，commit 指向真正落库的那个函数', () => {
  const engine = stripComments(read('src/lib/engine.ts'))
  const start = engine.indexOf('export async function sendMessage')
  const end = engine.indexOf('export async function sendGroupMessage', start)
  const body = engine.slice(start, end === -1 ? undefined : end)

  assert.match(body, /await runSend\(\{/, 'sendMessage 必须走 runSend')
  assert.match(body, /begin: beginTurn,/, '占位用 beginTurn')
  assert.match(body, /end: endTurn,/, '释放用 endTurn（带归属判断）')
  assert.match(body, /commit: \(turn\) => runSendCommit\(\{/, 'commit 指向真正落库的那个函数')
  assert.equal((body.match(/endTurn\(turn\)/g) ?? []).length, 0, 'engine 里不许再有零散的 endTurn')
  assert.equal((body.match(/beginTurn\(\)/g) ?? []).length, 0, '占位只由 runSend 负责')

  // 那四条副作用确实在 runSendCommit 里
  const commitStart = engine.indexOf('async function runSendCommit')
  const commitBody = engine.slice(commitStart, engine.indexOf('export async function sendGroupMessage', commitStart))
  assert.match(commitBody, /actions\.createConversation\(\)/, '建会话在 commit 里')
  assert.match(commitBody, /actions\.appendMessage\(userMessage\)/, '写用户消息在 commit 里')
  assert.match(commitBody, /options\.onAccepted\?\.\(\)/, 'onAccepted 在 commit 里')
  assert.match(commitBody, /runAssistantTurn\(/, '起模型请求在 commit 里')
})
