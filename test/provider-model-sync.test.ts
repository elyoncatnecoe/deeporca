import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mirrorProviderFields,
  patchProvider,
  settleProviderOnBoot,
  syncProviderToSettings,
} from '../src/lib/providers.ts'
import { checkModelId, modelInProviderList } from '../src/lib/models.ts'
import { DEFAULT_SETTINGS, type Provider, type Settings } from '../src/lib/types.ts'

/** 默认供应商的形状：models 列表里只有内置那四个。 */
function officialProvider(patch: Partial<Provider> = {}): Provider {
  return {
    id: 'provider_deepseek',
    name: 'DeepSeek 官方',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    headers: {},
    enabled: true,
    ...patch,
  }
}

function settingsWith(model: string, patch: Partial<Provider> = {}): Settings {
  const provider = officialProvider(patch)
  return { ...DEFAULT_SETTINGS, model, providers: [provider], providerId: provider.id }
}

/** 复刻 store.setSettings 的收敛规则（判据是 providerId 的值真的变了）。 */
function applyPatch(current: Settings, patch: Partial<Settings>): Settings {
  let next = { ...current, ...patch }
  const providerChanged = patch.providerId !== undefined && patch.providerId !== current.providerId
  if (providerChanged) next = syncProviderToSettings(next)
  else if (patch.providers !== undefined) next = mirrorProviderFields(next)
  return next
}

test('改 API Key 不会把自定义模型名冲掉', () => {
  let state = settingsWith('my-custom-model')
  for (const key of ['s', 'sk', 'sk-', 'sk-abc']) {
    const providers = state.providers.map((item) =>
      item.id === state.providerId ? { ...item, apiKey: key } : item,
    )
    state = applyPatch(state, { providers, apiKey: key })
  }
  assert.equal(state.model, 'my-custom-model')
  assert.equal(state.apiKey, 'sk-abc')
})

test('改 API 地址不会把自定义模型名冲掉', () => {
  const state = settingsWith('my-custom-model')
  const providers = state.providers.map((item) => ({ ...item, baseUrl: 'https://proxy.example.com' }))
  const next = applyPatch(state, { providers, baseUrl: 'https://proxy.example.com' })
  assert.equal(next.model, 'my-custom-model')
  assert.equal(next.baseUrl, 'https://proxy.example.com')
})

test('重启（loadSettings 路径）保留自定义模型名', () => {
  const next = settleProviderOnBoot(settingsWith('deepseek-ai/DeepSeek-V3'))
  assert.equal(next.model, 'deepseek-ai/DeepSeek-V3')
})

test('重启时模型为空才回落到供应商第一个模型', () => {
  const next = settleProviderOnBoot(settingsWith(''))
  assert.equal(next.model, 'deepseek-flash')
})

test('真正切换供应商时仍然回落，避免请求不存在的模型', () => {
  const first = officialProvider()
  const second: Provider = { ...officialProvider(), id: 'p2', name: '中转站', models: ['only-a'] }
  const state: Settings = {
    ...DEFAULT_SETTINGS,
    model: 'my-custom-model',
    providers: [first, second],
    providerId: first.id,
  }
  const next = applyPatch(state, { providerId: 'p2' })
  assert.equal(next.model, 'only-a')
})

test('模型名校验接受各家真实写法，只拦发不出去的', () => {
  const legal = [
    'deepseek-chat',
    'gpt-4.1',
    'claude-3-5-sonnet-20241022',
    'deepseek-ai/DeepSeek-V3',
    'models/gemini-1.5-pro',
    'Qwen2.5-72B-Instruct',
  ]
  for (const id of legal) {
    const result = checkModelId(id)
    assert.equal(result.ok, true, `${id} 应该合法`)
    assert.equal(result.model, id)
  }
  assert.equal(checkModelId('').ok, false)
  assert.equal(checkModelId('   ').ok, false)
  assert.equal(checkModelId('has space').ok, false)
  assert.equal(checkModelId('x'.repeat(129)).ok, false)
  assert.equal(checkModelId('  deepseek-chat  ').model, 'deepseek-chat')
})

test('供应商没声明模型列表时不提示「不在列表里」', () => {
  assert.equal(modelInProviderList([], 'anything'), true)
  assert.equal(modelInProviderList(['a'], 'a'), true)
  assert.equal(modelInProviderList(['a'], 'b'), false)
})
test('删掉一个无关供应商不会把自定义模型名重置', () => {
  const first = officialProvider()
  const extra: Provider = { ...officialProvider(), id: 'p_extra', name: '备用', models: ['only-a'] }
  const state: Settings = {
    ...DEFAULT_SETTINGS,
    model: 'my-custom-model',
    providers: [first, extra],
    providerId: first.id,
  }
  // 供应商页 remove() 的写法：providerId 会一起传，但值没变。
  const providers = state.providers.filter((item) => item.id !== extra.id)
  const next = applyPatch(state, { providers, providerId: state.providerId })
  assert.equal(next.model, 'my-custom-model')
})

test('按 id 合并供应商字段，不会丢掉其他字段（Key 不能被地址覆盖掉）', () => {
  const provider = officialProvider({ apiKey: 'sk-keep-me' })
  const other = { ...officialProvider(), id: 'p_other', apiKey: 'sk-other' }
  const list = [provider, other]

  const afterUrl = patchProvider(list, provider.id, { baseUrl: 'https://proxy.example.com' })
  assert.equal(afterUrl[0]?.apiKey, 'sk-keep-me', '改地址不该动 key')
  assert.equal(afterUrl[0]?.baseUrl, 'https://proxy.example.com')
  assert.equal(afterUrl[1]?.apiKey, 'sk-other', '别的供应商不受影响')
  assert.equal(afterUrl[1]?.baseUrl, 'https://api.deepseek.com')

  const afterKey = patchProvider(afterUrl, provider.id, { apiKey: 'sk-new' })
  assert.equal(afterKey[0]?.apiKey, 'sk-new')
  assert.equal(afterKey[0]?.baseUrl, 'https://proxy.example.com', '改 key 不该动地址')
})
