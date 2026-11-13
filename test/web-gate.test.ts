import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveSettings } from '../src/lib/assistant.ts'
import { BUILTIN_MODELS, WEB_CHAT_MODEL } from '../src/lib/models.ts'
import { currentProvider, isWebChatProvider } from '../src/lib/providers.ts'
import { DEFAULT_SETTINGS, defaultProviders, type Assistant, type Conversation, type Provider, type Settings } from '../src/lib/types.ts'
import { applyWebGate, webChatModelVisible, webGateNotice } from '../src/lib/web-gate.ts'

/**
 * 网页账号总闸（= 纸雕虎鲸开关）。
 *
 * 这里盯的是**两层约束都要落实**：
 *   1. 不可见 —— 对话页的模型选项、设置里的供应商入口；
 *   2. 不可用 —— 不管模型来自全局、助手覆盖还是历史对话快照，最终请求配置都不能落在
 *      网页账号路径上。`isWebChatProvider` 是「模型是网页模型 **或** 供应商协议是
 *      deepseek-web」，所以两条都得堵，只换模型会留下「界面显示 API 模型、实际走网页账号」。
 *
 * 前 8 条是行为测试（直接调用真实函数）；最后 3 条是接线断言，防止 UI 层被改回无条件显示。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

const baseAssistant = DEFAULT_SETTINGS.assistants[0] as Assistant

function apiProvider(patch: Partial<Provider> = {}): Provider {
  const base = defaultProviders()[0] as Provider
  return { ...base, id: 'provider_api', name: '中转站', protocol: 'openai', apiKey: 'sk-live', models: ['deepseek-flash', 'deepseek-v4-pro'], ...patch }
}

function webProvider(patch: Partial<Provider> = {}): Provider {
  return {
    ...apiProvider(),
    id: 'provider_web',
    name: '网页账号（免 Key）',
    protocol: 'deepseek-web',
    baseUrl: 'https://chat.deepseek.com',
    apiKey: '',
    models: [WEB_CHAT_MODEL],
    ...patch,
  }
}

function settingsWith(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

function conversationWith(model: string): Conversation {
  return {
    id: 'c1',
    title: '测试对话',
    assistantId: baseAssistant.id,
    kind: 'single',
    createdAt: 0,
    updatedAt: 0,
    config: {
      name: baseAssistant.name,
      avatar: baseAssistant.avatar,
      systemPrompt: baseAssistant.systemPrompt,
      model,
      temperature: 1,
      thinkingEffort: 'off',
      presetMessages: [],
      messageTemplate: '',
      regexes: [],
      recentChats: true,
      timeReminder: true,
    },
  } as unknown as Conversation
}

/* ------------------------------------------------------- P1-1 退出供应商 */

test('P1-1：当前供应商是网页账号时，关闭闸门必须切到一个真正的 API 供应商', () => {
  const settings = settingsWith({
    webPet: false,
    model: WEB_CHAT_MODEL,
    providers: [webProvider(), apiProvider()],
    providerId: 'provider_web',
  })
  const { settings: next, switchedProviderId } = applyWebGate(settings)

  assert.equal(switchedProviderId, 'provider_web')
  assert.equal(next.providerId, 'provider_api', '没有切走供应商')
  assert.equal(currentProvider(next).protocol, 'openai', '切完仍然是 deepseek-web 协议')
  assert.equal(next.model, 'deepseek-flash', '模型没有对齐到新供应商')
  // 两条判定线都不成立，才算真的退出网页账号。
  assert.equal(isWebChatProvider(next), false, '仍然被判成网页账号模式')
  // Key / 地址跟着新供应商走，否则请求发不出去。
  assert.equal(next.apiKey, 'sk-live')
  assert.equal(next.baseUrl, 'https://api.deepseek.com')
})

test('P1-1：一个 API 供应商都没有时，补上内置的官方供应商（不删用户数据）', () => {
  const settings = settingsWith({ webPet: false, model: WEB_CHAT_MODEL, providers: [webProvider()], providerId: 'provider_web' })
  const { settings: next } = applyWebGate(settings)

  assert.equal(currentProvider(next).protocol, 'openai')
  assert.equal(isWebChatProvider(next), false)
  assert.ok(next.providers.some((item) => item.id === 'provider_web'), '原来的网页账号供应商被删了')
  assert.equal(next.providers.length, 2, '没有补上可用的 API 供应商')
})

test('P1-1：切供应商时优先挑有 Key 的那个（切过去就能用）', () => {
  const settings = settingsWith({
    webPet: false,
    model: WEB_CHAT_MODEL,
    providers: [webProvider(), apiProvider({ id: 'no_key', name: '没填 Key', apiKey: '' }), apiProvider({ id: 'has_key', name: '有 Key' })],
    providerId: 'provider_web',
  })
  assert.equal(applyWebGate(settings).settings.providerId, 'has_key')
})

/* ------------------------------------------------- P1-2 助手/快照绕过 */

test('P1-2：全局是网页模型时，闸门关着不会走网页账号路径', () => {
  const settings = settingsWith({ webPet: false, model: WEB_CHAT_MODEL, providers: [webProvider(), apiProvider()], providerId: 'provider_web' })
  const effective = effectiveSettings(settings, undefined)
  assert.notEqual(effective.model, WEB_CHAT_MODEL)
  assert.equal(isWebChatProvider(effective), false)
})

test('P1-2：助手单独覆盖成网页模型时，闸门关着也要被拦下', () => {
  const settings = settingsWith({
    webPet: false,
    model: 'deepseek-flash',
    providers: [apiProvider()],
    providerId: 'provider_api',
    assistants: [{ ...baseAssistant, model: WEB_CHAT_MODEL }],
  })
  const effective = effectiveSettings(settings, undefined)
  assert.notEqual(effective.model, WEB_CHAT_MODEL, '助手覆盖绕过了闸门')
  assert.equal(isWebChatProvider(effective), false)
})

test('P1-2：历史对话快照里存着网页模型时，闸门关着也要被拦下', () => {
  const settings = settingsWith({
    webPet: false,
    model: 'deepseek-flash',
    providers: [apiProvider()],
    providerId: 'provider_api',
  })
  const effective = effectiveSettings(settings, conversationWith(WEB_CHAT_MODEL))
  assert.notEqual(effective.model, WEB_CHAT_MODEL, '对话快照绕过了闸门')
  assert.equal(isWebChatProvider(effective), false)
})

test('P1-2：闸门打开时，助手覆盖和对话快照仍然按原优先级生效（功能不倒退）', () => {
  const settings = settingsWith({
    webPet: true,
    model: 'deepseek-flash',
    providers: [webProvider(), apiProvider()],
    providerId: 'provider_web',
    assistants: [{ ...baseAssistant, model: WEB_CHAT_MODEL }],
  })
  // 助手覆盖
  assert.equal(effectiveSettings(settings, undefined).model, WEB_CHAT_MODEL)
  // 对话快照
  assert.equal(effectiveSettings(settings, conversationWith(WEB_CHAT_MODEL)).model, WEB_CHAT_MODEL)
  // 全局本来就是网页模型时，不许被拽回 API 模型（PR #6 那条不变量）
  const globalWeb = settingsWith({ webPet: true, model: WEB_CHAT_MODEL, providers: [webProvider()], providerId: 'provider_web' })
  assert.equal(effectiveSettings(globalWeb, conversationWith('deepseek-chat')).model, WEB_CHAT_MODEL)
})

/* ------------------------------------------------------ 不误伤 / 默认值 */

test('不误伤：普通 API 供应商 + 自定义模型名原样保留', () => {
  const custom = settingsWith({
    webPet: false,
    model: 'claude-3-5-sonnet-20241022',
    providers: [apiProvider({ models: [] })],
    providerId: 'provider_api',
  })
  const { settings: next, switchedModel, switchedProviderId } = applyWebGate(custom)
  assert.equal(next.model, 'claude-3-5-sonnet-20241022', '自定义模型名被改了')
  assert.equal(switchedModel, null)
  assert.equal(switchedProviderId, null)
  assert.equal(next.providerId, 'provider_api')
})

test('默认值与幂等：新装默认关、老数据缺字段按关算、重复收敛不变', () => {
  assert.equal(DEFAULT_SETTINGS.webPet, false, '纸雕虎鲸默认必须是关的')
  assert.equal(webChatModelVisible(settingsWith()), false)

  const legacy = { ...DEFAULT_SETTINGS } as Partial<Settings>
  delete legacy.webPet
  assert.equal(webChatModelVisible(legacy as Settings), false)

  const gated = applyWebGate(settingsWith({ webPet: false, model: WEB_CHAT_MODEL, providers: [webProvider(), apiProvider()], providerId: 'provider_web' })).settings
  const again = applyWebGate(gated)
  assert.equal(again.settings.model, gated.model)
  assert.equal(again.settings.providerId, gated.providerId)
  assert.equal(again.switchedModel, null, '第二次收敛还在改动，说明不幂等')
  assert.equal(again.switchedProviderId, null)
})

test('提示语：说清楚退出了什么、切到哪，以及怎么恢复', () => {
  const change = applyWebGate(settingsWith({ webPet: false, model: WEB_CHAT_MODEL, providers: [webProvider(), apiProvider()], providerId: 'provider_web' }))
  const notice = webGateNotice(change)
  assert.ok(notice !== null)
  assert.match(notice, /网页账号已关闭/)
  assert.match(notice, /中转站/)
  assert.match(notice, /纸雕虎鲸/)
  // 什么都没变的时候不该打扰用户
  assert.equal(webGateNotice(applyWebGate(settingsWith({ webPet: true }))), null)
})

/* ------------------------------------------------------------------ 接线 */

test('接线：对话页的网页模型选项由闸门控制，且不会从「目录外 ID」那条路漏出来', () => {
  const chat = stripComments(read('src/components/Chat.tsx'))
  assert.ok(
    chat.includes('webChatModelVisible(settings) && !options.some((option) => option.id === WEB_CHAT_MODEL_INFO.id)'),
    '网页模型又被无条件塞进选项列表了',
  )
  assert.ok(
    chat.includes('!isWebChatModel(settings.model) && !options.some((option) => option.id === settings.model)'),
    '「目录外 ID」那条回落会把藏起来的网页模型重新显示出来',
  )
})

test('接线：设置页连「已有的网页账号供应商」都不显示（数据保留）', () => {
  const providers = stripComments(read('src/components/Providers.tsx'))
  assert.ok(
    providers.includes('webChatModelVisible(settings) || item.protocol !== \'deepseek-web\''),
    '已有的网页账号供应商仍然出现在列表里 —— 用户点「切换」就能回到网页账号模式',
  )
  assert.ok(providers.includes('{visibleProviders.map((provider) => ('), '列表没有用过滤后的集合渲染')
  assert.ok(providers.includes('webChatModelVisible(settings) && ('), '「添加网页账号」按钮没被闸门包住')
})

test('接线：设置变更、启动装载、每轮请求配置三处都过闸门', () => {
  const store = stripComments(read('src/lib/store.ts'))
  assert.ok(store.includes('const gated = applyWebGate(next)'), 'setSettings 没过闸门')
  assert.ok(store.includes('settings = applyWebGate(settings).settings'), 'boot 装载没过闸门（它不走 setSettings）')
  assert.ok(store.includes('setNotice(gateNotice)'), '切走之后没有提示')

  const engine = stripComments(read('src/lib/engine.ts'))
  assert.ok(
    engine.includes('const settings: Settings = applyWebGate({'),
    '每轮请求配置没过闸门 —— 群聊 respondAs 与老对话快照会绕过',
  )
  const assistant = stripComments(read('src/lib/assistant.ts'))
  assert.ok(assistant.includes('return applyWebGate({'), 'effectiveSettings 没过闸门')
})
