import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnthropicBody, buildGoogleBody, buildOpenAiBody } from '../src/lib/protocols.ts'
import type { ChatRequestMessage } from '../src/lib/types.ts'

/**
 * 纯文本对话的请求体逐字节不变 —— A5 的护栏。
 *
 * 这次改动动的是「每条消息怎么捏成 content」那段，所有普通对话都要经过它，
 * 所以风险不在图片那一侧，而在「别把没图片的对话顺手改了」。下面这些 golden
 * 不是照着新代码手抄的：是把**改动前**的那份 protocols.ts（备份在
 * _backup-bugfix3-20261103-123006/src/lib/protocols.ts）直接 import 进 node，
 * 用同一组消息跑出来的实际输出。抄新代码的断言永远不会发现回归。
 *
 * **2026-11-03 修复 B 有意改了一处**（不是事故：改前改后都跑过 _tmp/goldens-gen.mjs 对比）：
 * Anthropic 开着 thinking 时不再发 `temperature` —— 官方要求此时恒为 1，带着 0.7 就是必 400，
 * 而 deepseek.ts 的 400 退避只会剥 stream_options / thinking / reasoning_effort /
 * reasoning_content，修不好这个搭配，接 Anthropic 中转的用户以前是「每次必失败」。
 * 所以下面两条 anthropic golden 去掉了 `,"temperature":0.7`，其余逐字节仍等于改动前的
 * protocols.ts；OpenAI 兼容与 Google 两条**一字未变**（Google 新增的 tools 字段在这组样例里
 * 没传，所以体还是旧的）。
 */

/** 一个图片段都没有的典型一轮：两条 system、纯文本、多 text 段、工具往返、空正文。 */
const TEXT_ONLY: ChatRequestMessage[] = [
  { role: 'system', content: '你是深鲸，' },
  { role: 'system', content: '第二块 system。' },
  { role: 'user', content: '你好' },
  { role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
  {
    role: 'assistant',
    content: '我先看一下',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.html"}' } }],
  },
  { role: 'tool', content: 'ok', tool_call_id: 'call_1', name: 'write_file' },
  { role: 'assistant', content: '' },
  { role: 'user', content: '' },
]

/**
 * 带图片、但那两张内联不了（一个是 http 外链，一个是脏串）。
 * 这一组也必须逐字节不变：回落成 `[图片]` 文字占位是**本来就该保留**的行为，
 * 我们只是把「能内联的图」换成了真图片块。
 */
const UNINLINABLE: ChatRequestMessage[] = [
  { role: 'user', content: [{ type: 'text', text: '看看这个' }, { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } }] },
  { role: 'assistant', content: [{ type: 'text', text: '收到' }, { type: 'image_url', image_url: { url: 'not-a-data-url' } }] },
]

const TOOLS: unknown[] = [{
  type: 'function',
  function: { name: 'write_file', description: '写文件', parameters: { type: 'object', properties: {} } },
}]

const GOLDEN = {
  textOnly: {
    openai: String.raw`{"model":"deepseek-chat","messages":[{"role":"system","content":"你是深鲸，"},{"role":"system","content":"第二块 system。"},{"role":"user","content":"你好"},{"role":"user","content":[{"type":"text","text":"第一段"},{"type":"text","text":"第二段"}]},{"role":"assistant","content":"我先看一下","tool_calls":[{"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\"path\":\"a.html\"}"}}]},{"role":"tool","content":"ok","tool_call_id":"call_1","name":"write_file"},{"role":"assistant","content":""},{"role":"user","content":""}],"temperature":0.7,"max_tokens":4096,"stream":true,"stream_options":{"include_usage":true},"tools":[{"type":"function","function":{"name":"write_file","description":"写文件","parameters":{"type":"object","properties":{}}}}],"tool_choice":"auto","thinking":{"type":"enabled"},"reasoning_effort":"high"}`,
    anthropic: String.raw`{"model":"claude-3-5-sonnet-20241022","max_tokens":4096,"messages":[{"role":"user","content":[{"type":"text","text":"你好"}]},{"role":"user","content":[{"type":"text","text":"第一段\n第二段"}]},{"role":"assistant","content":[{"type":"text","text":"我先看一下"},{"type":"tool_use","id":"call_1","name":"write_file","input":{"path":"a.html"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"ok"}]},{"role":"assistant","content":[{"type":"text","text":""}]},{"role":"user","content":[{"type":"text","text":""}]}],"system":"你是深鲸，\n\n第二块 system。","stream":true,"thinking":{"type":"enabled","budget_tokens":2048}}`,
    google: String.raw`{"contents":[{"role":"user","parts":[{"text":"你好"}]},{"role":"user","parts":[{"text":"第一段\n第二段"}]},{"role":"model","parts":[{"text":"我先看一下"}]},{"role":"user","parts":[{"functionResponse":{"name":"write_file","response":{"result":"ok"}}}]},{"role":"model","parts":[{"text":""}]},{"role":"user","parts":[{"text":""}]}],"generationConfig":{"temperature":0.7,"maxOutputTokens":4096,"thinkingConfig":{"thinkingBudget":1024}},"systemInstruction":{"parts":[{"text":"你是深鲸，"},{"text":"第二块 system。"}]}}`,
  },
  uninlinable: {
    openai: String.raw`{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"text","text":"看看这个"},{"type":"image_url","image_url":{"url":"https://cdn.example.com/a.png"}}]},{"role":"assistant","content":[{"type":"text","text":"收到"},{"type":"image_url","image_url":{"url":"not-a-data-url"}}]}],"temperature":0.7,"max_tokens":4096,"stream":true,"stream_options":{"include_usage":true},"tools":[{"type":"function","function":{"name":"write_file","description":"写文件","parameters":{"type":"object","properties":{}}}}],"tool_choice":"auto","thinking":{"type":"enabled"},"reasoning_effort":"high"}`,
    anthropic: String.raw`{"model":"claude-3-5-sonnet-20241022","max_tokens":4096,"messages":[{"role":"user","content":[{"type":"text","text":"看看这个\n[图片]"}]},{"role":"assistant","content":[{"type":"text","text":"收到\n[图片]"}]}],"stream":true,"thinking":{"type":"enabled","budget_tokens":2048}}`,
    google: String.raw`{"contents":[{"role":"user","parts":[{"text":"看看这个\n[图片]"}]},{"role":"model","parts":[{"text":"收到\n[图片]"}]}],"generationConfig":{"temperature":0.7,"maxOutputTokens":4096,"thinkingConfig":{"thinkingBudget":1024}}}`,
  },
}

function openAiBody(messages: ChatRequestMessage[]): string {
  return JSON.stringify(buildOpenAiBody({
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    maxTokens: 4096,
    tools: TOOLS,
    stream: true,
    includeUsage: true,
    thinking: { type: 'enabled' },
    reasoningEffort: 'high',
  }))
}

function anthropicBody(messages: ChatRequestMessage[]): string {
  return JSON.stringify(buildAnthropicBody({
    model: 'claude-3-5-sonnet-20241022',
    messages,
    temperature: 0.7,
    maxTokens: 4096,
    stream: true,
    thinkingBudget: 2048,
  }))
}

function googleBody(messages: ChatRequestMessage[]): string {
  return JSON.stringify(buildGoogleBody({
    messages,
    temperature: 0.7,
    maxTokens: 4096,
    thinkingBudget: 1024,
  }))
}

test('A5 纯文本对话：OpenAI 兼容的请求体逐字节不变', () => {
  assert.equal(openAiBody(TEXT_ONLY), GOLDEN.textOnly.openai)
})

test('A5 纯文本对话：Anthropic 的请求体逐字节不变', () => {
  assert.equal(anthropicBody(TEXT_ONLY), GOLDEN.textOnly.anthropic)
})

test('A5 纯文本对话：Google 的请求体逐字节不变', () => {
  assert.equal(googleBody(TEXT_ONLY), GOLDEN.textOnly.google)
})

test('A5 内联不了的图片照旧回落成文字占位，请求体也逐字节不变', () => {
  assert.equal(openAiBody(UNINLINABLE), GOLDEN.uninlinable.openai)
  assert.equal(anthropicBody(UNINLINABLE), GOLDEN.uninlinable.anthropic)
  assert.equal(googleBody(UNINLINABLE), GOLDEN.uninlinable.google)
})

test('A5 这两组样例确实没被塞进真图片块（golden 自证）', () => {
  for (const group of [GOLDEN.textOnly, GOLDEN.uninlinable]) {
    for (const body of [group.openai, group.anthropic, group.google]) {
      assert.ok(!body.includes('"type":"image"'), '没有图片就不该出现 Anthropic 的 image 块')
      assert.ok(!body.includes('inlineData'), '没有图片就不该出现 Google 的 inlineData')
      assert.ok(!body.includes('media_type'), '没有图片就不该有 media_type')
    }
  }
})