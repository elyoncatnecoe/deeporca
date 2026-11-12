import type { Assistant, AssistantRegex, Conversation, ConversationConfig, Settings, ThinkingEffort } from './types.ts'
import { DEFAULT_ASSISTANT_ID } from './types.ts'

/**
 * 取一个助手；找不到就退回第一个（永远存在，sanitize 保证）。
 */
export function findAssistant(settings: Settings, id: string | undefined): Assistant {
  const fallback = settings.assistants[0]
  if (id !== undefined) {
    const hit = settings.assistants.find((item) => item.id === id)
    if (hit !== undefined) return hit
  }
  if (settings.assistantId !== '') {
    const hit = settings.assistants.find((item) => item.id === settings.assistantId)
    if (hit !== undefined) return hit
  }
  return fallback ?? {
    id: DEFAULT_ASSISTANT_ID,
    name: '深鲸',
    avatar: '🐋',
    systemPrompt: '',
    model: '',
    temperature: -1,
    thinkingEffort: '',
    createdAt: 0,
    updatedAt: 0,
  }
}

/** 助手这一份配置里，实际生效的模型/温度/思考强度（空值跟随全局）。 */
export function resolveAssistantConfig(settings: Settings, assistant: Assistant): ConversationConfig {
  return {
    name: assistant.name,
    avatar: assistant.avatar,
    avatarKind: assistant.avatarKind,
    avatarBuiltin: assistant.avatarBuiltin,
    avatarImage: assistant.avatarImage,
    systemPrompt: assistant.systemPrompt,
    model: assistant.model.trim() !== '' ? assistant.model : settings.model,
    temperature: assistant.temperature >= 0 ? assistant.temperature : settings.temperature,
    thinkingEffort: (assistant.thinkingEffort !== '' ? assistant.thinkingEffort : settings.thinkingEffort) as ThinkingEffort,
    presetMessages: assistant.presetMessages.filter((item) => item.trim() !== ''),
    messageTemplate: assistant.messageTemplate,
    regexes: assistant.regexes.filter((item) => item.enabled && item.find.trim() !== ''),
    recentChats: assistant.recentChats ?? settings.recentChats,
    timeReminder: assistant.timeReminder ?? settings.timeReminder,
  }
}

/**
 * 老快照没有新字段时补默认值，避免读历史对话时炸掉。
 */
export function normalizeConfig(config: ConversationConfig): ConversationConfig {
  return {
    ...config,
    presetMessages: Array.isArray(config.presetMessages) ? config.presetMessages : [],
    messageTemplate: typeof config.messageTemplate === 'string' ? config.messageTemplate : '',
    regexes: Array.isArray(config.regexes) ? config.regexes : [],
    recentChats: config.recentChats !== false,
    timeReminder: config.timeReminder !== false,
  }
}

/**
 * 一段对话实际使用的配置：有快照就用快照，没有就用当前助手现算。
 * 快照是「对话开始那一刻」的助手，改助手不会回头影响它。
 */
export function conversationConfig(settings: Settings, conversation: Conversation | undefined): ConversationConfig {
  if (conversation?.config !== undefined) return normalizeConfig(conversation.config)
  return resolveAssistantConfig(settings, findAssistant(settings, conversation?.assistantId))
}

/** 把 `{{ message }}` 套进助手的消息模板；没配模板就原样返回。 */
export function applyMessageTemplate(template: string, text: string): string {
  const trimmed = (template ?? '').trim()
  if (trimmed === '') return text
  if (!trimmed.includes('{{ message }}')) return `${trimmed}\n\n${text}`
  return trimmed.replace(/\{\{\s*message\s*\}\}/g, text)
}

/** 对一段文本套用助手的显示层正则替换。 */
export function applyRegexes(text: string, regexes: readonly AssistantRegex[]): string {
  if (regexes.length === 0) return text
  let out = text
  for (const rule of regexes) {
    if (!rule.enabled || rule.find.trim() === '') continue
    try {
      out = out.replace(new RegExp(rule.find, 'g'), rule.replace)
    } catch {
      // 用户写坏了一个正则，跳过它，不要让整段回复显示不出来。
    }
  }
  return out
}

/** 这段对话的助手名字，用于气泡署名与标题。 */
export function conversationAssistantName(settings: Settings, conversation: Conversation | undefined): string {
  return conversationConfig(settings, conversation).name
}