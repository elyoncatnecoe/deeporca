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
