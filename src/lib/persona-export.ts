/**
 * 右键菜单要复制的两段文本。
 *
 * 放在 lib 里而不是组件里，是为了：
 *   1. 网页模式的注入脚本和 App 内的菜单共用同一份拼装逻辑；
 *   2. 纯函数，node 里可以直接测（不用起浏览器）。
 */

import { findAssistant, resolveAssistantConfig } from './assistant.ts'
import { selectForPrompt } from './memory-core.ts'
import { personaOpening } from './prompt.ts'
import type { MemoryEntry, Settings } from './types'

/**
 * 记忆导出命令：粘到聊天框里，让模型把当前人设与常驻记忆整理成一份 Markdown。
 *
 * 只带「常驻 / 置顶」的记忆（`selectForPrompt` 不给 hint，P1 不进），
 * 和网页账号自动注入的稳定块同源——导出的就是模型真正会读到的那部分。
 */
export function buildMemoryExportPrompt(
  settings: Settings,
  memories: readonly MemoryEntry[],
): string {
  const assistant = findAssistant(settings, settings.assistantId)
  const cfg = resolveAssistantConfig(settings, assistant)
  const selection = selectForPrompt({
    memories: [...memories],
    characterId: assistant.id,
    budget: settings.memoryTokenBudget,
  })
  const facts = selection.active
    .filter((memory) => memory.pending !== true)
    .map((memory) => '- ' + memory.text)
  const name = cfg.name.trim() !== '' ? cfg.name.trim() : (findAssistant(settings, undefined).name || '深鲸')

  const lines = [
    `请把下面这份「${name}」的设定整理成一份 Markdown 文档：保留原意、分好小节，不要编造没有的信息。`,
    '',
    '## 助手人设',
    personaOpening(settings, cfg.systemPrompt, cfg.name),
  ]
  if (facts.length > 0) {
    lines.push('', '## 记忆条目', ...facts)
  }
  return lines.join('\n')
}
