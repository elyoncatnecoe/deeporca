import test from 'node:test'
import assert from 'node:assert/strict'
import { linkAbort, raceAbort } from '../src/lib/abort.ts'

/**
 * 回归测试：超时与取消。
 *
 * 之前 MCP 的网络请求既没有超时、也没接本轮对话的 abort 信号：
 * 一台服务器挂住，await 就永远不返回，发送键卡在「停止」只能重启
 * （BUG-REVIEW P1-4）。这里守的是那条基础能力。
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('linkAbort：到点会自己断，并且能说清是超时断的', async () => {
  const link = linkAbort(undefined, 20)
  assert.equal(link.signal.aborted, false)
  await sleep(60)
  assert.equal(link.signal.aborted, true, '超时后信号必须是 aborted')
  assert.equal(link.timedOut(), true, '要能区分「超时」和「用户按了停止」')
  link.dispose()
})

test('linkAbort：外部取消立刻传导，且不算超时', async () => {
  const outer = new AbortController()
  const link = linkAbort(outer.signal, 60_000)
  assert.equal(link.signal.aborted, false)
  outer.abort()
  assert.equal(link.signal.aborted, true, '用户按停止必须立刻断')
  assert.equal(link.timedOut(), false, '这是用户取消，不是超时')
  link.dispose()
})

test('linkAbort：传进来就已经取消了，也立刻是 aborted', () => {
  const outer = new AbortController()
  outer.abort()
  const link = linkAbort(outer.signal, 60_000)
  assert.equal(link.signal.aborted, true)
  assert.equal(link.timedOut(), false)
  link.dispose()
})

test('linkAbort：dispose 之后定时器不再触发（不会留着后台计时器）', async () => {
  const link = linkAbort(undefined, 20)
  link.dispose()
  await sleep(60)
  assert.equal(link.signal.aborted, false, 'dispose 之后不该再被超时打断')
})

test('raceAbort：没有信号时原样透传', async () => {
  const value = await raceAbort(Promise.resolve(42), undefined)
  assert.equal(value, 42)
})

test('raceAbort：取消时立刻松手，不等对面（这就是「停止」不再卡 180 秒的原因）', async () => {
  const controller = new AbortController()
  // 一个永远不会 settle 的「原生调用」。
  const hanging = new Promise<string>(() => undefined)
  const raced = raceAbort(hanging, controller.signal)
  controller.abort()
  await assert.rejects(raced, /已停止/)
})

test('raceAbort：先取消再调用也立刻 reject', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(raceAbort(Promise.resolve(1), controller.signal), /已停止/)
})

test('raceAbort：原 Promise 的结果与异常都原样传出来', async () => {
  assert.equal(await raceAbort(Promise.resolve('ok'), new AbortController().signal), 'ok')
  await assert.rejects(raceAbort(Promise.reject(new Error('炸了')), new AbortController().signal), /炸了/)
})