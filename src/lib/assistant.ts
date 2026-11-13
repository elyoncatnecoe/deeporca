import type { Assistant, AssistantRegex, Conversation, ConversationConfig, Settings, ThinkingEffort } from './types.ts'
import { DEFAULT_ASSISTANT_ID } from './types.ts'
import { isWebChatModel } from './models.ts'
import { applyWebGate } from './web-gate.ts'

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

/**
 * 一段对话**实际生效**的设置：模型 / 温度 / 思考强度等按「对话快照 → 助手覆盖 → 全局」取值。
 *
 * 为什么需要它：发送链路里原来有两套判断 —— `sendMessage()` 拿**全局** settings 决定
 * 「要不要走网页账号 / 有没有 Key」，而 `runAssistantTurn()` 用 cfg.model 发请求。
 * 一旦助手或对话快照覆盖了模型，两边就会打架，真机上的表现是：
 *   · 全局是网页账号、快照是 API 模型 → 进了网页登录流程，请求却按 API 发 → 「还没有填 API Key」/401；
 *   · 全局是 API、快照是网页模型 → 直接走离线回复 → 「还没接上模型，点这里填 API Key」。
 * 现在两处都用这一个函数算出来的设置，判断和请求永远同源。
 */
export function effectiveSettings(settings: Settings, conversation: Conversation | undefined): Settings {
  const cfg = conversationConfig(settings, conversation)
  /*
   * 网页账号是「账号模式」，不是模型偏好。
   *
   * 全局选了网页账号，就不许助手覆盖 / 对话快照把这一轮拽回某个 API 模型 —— 否则
   * 真机上会出现「设置里明明是网页账号，发出去却按助手的旧 API 模型走」，然后报
   * 「API Key 无效或已过期」（那个 Key 早就过期了）。
   *
   * 反过来仍然成立：全局是 API 模型时，对话快照 / 助手可以单独指定网页模型。
   */
  const model = isWebChatModel(settings.model) ? settings.model : cfg.model
  /*
   * 最后一道闸：网页账号总闸（纸雕虎鲸）关着时，不管这个模型是全局选的、助手覆盖的，
   * 还是历史对话快照里存的，都不能让最终配置落在网页账号路径上。
   *
   * 只藏对话页的模型选项是不够的 —— 助手可以单独指定模型，老对话还带着自己的快照，
   * 这两条路都不经过模型选择器。这里是「这段对话实际生效的设置」的唯一来源，
   * 闸门放在这里才能覆盖全部来源。
   */
  return applyWebGate({
    ...settings,
    model,
    temperature: cfg.temperature,
    thinkingEffort: cfg.thinkingEffort,
    recentChats: cfg.recentChats,
    timeReminder: cfg.timeReminder,
  }).settings
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