import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveSettings } from '../src/lib/assistant.ts'
import { DEFAULT_SETTINGS } from '../src/lib/types.ts'
import type { Conversation, Settings } from '../src/lib/types.ts'

/**
 * 「这段对话到底用哪个模型」的一致性回归。
 *
 * 真机反馈：把模型切回 `deepseek-chat-web`（网页账号）之后，界面又跳回助手原来的
 * API 模型，然后一直报「还没有填 API Key」/「API Key 无效」/「还没接上模型」。
 *
 * 根因有两层：
 *   1. 助手可以单独覆盖模型（`resolveAssistantConfig` 里 `assistant.model` 优先），
 *      而聊天页/设置页的模型选择只写全局 —— 于是「切了但没变」；
 *   2. 发送链路里 `sendMessage()` 用**全局** settings 判断走不走网页账号 / 有没有 Key，
 *      `runAssistantTurn()` 却用 cfg.model 发请求 —— 两边不一致时就会一边说「有登录态」、
 *      另一边说「没有 API Key」。
 *
 * 这个文件盯的就是第 2 层：`effectiveSettings` 必须是两边共用的唯一来源。
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

const baseAssistant = DEFAULT_SETTINGS.assistants[0]!

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

function conversationWith(config: Conversation['config']): Conversation {
  return {
    id: 'c1',
    title: '测试对话',
    assistantId: baseAssistant.id,
    kind: 'single',
    createdAt: 0,
    updatedAt: 0,
    config,
  } as unknown as Conversation
}

/* ------------------------------------------------------------------ */
/* 取值优先级：对话快照 → 助手覆盖 → 全局                                */
/* ------------------------------------------------------------------ */

test('没有助手覆盖、没有快照时，跟随全局模型', () => {
  const settings = settingsWith({
    // 网页账号要过「纸雕虎鲸」总闸（默认关）：这里测的是取值优先级，先把闸门打开。
    webPet: true,
    model: 'deepseek-chat-web',
    assistants: [{ ...baseAssistant, model: '' }],
  })
  assert.equal(effectiveSettings(settings, undefined).model, 'deepseek-chat-web')
})

test('助手覆盖了模型时，以助手为准（全局是 API 模型的前提下）', () => {
  const settings = settingsWith({
    model: 'deepseek-chat',
    assistants: [{ ...baseAssistant, model: 'deepseek-reasoner' }],
  })
  assert.equal(effectiveSettings(settings, undefined).model, 'deepseek-reasoner')
})

test('全局选了网页账号时，助手覆盖不能把它拽回 API 模型（真机 401 的根因）', () => {
  const settings = settingsWith({
    webPet: true,
    model: 'deepseek-chat-web',
    assistants: [{ ...baseAssistant, model: 'deepseek-chat' }],
  })
  assert.equal(
    effectiveSettings(settings, undefined).model,
    'deepseek-chat-web',
    '网页账号是账号模式，不是模型偏好 —— 全局选了它就必须真的走它',
  )
})

test('全局选了网页账号时，对话快照也不能把它拽回 API 模型', () => {
  const settings = settingsWith({ webPet: true, model: 'deepseek-chat-web' })
  const conversation = conversationWith({
    name: baseAssistant.name,
    avatar: baseAssistant.avatar,
    systemPrompt: baseAssistant.systemPrompt,
    model: 'deepseek-chat',
    temperature: 1,
    thinkingEffort: 'off',
    presetMessages: [],
    messageTemplate: '',
    regexes: [],
    recentChats: true,
    timeReminder: true,
  } as Conversation['config'])
  assert.equal(effectiveSettings(settings, conversation).model, 'deepseek-chat-web')
})

test('对话快照优先于助手覆盖', () => {
  const settings = settingsWith({
    webPet: true,
    model: 'deepseek-chat',
    assistants: [{ ...baseAssistant, model: 'deepseek-chat' }],
  })
  const conversation = conversationWith({
    name: baseAssistant.name,
    avatar: baseAssistant.avatar,
    systemPrompt: baseAssistant.systemPrompt,
    model: 'deepseek-chat-web',
    temperature: 1,
    thinkingEffort: 'off',
    presetMessages: [],
    messageTemplate: '',
    regexes: [],
    recentChats: true,
    timeReminder: true,
  } as Conversation['config'])
  assert.equal(effectiveSettings(settings, conversation).model, 'deepseek-chat-web')
})

test('思考强度 / 温度也跟着同一套优先级走', () => {
  const settings = settingsWith({
    model: 'deepseek-chat',
    thinkingEffort: 'off',
    temperature: 1,
    assistants: [{ ...baseAssistant, model: '', thinkingEffort: 'high', temperature: 0.3 }],
  })
  const effective = effectiveSettings(settings, undefined)
  assert.equal(effective.thinkingEffort, 'high')
  assert.equal(effective.temperature, 0.3)
})

/* ------------------------------------------------------------------ */
/* 接线：发送链路必须用同一份                                            */
/* ------------------------------------------------------------------ */

test('sendMessage 用 effectiveSettings 判断路由，而不是全局 settings', () => {
  const engine = stripComments(read('src/lib/engine.ts'))
  const start = engine.indexOf('export async function sendMessage')
  const end = engine.indexOf('export async function sendGroupMessage', start)
  const body = engine.slice(start, end === -1 ? undefined : end)

  assert.match(body, /const effective = effectiveSettings\(/, '必须先算出这段对话实际生效的设置')
  assert.match(body, /hasApiKey: hasApiKey\(effective\)/, '有没有 Key 要看生效设置')
  assert.match(body, /isWebChatProvider: isWebChatProvider\(effective\)/, '走不走网页账号也要看生效设置')
  assert.doesNotMatch(body, /hasApiKey: hasApiKey\(settings\)/, '不许再拿全局 settings 判断')
  assert.match(body, /settings: effective,/, '提交阶段也传同一份，请求与判断同源')
})

test('runAssistantTurn 用的是同一套「网页账号优先」规则', () => {
  const engine = stripComments(read('src/lib/engine.ts'))
  const start = engine.indexOf('async function runAssistantTurn')
  const body = engine.slice(start, start + 3000)
  assert.match(body, /const cfg = /, '要先算出这段对话的配置')
  assert.match(
    body,
    /model: isWebChatModel\(options\.settings\.model\) \? options\.settings\.model : cfg\.model/,
    '实际发请求那一层也必须让网页账号压过助手/快照的模型覆盖',
  )
  assert.match(body, /const webMode = isWebChatProvider\(settings\)/, '路由判断用同一份 settings')
})

test('网页登录失效会自愈：清 token → 重新采集 → 重发一次', () => {
  const src = stripComments(read('src/lib/web-chat.ts'))

  // 发送端是唯一能观察到「网页说登录态失效」的地方
  assert.match(src, /if \(first\.status !== 'no-session'\) return first/, '先正常发，不是 no-session 就直接返回')
  assert.match(src, /sessionInvalid = true/, '标记登录态失效')
  assert.match(src, /await logoutWebChat\(\)/, '清掉本地旧 token，否则 hasSession 一直为真')
  assert.match(src, /const login = await loginWebChat\(\)/, '重新采集一次登录态')
  assert.match(src, /if \(!login\.ok\) return first/, '采集失败就把原始错误交回去，不无限重试')

  // 标记要影响「就绪判断」，否则永远走不到重新登录
  assert.match(src, /if \(sessionInvalid\) return false/, 'webChatReady 要因此返回 false')
  assert.match(src, /if \(result\.ok\) sessionInvalid = false/, '登录成功要清标记')
})
test('聊天页选模型时会把助手的旧覆盖清掉，避免「切了又跳回去」', () => {
  const chat = stripComments(read('src/components/Chat.tsx'))
  const start = chat.indexOf('async function chooseModel')
  const body = chat.slice(start, chat.indexOf('function onModelKeyDown', start))

  assert.match(body, /updateAssistant\(assistant\.id, \{ model: '' \}\)/, '清掉助手级模型覆盖，回到「跟随全局」')
  assert.match(body, /await actions\.setSettings\(\{ model: id \}\)/, '全局模型要 await，别让紧接着的发送读到旧值')
  assert.match(body, /await actions\.patchConversationConfig\(\{ model: id \}\)/, '对话快照也要落盘')
})
