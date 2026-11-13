import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_MODELS, WEB_CHAT_MODEL } from '../src/lib/models.ts'
import { DEFAULT_SETTINGS, defaultProviders, type Provider, type Settings } from '../src/lib/types.ts'
import { webChatFallbackModel, webChatFallbackNotice, webChatModelVisible } from '../src/lib/web-gate.ts'

/**
 * 网页账号模型（deepseek-chat-web）的可见性闸门。
 *
 * 需求：它默认不出现在前端对话的模型列表里，和「纸雕虎鲸」共用同一个开关；
 * 打开纸雕虎鲸，模型和对应功能一起回来。其余行为不变。
 *
 * 前六条是行为测试（纯模块，直接跑）；后面三条是接线断言 —— Chat / Providers 是 React
 * 组件，store 依赖 IndexedDB，node 里跑不起来，但「有没有真的接上这个闸门」必须守住，
 * 否则改回无条件 push 也不会有人发现。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

/** 去掉注释，避免注释里解释规矩的字眼被当成代码（CRLF 检出也能正确切行）。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

function settingsWith(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

/** 一个普通 API 供应商：模型列表里有网页模型之外的东西。 */
function apiProvider(): Provider {
  const base = defaultProviders()[0] as Provider
  return { ...base, models: ['deepseek-flash', 'deepseek-v4-pro'] }
}

/* ------------------------------------------------------------------ 行为 */

test('新装默认：纸雕虎鲸关着，网页账号模型不可见', () => {
  assert.equal(DEFAULT_SETTINGS.webPet, false, '纸雕虎鲸默认必须是关的')
  assert.equal(webChatModelVisible(settingsWith()), false)
})

test('开关打开才可见；老数据缺字段一律按「关」算', () => {
  assert.equal(webChatModelVisible(settingsWith({ webPet: true })), true)
  // 老数据里这个字段可能是 undefined：不能因为 undefined 就当成开着。
  const legacy = { ...DEFAULT_SETTINGS } as Partial<Settings>
  delete legacy.webPet
  assert.equal(webChatModelVisible(legacy as Settings), false)
})

test('闸门关着且模型停在网页模型上时，切回供应商自己的 API 模型', () => {
  const settings = settingsWith({ webPet: false, model: WEB_CHAT_MODEL, providers: [apiProvider()] })
  assert.equal(webChatFallbackModel(settings), 'deepseek-flash')
})

test('不需要切的时候返回 null：模型不是网页模型，或者开关本来就是开的', () => {
  assert.equal(webChatFallbackModel(settingsWith({ webPet: false, model: 'deepseek-flash' })), null)
  assert.equal(webChatFallbackModel(settingsWith({ webPet: true, model: WEB_CHAT_MODEL })), null)
})

test('供应商列表里只剩网页模型时，退回内置默认模型（不能切回它自己）', () => {
  const webProvider: Provider = { ...apiProvider(), id: 'provider_web', protocol: 'deepseek-web', models: [WEB_CHAT_MODEL] }
  const settings = settingsWith({ webPet: false, model: WEB_CHAT_MODEL, providers: [webProvider], providerId: 'provider_web' })
  const fallback = webChatFallbackModel(settings)
  assert.equal(fallback, BUILTIN_MODELS[0]?.id)
  assert.notEqual(fallback, WEB_CHAT_MODEL, '切回网页模型自己等于没切')
})

test('提示语说清楚发生了什么，以及怎么恢复', () => {
  const text = webChatFallbackNotice('deepseek-flash')
  assert.match(text, /网页账号已关闭/)
  assert.match(text, /deepseek-flash/)
  assert.match(text, /纸雕虎鲸/)
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

test('接线：设置里的「网页账号」供应商入口跟着同一个闸门走', () => {
  const providers = stripComments(read('src/components/Providers.tsx'))
  assert.ok(
    providers.includes('webChatModelVisible(settings) && ('),
    '网页账号供应商入口没被闸门包住 —— 用户仍能在设置里手动建出来',
  )
})

test('接线：设置变更时会把停在网页模型上的当前模型切走，并给出常驻提示', () => {
  const store = stripComments(read('src/lib/store.ts'))
  assert.ok(store.includes('const fallbackModel = webChatFallbackModel(next)'), 'setSettings 里没有做模型回落')
  assert.ok(store.includes('setNotice(webChatFallbackNotice(fallbackModel))'), '切回模型没有提示，用户会以为模型自己变了')
})
