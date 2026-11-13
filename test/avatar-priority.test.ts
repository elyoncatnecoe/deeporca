import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { avatarSourceFor } from '../src/lib/avatar-pick.ts'
import { DEFAULT_SETTINGS, type Settings } from '../src/lib/types.ts'

/**
 * 头像来源：开着助手 → 助手自己的头像；关掉 → 设置里那张。
 *
 * 用户反馈的「两个头像在打架」：聊天气泡有的地方用助手头像、有的地方用设置头像，
 * 网页端则永远只用设置级。修法是**单一来源**：这三处（气泡 / 生成中气泡 / 网页注入）
 * 全部改走同一个判断，设置页那行也跟着改，并加一句说明。
 *
 * 前 2 条是行为测试（纯规则）；后面是接线断言 —— Avatar / Chat / Settings 是 React
 * 组件、web-mode 带 `?raw` 资源，node 里都跑不起来，只能守住「有没有真的接上」。
 */

const CHAT = readFileSync('src/components/Chat.tsx', 'utf8')
const AVATAR = readFileSync('src/components/Avatar.tsx', 'utf8')
const WEB_MODE = readFileSync('src/lib/web-mode.ts', 'utf8')
const SETTINGS = readFileSync('src/components/Settings.tsx', 'utf8')

function settingsWith(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

/* ------------------------------------------------------------------ 行为 */

test('助手开着：头像来源是助手', () => {
  assert.equal(avatarSourceFor(settingsWith({ assistantsEnabled: true })), 'assistant')
})

test('助手关着、或老数据没有这个字段：都回落到设置里的头像', () => {
  assert.equal(avatarSourceFor(settingsWith({ assistantsEnabled: false })), 'settings')
  const legacy = { ...DEFAULT_SETTINGS } as Partial<Settings>
  delete legacy.assistantsEnabled
  assert.equal(avatarSourceFor(legacy as Settings), 'settings', '缺字段被当成「开着」会把设置头像顶掉')
})

/* ------------------------------------------------------------------ 接线 */

test('接线：Avatar 组件按同一来源决定用不用助手头像', () => {
  assert.ok(AVATAR.includes('avatarSourceFor(settings)'), 'Avatar 没有走共享判断')
  assert.ok(
    AVATAR.includes("if (avatarSourceFor(settings) !== 'assistant') return { avatarSrc: '', emoji: '' }"),
    '关掉助手时没有回落到设置头像',
  )
})

test('接线：聊天气泡的两处头像都用当前助手的（不再一处助手、一处设置）', () => {
  // 有 speaker 的那条本来就用助手自己的头像，这里守住「没有 speaker 的回落」和「生成中气泡」。
  assert.ok(CHAT.includes('<Avatar role="assistant" size={17} {...fallbackAvatar} />'), '无 speaker 的气泡仍在用设置头像')
  assert.ok(
    CHAT.includes('<Avatar role="assistant" size={17} {...currentAssistantAvatar(settings)} />'),
    '生成中的气泡头像没跟当前助手走（名字跟了、头像没跟）',
  )
  assert.ok(
    CHAT.includes('const fallbackAvatar = currentAssistantAvatar(settings)'),
    'fallbackAvatar 不是从共享函数算的',
  )
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
