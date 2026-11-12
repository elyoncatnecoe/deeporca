import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAnthropicEvent, parseGoogleEvent } from '../src/lib/protocols.ts'
import { isTruncatedFinish } from '../src/lib/budget.ts'

/**
 * 流解析回归测试（修复 B）。
 *
 * 以前全仓没有一个流解析测试，于是 Anthropic 的 input_json_delta 一个都没被处理：
 * content_block_start 当场发 arguments:'{}'，每个 write_file 都是空参，
 * 工坊那边必然抛「content 必须是字符串」—— 而聊天里只留一句工具执行失败。
 * 这里锁两条：各家事件要解成同一组增量；「撞顶」的 finishReason 要能被认出来。
 */

// B4 的按 block index 累积要落到 protocols.ts（task-1 现在持有它），见 _tmp/pending-b.md §2a/§2b。
const PENDING_PROTOCOLS = '等 _tmp/pending-b.md §2 落到 protocols.ts（task-1 完成后由我应用）'

test('Anthropic：文本与思考增量解成同一组形状', () => {
  assert.deepEqual(parseAnthropicEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } })), { text: '你好' })
  const thinking = parseAnthropicEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想想结构' } }))
  assert.equal(thinking?.reasoning, '先想想结构')
})

test('Anthropic：message_start 的用量与 message_delta 的 stop_reason 都要回传', () => {
  const start = parseAnthropicEvent(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 3 } } }))
  assert.deepEqual(start?.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 })
  const delta = parseAnthropicEvent(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } }))
  assert.equal(delta?.finishReason, 'max_tokens')
  // finishReason 一路回传却没人读，是「截断完全隐形」的另一半（RC-3）。引擎现在必须认得它。
  assert.ok(isTruncatedFinish(delta?.finishReason), 'max_tokens 要判成截断')
  const stop = parseAnthropicEvent(JSON.stringify({ type: 'message_stop' }))
  assert.equal(stop?.done, true)
})

test('Anthropic：认不出来的事件返回 null，不要伪造一个空增量', () => {
  assert.equal(parseAnthropicEvent(JSON.stringify({ type: 'ping' })), null)
  assert.equal(parseAnthropicEvent('不是 JSON'), null)
})

test('Google：functionCall 是整块给出的，参数一次到位', () => {
  const event = parseGoogleEvent(JSON.stringify({
    candidates: [{ content: { parts: [{ functionCall: { name: 'write_file', args: { path: 'index.html', content: '<p>hi</p>' } } }] } }],
  }))
  assert.equal(event?.toolCall?.name, 'write_file')
  assert.deepEqual(JSON.parse(event?.toolCall?.arguments ?? '{}'), { path: 'index.html', content: '<p>hi</p>' })
})

test('Google：MAX_TOKENS 也要判成截断，thought 段不能混进正文', () => {
  const event = parseGoogleEvent(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '推理过程', thought: true }, { text: '正文' }] }, finishReason: 'MAX_TOKENS' }],
  }))
  assert.equal(event?.reasoning, '推理过程')
  assert.equal(event?.text, '正文')
  assert.equal(event?.finishReason, 'MAX_TOKENS')
  assert.ok(isTruncatedFinish(event?.finishReason))
})

test('OpenAI 兼容：finish_reason 的三种写法都要认得', () => {
  assert.ok(isTruncatedFinish('length'), 'OpenAI 兼容 / DeepSeek')
  assert.ok(isTruncatedFinish('max_tokens'), 'Anthropic')
  assert.ok(isTruncatedFinish('MAX_TOKENS'), 'Gemini')
  assert.equal(isTruncatedFinish('stop'), false)
  assert.equal(isTruncatedFinish('tool_use'), false)
  assert.equal(isTruncatedFinish(undefined), false)
})

test('Anthropic：按 block index 累积 input_json_delta，content_block_stop 才定稿（回归 P1-8）', { skip: PENDING_PROTOCOLS }, async () => {
  // 现场：这一段分片今天全被丢掉，工具参数永远停在 '{}'。
  // 累积/定稿两个函数随 pending-b §2 落到 protocols.ts；先按那个形状写断言，
  // 落地后把这里的动态 import 换成普通 import 即可。
  const protocols = await import('../src/lib/protocols.ts') as typeof import('../src/lib/protocols.ts') & {
    mergeToolDelta: (drafts: Map<number, ToolDraft>, part: { index?: number; id?: string; name?: string; partial?: string; stop?: boolean }) => void
    finalizedToolDrafts: (drafts: Map<number, ToolDraft>) => Array<{ id: string; name: string; arguments: string }>
  }
  type ToolDraft = { id: string; name: string; arguments: string }
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'write_file', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"in' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'dex.html","content":"<h1>hi</h1>' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"}' } },
    { type: 'content_block_stop', index: 0 },
  ]
  const drafts = new Map<number, ToolDraft>()
  for (const event of events) {
    const delta = parseAnthropicEvent(JSON.stringify(event))
    if (delta?.toolCallDelta !== undefined) protocols.mergeToolDelta(drafts, delta.toolCallDelta)
  }
  const calls = protocols.finalizedToolDrafts(drafts)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, 'write_file')
  assert.deepEqual(JSON.parse(calls[0]?.arguments ?? '{}'), { path: 'index.html', content: '<h1>hi</h1>' })
  // content_block_start 那一刻不许发出任何可直接执行的参数（那就是空参 write_file 的来源）。
  assert.notEqual(calls[0]?.arguments, '{}')
})
