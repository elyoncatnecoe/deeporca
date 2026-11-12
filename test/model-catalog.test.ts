import assert from 'node:assert/strict'
import test from 'node:test'
import {
  catalogHeaders,
  fetchProviderModels,
  mergeCatalogModels,
  modelsEndpoint,
  modelMetaText,
  parseCatalog,
  removeCatalogModel,
} from '../src/lib/model-catalog.ts'
import type { Provider } from '../src/lib/types.ts'

/**
 * 「获取可用模型」的回归测试。
 *
 * 这一层最容易写错的是三件事：地址怎么拼（用户填的 baseUrl 千奇百怪）、
 * 各家返回的字段别名、以及失败时给用户看的那句话对不对（界面直接显示 reason，
 * 错了用户就不知道该改地址还是该换 Key）。
 */

function makeProvider(patch: Partial<Provider> = {}): Provider {
  return {
    id: 'provider_test',
    name: '测试供应商',
    protocol: 'openai',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    models: [],
    headers: {},
    enabled: true,
    ...patch,
  }
}

/** 把 globalThis.fetch 换成假实现，返回还原函数。 */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/** 一个永远不返回的假请求：只在收到 abort 时 reject，用来测超时与取消。 */
function hangingFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init.signal
    if (signal === null || signal === undefined) return
    if (signal.aborted) {
      reject(abortError())
      return
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

/* ------------------------------------------------------------------ 地址拼接 */

test('modelsEndpoint：OpenAI 兼容默认拼 /models，尾斜杠先去掉', () => {
  assert.equal(modelsEndpoint(makeProvider()), 'https://api.example.com/models')
  assert.equal(modelsEndpoint(makeProvider({ baseUrl: 'https://api.example.com/' })), 'https://api.example.com/models')
  assert.equal(modelsEndpoint(makeProvider({ baseUrl: '  https://api.example.com//  ' })), 'https://api.example.com/models')
  // 用户自己带 /v1 的（很多中转站要求）要原样保留。
  assert.equal(modelsEndpoint(makeProvider({ baseUrl: 'https://api.example.com/v1' })), 'https://api.example.com/v1/models')
})

test('modelsEndpoint：baseUrl 带 /chat/completions 时先剥掉再拼', () => {
  assert.equal(
    modelsEndpoint(makeProvider({ baseUrl: 'https://api.example.com/v1/chat/completions' })),
    'https://api.example.com/v1/models',
  )
})

test('modelsEndpoint：Anthropic 剥掉一个 /v1 再拼 /v1/models', () => {
  const anthropic = (baseUrl: string): string | null => modelsEndpoint(makeProvider({ protocol: 'anthropic', baseUrl }))
  assert.equal(anthropic('https://api.anthropic.com'), 'https://api.anthropic.com/v1/models?limit=1000')
  assert.equal(anthropic('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/models?limit=1000')
  assert.equal(anthropic('https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1/models?limit=1000')
})

test('modelsEndpoint：Google 用 /v1beta/models', () => {
  const google = (baseUrl: string): string | null => modelsEndpoint(makeProvider({ protocol: 'google', baseUrl }))
  assert.equal(google('https://generativelanguage.googleapis.com'), 'https://generativelanguage.googleapis.com/v1beta/models')
  assert.equal(google('https://generativelanguage.googleapis.com/'), 'https://generativelanguage.googleapis.com/v1beta/models')
})

test('modelsEndpoint：网页账号与空地址都没有可用的列表地址', () => {
  assert.equal(modelsEndpoint(makeProvider({ protocol: 'deepseek-web', baseUrl: 'https://chat.deepseek.com' })), null)
  assert.equal(modelsEndpoint(makeProvider({ baseUrl: '   ' })), null)
})

/* -------------------------------------------------------------------- 鉴权头 */

test('catalogHeaders：三种协议各自的鉴权头，且不带 Content-Type', () => {
  const openai = catalogHeaders(makeProvider({ apiKey: 'sk-1' }))
  assert.equal(openai.Authorization, 'Bearer sk-1')
  assert.equal(openai.accept, 'application/json')
  assert.equal(openai['Content-Type'], undefined)

  const anthropic = catalogHeaders(makeProvider({ protocol: 'anthropic', apiKey: 'sk-ant' }))
  assert.equal(anthropic['x-api-key'], 'sk-ant')
  assert.equal(anthropic['anthropic-version'], '2023-06-01')

  const google = catalogHeaders(makeProvider({ protocol: 'google', apiKey: 'gk' }))
  assert.equal(google['x-goog-api-key'], 'gk')
})

test('catalogHeaders：自定义头最后覆盖', () => {
  const headers = catalogHeaders(makeProvider({ headers: { accept: 'application/vnd.x+json', 'X-Title': 'DeepSea' } }))
  assert.equal(headers.accept, 'application/vnd.x+json')
  assert.equal(headers['X-Title'], 'DeepSea')
})

/* -------------------------------------------------------------------- 解析 */

test('parseCatalog：data[] 优先，各家字段别名都认', () => {
  const models = parseCatalog('openai', {
    data: [
      { id: 'gpt-4.1', name: 'GPT-4.1', context_length: 1047576, max_output_tokens: 32768 },
      { id: 'gpt-4o-mini', context_window: 128000, max_tokens: 16384 },
      { id: 'o3', max_input_tokens: 200000, top_provider: { max_completion_tokens: 100000 } },
      { id: 'tiny', limit: { context: 65536 } },
    ],
  })
  assert.deepEqual(models.map((model) => model.id), ['gpt-4.1', 'gpt-4o-mini', 'o3', 'tiny'])
  assert.equal(models[0]?.name, 'GPT-4.1')
  assert.equal(models[0]?.contextWindow, 1047576)
  assert.equal(models[0]?.maxTokens, 32768)
  assert.equal(models[1]?.contextWindow, 128000)
  assert.equal(models[1]?.maxTokens, 16384)
  assert.equal(models[2]?.contextWindow, 200000)
  assert.equal(models[2]?.maxTokens, 100000)
  assert.equal(models[3]?.contextWindow, 65536)
})

test('parseCatalog：display_name / displayName 别名', () => {
  const anthropic = parseCatalog('anthropic', { data: [{ id: 'claude-3-5-sonnet', display_name: 'Claude 3.5 Sonnet' }] })
  assert.equal(anthropic[0]?.name, 'Claude 3.5 Sonnet')
  const openrouter = parseCatalog('openai', { data: [{ id: 'x-model', displayName: 'X 模型' }] })
  assert.equal(openrouter[0]?.name, 'X 模型')
})

test('parseCatalog：Google 的 models/ 前缀要剥掉，显示名用 displayName', () => {
  const models = parseCatalog('google', {
    models: [
      { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', inputTokenLimit: 1048576, outputTokenLimit: 8192 },
      { name: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
    ],
  })
  assert.deepEqual(models.map((model) => model.id), ['gemini-2.0-flash', 'gemini-1.5-pro'])
  assert.equal(models[0]?.name, 'Gemini 2.0 Flash')
  assert.equal(models[0]?.contextWindow, 1048576)
  assert.equal(models[0]?.maxTokens, 8192)
})

test('parseCatalog：空 id 丢弃、重复 id 去重保序、不排序', () => {
  const models = parseCatalog('openai', {
    data: [{ id: '' }, { id: '   ' }, { id: 'zeta' }, { id: 'alpha' }, { id: 'zeta' }, {}, { id: 42 }],
  })
  // 顺序就是提供商给的顺序：不排序（用户看着最自然），也不过滤 embedding/tts。
  assert.deepEqual(models.map((model) => model.id), ['zeta', 'alpha'])
})

test('parseCatalog：只认正整数，0 / 负数 / 字符串都当没给', () => {
  const models = parseCatalog('openai', {
    data: [
      { id: 'a', context_length: 0, max_tokens: -1 },
      { id: 'b', context_length: '8192' },
    ],
  })
  assert.equal(models[0]?.contextWindow, undefined)
  assert.equal(models[0]?.maxTokens, undefined)
  assert.equal(models[1]?.contextWindow, undefined)
})

test('parseCatalog：models 是字典也能读', () => {
  const models = parseCatalog('openai', { models: { 'model-a': { name: 'A' }, 'model-b': {} } })
  assert.deepEqual(models.map((model) => model.id), ['model-a', 'model-b'])
  assert.equal(models[0]?.name, 'A')
})

test('parseCatalog：形状不认识时返回空数组', () => {
  assert.deepEqual(parseCatalog('openai', { hello: 'world' }), [])
  assert.deepEqual(parseCatalog('openai', null), [])
  assert.deepEqual(parseCatalog('openai', 'nope'), [])
})

/* ------------------------------------------------------------ 目录合并 / 删除 */

test('mergeCatalogModels：只追加，已有条目的顺序与元信息都不动', () => {
  const provider = { models: ['mine'], modelMeta: { mine: { name: '我的模型' } } }
  const merged = mergeCatalogModels(provider, [
    { id: 'mine', name: '别人起的名字' },
    { id: 'new', contextWindow: 128000, vision: true },
  ])
  assert.deepEqual(merged.models, ['mine', 'new'])
  assert.equal(merged.modelMeta?.mine?.name, '我的模型')
  assert.equal(merged.modelMeta?.new?.contextWindow, 128000)
  assert.equal(merged.modelMeta?.new?.vision, true)
})

test('removeCatalogModel：删模型时连元信息一起删', () => {
  const provider = { models: ['a', 'b'], modelMeta: { a: { name: 'A' }, b: { name: 'B' } } }
  const next = removeCatalogModel(provider, 'a')
  assert.deepEqual(next.models, ['b'])
  assert.deepEqual(Object.keys(next.modelMeta ?? {}), ['b'])
})

test('modelMetaText：拼成一行小字，没有元信息就是空串', () => {
  assert.equal(modelMetaText(undefined), '')
  assert.equal(modelMetaText({}), '')
  assert.equal(
    modelMetaText({ name: 'Gemini', contextWindow: 128000, maxTokens: 16000, vision: true }),
    'Gemini · 上下文 128K · 输出 16K · 看图',
  )
  assert.equal(modelMetaText({ contextWindow: 1048576 }), '上下文 1M')
})

/* ---------------------------------------------------------------- 请求与失败 */

test('fetchProviderModels：成功时返回解析后的模型，地址与头都对', async () => {
  let seenUrl = ''
  let seenInit: RequestInit = {}
  const restore = stubFetch(async (url, init) => {
    seenUrl = url
    seenInit = init
    return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }))
  })
  try {
    const result = await fetchProviderModels(makeProvider({ baseUrl: 'https://api.example.com/v1' }))
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.models.map((model) => model.id), ['a', 'b'])
  } finally {
    restore()
  }
  assert.equal(seenUrl, 'https://api.example.com/v1/models')
  assert.equal(seenInit.method, 'GET')
  const headers = seenInit.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer sk-test')
})

test('fetchProviderModels：401 / 403 提示检查 API Key', async () => {
  const restore = stubFetch(async () => new Response('nope', { status: 401 }))
  try {
    const result = await fetchProviderModels(makeProvider())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /返回 401/)
    assert.match(result.reason, /API Key/)
  } finally {
    restore()
  }
})

test('fetchProviderModels：其它非 2xx 只报状态码', async () => {
  const restore = stubFetch(async () => new Response('oops', { status: 500 }))
  try {
    const result = await fetchProviderModels(makeProvider())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'https://api.example.com/models 返回 500')
  } finally {
    restore()
  }
})

test('fetchProviderModels：响应不是 JSON', async () => {
  const restore = stubFetch(async () => new Response('<html>登录页</html>'))
  try {
    const result = await fetchProviderModels(makeProvider())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'https://api.example.com/models 的响应不是 JSON')
  } finally {
    restore()
  }
})

test('fetchProviderModels：形状不符时让用户手动添加', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({ hello: 'world' })))
  try {
    const result = await fetchProviderModels(makeProvider())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, '该地址的模型列表格式无法识别，请手动添加模型')
  } finally {
    restore()
  }
})

test('fetchProviderModels：空列表有单独的文案', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({ data: [] })))
  try {
    const result = await fetchProviderModels(makeProvider())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, '该提供商没有列出任何模型，请手动添加。')
  } finally {
    restore()
  }
})

test('fetchProviderModels：没有地址 / 网页账号都不发请求', async () => {
  let called = 0
  const restore = stubFetch(async () => {
    called += 1
    return new Response('{}')
  })
  try {
    const noBase = await fetchProviderModels(makeProvider({ baseUrl: '' }))
    assert.equal(noBase.ok, false)
    if (!noBase.ok) assert.equal(noBase.reason, '请先填写 API 地址，再获取。')

    const web = await fetchProviderModels(makeProvider({ protocol: 'deepseek-web' }))
    assert.equal(web.ok, false)
    if (!web.ok) assert.equal(web.reason, '网页账号没有可获取的模型列表')
  } finally {
    restore()
  }
  assert.equal(called, 0, '这两种情况不该真的发请求')
})

test('fetchProviderModels：网络失败给「无法连接」', async () => {
  const restore = stubFetch(async () => {
    throw new TypeError('fetch failed')
  })
  try {
    const result = await fetchProviderModels(makeProvider())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, '无法连接到 https://api.example.com/models')
  } finally {
    restore()
  }
})

test('fetchProviderModels：超时会自己断开并给超时文案', async () => {
  const restore = stubFetch(hangingFetch)
  try {
    const result = await fetchProviderModels(makeProvider(), { timeoutMs: 20 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /请求超时/)
  } finally {
    restore()
  }
})

test('fetchProviderModels：外部取消立刻放手，算「已取消」而不是超时', async () => {
  const controller = new AbortController()
  const restore = stubFetch(hangingFetch)
  try {
    const pending = fetchProviderModels(makeProvider(), { signal: controller.signal, timeoutMs: 5000 })
    setTimeout(() => controller.abort(), 10)
    const result = await pending
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, '已取消')
  } finally {
    restore()
  }
})

test('fetchProviderModels：响应超过 4MB 直接拒绝', async () => {
  const huge = 'x'.repeat(4 * 1024 * 1024 + 1)
  const restore = stubFetch(async () => new Response(huge))
  try {
    const result = await fetchProviderModels(makeProvider())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, '响应超过 4MB，无法解析')
  } finally {
    restore()
  }
})