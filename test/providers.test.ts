import assert from 'node:assert/strict'
import test from 'node:test'
import { hasApiKey, isWebChatProvider } from '../src/lib/providers.ts'
import { DEFAULT_SETTINGS, defaultProviders, type Provider, type Settings } from '../src/lib/types.ts'

function webSettings(patch: Partial<Provider> = {}): Settings {
  const provider: Provider = {
    id: 'provider_web',
    name: '网页账号',
    protocol: 'deepseek-web',
    baseUrl: 'https://chat.deepseek.com',
    apiKey: '',
    models: ['deepseek-web'],
    headers: {},
    enabled: true,
    ...patch,
  }
  return { ...DEFAULT_SETTINGS, apiKey: '', providers: [provider], providerId: provider.id }
}

test('网页账号模式不需要 Key 也算可用', () => {
  const settings = webSettings()
  assert.equal(isWebChatProvider(settings), true)
  assert.equal(hasApiKey(settings), true)
})

test('普通供应商没有 Key 就不可用', () => {
  const provider: Provider = { ...(defaultProviders()[0] as Provider), apiKey: '' }
  const settings: Settings = { ...DEFAULT_SETTINGS, apiKey: '', providers: [provider], providerId: provider.id }
  assert.equal(isWebChatProvider(settings), false)
  assert.equal(hasApiKey(settings), false)
})

test('普通供应商填了 Key 就可用', () => {
  const provider: Provider = { ...(defaultProviders()[0] as Provider), apiKey: 'sk-test' }
  const settings: Settings = { ...DEFAULT_SETTINGS, apiKey: '', providers: [provider], providerId: provider.id }
  assert.equal(hasApiKey(settings), true)
})

test('网页账号模式下即使残留旧 Key 也优先走网页', () => {
  const settings = webSettings({ apiKey: 'sk-stale-old-key' })
  assert.equal(isWebChatProvider(settings), true)
  assert.equal(hasApiKey(settings), true)
})