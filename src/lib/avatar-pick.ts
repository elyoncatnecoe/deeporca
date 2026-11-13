import type { Settings } from './types.ts'

/**
 * 头像该听谁的：开着助手 → 助手说了算；关掉助手 → 用设置里那张。
 *
 * 用户反馈的「两个头像在打架」就是这个规则没落地：聊天气泡有的地方用助手头像、
 * 有的地方用设置头像，网页端则永远只用设置级。
 *
 * 只把**判断**放这里，具体解析（内置 SVG / 上传图 / emoji 文字头像）在
 * `components/Avatar.tsx` 里做 —— 那个模块带 `?raw` 资源导入，node 里跑不起来，
 * 而这条规则要能被测试守住。
 *
 * `undefined` 按「关」算：老数据里没有这个字段时不能当成开着。
 */
export type AvatarSource = 'assistant' | 'settings'

export function avatarSourceFor(settings: Settings): AvatarSource {
  return settings.assistantsEnabled === true ? 'assistant' : 'settings'
}

/**
 * 一条助手气泡该用**谁**的头像。
 *
 * 为什么需要它：以前气泡只按「当前助手」取头像，于是用户在同一个对话里换了助手，
 * 连历史消息的头像都一起被改掉 —— 那些消息明明是上一个助手说的。
 *
 * 优先级（和「这条消息是谁说的」对齐，而不是和「现在选的是谁」对齐）：
 *   1. `message-assistant`：消息自己记了 assistantId（群聊一定有，单聊新数据也有）。
 *   2. `conversation-assistant`：没记的话，用这段对话绑定的助手（单聊老数据的兜底）。
 *   3. `settings`：助手功能关着，或者两个 id 都没有 → 回落到设置里那张。
 *
 * 参考做法：agent 类产品在切换模型/助手后，历史轨迹靠**每条消息自带作者快照**来渲染，
 * 不在渲染时读「当前是谁」，否则历史会跟着当前选择漂移。
 */
export type AvatarOwner = 'message-assistant' | 'conversation-assistant' | 'settings'

export function avatarOwnerFor(input: {
  enabled: boolean
  messageAssistantId?: string
  conversationAssistantId?: string
}): AvatarOwner {
  if (!input.enabled) return 'settings'
  if (input.messageAssistantId !== undefined && input.messageAssistantId !== '') return 'message-assistant'
  if (input.conversationAssistantId !== undefined && input.conversationAssistantId !== '') return 'conversation-assistant'
  return 'settings'
}
