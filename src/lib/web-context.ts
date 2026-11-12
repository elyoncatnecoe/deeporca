/**
 * 把「助手人设 + 常驻记忆」同步给网页账号（DOM 遥控窗 + HTTP 直发）。
 *
 * 网页账号模式没有 system 角色，所以人设只能当成一段文字塞进用户消息。
 * 关键约束：这里只拼「稳定块」——人设 + 常驻记忆，**不拼**身体读数、时间、
 * 最近对话回顾、滚动摘要这些每轮都在变的东西。
 *
 * 为什么必须稳定：网页线程靠「这段文字和上次拼进去的是不是一样」来决定要不要
 * 再拼一次（见 electron/deepseek-api.ts 的 needPersona、Android 的
 * WebApiClient.needPersona）。以前上层把整个 system prompt 传下去，身体/时间/
 * 摘要每轮都变，判据几乎每轮成立，用户看到的就是「每条消息都带一段人设」。
 *
 * 用户改了助手设定（人设、名字）或记忆之后要重新同步一次，否则网页那边还在用
 * 旧人设说话——这时稳定块真的变了，重拼一次是应该的。
 */

import { findAssistant, resolveAssistantConfig } from './assistant.ts'
import { selectForPrompt } from './memory-core.ts'
import { personaOpening } from './prompt.ts'
import type { MemoryEntry, Settings } from './types'
import { setWebChatContext } from './web-chat.ts'

export interface WebContextInput {
  settings: Settings
  /** 这段对话实际生效的人设（助手覆盖或内置，通常就是 ConversationConfig.systemPrompt）。 */
  persona: string
  /** 助手显示名；人设为空时用它兜底。 */
  name: string
  /** 记忆归属的助手 id。 */
  characterId: string
  memories: readonly MemoryEntry[]
}

/**
 * 拼出要注入网页账号的稳定块：人设 + 常驻记忆。
 *
 * 只带「常驻」和「置顶」那些记忆（selectForPrompt 不给 hint，所以 P1 不进）：
 * 避免把整库塞进输入框，也避免块随对话标题/内容变化而抖动。
 */
export function buildWebChatContext(input: WebContextInput): string {
  const persona = personaOpening(input.settings, input.persona, input.name)

  const selection = selectForPrompt({
    memories: [...input.memories],
    characterId: input.characterId,
    budget: input.settings.memoryTokenBudget,
  })

  const blocks: string[] = [persona]
  const facts = selection.active
    .filter((memory) => memory.pending !== true)
    .map((memory) => '- ' + memory.text)
  if (facts.length > 0) {
    blocks.push('关于用户，你记得这些：\n' + facts.join('\n'))
  }

  return [
    '【以下是你的设定，请在整段对话里保持】',
    blocks.join('\n\n'),
  ].join('\n')
}

/** 按「设置里当前选中的助手」拼稳定块，供设置/记忆变更时主动同步。 */
export function buildWebChatContextForSettings(
  settings: Settings,
  memories: readonly MemoryEntry[],
): string {
  const assistant = findAssistant(settings, settings.assistantId)
  const cfg = resolveAssistantConfig(settings, assistant)
  return buildWebChatContext({
    settings,
    persona: cfg.systemPrompt,
    name: cfg.name,
    characterId: assistant.id,
    memories,
  })
}

/** 把当前助手的人设与记忆推给网页窗；失败静默（下次发送前还会再试）。 */
export async function syncWebChatContext(
  settings: Settings,
  memories: readonly MemoryEntry[],
): Promise<void> {
  await setWebChatContext(buildWebChatContextForSettings(settings, memories))
}
