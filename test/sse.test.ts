import test from 'node:test'
import assert from 'node:assert/strict'
import { SseDecoder } from '../src/lib/sse.ts'

/**
 * SSE 解码器单测（P0 · 对齐 chat-demo 的 WHATWG 实现）。
 *
 * 锁住三件以前会出错的事：
 *   1. 换行必须是 CRLF / LF / CR 三种都认（旧实现只认 \n 和 \r\n）；
 *   2. `event:` 名要带出来（错误帧靠它识别，旧实现只取 data: 行）；
 *   3. 多行 data 用 \n 连接（旧实现逐行 trimStart）。
 * 另外验证「跨分片切在 \r\n 中间」和「收尾没有空行」两个真实网关场景。
 */

function decodeAll(chunks: string[]): Array<{ event: string; data: string; lastEventId: string }> {
  const d = new SseDecoder()
  const out = []
  for (const chunk of chunks) out.push(...d.push(chunk))
  // 模拟流结束：把没有空行结尾的最后一段也派发出来。
  out.push(...d.flush())
  return out
}

test('LF 换行：普通 data 事件', () => {
  assert.deepEqual(decodeAll(['data: a\n\ndata: b\n\n']).map((e) => e.data), ['a', 'b'])
})

test('CRLF 换行：普通 data 事件', () => {
  assert.deepEqual(decodeAll(['data: a\r\n\r\ndata: b\r\n\r\n']).map((e) => e.data), ['a', 'b'])
})

test('CR-only 换行：旧实现切不出来，这里必须认', () => {
  assert.deepEqual(decodeAll(['data: a\r\rdata: b\r\r']).map((e) => e.data), ['a', 'b'])
})

test('多行 data 用 \\n 连接', () => {
  const events = decodeAll(['data: {"a":\ndata: 1}\n\n'])
  assert.equal(events.length, 1)
  assert.equal(events[0]?.data, '{"a":\n1}')
})

test('注释保活行被忽略，不产生事件', () => {
  const events = decodeAll([': keep-alive\n\ndata: x\n\n'])
  assert.deepEqual(events.map((e) => e.data), ['x'])
})

test('event 名（错误帧）要带出来，缺省是 message', () => {
  const events = decodeAll(['event: error\ndata: 等待生成超时\n\n', 'data: y\n\n'])
  assert.equal(events[0]?.event, 'error')
  assert.equal(events[0]?.data, '等待生成超时')
  assert.equal(events[1]?.event, 'message')
})

test('跨分片切在 \\r\\n 中间不能把事件切碎', () => {
  // 第一段以 \r 结尾（\r\n 的前半），第二段才是 \n\r\n。
  const events = decodeAll(['data: hello\r', '\n\r\n'])
  assert.equal(events.length, 1)
  assert.equal(events[0]?.data, 'hello')
})

test('结尾的 \\r 单独留到下一段判，不当成完整行', () => {
  const d = new SseDecoder()
  assert.deepEqual(d.push('data: par'), [])
  assert.deepEqual(d.push('tial\r'), [], '末尾单个 \\r 可能只是 \\r\\n 的前半，先别切')
  assert.equal(d.pending, 'data: partial\r')
  assert.deepEqual(d.push('\n\r\n').map((e) => e.data), ['partial'])
})

test('id 字段记录到 lastEventId（含 NUL 的忽略）', () => {
  const events = decodeAll(['id: 42\ndata: a\n\n'])
  assert.equal(events[0]?.lastEventId, '42')
})

test('flush：没有空行结尾的最后一段也要派发出来（对齐 T-10/T-12 收尾）', () => {
  const d = new SseDecoder()
  assert.deepEqual(d.push('data: 尾段'), [])
  assert.equal(d.pending, 'data: 尾段')
  assert.deepEqual(d.flush().map((e) => e.data), ['尾段'])
  assert.equal(d.pending, '')
})

test('flush：末尾只剩一个 LF 时也要派发（行已被吃掉、事件还压在内部）', () => {
  const d = new SseDecoder()
  assert.deepEqual(d.push('data: 尾段\n'), [], '缺空行，这一帧还不能派发')
  assert.equal(d.pending, '', 'buffer 被 push() 吃空了 —— 只看它就会漏掉这一帧')
  assert.deepEqual(d.flush().map((e) => e.data), ['尾段'])
  assert.deepEqual(d.flush(), [], 'flush 再调一次必须什么都不做')
})

test('flush：末尾只剩一个 CRLF 时同样不能漏', () => {
  const d = new SseDecoder()
  assert.deepEqual(d.push('data: 甲\r\n'), [])
  assert.deepEqual(d.flush().map((e) => e.data), ['甲'])
})

test('flush：末尾是半个 CRLF（只剩 \\r）时也不能漏', () => {
  const d = new SseDecoder()
  assert.deepEqual(d.push('data: 乙\r'), [])
  assert.deepEqual(d.flush().map((e) => e.data), ['乙'])
})

test('reset：清空缓冲后可复用', () => {
  const d = new SseDecoder()
  d.push('data: 半截')
  d.reset()
  assert.equal(d.pending, '')
  assert.deepEqual(d.push('data: 新\n\n').map((e) => e.data), ['新'])
})
