import test from 'node:test'
import assert from 'node:assert/strict'
import { NetError, nativeTransportAvailable, netRequest, netRequestBinary, netStream, transportName } from '../src/lib/net.ts'

/**
 * 网络传输层的回归锁（2026-11-03 的「三家接口只有一家能上」）。
 *
 * 根因不是那三家站点，而是「WebView 直连第三方 API」这个架构：对方不返回
 * Access-Control-Allow-Origin 时，浏览器只会给一句 Failed to fetch。这里锁三件事：
 *   1. 传输层在纯浏览器环境会落到 fetch，并把 CORS 失败翻译成能行动的话；
 *   2. 原生通道（桌面/安卓）不走 CORS，同样的调用能拿到响应；
 *   3. 流式请求按 chunk 回调、结束时给出最终状态。
 */

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

test('纯 node / 浏览器环境没有原生通道，传输层名字是 fetch', () => {
  assert.equal(nativeTransportAvailable(), false)
  assert.equal(transportName(), '浏览器 fetch')
})

test('netRequest：成功时返回状态、响应头与正文', async () => {
  const restore = stubFetch(async () => new Response('{"ok":true}', { status: 200, headers: { 'x-test': '1' } }))
  try {
    const response = await netRequest({ url: 'https://api.example.com/v1/models', method: 'GET' })
    assert.equal(response.status, 200)
    assert.equal(response.text, '{"ok":true}')
    assert.equal(response.headers['x-test'], '1')
  } finally {
    restore()
  }
})

test('netRequest：CORS 被拦时给出「换网络没用」的可行动提示，而不是装成网络不好', async () => {
  const restore = stubFetch(async () => {
    throw new TypeError('Failed to fetch')
  })
  try {
    await assert.rejects(
      () => netRequest({ url: 'https://model.inferx.net/endpoints/v1/models' }),
      (error: unknown) => {
        assert.ok(error instanceof NetError)
        assert.equal(error.kind, 'network')
        assert.match(error.message, /跨域/)
        assert.match(error.message, /model\.inferx\.net/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('netRequest：超时单独归一类，不混进 CORS 文案', async () => {
  const restore = stubFetch(async (_url, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  })
  try {
    await assert.rejects(
      () => netRequest({ url: 'https://slow.example.com/v1/models', timeoutMs: 20 }),
      (error: unknown) => {
        assert.ok(error instanceof NetError)
        assert.equal(error.kind, 'timeout')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('netStream：逐块回调，结束时给最终状态与完整正文', async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"a":1}\n\n'))
      controller.enqueue(encoder.encode('data: {"b":2}\n\n'))
      controller.close()
    },
  })
  const restore = stubFetch(async () => new Response(body, { status: 200 }))
  const chunks: string[] = []
  let status = 0
  try {
    const response = await netStream(
      { url: 'https://api.example.com/v1/chat/completions', method: 'POST', body: '{}' },
      { onStatus: (next) => { status = next }, onChunk: (chunk) => chunks.push(chunk) },
    )
    assert.equal(status, 200)
    assert.equal(response.status, 200)
    assert.equal(chunks.join(''), 'data: {"a":1}\n\ndata: {"b":2}\n\n')
    assert.equal(response.text, chunks.join(''))
  } finally {
    restore()
  }
})

test('netStream：用户点停止时以 aborted 结束，不报成网络故障', async () => {
  const restore = stubFetch(async (_url, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  })
  const controller = new AbortController()
  try {
    const pending = netStream(
      { url: 'https://api.example.com/v1/chat/completions', method: 'POST', body: '{}', signal: controller.signal },
      {},
    )
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof NetError)
      assert.equal(error.kind, 'aborted')
      return true
    })
  } finally {
    restore()
  }
})

test('netRequestBinary：二进制按 base64 返回，JSON 错误体保留 text', async () => {
  const restore = stubFetch(async () => new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  }))
  try {
    const audio = await netRequestBinary({ url: 'https://api.example.com/audio/speech', method: 'POST' })
    assert.equal(audio.status, 200)
    assert.equal(audio.mime, 'audio/mpeg')
    assert.equal(audio.base64, 'SUQzBA==')
    assert.equal(audio.text, undefined)
  } finally {
    restore()
  }

  const restoreError = stubFetch(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  }))
  try {
    const failure = await netRequestBinary({ url: 'https://api.example.com/audio/speech', method: 'POST' })
    assert.equal(failure.status, 401)
    assert.match(failure.text ?? '', /bad key/)
  } finally {
    restoreError()
  }
})
