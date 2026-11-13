import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { avatarOwnerFor, avatarSourceFor } from '../src/lib/avatar-pick.ts'
import { DEFAULT_SETTINGS, type Settings } from '../src/lib/types.ts'

/**
 * 头像归属。
 *
 * 两条规则，对应两次真机反馈：
 *   1. 「两个头像打架」：开着助手就该用助手自己的头像（网页端也是），关掉才用设置里那张。
 *   2. 「换助手把历史消息的头像也改了」：历史气泡要跟着**作者**走，不能跟着**当前选中的助手**走。
 *
 * 前 6 条是行为测试（纯规则）；后面是接线断言 —— Avatar / Chat / Settings 是 React 组件、
 * web-mode 带 `?raw` 资源，node 里都跑不起来，只能守住「有没有真的接上」。
 */

const CHAT = readFileSync('src/components/Chat.tsx', 'utf8')
const AVATAR = readFileSync('src/components/Avatar.tsx', 'utf8')
const WEB_MODE = readFileSync('src/lib/web-mode.ts', 'utf8')
const SETTINGS = readFileSync('src/components/Settings.tsx', 'utf8')

function settingsWith(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

/* --------------------------------------------------------- 规则一：谁说了算 */

test('助手开着：头像来源是助手', () => {
  assert.equal(avatarSourceFor(settingsWith({ assistantsEnabled: true })), 'assistant')
})

test('助手关着、或老数据没有这个字段：都回落到设置里的头像', () => {
  assert.equal(avatarSourceFor(settingsWith({ assistantsEnabled: false })), 'settings')
  const legacy = { ...DEFAULT_SETTINGS } as Partial<Settings>
  delete legacy.assistantsEnabled
  assert.equal(avatarSourceFor(legacy as Settings), 'settings', '缺字段被当成「开着」会把设置头像顶掉')
})

/* ------------------------------------------------- 规则二：历史气泡跟作者走 */

test('消息自己记了作者（群聊 / 新数据）：用那个作者的', () => {
  assert.equal(
    avatarOwnerFor({ enabled: true, messageAssistantId: 'asst_a', conversationAssistantId: 'asst_b' }),
    'message-assistant',
    '消息自带的作者被对话绑定覆盖了',
  )
})

test('消息没记作者（单聊老数据）：用这段对话绑定的助手，而不是当前选中的', () => {
  assert.equal(
    avatarOwnerFor({ enabled: true, conversationAssistantId: 'asst_b' }),
    'conversation-assistant',
    '回落到「当前助手」会把历史消息的头像一起改掉',
  )
})

test('两个 id 都没有、或助手功能关着：回落到设置级头像', () => {
  assert.equal(avatarOwnerFor({ enabled: true }), 'settings')
  assert.equal(avatarOwnerFor({ enabled: false, messageAssistantId: 'asst_a' }), 'settings')
})

test('空字符串 id 不能当成「有作者」', () => {
  assert.equal(avatarOwnerFor({ enabled: true, messageAssistantId: '', conversationAssistantId: '' }), 'settings')
})

/* ------------------------------------------------------------------ 接线 */

test('接线：Avatar 组件按同一来源决定用不用助手头像', () => {
  assert.ok(AVATAR.includes('avatarSourceFor(settings)'), 'Avatar 没有走共享判断')
  assert.ok(
    AVATAR.includes("if (avatarSourceFor(settings) !== 'assistant') return { avatarSrc: '', emoji: '' }"),
    '关掉助手时没有回落到设置头像',
  )
  assert.ok(AVATAR.includes('avatarOwnerFor({'), '气泡头像没有走作者归属判断')
  assert.ok(
    AVATAR.includes("if (input.conversation?.config !== undefined) return assistantAvatarProps(input.conversation.config)"),
    '作者被删时没有用对话快照兜底（会掉回「当前助手」）',
  )
})

test('接线：聊天气泡按作者取头像，只有生成中的那条用当前对话的助手', () => {
  assert.ok(
    CHAT.includes('const avatarProps = messageAvatarProps({ settings, conversation, message, assistants })'),
    '历史气泡没有走作者归属',
  )
  assert.ok(CHAT.includes('{...(avatarProps ?? {})}'), '历史气泡没有用归属结果渲染')
  assert.ok(
    CHAT.includes('{...assistantAvatarProps(activeConfig)}'),
    '生成中的气泡没有和名字同源（activeConfig）',
  )
  assert.ok(!CHAT.includes('currentAssistantAvatar(settings)'), '还在用「当前助手」画历史气泡')
})

test('接线：网页注入用助手的头像，emoji 才回落到设置头像', () => {
  assert.ok(
    WEB_MODE.includes("assistant: ownAssistantAvatar !== '' ? ownAssistantAvatar : avatarStore.get('assistant')"),
    '网页端没有优先用助手头像',
  )
  assert.ok(
    WEB_MODE.includes('currentAssistantAvatar(settings).avatarSrc'),
    'ownAssistantAvatar 不是从共享函数算的',
  )
})

test('接线：设置页那行显示「实际生效」的头像，并说明被覆盖的关系', () => {
  assert.ok(SETTINGS.includes('{...currentAssistantAvatar(draft)}'), '设置页预览还是画设置级头像')
  assert.ok(SETTINGS.includes('当前由助手的头像覆盖'), '没有说明「开着助手时这里不生效」')
})
