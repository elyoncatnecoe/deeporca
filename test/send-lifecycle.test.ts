import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTurnGate } from '../src/lib/turn-gate.ts'
import { DEFAULT_LOGIN_HINT, ensureWebChatLogin } from '../src/lib/web-login-step.ts'

/**
 * 发送生命周期：占位 → 准备（含网页登录）→ 释放。
 *
 * 二审 P1 报的是：`await loginWebChat()` 没有异常保护，它 reject 之后 `endTurn`
 * 轮不到执行，`busy` 永远停在 true，发送键卡成「停止」，只能重启进程。
 *
 * engine.ts 依赖 IndexedDB 与 Capacitor，node 里跑不起来，所以把这段状态机拆成了
 * 两个模块（`src/lib/turn-gate.ts` / `src/lib/web-login-step.ts`），这里用**真实异步**
 * 跑一遍：断言的是 gate 的实际状态（isBusy / current），不是源码字符串。
 *
 * sendMessage 本身与这两个模块的接线（只有一个 try/finally、endTurn 只在 finally 里）
 * 由本文件最后一条结构断言守着 —— 那条是补充，不是替代。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

/** 去掉注释再数，免得注释里提到的 beginTurn() / endTurn() 被算进去。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

interface SendOptions {
  webChatReady?: () => Promise<boolean>
  loginWebChat?: () => Promise<{ ok: boolean; message?: string }>
  /** 准备阶段跑完之后、释放之前要做的额外动作（模拟取消等） */
  during?: (signal: AbortSignal) => Promise<void>
}

type SendResult =
  | { started: false; outcome: 'busy' }
  | { started: true; outcome: 'ready'; justLoggedIn: boolean }
  | { started: true; outcome: 'blocked'; message: string }

/**
 * 按 sendMessage 现在的顺序跑一轮：先 begin，准备阶段放在同一个 try 里，
 * 释放只由 finally 负责。prepare 抛错时不吞，直接往外冒。
 */
async function attemptSend(
  gate: ReturnType<typeof createTurnGate>,
  options: SendOptions = {},
): Promise<SendResult> {
  const turn = gate.begin()
  if (turn === null) return { started: false, outcome: 'busy' }
  try {
    const outcome = await ensureWebChatLogin({
      webChatReady: options.webChatReady ?? (async () => true),
      loginWebChat: options.loginWebChat ?? (async () => ({ ok: true })),
    })
    if (outcome.kind === 'blocked') {
      return { started: true, outcome: 'blocked', message: outcome.message }
    }
    if (options.during !== undefined) await options.during(turn.abort.signal)
    return { started: true, outcome: 'ready', justLoggedIn: outcome.justLoggedIn }
  } finally {
    gate.end(turn)
  }
}

/* ------------------------------------------------------------------ */
/* 1. 登录已就绪：不触发登录，流程继续                                   */
/* ------------------------------------------------------------------ */

test('P1：登录态已就绪时不会多走一次登录，流程继续', async () => {
  const gate = createTurnGate()
  let loginCalls = 0
  const result = await attemptSend(gate, {
    webChatReady: async () => true,
    loginWebChat: async () => {
      loginCalls += 1
      return { ok: true }
    },
  })

  assert.deepEqual(result, { started: true, outcome: 'ready', justLoggedIn: false })
  assert.equal(loginCalls, 0, '已经就绪就不该再弹登录')
  assert.equal(gate.isBusy(), false, '跑完必须释放')
})

/* ------------------------------------------------------------------ */
/* 2. 登录成功：流程继续                                               */
/* ------------------------------------------------------------------ */

test('P1：登录成功后流程继续，并标记「刚登录」', async () => {
  const gate = createTurnGate()
  const result = await attemptSend(gate, {
    webChatReady: async () => false,
    loginWebChat: async () => ({ ok: true }),
  })

  assert.deepEqual(result, { started: true, outcome: 'ready', justLoggedIn: true })
  assert.equal(gate.isBusy(), false)
})

/* ------------------------------------------------------------------ */
/* 3. 登录返回 ok:false：释放 busy，返回失败                            */
/* ------------------------------------------------------------------ */

test('P1：登录返回 ok:false 时正常释放 busy，并把原因带回去', async () => {
  const gate = createTurnGate()
  const result = await attemptSend(gate, {
    webChatReady: async () => false,
    loginWebChat: async () => ({ ok: false, message: '登录窗口被关掉了' }),
  })

  assert.equal(result.outcome, 'blocked')
  assert.equal((result as { message: string }).message, '登录窗口被关掉了')
  assert.equal(gate.isBusy(), false, '没登录成也要释放，否则发送键卡死')
})

test('P1：登录失败但对方没给原因时用默认文案', async () => {
  const gate = createTurnGate()
  const result = await attemptSend(gate, {
    webChatReady: async () => false,
    loginWebChat: async () => ({ ok: false }),
  })
  assert.equal((result as { message: string }).message, DEFAULT_LOGIN_HINT)
})

/* ------------------------------------------------------------------ */
/* 4. 登录 reject：异常路径也释放 busy                                  */
/* ------------------------------------------------------------------ */

test('P1：loginWebChat reject 时异常照原样抛出，但 busy 仍然释放', async () => {
  const gate = createTurnGate()
  const boom = new Error('IPC 断了')

  await assert.rejects(
    attemptSend(gate, {
      webChatReady: async () => false,
      loginWebChat: async () => {
        throw boom
      },
    }),
    (error: unknown) => error === boom,
    '异常不能被吞掉，调用方要能拿到原始错误',
  )

  assert.equal(gate.isBusy(), false, '这就是二审报的 bug：异常路径不释放，发送键永久卡死')
  assert.equal(gate.current(), null)
})

test('P1：webChatReady reject 同样释放 busy', async () => {
  const gate = createTurnGate()
  await assert.rejects(
    attemptSend(gate, {
      webChatReady: async () => {
        throw new Error('bridge 未就绪')
      },
    }),
  )
  assert.equal(gate.isBusy(), false)
})

/* ------------------------------------------------------------------ */
/* 5. 登录期间触发取消                                                 */
/* ------------------------------------------------------------------ */

/** 手动控制何时 resolve 的 promise，用来卡住「登录进行中」这个状态。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

test('P1：登录进行中被「停止」，不遗留 busy，也不误清下一轮', async () => {
  const gate = createTurnGate()
  const login = deferred<{ ok: boolean }>()

  const pending = attemptSend(gate, {
    webChatReady: async () => false,
    loginWebChat: () => login.promise,
  })

  // 登录还挂着：这一轮应当占着 busy，并且能被「停止」拿到 signal
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(gate.isBusy(), true)
  assert.equal(gate.abortCurrent(), true, '停止键要能中止登录中的这一轮')

  // 登录这时才返回；因为已经 abort，调用方会拿到结果并走 finally
  login.resolve({ ok: true })
  const result = await pending
  assert.equal(result.started, true)
  assert.equal(gate.isBusy(), false, '取消之后也必须释放')

  // 新一轮可以立刻开始，而且旧轮的 finally 不会把它清掉
  const second = gate.begin()
  assert.ok(second !== null)
  assert.equal(gate.current(), second?.abort)
})

/* ------------------------------------------------------------------ */
/* 6. 登录异常后立即再发：第二轮可以正常启动                             */
/* ------------------------------------------------------------------ */

test('P1：登录异常之后立刻再发，第二轮能正常占位并跑完', async () => {
  const gate = createTurnGate()

  await assert.rejects(
    attemptSend(gate, {
      webChatReady: async () => false,
      loginWebChat: async () => {
        throw new Error('第一次炸了')
      },
    }),
  )

  const second = await attemptSend(gate, {
    webChatReady: async () => false,
    loginWebChat: async () => ({ ok: true }),
  })

  assert.deepEqual(second, { started: true, outcome: 'ready', justLoggedIn: true })
  assert.equal(gate.isBusy(), false)
})

/* ------------------------------------------------------------------ */
/* 7. 归属判断：旧轮晚到的 finally 不许动新轮                            */
/* ------------------------------------------------------------------ */

test('P1：旧轮 finally 晚到时不清理新轮的 controller', () => {
  const gate = createTurnGate()
  const first = gate.begin()
  assert.ok(first !== null)

  // 模拟「上一轮被兜底复位之后，新一轮已经起来了」
  gate.reset()
  const second = gate.begin()
  assert.ok(second !== null)
  assert.notEqual(second?.abort, first?.abort)

  // 旧轮现在才收尾
  const released = gate.end(first!)
  assert.equal(released, false, '旧轮不该被当成当前轮')
  assert.equal(gate.isBusy(), true, '新一轮还在跑，busy 不能被旧轮清掉')
  assert.equal(gate.current(), second?.abort)

  // 新轮自己收尾才生效
  assert.equal(gate.end(second!), true)
  assert.equal(gate.isBusy(), false)
})

/* ------------------------------------------------------------------ */
/* 8. 接线：sendMessage 里只有一个释放点                                */
/* ------------------------------------------------------------------ */

test('P1：sendMessage 的准备阶段在主 try 内，且只有一个 endTurn（在 finally 里）', () => {
  const engine = stripComments(read('src/lib/engine.ts'))
  const start = engine.indexOf('export async function sendMessage')
  const end = engine.indexOf('export async function sendGroupMessage', start)
  const body = engine.slice(start, end === -1 ? undefined : end)

  const tryAt = body.indexOf('try {')
  const loginAt = body.indexOf('ensureWebChatLogin(')
  const finallyAt = body.indexOf('} finally {')
  const endTurnAt = body.indexOf('endTurn(turn)')

  assert.ok(tryAt > 0 && loginAt > 0 && finallyAt > tryAt && endTurnAt > 0, '锚点都要能找到')
  assert.ok(tryAt < loginAt, '网页登录必须在主 try 里面 —— 否则 reject 时没人释放')
  assert.ok(finallyAt < endTurnAt, 'endTurn 必须在 finally 里')
  assert.equal(
    (body.match(/endTurn\(turn\)/g) ?? []).length,
    1,
    '准备阶段不许再有零散的 endTurn 补丁，释放只留 finally 一处',
  )
  assert.equal(
    (body.match(/beginTurn\(\)/g) ?? []).length,
    1,
    '一轮只占一次位',
  )
})
