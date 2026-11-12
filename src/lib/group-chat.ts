import type { Assistant, GroupChatSettings } from './types'

/**
 * 群聊的调度规则（纯函数，便于单测）。
 *
 * 真正的「一个接一个生成」在 engine.ts 的 sendGroupMessage 里做；这里只负责
 * 「谁先说、谁不该说」这类可以脱离网络单独验证的判断。
 */

/** 用户点名某个助手时，容忍的叫法（英文名 + 常见简称/中文名）。 */
const NICKNAMES: Record<string, string[]> = {
  deeporca: ['deeporca', 'deep orca', 'orca', '虎鲸', '深鲸'],
  clawd: ['clawd', 'claude', '螃蟹', '小螃蟹'],
  sealgpt: ['seal-gpt', 'seal gpt', 'seal', '海豹'],
}

/** 从用户这句话里点名了哪些助手（返回 assistantId 列表，按出现顺序）。 */
export function detectNamedAssistantIds(text: string, members: readonly Assistant[]): string[] {
  const lower = text.toLowerCase()
  const hits: { id: string; at: number }[] = []
  for (const member of members) {
    const keys = new Set<string>([member.name.toLowerCase(), ...(NICKNAMES[member.id] ?? [])])
    let best = -1
    for (const key of keys) {
      if (key === '') continue
      const at = lower.indexOf(key)
      if (at >= 0 && (best < 0 || at < best)) best = at
    }
    if (best >= 0) hits.push({ id: member.id, at: best })
  }
  return hits.sort((a, b) => a.at - b.at).map((hit) => hit.id)
}

/**
 * 决定这一轮每个成员是否发言、按什么顺序。
 *
 * 规则（省 token 优先）：
 *  1. 被点名的助手一定发言，且排在前面（按点名顺序）；
 *  2. 没被点名时，只有第一个成员（默认主角）一定发言；
 *  3. 其余成员只在 allowChatter 打开时才可能接话；
 *  4. 总数不超过 maxTurnsPerRound。
 *
 * 返回「参与本轮」的助手列表；真正的跳过（<pass/>）在生成时还会再判一次。
 */
export function planGroupRound(
  members: readonly Assistant[],
  text: string,
  settings: GroupChatSettings,
): { speakers: Assistant[]; named: string[] } {
  if (members.length === 0) return { speakers: [], named: [] }
  const named = detectNamedAssistantIds(text, members)
  const limit = Math.max(1, settings.maxTurnsPerRound)

  const ordered: Assistant[] = []
  const push = (item: Assistant | undefined): void => {
    if (item === undefined) return
    if (ordered.some((existing) => existing.id === item.id)) return
    ordered.push(item)
  }

  // 1. 点名的先上。
  for (const id of named) push(members.find((member) => member.id === id))

  // 2. 主角（第一个成员）默认一定在，除非它已经被点名排过。
  push(members[0])

  // 3. 其余成员：只有允许互相接话时才补位。
  if (settings.allowChatter) {
    for (const member of members) push(member)
  }

  return { speakers: ordered.slice(0, limit), named }
}

/** 这条消息是不是「跳过」（模型约定：只回 <pass/>）。 */
export function isPassReply(text: string): boolean {
  return text.trim() === '<pass/>'
}
