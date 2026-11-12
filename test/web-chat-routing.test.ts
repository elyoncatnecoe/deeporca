import test from 'node:test'
import assert from 'node:assert/strict'
import { hasApiKey, isWebChatProvider } from '../src/lib/providers.ts'
import { DEFAULT_SETTINGS, WEB_CHAT_MODEL, defaultProviders, type Settings } from '../src/lib/types.ts'
import { WEB_CHAT_MODEL_INFO, isWebChatModel } from '../src/lib/models.ts'

/**
 * 回归测试：网页账号模式必须「选模型就生效」。
 *
 * 之前踩过的坑：判定只看供应商协议，而用户是在聊天页模型下拉里选的
 * deepseek-chat-web，供应商仍是「DeepSeek 官方(openai)」，于是
 * hasApiKey 判 false → 走了本地离线回复（「我只有本能，没有语言模型」）。
 */

function settingsWith(overrides: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    providers: defaultProviders(),
    providerId: 'provider_deepseek',
    apiKey: '',
    ...overrides,
  }
}

test('选了网页模型，即使供应商还是官方 openai，也算网页模式', () => {
  const settings = settingsWith({ model: WEB_CHAT_MODEL })
  assert.equal(isWebChatModel(WEB_CHAT_MODEL), true)
  assert.equal(isWebChatProvider(settings), true, '模型是网页账号时必须是网页模式')
})

test('网页模式不要求填 Key（否则会被判成离线回复）', () => {
  const settings = settingsWith({ model: WEB_CHAT_MODEL })
  assert.equal(settings.apiKey, '')
  assert.equal(hasApiKey(settings), true, '网页模式必须被认作「可用」')
})

test('普通 API 模型仍然要求 Key', () => {
  const settings = settingsWith({ model: 'deepseek-chat' })
  assert.equal(isWebChatProvider(settings), false)
  assert.equal(hasApiKey(settings), false, '没 Key 时应继续走离线回复')
})

test('普通 API 模型填了 Key 就可用', () => {
  const settings = settingsWith({ model: 'deepseek-chat', apiKey: 'sk-test' })
  assert.equal(hasApiKey(settings), true)
})

test('供应商协议是 deepseek-web 时也算网页模式（两条路都通）', () => {
  const providers = [
    ...defaultProviders(),
    {
      id: 'provider_web',
      name: '网页账号',
      protocol: 'deepseek-web' as const,
      baseUrl: 'https://chat.deepseek.com',
      apiKey: '',
      models: [WEB_CHAT_MODEL],
      headers: {},
      enabled: true,
    },
  ]
  const settings = settingsWith({ model: WEB_CHAT_MODEL, providers, providerId: 'provider_web' })
  assert.equal(isWebChatProvider(settings), true)
  assert.equal(hasApiKey(settings), true)
})

test('网页模型在模型列表里有可读的标签', () => {
  assert.equal(WEB_CHAT_MODEL_INFO.id, WEB_CHAT_MODEL)
  assert.ok(WEB_CHAT_MODEL_INFO.hint.length > 0)
  assert.ok(WEB_CHAT_MODEL_INFO.tags.length > 0)
})