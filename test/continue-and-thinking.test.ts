import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { conversationConfig, resolveAssistantConfig } from '../src/lib/assistant.ts'
import { DEFAULT_SETTINGS } from '../src/lib/types.ts'

/**
 * 「关闭思考没生效」和「截断续写」的回归锁（2026-11-03 晚）。
 *
 * 前者是纯逻辑 bug：对话创建时把配置拍成快照，引擎读快照；聊天页只写全局 settings，
 * 于是「切到关闭」对当前对话完全无效。这里既锁纯函数语义，也锁界面接线
 * （否则有人把 chip 改回 settings 就又坏了）。
 */

const CHAT = readFileSync('src/components/Chat.tsx', 'utf8')
const STORE = readFileSync('src/lib/store.ts', 'utf8')
const ENGINE = readFileSync('src/lib/engine.ts', 'utf8')

function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

test('conversationConfig 优先用对话快照（这就是「关了思考还在想」的根因）', () => {
  const settings = { ...DEFAULT_SETTINGS, thinkingEffort: 'off' as const }
  const snapshot = { ...resolveAssistantConfig(DEFAULT_SETTINGS, DEFAULT_SETTINGS.assistants[0]), thinkingEffort: 'high' as const }
  const conversation = { id: 'c1', title: 't', createdAt: 0, updatedAt: 0, model: 'deepseek-flash', config: snapshot }
  assert.equal(settings.thinkingEffort, 'off')
  assert.equal(conversationConfig(settings, conversation).thinkingEffort, 'high', '快照应当赢过全局——所以界面必须改快照')
})

test('聊天页思考 chip 改的是对话快照（同时写全局作默认），显示读 activeConfig', () => {
  const code = codeOnly(CHAT)
  assert.ok(code.includes('patchConversationConfig({ thinkingEffort: effort.id })'), '思考 chip 没有写对话快照')
  assert.ok(code.includes('思考 {effortLabel(activeConfig.thinkingEffort)}'), '思考 chip 显示的不是 activeConfig')
  assert.ok(!code.includes('思考 {effortLabel(settings.thinkingEffort)}'), '又变回读全局了')
})

test('聊天页切模型也写对话快照（同一个根因）', () => {
  const code = codeOnly(CHAT)
  assert.ok(code.includes('patchConversationConfig({ model: id })'), '切模型没有写对话快照')
  assert.ok(code.includes('{activeConfig.model ||'), '模型 chip 显示的不是 activeConfig')
})

test('store 提供 patchConversationConfig，并且会同步 conversation.model', () => {
  const code = codeOnly(STORE)
  assert.ok(code.includes('async patchConversationConfig('), 'store 没有这个 action')
  assert.ok(code.includes('...(patch.model !== undefined ? { model: patch.model } : {})'), '没有同步 conversation.model')
})

/* ------------------------------ 截断续写 ------------------------------ */

test('引擎支持「续写并入同一条消息」，并把结果并进原消息', () => {
  const code = codeOnly(ENGINE)
  assert.ok(code.includes('continueFrom'), '引擎没有 continueFrom')
  assert.ok(code.includes('updateMessage(existing.id, stored)'), '续写没有并回原消息，而是新起一条')
  assert.ok(code.includes('export async function continueTurn('), '没有对外的 continueTurn')
})

test('自动续写只做一次，且可以在设置里关掉', () => {
  const code = codeOnly(ENGINE)
  assert.ok(code.includes("options.continueFrom === undefined"), '自动续写没有「只做一次」的护栏')
  assert.ok(code.includes('autoContinue !== false'), '自动续写没有读设置开关')
  const settings = readFileSync('src/lib/settings.ts', 'utf8')
  assert.ok(settings.includes('settings.autoContinue = settings.autoContinue !== false'), '设置没有收敛 autoContinue')
})

test('截断气泡上有一键「继续写」，并且续写段不重复画头像', () => {
  const code = codeOnly(CHAT)
  assert.ok(code.includes('bubble-continue'), '没有「继续写」按钮')
  assert.ok(code.includes('onContinue={(id) => void continueTurn(id)}'), '按钮没有接到 continueTurn')
  assert.ok(code.includes('bubble-continued-divider'), '续写段没有分隔线（会看起来像两条回复）')
  assert.ok(!code.includes('>记忆</span>'), '对话栏下面的记忆入口应该已经移除')
})

