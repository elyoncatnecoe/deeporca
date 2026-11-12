import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaCatalogHeaders, mediaModelsEndpoint, parseMediaCatalog } from '../src/lib/media-catalog.ts'

/**
 * 「获取可用模型」（生图 / 语音）的纯逻辑回归。
 *
 * 最易错的三件事：地址怎么拼（用户会把完整 endpoint 贴进 baseUrl）、
 * 各协议能力字段别名叫什么、以及拿不到列表时要老实返回 null 让用户手填。
 */

test('mediaModelsEndpoint：各协议地址与兜底', () => {
  assert.equal(mediaModelsEndpoint('openai', 'https://api.openai.com/v1'), 'https://api.openai.com/v1/models')
  assert.equal(mediaModelsEndpoint('openrouter', 'https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1/models')
  assert.equal(mediaModelsEndpoint('gemini', 'https://generativelanguage.googleapis.com/v1beta'), 'https://generativelanguage.googleapis.com/v1beta/models')
  // 用户把完整 endpoint 贴进来时先剥掉，避免 /models/models
  assert.equal(mediaModelsEndpoint('openai', 'https://x/v1/images/generations'), 'https://x/v1/models')
  assert.equal(mediaModelsEndpoint('elevenlabs', 'https://api.elevenlabs.io'), 'https://api.elevenlabs.io/v1/models')
  assert.equal(mediaModelsEndpoint('elevenlabs', 'https://api.elevenlabs.io/v1'), 'https://api.elevenlabs.io/v1/models')
  // 没有稳定 /models 的协议返回 null
  assert.equal(mediaModelsEndpoint('aliyun', 'https://dashscope.aliyuncs.com/api/v1'), null)
  assert.equal(mediaModelsEndpoint('minimax', 'https://api.minimaxi.com/v1'), null)
  assert.equal(mediaModelsEndpoint('openai', ''), null)
})

test('mediaCatalogHeaders：鉴权头与额外头覆盖', () => {
  assert.equal(mediaCatalogHeaders({ protocol: 'openai', baseUrl: '', apiKey: 'sk-1', extraHeaders: {} }).Authorization, 'Bearer sk-1')
  assert.equal(mediaCatalogHeaders({ protocol: 'gemini', baseUrl: '', apiKey: 'g-1', extraHeaders: {} })['x-goog-api-key'], 'g-1')
  const extra = mediaCatalogHeaders({ protocol: 'openai', baseUrl: '', apiKey: 'sk-1', extraHeaders: { 'X-Custom': 'v' } })
  assert.equal(extra['X-Custom'], 'v')
})

test('parseMediaCatalog：按能力字段过滤生图 / 语音', () => {
  const json = {
    data: [
      { id: 'openai/gpt-4o', architecture: { output_modalities: ['text'] } },
      { id: 'bytedance/seedream', architecture: { output_modalities: ['image'] }, name: 'Seedream' },
      { id: 'openai/gpt-4o-audio-preview', architecture: { output_modalities: ['text', 'audio'] } },
      { id: 'some/tts-model' },
    ],
  }
  assert.deepEqual(parseMediaCatalog(json, 'image').map((m) => m.id), ['bytedance/seedream'])
  assert.deepEqual(parseMediaCatalog(json, 'speech').map((m) => m.id), ['openai/gpt-4o-audio-preview', 'some/tts-model'])
})

test('parseMediaCatalog：Gemini 的 supportedGenerationMethods 与 name 前缀', () => {
  const json = {
    models: [
      { name: 'models/imagen-3.0-generate-002', supportedGenerationMethods: ['predict'] },
      { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    ],
  }
  assert.deepEqual(parseMediaCatalog(json, 'image').map((m) => m.id), ['imagen-3.0-generate-002'])
  assert.deepEqual(parseMediaCatalog(json, 'speech').map((m) => m.id), ['gemini-2.5-flash-preview-tts'])
})

test('parseMediaCatalog：裸数组（ElevenLabs）也能解析', () => {
  const json = [{ model_id: 'eleven_multilingual_v2', name: 'Multilingual v2' }]
  assert.deepEqual(parseMediaCatalog(json, 'speech'), [{ id: 'eleven_multilingual_v2', name: 'Multilingual v2' }])
})

test('parseMediaCatalog：形状不认识返回空数组（交由调用方提示手填）', () => {
  assert.deepEqual(parseMediaCatalog({ foo: 'bar' }, 'image'), [])
  assert.deepEqual(parseMediaCatalog('not json', 'image'), [])
})
