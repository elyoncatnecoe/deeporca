import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildAnthropicBody, buildGoogleBody, splitDataUrl } from '../src/lib/protocols.ts'
import type { ChatRequestMessage } from '../src/lib/types.ts'

/**
 * A5：Anthropic / Google 这两条路上必须出现真图片块。
 *
 * 这是 BUG-REVIEW.md 里 P1-11 那条的老账：闸门就算打开，这两个协议把图片压成
 * 字面文本 `[图片]`，供应商收到的永远是一串汉字。下面每一条都同时断言
 * 「块是对的」和「body 里没有 [图片]」，两件事缺一条都不算修好。
 */

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP/'

function userTurn(text: string, urls: string[]): ChatRequestMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text }, ...urls.map((url) => ({ type: 'image_url' as const, image_url: { url } }))] }]
}

function anthropicMessages(body: Record<string, unknown>): Array<{ role: string; content: Array<Record<string, unknown>> }> {
  return body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
}

function googleContents(body: Record<string, unknown>): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
  return body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>
}

function anthropic(messages: ChatRequestMessage[]): Record<string, unknown> {
  return buildAnthropicBody({ model: 'claude-3-5-sonnet-20241022', messages, temperature: 0.7, maxTokens: 4096, stream: true })
}

function google(messages: ChatRequestMessage[]): Record<string, unknown> {
  return buildGoogleBody({ messages, temperature: 0.7, maxTokens: 4096 })
}

/* ------------------------------------------------------------ splitDataUrl */

test('A5 splitDataUrl 认出内联 base64，容忍参数段，外链一律返回 null', () => {
  assert.deepEqual(splitDataUrl(PNG), { mime: 'image/png', base64: 'iVBORw0KGgo=' })
  assert.deepEqual(splitDataUrl('data:image/jpeg;charset=utf-8;base64,/9j/4AAQ'), { mime: 'image/jpeg', base64: '/9j/4AAQ' })
  assert.equal(splitDataUrl('https://cdn.example.com/a.png'), null, '外链我们没法内联')
  assert.equal(splitDataUrl('data:image/png;base64,'), null, '空数据不算一张图')
  assert.equal(splitDataUrl('data:;base64,AAAA'), null, '连 mime 都没有，只能退回占位文字')
  assert.equal(splitDataUrl('data:image/png,iVBORw0KGgo='), null, '非 base64 编码不支持')
  assert.equal(splitDataUrl(''), null)
})

/* ---------------------------------------------------------------- Anthropic */

test('A5 Anthropic 收到 image + source.base64，body 里没有 [图片]', () => {
  const body = anthropic(userTurn('这是什么？', [PNG]))
  assert.deepEqual(anthropicMessages(body)[0]?.content, [
    { type: 'text', text: '这是什么？' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
  ])
  const json = JSON.stringify(body)
  assert.ok(!json.includes('[图片]'), '图片又被压成字面文本了')
  assert.ok(json.includes('"media_type":"image/png"'), 'mime 要从 data URL 里带出来')
})

test('A5 Anthropic 多张图按顺序全发，mime 各随其图', () => {
  const body = anthropic(userTurn('对比一下', [PNG, JPEG, GIF]))
  const blocks = anthropicMessages(body)[0]?.content ?? []
  assert.equal(blocks.length, 4, '一段文字 + 三张图')
  assert.deepEqual(blocks.slice(1).map((block) => (block.source as Record<string, unknown>).media_type), ['image/png', 'image/jpeg', 'image/gif'])
})

test('A5 纯图片的一轮不塞空 text 块（两种协议都是）', () => {
  const imageOnly: ChatRequestMessage[] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }]
  assert.deepEqual(anthropicMessages(anthropic(imageOnly))[0]?.content ?? [], [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
  ])
  assert.deepEqual(googleContents(google(imageOnly))[0]?.parts ?? [], [
    { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
  ])
})

/* ------------------------------------------------------------------- Google */

test('A5 Google 收到 inlineData{mimeType,data}，body 里没有 [图片]', () => {
  const body = google(userTurn('看看这张', [JPEG]))
  assert.deepEqual(googleContents(body)[0]?.parts, [
    { text: '看看这张' },
    { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' } },
  ])
  assert.ok(!JSON.stringify(body).includes('[图片]'), 'Gemini 那边也在收汉字')
})

test('A5 只有 user 轮带图：assistant / tool 那两侧照旧是文字', () => {
  // Anthropic 明确不接受 assistant 的 image 块，硬塞会 400。
  const assistant: ChatRequestMessage[] = [{ role: 'assistant', content: [{ type: 'image_url', image_url: { url: PNG } }] }]
  const anthropicJson = JSON.stringify(anthropic(assistant))
  assert.ok(anthropicJson.includes('[图片]'), '内联不了的轮次要留占位')
  assert.ok(!anthropicJson.includes('"type":"image"'), '别把图塞进 assistant 轮')

  const tool: ChatRequestMessage[] = [{ role: 'tool', content: [{ type: 'image_url', image_url: { url: PNG } }], tool_call_id: 'call_1', name: 'read_file' }]
  const toolBlocks = anthropicMessages(anthropic(tool))[0]?.content ?? []
  assert.deepEqual(toolBlocks, [{ type: 'tool_result', tool_use_id: 'call_1', content: '[图片]' }])

  const googleModelTurn = google([{ role: 'assistant', content: [{ type: 'image_url', image_url: { url: PNG } }] }])
  assert.deepEqual(googleContents(googleModelTurn)[0]?.parts, [{ text: '[图片]' }])
})

test('A5 内联不了的那一张退回文字占位，能内联的照发', () => {
  const content = anthropicMessages(anthropic(userTurn('两张', ['https://cdn.example.com/a.png', PNG])))[0]?.content ?? []
  assert.deepEqual(content, [
    { type: 'text', text: '两张\n[图片]' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
  ])
})

/* ------------------------------------------------------------------- 源码层 */

const PROTOCOLS = readFileSync('src/lib/protocols.ts', 'utf8')

test('A5 拆 data URL 只有一份实现（两种协议共用同一个 helper）', () => {
  assert.equal((PROTOCOLS.match(/function splitDataUrl/g) ?? []).length, 1)
  assert.ok(PROTOCOLS.includes('splitMessageContent(message, isUser)'), '两种协议没共用同一套 content 拆解')
})