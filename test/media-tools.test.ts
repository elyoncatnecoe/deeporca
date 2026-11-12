import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { DEFAULT_SETTINGS, type ImageApiConfig, type Settings, type SpeechApiConfig } from '../src/lib/types.ts'
import {
  dataUrlOf,
  estimateDataUrlBytes,
  mediaRefOf,
  parseDataUrl,
  sanitizeMediaRecord,
} from '../src/lib/media-store.ts'
import {
  generateImages,
  mediaApiUrl,
  MediaApiError,
  synthesizeSpeech,
} from '../src/lib/media-api.ts'
import {
  GENERATE_IMAGE_TOOL_NAME,
  SPEAK_TOOL_NAME,
  mediaToolDefinitions,
  runMediaTool,
} from '../src/lib/media-tools.ts'

// media-api / media-tools 内部沿用项目风格的无扩展名相对 import；Node 的 ESM
// 解析器不认，补一个 .ts 解析钩子，测试才能直接跑源码而不是抄一份规则。
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

/** 1×1 透明 PNG，测试里用来假装生图接口返回。 */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lQn4WQAAAABJRU5ErkJggg=='

function imageConfig(patch: Partial<ImageApiConfig> = {}): ImageApiConfig {
  return {
    ...DEFAULT_SETTINGS.imageApi,
    enabled: true,
    protocol: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-test',
    model: 'bytedance-seed/seedream-4.5',
    ...patch,
  }
}

function speechConfig(patch: Partial<SpeechApiConfig> = {}): SpeechApiConfig {
  return {
    ...DEFAULT_SETTINGS.speechApi,
    enabled: true,
    protocol: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-test',
    model: 'openai/gpt-4o-audio-preview',
    ...patch,
  }
}

function settingsWith(imageApi?: ImageApiConfig, speechApi?: SpeechApiConfig): Settings {
  return {
    ...DEFAULT_SETTINGS,
    imageApi: imageApi ?? DEFAULT_SETTINGS.imageApi,
    speechApi: speechApi ?? DEFAULT_SETTINGS.speechApi,
  }
}

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

test('media-store：data URL 解析、字节估算、引用不携带 dataUrl', () => {
  const url = dataUrlOf('image/png', TINY_PNG)
  const parsed = parseDataUrl(url)
  assert.equal(parsed?.mime, 'image/png')
  assert.ok((parsed?.base64.length ?? 0) > 10)
  assert.ok(estimateDataUrlBytes(url) > 0)
  assert.equal(parseDataUrl('https://example.com/a.png'), null)

  const record = {
    id: 'media_1',
    conversationId: 'conv_1',
    messageId: 'msg_1',
    kind: 'image' as const,
    mime: 'image/png',
    dataUrl: url,
    prompt: '一只虎鲸',
    createdAt: 1,
  }
  const ref = mediaRefOf(record)
  assert.equal(ref.id, 'media_1')
  assert.equal(ref.kind, 'image')
  assert.equal('dataUrl' in ref, false, '消息引用绝不能带 dataUrl')
})

test('media-store：脏媒体记录不炸，坏 data URL 直接丢掉', () => {
  assert.equal(sanitizeMediaRecord(null), null)
  assert.equal(sanitizeMediaRecord({ id: 'x', kind: 'image', dataUrl: 'not-a-data-url' }), null)
  const ok = sanitizeMediaRecord({
    id: 'm1', conversationId: 'c1', messageId: 'msg1', kind: 'audio', mime: 'audio/mpeg',
    dataUrl: dataUrlOf('audio/mpeg', 'SUQz'), createdAt: 123,
  })
  assert.equal(ok?.kind, 'audio')
})

test('media API：URL 不重复拼 endpoint，完整地址也能用', () => {
  assert.equal(mediaApiUrl('https://openrouter.ai/api/v1', '/images'), 'https://openrouter.ai/api/v1/images')
  assert.equal(mediaApiUrl('https://openrouter.ai/api/v1/', '/images'), 'https://openrouter.ai/api/v1/images')
  assert.equal(mediaApiUrl('https://openrouter.ai/api/v1/images', '/images'), 'https://openrouter.ai/api/v1/images')
  assert.equal(mediaApiUrl('https://api.openai.com/v1', '/audio/speech'), 'https://api.openai.com/v1/audio/speech')
})

test('media-tools：未配置时不给模型媒体工具；配置后只给对应工具', () => {
  assert.deepEqual(mediaToolDefinitions(settingsWith()), [])
  const onlyImage = mediaToolDefinitions(settingsWith(imageConfig()))
  assert.equal(onlyImage.length, 1)
  assert.equal((onlyImage[0] as { function: { name: string } }).function.name, GENERATE_IMAGE_TOOL_NAME)
  const both = mediaToolDefinitions(settingsWith(imageConfig(), speechConfig()))
  assert.deepEqual(both.map((tool) => (tool as { function: { name: string } }).function.name).sort(), [GENERATE_IMAGE_TOOL_NAME, SPEAK_TOOL_NAME].sort())
})

test('media-tools：未配置时调用返回配置提示，不抛异常', async () => {
  const outcome = await runMediaTool(GENERATE_IMAGE_TOOL_NAME, '{"prompt":"猫"}', {
    settings: settingsWith(),
    conversationId: 'c1',
    referenceImages: [],
  })
  assert.match(outcome.resultText, /还没配置/)
  assert.deepEqual(outcome.media, [])
})

test('media-tools：generate_image 走 OpenRouter /images，图生图带 input_references', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const restore = stubFetch(async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG, media_type: 'image/png' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  try {
    const outcome = await runMediaTool(GENERATE_IMAGE_TOOL_NAME, JSON.stringify({
      prompt: '把背景改成雪山',
      size: '1024x1024',
      count: 1,
      reference: 'last_user_images',
    }), {
      settings: settingsWith(imageConfig()),
      conversationId: 'c1',
      referenceImages: [dataUrlOf('image/png', TINY_PNG)],
    })
    assert.match(outcome.resultText, /已生成 1 张图片/)
    assert.equal(outcome.media.length, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'https://openrouter.ai/api/v1/images')
    assert.equal(calls[0]?.body.model, 'bytedance-seed/seedream-4.5')
    assert.equal(calls[0]?.body.prompt, '把背景改成雪山')
    assert.equal(Array.isArray(calls[0]?.body.input_references), true)
  } finally {
    restore()
  }
})

test('media-tools：generate_image 无参考图却要求 last_user_images 时拒绝调用', async () => {
  let called = false
  const restore = stubFetch(async () => {
    called = true
    return new Response('{}', { status: 200 })
  })
  try {
    const outcome = await runMediaTool(GENERATE_IMAGE_TOOL_NAME, JSON.stringify({
      prompt: '改这张图',
      reference: 'last_user_images',
    }), {
      settings: settingsWith(imageConfig()),
      conversationId: 'c1',
      referenceImages: [],
    })
    assert.match(outcome.resultText, /没有可参考的图片/)
    assert.equal(called, false)
  } finally {
    restore()
  }
})

test('media API：OpenRouter 生图返回 b64_json → data URL；错误响应变可读中文', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({
    data: [{ b64_json: TINY_PNG, media_type: 'image/png' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  try {
    const images = await generateImages(imageConfig(), { prompt: '猫' })
    assert.equal(images.length, 1)
    assert.equal(images[0]?.mime, 'image/png')
    assert.ok(images[0]?.dataUrl.startsWith('data:image/png;base64,'))
  } finally {
    restore()
  }

  const restoreError = stubFetch(async () => new Response(JSON.stringify({ error: { message: 'insufficient balance' } }), {
    status: 402,
    headers: { 'Content-Type': 'application/json' },
  }))
  try {
    await assert.rejects(() => generateImages(imageConfig(), { prompt: '猫' }), (error: unknown) => {
      assert.ok(error instanceof MediaApiError)
      assert.match(error.message, /余额不足/)
      return true
    })
  } finally {
    restoreError()
  }
})

test('media API：OpenRouter 语音从 SSE 的 delta.audio.data 收集并拼成 data URL', async () => {
  const audioBytes = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00])
  const chunk = Buffer.from(audioBytes).toString('base64')
  const encoder = new TextEncoder()
  const restores = stubFetch(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: chunk } } }] })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  })
  try {
    const audio = await synthesizeSpeech(speechConfig(), '你好')
    assert.ok(audio.dataUrl.startsWith('data:audio/mpeg;base64,'))
    assert.ok(audio.dataUrl.length > 'data:audio/mpeg;base64,'.length)
  } finally {
    restores()
  }
})

test('Gemini Imagen：走 :predict，解析 bytesBase64Encoded', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const restore = stubFetch(async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    return new Response(JSON.stringify({ predictions: [{ bytesBase64Encoded: TINY_PNG, mimeType: 'image/png' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  try {
    const images = await generateImages(imageConfig({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'imagen-3.0-generate-002',
    }), { prompt: '一只猫', size: '1024x1024', count: 1 })
    assert.equal(images.length, 1)
    assert.equal(images[0]?.mime, 'image/png')
    assert.equal(calls[0]?.url, 'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict')
    assert.deepEqual((calls[0]?.body.instances as Array<Record<string, unknown>>)[0], { prompt: '一只猫' })
  } finally {
    restore()
  }
})

test('Gemini 图像模型：generateContent 的 inlineData 图片能被解析', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG } }] } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  try {
    const images = await generateImages(imageConfig({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash-image',
    }), { prompt: '一只猫' })
    assert.equal(images.length, 1)
    assert.equal(images[0]?.mime, 'image/png')
  } finally {
    restore()
  }
})

test('Gemini TTS：inlineData 的 PCM 会包成可播放的 WAV', async () => {
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]).toString('base64')
  const restore = stubFetch(async () => new Response(JSON.stringify({
    candidates: [{
      content: {
        parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm } }],
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  try {
    const audio = await synthesizeSpeech(speechConfig({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash-preview-tts',
      voice: 'Kore',
    }), '你好')
    assert.equal(audio.mime, 'audio/wav')
    assert.ok(audio.dataUrl.startsWith('data:audio/wav;base64,'))
    // WAV 头前 4 字节是 RIFF。
    const wav = Buffer.from(audio.dataUrl.split(',')[1] ?? '', 'base64')
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF')
  } finally {
    restore()
  }
})

test('MiniMax TTS：把 data.audio 的十六进制转成音频 data URL', async () => {
  const hex = Buffer.from('ID3test').toString('hex')
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const restore = stubFetch(async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    return new Response(JSON.stringify({ data: { audio: hex, status: 2 }, extra_info: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  try {
    const audio = await synthesizeSpeech(speechConfig({
      protocol: 'minimax',
      baseUrl: 'https://api.minimaxi.com/v1',
      model: 'speech-2.6-turbo',
      voice: 'English_Graceful_Lady',
    }), '你好')
    assert.ok(audio.dataUrl.startsWith('data:audio/mpeg;base64,'))
    assert.equal(calls[0]?.url, 'https://api.minimaxi.com/v1/t2a_v2')
    assert.equal((calls[0]?.body.voice_setting as Record<string, unknown>).voice_id, 'English_Graceful_Lady')
  } finally {
    restore()
  }
})

test('阿里百炼生图：解析 output.choices[].message.content[].image 并下载', async () => {
  const calls: string[] = []
  const restore = stubFetch(async (url) => {
    calls.push(url)
    if (url.includes('cdn.example.com')) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    }
    return new Response(JSON.stringify({
      output: { choices: [{ message: { content: [{ image: 'https://cdn.example.com/generated.png' }] } }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  try {
    const images = await generateImages(imageConfig({
      protocol: 'aliyun',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      model: 'qwen-image',
    }), { prompt: '一只猫', size: '1024x1024', count: 1 })
    assert.equal(images.length, 1)
    assert.equal(images[0]?.mime, 'image/png')
    assert.ok(calls.some((url) => url.includes('/services/aigc/multimodal-generation/generation')))
    assert.ok(calls.includes('https://cdn.example.com/generated.png'))
  } finally {
    restore()
  }
})

test('ElevenLabs：走 /v1/text-to-speech/<voice>，xi-api-key 与二进制音频', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const restore = stubFetch(async (url, init) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> })
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    })
  })
  try {
    const audio = await synthesizeSpeech(speechConfig({
      protocol: 'elevenlabs',
      baseUrl: 'https://api.elevenlabs.io',
      model: 'eleven_multilingual_v2',
      voice: 'voice-id',
    }), '你好')
    assert.ok(audio.dataUrl.startsWith('data:audio/mpeg;base64,'))
    assert.match(calls[0]?.url ?? '', /\/v1\/text-to-speech\/voice-id\?output_format=mp3_44100_128/)
    assert.equal(calls[0]?.headers['xi-api-key'], 'sk-or-test')
  } finally {
    restore()
  }
})

test('阿里百炼 TTS：解析 output.audio.url 并下载音频', async () => {
  const calls: string[] = []
  const restore = stubFetch(async (url) => {
    calls.push(url)
    if (url.includes('cdn.example.com')) {
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      })
    }
    return new Response(JSON.stringify({ output: { audio: { url: 'https://cdn.example.com/tts.wav' } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  try {
    const audio = await synthesizeSpeech(speechConfig({
      protocol: 'aliyun',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      model: 'qwen3-tts-flash',
      voice: 'Cherry',
    }), '你好')
    assert.equal(audio.mime, 'audio/wav')
    assert.ok(calls.some((url) => url.includes('/services/aigc/multimodal-generation/generation')))
    assert.ok(calls.includes('https://cdn.example.com/tts.wav'))
  } finally {
    restore()
  }
})

/* ------------------------------------------- 批次 3 · B 组（T-12 / T-16） */

test('T-12：CRLF 分隔的语音 SSE 也要能切出事件（以前整段 join 成坏包 → 502）', async () => {
  // 两段音频各自是一段合法 base64，拼起来的字节数必须等于两段之和。
  const first = Uint8Array.from([0x49, 0x44, 0x33, 0x04])
  const second = Uint8Array.from([0x00, 0x01, 0x02, 0x03])
  const chunkOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
  const encoder = new TextEncoder()
  const restore = stubFetch(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        /*
         * 关键：**一个 chunk 里两个事件**，而且用 CRLF 分隔。
         * `\r\n\r\n` 里不含 `\n\n`，旧代码 indexOf('\n\n') 一个边界都找不到，
         * 收尾时把两行 data: 拼成一个 payload 去 JSON.parse → 必然失败。
         */
        const events = [
          `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: chunkOf(first) } } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: chunkOf(second) } } }] })}`,
          'data: [DONE]',
        ]
        controller.enqueue(encoder.encode(`${events.join('\r\n\r\n')}\r\n\r\n`))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  })
  try {
    const audio = await synthesizeSpeech(speechConfig(), '你好')
    const parsed = parseDataUrl(audio.dataUrl)
    assert.ok(parsed !== null)
    assert.equal(
      Buffer.from(parsed.base64, 'base64').length,
      first.length + second.length,
      '两段音频没都被收到（CRLF 边界没切开，或者只吃到一段）',
    )
  } finally {
    restore()
  }
})

test('T-16：同一批多张图前 80 个 base64 字符相同，不能被当成重复丢掉', async () => {
  // 同格式、同尺寸的 PNG 前 80 个 base64 字符往往逐字相同（文件头、尺寸块、编码参数），
  // 只有尾部不一样。这里直接构造这种形状：前 80 字符一致，长度一致，尾部不同。
  const shared = 'A'.repeat(80)
  const first = `${shared}${'X'.repeat(40)}`
  const second = `${shared}${'Y'.repeat(40)}`
  const restore = stubFetch(async () => new Response(JSON.stringify({
    predictions: [
      { bytesBase64Encoded: first, mimeType: 'image/png' },
      { bytesBase64Encoded: second, mimeType: 'image/png' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  try {
    const images = await generateImages(imageConfig({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'imagen-3.0-generate-002',
    }), { prompt: '四只猫', count: 2 })
    assert.equal(images.length, 2, '两张真图被判成重复，只回来一张')
    assert.notEqual(images[0]?.dataUrl, images[1]?.dataUrl)
  } finally {
    restore()
  }
})

/* ------------------------------------------- 批次 3 · C 组（T-19 / T-20） */

/**
 * 一段解码后超过 16MB 的 base64。
 *
 * mediaWithinLimit 判的是**解码后字节**，所以 base64 长度要超过 16MB × 4/3 ≈ 22.4MB。
 * 这个字符串只在用到它的两条用例里才分配（懒加载），别拖慢其它用例。
 */
let oversizedBase64Cache: string | undefined
function oversizedImageBase64(): string {
  oversizedBase64Cache ??= 'A'.repeat(24 * 1024 * 1024)
  return oversizedBase64Cache
}

test('T-19：超过 16MB 的生成图不进 media，也不落库', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({
    predictions: [{ bytesBase64Encoded: oversizedImageBase64(), mimeType: 'image/png' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  try {
    const outcome = await runMediaTool(GENERATE_IMAGE_TOOL_NAME, '{"prompt":"一只猫"}', {
      settings: settingsWith(imageConfig({
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'imagen-3.0-generate-002',
      })),
      conversationId: 'c1',
      referenceImages: [],
    })
    // 用 length 而不是 deepEqual([])：失败时不要把 25MB 的 data URL 打进日志。
    assert.equal(outcome.media.length, 0, '超限的图仍然被交给 engine 写库了')
    assert.match(outcome.resultText, /太大/)
  } finally {
    restore()
  }
})

test('T-19：超过 12MB 的语音不进 media', async () => {
  // 13MB 字节 → base64 约 17.3MB，超过 MAX_AUDIO_BYTES（12MB）。
  const audioBytes = 13 * 1024 * 1024
  const chunk = Buffer.alloc(audioBytes, 0x41).toString('base64')
  const encoder = new TextEncoder()
  const restore = stubFetch(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: chunk } } }] })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  })
  try {
    const outcome = await runMediaTool(SPEAK_TOOL_NAME, '{"text":"很长的一段话"}', {
      settings: settingsWith(undefined, speechConfig()),
      conversationId: 'c1',
      referenceImages: [],
    })
    assert.equal(outcome.media.length, 0, '超限的语音仍然被交给 engine 写库了')
    assert.match(outcome.resultText, /太长/)
  } finally {
    restore()
  }
})

test('T-19：参考图最多带 4 张，多出来的不进请求体', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = []
  const restore = stubFetch(async (_url, init) => {
    calls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> })
    return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  try {
    const references = [1, 2, 3, 4, 5, 6].map((index) => dataUrlOf('image/png', Buffer.from([index]).toString('base64')))
    await generateImages(imageConfig(), { prompt: '参考这几张', referenceImages: references })
    const sent = calls[0]?.body.input_references as unknown[]
    assert.ok(Array.isArray(sent))
    assert.equal(sent.length, 4, '参考图没有按 4 张截断，请求体白涨一倍')
  } finally {
    restore()
  }
})

test('T-19：参考图超过 16MB 时直接说清楚，而不是偷偷不带图去生成', async () => {
  const restore = stubFetch(async () => {
    throw new Error('不该发请求：体积闸门在发请求之前就该拦下')
  })
  try {
    await assert.rejects(
      () => generateImages(imageConfig(), {
        prompt: '参考这张',
        referenceImages: [dataUrlOf('image/png', oversizedImageBase64())],
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaApiError)
        assert.match(error.message, /参考图太大/)
        return true
      },
    )
  } finally {
    restore()
  }
})
