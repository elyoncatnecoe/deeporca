import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { DEFAULT_SETTINGS, type Provider, type Settings } from '../src/lib/types.ts'

/**
 * 流式解析的收尾与 400 退避（批次 3 · A 组）。
 *
 * 这两条（T-10 / T-11）以前都是「看起来有处理、实际没生效」的类型：
 *   - T-10 只在空行处分事件，最后一个事件没有空行结尾就整段丢掉；
 *     网关忽略 stream:true 回整包 JSON 时，200 被当成成功，正文一个字都不剩。
 *   - T-11 只把 includeUsage 开关关掉，body 里的 stream_options 照样被展开出去；
 *     reasoning_content 分支无条件置 changed，历史里没有这个字段也会重发一遍。
 *
 * 这里全部走**真的 streamChat + 真的 net.ts 传输层**（stub 掉 globalThis.fetch），
 * 断言打在「界面拿到什么」和「第二次请求的 body 长什么样」上，不去数源码里的字。
 */

// deepseek.ts 内部是 bundler 风格的无扩展名 import，Node 的 ESM 解析器不认。
// 补一个 .ts 解析钩子（与 model-vision / settings-migration 同一套），并且必须在
// 钩子注册**之后**再动态加载它 —— 静态 import 的解析发生在任何代码执行之前。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})

const { ApiError, streamChat } = await import('../src/lib/deepseek.ts')

/**
 * 流式解析的收尾与 400 退避（批次 3 · A 组）。
 *
 * 这两条（T-10 / T-11）以前都是「看起来有处理、实际没生效」的类型：
 *   - T-10 只在空行处分事件，最后一个事件没有空行结尾就整段丢掉；
 *     网关忽略 stream:true 回整包 JSON 时，200 被当成成功，正文一个字都不剩。
 *   - T-11 只把 includeUsage 开关关掉，body 里的 stream_options 照样被展开出去；
 *     reasoning_content 分支无条件置 changed，历史里没有这个字段也会重发一遍。
 *
 * 这里全部走**真的 streamChat + 真的 net.ts 传输层**（stub 掉 globalThis.fetch），
 * 断言打在「界面拿到什么」和「第二次请求的 body 长什么样」上，不去数源码里的字。
 */

function providerFor(patch: Partial<Provider> = {}): Provider {
  const base = DEFAULT_SETTINGS.providers[0] as Provider
  return {
    ...base,
    protocol: 'openai',
    baseUrl: 'https://gateway.example.com/v1',
    apiKey: 'sk-test',
    models: ['test-model'],
    ...patch,
  }
}

function settingsFor(provider: Provider, patch: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    providerId: provider.id,
    providers: [provider],
    model: 'test-model',
    apiKey: 'sk-test',
    ...patch,
  }
}

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Call {
  url: string
  body: Record<string, unknown>
}

/** 按顺序回放响应，并记录每次请求体。用完最后一个就重复最后一个。 */
function stubFetch(responses: Response[]): { calls: Call[]; restore: () => void } {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)] as Response
    // 每次都要给一个新的 Response：body 只能被读一次。
    return Promise.resolve(next.clone())
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const USER = { role: 'user' as const, content: '你好' }

/* ------------------------------------------------------------------ T-10 */

test('T-10：最后一个事件没有空行结尾，也必须收进正文和 usage', async () => {
  const stub = stubFetch([sse([
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    // 注意：这段**没有**结尾的 \n\n —— 很多网关 [DONE] 之前就是这样断的。
    'data: {"choices":[{"delta":{"content":"，世界"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
  ])])
  try {
    const result = await streamChat({
      settings: settingsFor(providerFor()),
      messages: [USER],
    })
    assert.equal(result.content, '你好，世界', '末尾那段正文被吞了')
    assert.equal(result.usage?.totalTokens, 3, '末尾那个 usage 被吞了')
  } finally {
    stub.restore()
  }
})

test('T-10：网关忽略 stream 直接回整包 JSON 时，正文要兜回来（以前是空白气泡）', async () => {
  const stub = stubFetch([json({ choices: [{ message: { content: '整包回复' } }] })])
  try {
    const deltas: string[] = []
    const result = await streamChat({
      settings: settingsFor(providerFor()),
      messages: [USER],
      handlers: { onDelta: (delta) => deltas.push(delta) },
    })
    assert.equal(result.content, '整包回复')
    assert.deepEqual(deltas, ['整包回复'], '兜回来的正文要当成一次增量交给界面')
  } finally {
    stub.restore()
  }
})

test('T-10：正常 SSE 不会被收尾逻辑重复解析（正文不翻倍）', async () => {
  const stub = stubFetch([sse([
    'data: {"choices":[{"delta":{"content":"甲"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"乙"}}]}\n\n',
    'data: [DONE]\n\n',
  ])])
  try {
    const result = await streamChat({ settings: settingsFor(providerFor()), messages: [USER] })
    assert.equal(result.content, '甲乙')
  } finally {
    stub.restore()
  }
})

/* ------------------------------------------------------------------ T-11 */

test('T-11：网关嫌 stream_options 时，重试的请求体里必须真的没有这个字段', async () => {
  const stub = stubFetch([
    json({ error: { message: 'unknown field: stream_options' } }, 400),
    sse(['data: {"choices":[{"delta":{"content":"好的"}}]}\n\n', 'data: [DONE]\n\n']),
  ])
  try {
    const result = await streamChat({ settings: settingsFor(providerFor()), messages: [USER] })
    assert.equal(result.content, '好的')
    assert.equal(stub.calls.length, 2, '应该只重试一次')
    assert.ok('stream_options' in (stub.calls[0]?.body ?? {}), '第一次请求本来就该带 stream_options')
    assert.equal(
      'stream_options' in (stub.calls[1]?.body ?? {}),
      false,
      '重试仍然带着 stream_options —— 等于同一个 400 白重试',
    )
  } finally {
    stub.restore()
  }
})

test('T-11：历史里没有 reasoning_content 时，不许因为 400 文案重发一遍同样的请求', async () => {
  const stub = stubFetch([json({ error: { message: 'unsupported reasoning_content' } }, 400)])
  try {
    await assert.rejects(
      () => streamChat({ settings: settingsFor(providerFor()), messages: [USER] }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.status, 400)
        return true
      },
    )
    assert.equal(stub.calls.length, 1, '没有任何字段可剥就该立刻报错，不该重试')
  } finally {
    stub.restore()
  }
})

test('T-11：历史里真有 reasoning_content 时，重试请求里必须已经剥掉', async () => {
  const stub = stubFetch([
    json({ error: { message: 'unsupported reasoning_content' } }, 400),
    sse(['data: {"choices":[{"delta":{"content":"好"}}]}\n\n', 'data: [DONE]\n\n']),
  ])
  try {
    await streamChat({
      settings: settingsFor(providerFor()),
      messages: [
        USER,
        { role: 'assistant', content: '想过了', reasoning_content: '内部推理' },
        { role: 'user', content: '继续' },
      ],
    })
    assert.equal(stub.calls.length, 2)
    const sent = stub.calls[1]?.body.messages as Array<Record<string, unknown>>
    assert.ok(Array.isArray(sent))
    assert.equal(sent.some((message) => message.reasoning_content !== undefined), false)
  } finally {
    stub.restore()
  }
})
