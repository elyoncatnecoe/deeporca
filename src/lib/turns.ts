import type { ChatMessage } from './types'

/** 一轮 = 一条用户消息 + 它之后的所有助手/工具消息。 */
export interface Turn {
  /** 第几轮，从 1 开始。 */
  index: number
  /** 这一轮的锚点消息 id（用用户消息那条）。 */
  anchorId: string
  /** 用户这一问的纯文本，用于预览。 */
  prompt: string
  /** 这一轮最后一条助手回复的纯文本，用于预览。 */
  reply: string
}

/**
 * 把消息列表切成「轮」。
 * 开头如果先出现助手消息（分叉/压缩后可能如此），把它归进第 1 轮，不单独成轮。
 */
export function buildTurns(messages: readonly ChatMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({
        index: turns.length + 1,
        anchorId: message.id,
        prompt: message.content.trim(),
        reply: '',
      })
      continue
    }
    if (message.role !== 'assistant') continue
    const current = turns[turns.length - 1]
    if (current === undefined) {
      // 还没有用户消息就先来的助手内容，算作第 1 轮的回复。
      turns.push({ index: 1, anchorId: message.id, prompt: '', reply: message.content.trim() })
      continue
    }
    if (message.content.trim() !== '') current.reply = message.content.trim()
  }
  return turns
}