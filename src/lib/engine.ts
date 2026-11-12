import { nanoid } from 'nanoid'
import { addUsage, listMessageSiblings, putMedia, putMessage, rewriteMessageAndTruncate } from './db'
import { ApiError, streamChat, type StreamResult } from './deepseek'
import { isTruncatedFinish, resolveOutputCap, retryCap } from './budget'
import {
  REMEMBER_TOOL,
  REMEMBER_TOOL_NAME,
  detectRepeatedMemories,
  memoryForPrompt,
  memoryReadEnabled,
  recentRecap,
  remember,
} from './memory'
import { conversationDigest, maybeCompress } from './compress'
import { applyMessageTemplate, conversationConfig, effectiveSettings, findAssistant, resolveAssistantConfig } from './assistant'
import { isWebChatModel } from './models'
import { buildRequestMessages, buildRequestMessagesDetailed, buildSystemPrompt, estimateTokens } from './prompt'
import { bodyMind, extractBodyDirectives, type BodyDirective } from './body'
import { parseCommand } from './commands'
import { stageBridge } from './stage-bridge'
import { useAppStore } from './store'
import { hasApiKey } from './providers'
import type { Assistant, Attachment, ChatMessage, MediaRecord, MessageMediaRef, Settings, ToolCall } from './types'
import { DEFAULT_WORKSPACE } from './types'
import { MAX_ATTACHMENTS } from './attachments'
import { TOOL_DEFINITIONS, executeTool, setToolWorkspaceName } from './workspace'
import { availableTools, callToolByName, isMcpToolName, waitForReady } from './mcp-registry'
import { isMediaToolName, mediaToolDefinitions, runMediaTool, type MediaDraft } from './media-tools'
import { isImageConfigured, isSpeechConfigured } from './media-api'
import { planGroupRound } from './group-chat'
import { calendarToolDefinitions, isCalendarToolName, runCalendarTool } from './calendar-tools'
import { mediaRefOf } from './media-store'
import { currentProvider, isWebChatProvider } from './providers'
import { webChatReady, loginWebChat, setWebChatContext } from './web-chat'
import { buildWebChatContext } from './web-context'
import { createTurnGate, type Turn } from './turn-gate'
import { runSend } from './send-orchestrator'

/**
 * 一次发言允许的工具循环轮数。
 *
 * 旧值是 4：写 index.html + style.css + script.js 再加一句收尾说明正好吃满，
 * 中途任何一次 list_files / read_file 都会把配额耗光，于是「做完了」却停在半路上，
 * 而且一声不吭。抬到 10，撞上限时明确说出来。
 */
const MAX_TOOL_ITERATIONS = 10

/** 一轮发送的占位/释放都走这个门；抽到 src/lib/turn-gate.ts 是为了能写行为测试。 */
const turnGate = createTurnGate()
/**
 * 本轮回复要落进哪个消息节点。null = 新消息（各自成节点）。
 * 重新生成时设为被重新生成那条的 nodeId，于是新回复成为同节点的另一个候选。
 */
let turnNodeId: string | null = null

/**
 * 一轮「发送」的独占句柄。
 *
 * 以前 busy / activeAbort / turnNodeId 是三个散着的全局变量，谁都能改，于是有三个洞：
 *   1. 检查 busy 和置位 busy 之间夹着 runLocalCommand / webChatReady / loginWebChat
 *      这些真实 await —— 连点两下发送能开出两轮；
 *   2. 两轮各自 new AbortController() 覆盖 activeAbort，先启动那轮失去 abort 句柄；
 *   3. 所有 finally 无条件清空全局状态，旧轮收尾会把新轮的 controller 清成 null，
 *      使新轮再也停不下来（BUG-REVIEW T-08）。
 *
 * 现在每轮先 beginTurn() 占位拿到自己的句柄，收尾用 endTurn() 只复位「自己还是当前轮」
 * 的那一份。五个入口（sendMessage / sendGroupMessage / continueTurn / regenerate /
 * editAndResend）必须成对使用，漏一个就会出现「旧任务清掉新任务状态」。
 */
/** 占住「正在发送」并建立这一轮的 controller。返回 null 表示已经有一轮在跑。 */
function beginTurn(): Turn | null {
  return turnGate.begin()
}

/** 只在这一轮仍然是当前轮时复位。旧轮晚到的 finally 不许动新轮的状态。 */
function endTurn(turn: Turn): void {
  if (turnGate.end(turn)) turnNodeId = null
}

/**
 * 一次性放掉「正在发送」的全部状态。正常流程走 sendMessage/regenerate 的 finally，
 * 这里给漏网的兜底：只要用户还能按到「停止」，就不该需要重启进程才能再发消息。
 */
function resetSendingState(): void {
  turnNodeId = null
  turnGate.reset()
  const actions = useAppStore.getState().actions
  actions.setSending(false)
  actions.endLive()
}

export function stopSending(): void {
  if (turnGate.abortCurrent()) return
  // 还挂着 sending 却没有在跑的请求：说明上一次收尾漏了（BUG-REVIEW P0-2）。
  if (turnGate.isBusy()) resetSendingState()
}

export function isSending(): boolean {
  return turnGate.isBusy()
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 本地指令：认出来就当场做动作、回一句预制台词，不碰 API。
 *
 * 这是「不接 Key 时虎鲸也活着」的唯一通路，所以必须在 hasApiKey 检查之前跑。
 * 动作由 3D 层执行，模型那边只从 bodyMind 的事件里知道「我刚做了什么」，
 * 于是它仍然认为那是自己的行为，却不需要为一次转圈多跑一轮请求。
 * @returns true 表示这一轮已经被本地处理掉，调用方不必再走模型。
 */
async function runLocalCommand(
  text: string,
  attachments: readonly Attachment[],
  signal: AbortSignal,
): Promise<boolean> {
  if (attachments.length > 0) return false
  const command = parseCommand(text)
  if (command === null) return false

  const store = useAppStore.getState()
  if (!store.settings.embodiment) return false

  /*
   * busy / activeAbort 由调用方（sendMessage 里的 beginTurn）统一持有。
   *
   * 以前这里自己 `busy = true` … finally `busy = false`，会把调用方刚占住的那一份
   * 提前放掉：本地动作还在演，用户就能再发一条，两轮叠在一起（BUG-REVIEW T-09）。
   * 取消改走 signal —— 停止之后不要再演动作，也不要补那条预制回复。
   */
  let conversationId = store.activeId
  if (conversationId === null) conversationId = await store.actions.createConversation()

  const userMessage: ChatMessage = {
    id: `msg_${nanoid(10)}`,
    conversationId,
    role: 'user',
    content: text.trim(),
    createdAt: Date.now(),
    status: 'done',
  }
  await store.actions.appendMessage(userMessage)

  const conversation = useAppStore.getState().conversations.find((item) => item.id === conversationId)
  if (conversation !== undefined && conversation.title === '新的对话') {
    await store.actions.bumpConversation({ title: text.trim().replace(/\s+/g, ' ').slice(0, 26) }, conversationId)
  }

  // 用户消息已经落库，从这一刻起用户随时可能按停止。
  if (signal.aborted) return true

  // 身体先动，再说那句预制的话；两件事都不依赖网络。
  const directive: BodyDirective = {
    act: command.act,
    ...(command.mood !== undefined ? { mood: command.mood } : {}),
  }
  stageBridge.current?.perform?.(directive)
  bodyMind.perform(directive)
  bodyMind.speak(command.reply, 'say', 4200)
  stageBridge.current?.pulse('reply')

  const reply: ChatMessage = {
    id: `msg_${nanoid(10)}`,
    conversationId,
    role: 'assistant',
    content: command.reply,
    createdAt: Date.now(),
    status: 'done',
  }
  // 演动作这段时间里也可能被停掉：那就只留用户那条，不补回复。
  if (signal.aborted) return true
  await store.actions.appendMessage(reply)
  return true
}

/**
 * 没接 Key 时的一轮回复。
 *
 * 虎鲸还在，只是没有模型替它组织长句子。做法是：消息照常落库（这样接上 Key
 * 之后历史是完整的），回一句本地短话，并提示「接上 Key 我才能好好答」。
 * 绝不弹设置页——用户只是想说句话，不是想改配置。
 * @returns true 表示这一轮已经被本地处理掉。
 */
async function runOfflineReply(
  text: string,
  attachments: readonly Attachment[],
  signal: AbortSignal,
): Promise<boolean> {
  const store = useAppStore.getState()
  // busy / activeAbort 同样由调用方的 beginTurn 持有（见 runLocalCommand 的注释）。
  let conversationId = store.activeId
  if (conversationId === null) conversationId = await store.actions.createConversation()

  const userMessage: ChatMessage = {
    id: `msg_${nanoid(10)}`,
    conversationId,
    role: 'user',
    content: text.trim(),
    attachments: attachments.length > 0 ? [...attachments] : undefined,
    createdAt: Date.now(),
    status: 'done',
  }
  await store.actions.appendMessage(userMessage)

  const conversation = useAppStore.getState().conversations.find((item) => item.id === conversationId)
  if (conversation !== undefined && conversation.title === '新的对话') {
    const source = text.trim() !== '' ? text.trim() : attachments[0]?.name ?? '新的对话'
    await store.actions.bumpConversation({ title: source.replace(/\s+/g, ' ').slice(0, 26) }, conversationId)
  }

  // 用户消息已落库；停止之后不要再补那句本地回复，也不要再弹「去填 Key」的提示。
  if (signal.aborted) return true

  const reply: ChatMessage = {
    id: `msg_${nanoid(10)}`,
    conversationId,
    role: 'assistant',
    content: offlineLine(),
    createdAt: Date.now(),
    status: 'done',
  }
  await store.actions.appendMessage(reply)
  bodyMind.speak(reply.content, 'say', 4200)
  stageBridge.current?.pulse('reply')
  // 提示是可点的，想填 Key 的人点一下就去；不想填的人可以继续在这儿待着。
  store.actions.setNotice('还没接上模型，我现在只能这样简单回你。点这里填 API Key。')
  return true
}

/** 没接 Key 时的预制回应，随机且不重复上一条。 */
const OFFLINE_LINES = [
  '我还连不上脑子，只能说这么一句。',
  '现在我只有本能，没有语言模型。',
  '这片海我还在，只是暂时想不了复杂的事。',
  '等接上模型，我就能好好跟你说话了。',
]

let lastOfflineLine = ''

function offlineLine(): string {
  const pool = OFFLINE_LINES.length > 1
    ? OFFLINE_LINES.filter((line) => line !== lastOfflineLine)
    : OFFLINE_LINES
  const line = pool[Math.floor(Math.random() * pool.length)] ?? OFFLINE_LINES[0] ?? ''
  lastOfflineLine = line
  return line
}

/**
 * Run one user turn end to end: persist the message and its attachments,
 * stream the assistant, execute tool calls against the workshop, perform any
 * body-control directives, and fold the result into memory.
 * @returns true once the user message was accepted (the composer may clear).
 */
export async function sendMessage(
  text: string,
  attachments: Attachment[] = [],
  options: { onAccepted?: () => void } = {},
): Promise<boolean> {
  const trimmed = text.trim()
  if (trimmed === '' && attachments.length === 0) return false
  if (attachments.length > MAX_ATTACHMENTS) {
    useAppStore.getState().actions.showToast(`一次最多附上 ${MAX_ATTACHMENTS} 个文件`)
    return false
  }
  const store = useAppStore.getState()
  /*
   * 路由判断用「这段对话实际生效的设置」，不是全局 settings。
   *
   * 助手可以覆盖模型、对话也有快照。全局与生效值不一致时，以前两套判断会打架：
   * 全局是网页账号、快照是 API 模型 → 进了登录流程但请求按 API 发 → 「还没有填 API Key」/401；
   * 全局是 API、快照是网页模型 → 直接走离线回复 → 「还没接上模型，点这里填 API Key」。
   * runAssistantTurn 用的是 cfg.model，这里也用同一份。
   */
  const effective = effectiveSettings(
    store.settings,
    store.conversations.find((item) => item.id === store.activeId),
  )

  /*
   * 整条链路（占位 → 准备 → 取消闸门 → 提交 → 统一释放）都在 runSend 里。
   *
   * 抽出去的原因很具体：engine 依赖 IndexedDB 与 Capacitor，node 里跑不起来，
   * 所以「登录期间点了停止，回来还会不会继续发」这种问题，只有把业务编排放在
   * 一个可注入依赖的函数里才测得动 —— 否则测试只能在测试文件里自己抄一遍流程，
   * 那证明的是测试代码，不是生产代码（三审意见）。
   *
   * 取消判断（signal.aborted）也在 runSend 里：webChatReady / loginWebChat 每个
   * await 之后、以及进入 commit 之前都会复查，取消之后不会再建会话、不会落库、
   * 不会触发 onAccepted、也不会起模型请求。
   */
  const outcome = await runSend({
    begin: beginTurn,
    end: endTurn,
    notify: (message) => useAppStore.getState().actions.showToast(message),
    runLocalCommand: (signal) => runLocalCommand(trimmed, attachments, signal),
    runOfflineReply: (signal) => runOfflineReply(trimmed, attachments, signal),
    hasApiKey: hasApiKey(effective),
    isWebChatProvider: isWebChatProvider(effective),
    webChatReady,
    loginWebChat,
    commit: (turn) => runSendCommit({
      store,
      settings: effective,
      trimmed,
      attachments,
      options,
      signal: turn.abort.signal,
    }),
    settle: () => {
      useAppStore.getState().actions.setSending(false)
      useAppStore.getState().actions.endLive()
    },
  })
  return outcome.accepted
}

/**
 * 一轮发送的「提交」阶段：建会话 → 写用户消息 → onAccepted → 起模型请求。
 *
 * 只有 runSend 通过了取消闸门才会调到这里 —— 这也是为什么取消之后不会出现
 * 「消息还是发出去了」：这四条副作用全在这个函数里。
 */
async function runSendCommit(input: {
  store: ReturnType<typeof useAppStore.getState>
  settings: Settings
  trimmed: string
  attachments: Attachment[]
  options: { onAccepted?: () => void }
  signal: AbortSignal
}): Promise<boolean> {
  const { store, settings, trimmed, attachments, options, signal } = input

  store.actions.setNotice('')
  stageBridge.current?.pulse('send')

  let accepted = false
  let stream: { conversationId: string; history: ChatMessage[] } | null = null
  try {
    let conversationId = store.activeId
    if (conversationId === null) {
      conversationId = await store.actions.createConversation()
    }
    // 发送状态带上「属于哪段对话」：生成中切到别的对话时，正在思考的占位
    // 不该跑到别人家的界面上（BUG-REVIEW P1-1）。
    store.actions.setSending(true, conversationId)

    // 助手可以给用户消息套一层模板（{{ message }} 会被替换）。存的是套过模板的正文，
    // 这样重发、分支、压缩看到的都是模型当时真正收到的东西。
    const liveConversation = useAppStore.getState().conversations.find((item) => item.id === conversationId)
    const activeCfg = conversationConfig(useAppStore.getState().settings, liveConversation)
    const outgoing = applyMessageTemplate(activeCfg.messageTemplate, trimmed)

    const userMessage: ChatMessage = {
      id: `msg_${nanoid(10)}`,
      conversationId,
      role: 'user',
      content: outgoing,
      attachments: attachments.length > 0 ? attachments : undefined,
      createdAt: Date.now(),
      status: 'done',
    }
    await store.actions.appendMessage(userMessage)
    accepted = true
    // 用户消息已落库：立刻通知调用方（输入框可以在这一刻清空，不必等整轮生成结束）。
    options.onAccepted?.()

    const attachmentTitle = attachments[0]?.name
    const titleSource = trimmed !== '' ? trimmed : attachmentTitle ?? '新的对话'
    const conversation = useAppStore.getState().conversations.find((item) => item.id === conversationId)
    if (conversation !== undefined && conversation.title === '新的对话') {
      await store.actions.bumpConversation({ title: titleSource.replace(/\s+/g, ' ').slice(0, 26) }, conversationId)
    }

    stream = { conversationId, history: useAppStore.getState().messages }
    await runAssistantTurn({ conversationId: stream.conversationId, history: stream.history, settings, signal })
  } catch (error) {
    const message = errorText(error)
    const conversationId = stream?.conversationId ?? null
    if (conversationId === null) {
      // 还没开始生成就失败了（建会话或落库抛错）。这时候不伪造空的助手消息，
      // 只把原因说出来；输入框保留原文，用户可以直接重试。
      useAppStore.getState().actions.showToast(message)
      stageBridge.current?.pulse('error')
    } else {
      const live = useAppStore.getState().live
      const partial = extractBodyDirectives(live?.content ?? '', true).clean
      const partialReasoning = live?.reasoning ?? ''
      useAppStore.getState().actions.endLive()
      if (signal.aborted) {
        if (partial.trim() !== '' || partialReasoning.trim() !== '') {
          const stopped: ChatMessage = {
            id: `msg_${nanoid(10)}`,
            conversationId,
            nodeId: turnNodeId ?? undefined,
            role: 'assistant',
            content: partial,
            reasoning: partialReasoning || undefined,
            createdAt: Date.now(),
            status: 'aborted',
          }
          await useAppStore.getState().actions.appendMessage(stopped)
        }
        useAppStore.getState().actions.showToast('已停止生成')
      } else {
        const failed: ChatMessage = {
          id: `msg_${nanoid(10)}`,
          conversationId,
          nodeId: turnNodeId ?? undefined,
          role: 'assistant',
          content: partial,
          reasoning: partialReasoning || undefined,
          createdAt: Date.now(),
          status: 'error',
          error: message,
        }
        await useAppStore.getState().actions.appendMessage(failed)
        useAppStore.getState().actions.showToast(message)
        stageBridge.current?.pulse('error')
        bodyMind.note('error', '你和用户的连接刚刚断了一下')
      }
    }
  }

  return accepted
}

/**
 * 群聊发送：用户只说一次，被选中的助手依次发言（有间隔）。
 *
 * 和 sendMessage 的区别只有「谁来答、答几次」：用户消息只落一条，然后按
 * planGroupRound 排出的顺序逐个跑 runAssistantTurn（每个都带着 respondAs）。
 * 被点名的助手一定开口；其余成员可以在允许时选择 <pass/> 跳过，省 token。
 */
export async function sendGroupMessage(
  text: string,
  attachments: Attachment[] = [],
  options: { onAccepted?: () => void } = {},
): Promise<boolean> {
  const trimmed = text.trim()
  if ((trimmed === '' && attachments.length === 0) || turnGate.isBusy()) return false
  const store = useAppStore.getState()
  const settings = store.settings
  const conversationId = store.activeId
  const conversation = conversationId === null
    ? undefined
    : store.conversations.find((item) => item.id === conversationId)

  // 不是群聊 / 没有成员 / 没有 Key / 网页账号模式：都退回单助手那条成熟路径，
  // 群聊只是叠加在能正常工作的单聊之上，任何一条不满足都不该让发送变哑。
  if (
    conversationId === null
    || conversation === undefined
    || conversation.kind !== 'group'
    || (conversation.members ?? []).length === 0
    || !hasApiKey(settings)
    || isWebChatProvider(settings)
  ) {
    return sendMessage(text, attachments, options)
  }

  const members = (conversation.members ?? [])
    .map((id) => settings.assistants.find((item) => item.id === id))
    .filter((item): item is Assistant => item !== undefined)
  if (members.length === 0) return sendMessage(text, attachments, options)

  const groupSettings = conversation.groupSettings ?? { gapMs: 1500, allowChatter: false, maxTurnsPerRound: 3 }
  const { speakers, named } = planGroupRound(members, trimmed, groupSettings)
  if (speakers.length === 0) return sendMessage(text, attachments, options)

  const turn = beginTurn()
  if (turn === null) return false
  const signal = turn.abort.signal
  store.actions.setNotice('')
  stageBridge.current?.pulse('send')

  let accepted = false
  try {
    const firstCfg = resolveAssistantConfig(settings, speakers[0])
    const outgoing = applyMessageTemplate(firstCfg.messageTemplate, trimmed)
    const userMessage: ChatMessage = {
      id: `msg_${nanoid(10)}`,
      conversationId,
      role: 'user',
      content: outgoing,
      attachments: attachments.length > 0 ? attachments : undefined,
      createdAt: Date.now(),
      status: 'done',
    }
    await store.actions.appendMessage(userMessage)
    accepted = true
    // 用户消息已落库：立刻通知调用方清空输入框（群聊同样要立刻清）。
    options.onAccepted?.()
    store.actions.setSending(true, conversationId)

    if (conversation.title === '新的对话') {
      const titleSource = trimmed !== '' ? trimmed : attachments[0]?.name ?? '新的对话'
      await store.actions.bumpConversation({ title: titleSource.replace(/\s+/g, ' ').slice(0, 26) }, conversationId)
    }

    for (let index = 0; index < speakers.length; index++) {
      if (signal.aborted) break
      const speaker = speakers[index]
      // 第一个发言人直接开口；其他人先等一个间隔，视觉上才像「轮流说话」。
      if (index > 0) {
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, Math.max(200, groupSettings.gapMs))
          signal.addEventListener('abort', () => {
            window.clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        if (signal.aborted) break
      }
      const isNamed = named.includes(speaker.id)
      // 主角（第一个）和被点名的人不许跳过；其余人允许 <pass/>。
      const allowPass = index > 0 && !isNamed
      await runAssistantTurn({
        conversationId,
        history: useAppStore.getState().messages,
        settings,
        signal,
        respondAs: speaker,
        allowPass,
      })
    }
  } catch (error) {
    useAppStore.getState().actions.showToast(errorText(error))
  } finally {
    // 群聊也要按归属复位：这里以前漏清 turnNodeId，下一轮消息会挂到上一轮的节点上。
    endTurn(turn)
    useAppStore.getState().actions.setSending(false)
    useAppStore.getState().actions.endLive()
  }
  return accepted
}

/**
 * 生成一轮助手回复（可能含多轮工具调用）。
 * sendMessage / sendGroupMessage / regenerateAtMessage / editAndResend 都走这里，
 * 避免多份流式逻辑漂移。
 */
async function runAssistantTurn(options: {
  conversationId: string
  history: ChatMessage[]
  settings: Settings
  signal: AbortSignal
  /** 这一轮是改写历史（编辑重发 / 重新生成）；网页账号模式要额外说明。 */
  rewrite?: 'edit' | 'regenerate'
  /**
   * 续写：把这一轮的结果**并入**这条已有消息，而不是新起一条。
   *
   * 用途：「输出上限被截断」之后点「继续」/自动续写。界面上仍是一条连续的回复
   * （见 Chat 里 continuedFrom 的渲染），历史里也保持一条 assistant，避免模型
   * 看到「自己说了两遍」。
   */
  continueFrom?: string
  /**
   * 群聊用：这一轮以哪个助手的身份发言。
   * 不给 = 用这段对话快照里的助手（单聊的常态）。
   */
  respondAs?: Assistant
  /**
   * 群聊用：允许这个助手「不想说就跳过」。
   * 模型回 `<pass/>` 时这一轮不落库、不占轮数。
   */
  allowPass?: boolean
}): Promise<{ spoke: boolean }> {
  const { conversationId, signal } = options
  let history = [...options.history]
  let lastReply = ''
  // 续写时把「同一条消息」当目标；只对第一轮生效（后面工具循环正常追加）。
  let continueTarget = options.continueFrom
  // 自动续写只做一次：本轮最后一次落库的助手消息是否被截断。
  let lastAssistantId: string | null = null
  let lastTruncated = false

  if (options.continueFrom !== undefined) {
    // 这句只进本轮请求，不落库：让模型知道「接着上次断开处写，别重复」。
    history = [
      ...history,
      {
        id: `synthetic_${nanoid(8)}`,
        conversationId,
        role: 'user',
        content: '继续。从你上一条回复断开的地方接着写，不要重复已经写过的内容，也不要重新开头。',
        createdAt: Date.now(),
        status: 'done',
      },
    ]
  }

    // 这段对话实际用哪套人格与参数：有快照用快照，没有就用当前助手现算。
    const conversation = useAppStore.getState().conversations.find((item) => item.id === conversationId)
    // 群聊：这一轮以指定助手身份发言，配置用它自己的；否则用对话快照。
    const cfg = options.respondAs !== undefined
      ? resolveAssistantConfig(options.settings, options.respondAs)
      : conversationConfig(options.settings, conversation)
    // 助手可以覆盖模型 / 温度 / 思考强度 / 回顾 / 时间提醒；没覆盖的跟随全局。
    // 但「全局选了网页账号」是账号模式，不许被助手/快照拽回 API 模型（真机 401 的根因）。
    const settings: Settings = {
      ...options.settings,
      model: isWebChatModel(options.settings.model) ? options.settings.model : cfg.model,
      temperature: cfg.temperature,
      thinkingEffort: cfg.thinkingEffort,
      recentChats: cfg.recentChats,
      timeReminder: cfg.timeReminder,
    }
    // 走不走网页账号，以「这段对话实际用的模型」为准（和 streamChat 里的判断同源）。
    // 用全局设置判断会漏掉「对话快照是网页模型、全局已经切回 API」的情况。
    const webMode = isWebChatProvider(settings)
    // 这一轮的工具调用落在哪个工坊项目：对话绑定优先，老对话回落到当前项目。
    const workspaceId = conversation?.workspaceId || settings.activeWorkspaceId || DEFAULT_WORKSPACE

    // 记忆读闸门：全局关掉就全停，助手说不读就只对这个助手生效。
    const assistant = options.respondAs ?? findAssistant(options.settings, conversation?.assistantId)
    const memoryOn = memoryReadEnabled(options.settings, assistant)
    const firstUser = options.history.find((message) => message.role === 'user')
    const memoryHint = [conversation?.title, firstUser?.content]
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
      .join(' ')
    const memory = memoryOn
      ? await memoryForPrompt({
        settings: options.settings,
        characterId: assistant.id,
        hint: memoryHint,
      })
      : { active: [], hidden: 0, usedTokens: 0, budget: 0 }
    const recap = settings.recentChats ? await recentRecap(conversationId) : ''
    const digest = await conversationDigest(conversationId)
    const system = buildSystemPrompt({
      settings,
      memories: memory.active,
      recap,
      digest,
      body: settings.embodiment ? bodyMind.promptBlock() : undefined,
      persona: cfg.systemPrompt,
      assistantName: cfg.name,
      media: {
        image: !webMode && isImageConfigured(settings.imageApi),
        speech: !webMode && isSpeechConfigured(settings.speechApi),
      },
    })

    // 群聊：告诉这个助手「你不是一个人」。也给它一个体面的退出方式（<pass/>），
    // 否则每个成员都会硬接一句，token 会成倍烧。
    const groupPrompt = options.allowPass === true
      ? [
        '',
        '<group_chat>',
        `你们是一个群聊，这一轮轮到你（${cfg.name}）发言。群里还有其他人，你只代表你自己。`,
        '如果这句话轮不到你说、或你没什么要补充的，就**只输出** <pass/> 这一个标记，不要写别的。',
        '被点名时必须认真回答。',
        '</group_chat>',
      ].join('\n')
      : ''
    const finalSystem = groupPrompt === '' ? system : `${system}\n${groupPrompt}`

    // 等 MCP 连好再组请求，否则刚开机就发消息会看不到 MCP 工具。
    // 放在循环外：多轮工具调用不该每一轮都等一遍。
    await waitForReady()

    // 网页账号模式：注入的只有「稳定块」（人设 + 常驻记忆）。
    //
    // 以前这里把整个 system prompt 传下去（含身体读数、时间、回顾、滚动摘要），
    // 而身体/时间/摘要每轮都在变，于是「和上次不一样才重拼」的判据几乎每轮成立，
    // 用户看到的就是每条消息都带一段人设。稳定块不随轮次变化，首轮拼一次就够。
    //
    // 身体/时间这些在网页账号模式下不再注入：网页线程自己记得上下文，硬塞只会
    // 撑长输入；API 模式不受影响（那里走真正的 system 角色）。
    const webContext = webMode
      ? buildWebChatContext({
        settings,
        persona: cfg.systemPrompt,
        name: cfg.name,
        characterId: assistant.id,
        memories: useAppStore.getState().memories,
      })
      : ''
    // DOM 遥控窗那条路要提前写进中继脚本；HTTP 路顺手写一次也无害（没窗口就是 no-op）。
    if (webContext !== '') {
      await setWebChatContext(webContext).catch(() => undefined)
    }
    // 改写历史时，网页那边只会多一条新消息（旧消息删不掉）。先说清楚，
    // 别让用户以为网页版也会跟着改。
    if (webMode && options.rewrite !== undefined) {
      useAppStore.getState().actions.setNotice('网页账号模式：网页会话只能追加，这次改写会作为新消息发过去（网页里那条旧的还在）')
    }

    // 输出预算：正文预算 + 思考预留（见 budget.ts）。这一轮里模型与思考强度都不变，
    // 所以只算一次；撞顶时用它算「翻倍上限」。
    const outputCap = resolveOutputCap(settings, currentProvider(settings))
    // 图生图的参考图：只取本轮最后一条用户消息里的图片附件。模型要显式传
    // reference="last_user_images" 才会用到它们——绝不能在用户只是「发图聊天」时自动生图。
    const lastUserMessage = [...options.history].reverse().find((message) => message.role === 'user')
    const referenceImages = (lastUserMessage?.attachments ?? [])
      .filter((attachment) => attachment.kind === 'image' && typeof attachment.dataUrl === 'string' && attachment.dataUrl !== '')
      .map((attachment) => attachment.dataUrl as string)
    let activeLimit: number | undefined
    // 一轮发言里最多自救两次 —— 每次都把新预算吃光的模型不该让我们空转。
    let lengthRetries = 0
    let iteration = 0
    while (iteration < MAX_TOOL_ITERATIONS) {
      // 停止之后不要再来一轮：否则会为一次已经取消的生成再付一次请求（T-05）。
      if (signal.aborted) break
      iteration += 1
      useAppStore.getState().actions.startLive(conversationId)
      stageBridge.current?.pulse('think')

      let rawContent = ''
      let visibleContent = ''
      let reasoning = ''
      let reasoningEndedAt: number | null = null
      let requestStartedAt = Date.now()
      let timer: number | undefined
      let pendingFlush = false

      const flush = (): void => {
        pendingFlush = false
        if (timer !== undefined) {
          window.clearTimeout(timer)
          timer = undefined
        }
        useAppStore.getState().actions.updateLive({ content: visibleContent, reasoning })
      }
      const schedule = (): void => {
        if (pendingFlush) return
        pendingFlush = true
        timer = window.setTimeout(flush, 33)
      }

      /**
       * 一次流式请求。
       *
       * 撞顶重试会第二次进来，所以先把累加器清空：服务端重新一字不落地生成，
       * 留着上一次的正文与思考会让界面显示两份内容（思考计时也会串到上一轮去）。
       */
      const streamOnce = async (limit: number | undefined): Promise<StreamResult> => {
        rawContent = ''
        visibleContent = ''
        reasoning = ''
        reasoningEndedAt = null
        requestStartedAt = Date.now()
        if (timer !== undefined) {
          window.clearTimeout(timer)
          timer = undefined
        }
        pendingFlush = false
        const request = buildRequestMessagesDetailed({ settings, system: finalSystem, history })
        if (request.dropped > 0) {
          console.info(`[history] dropped ${request.dropped} older messages to fit context`)
          useAppStore.getState().actions.setNotice(`前面的 ${request.dropped} 条消息已超出上下文，我丢掉了`)
        }
        const streamed = await streamChat({
          settings,
          messages: request.messages,
          // 被长度切断后原地重发时带的放大上限；平时是 undefined，用预算模块算出来的值。
          maxTokensOverride: limit,
          // 网页账号的 HTTP 模式靠它把 App 对话映射到网页线程。
          conversationId,
          // 人设 + 常驻记忆的稳定块（只有网页账号模式非空）。
          webContext,
          // 改写历史时给网页模型补一句「以这条为准」。
          webRewrite: webMode ? options.rewrite : undefined,
          // 内置工具 + 已连上的 MCP 工具一起交给模型。
          // 网页账号没有 function-calling，给了也只会被忽略，干脆不传。
          tools: webMode
            ? []
            : [
              // 记忆关了就不给模型这个工具，省 token，也免得它写进一个用户关掉的库。
              ...(options.settings.memoryEnabled ? [{ ...REMEMBER_TOOL }] : []),
              ...TOOL_DEFINITIONS.map((tool) => ({ ...tool })),
              // 生图/语音只在对应 API 配好时才交给模型；未配置不出现。
              ...mediaToolDefinitions(settings),
              // 便签工具只在助手功能开启时给：关掉助手就是纯净对话，
              // 不该让模型自己去写日历。
              ...(options.settings.assistantsEnabled === true ? calendarToolDefinitions(settings) : []),
              ...availableTools().map((item) => item.definition),
            ],
          signal,
          handlers: {
            onDelta: (delta) => {
              rawContent += delta
              const streamedText = extractBodyDirectives(rawContent)
              visibleContent = streamedText.clean
              schedule()
            },
            onReasoning: (delta) => {
              reasoning += delta
              reasoningEndedAt = Date.now()
              schedule()
            },
          },
        }).finally(() => {
          /*
           * 收掉这一轮的 debounce 定时器 —— 成功、抛错、被 abort 三条路都要收。
           *
           * schedule() 每 33ms 排一次 flush()，而 flush 会无条件 updateLive()。
           * 以前只有「streamChat 正常返回」这条路上会走到下面的 flush()，
           * 网络中断 / SSE error / 400 退避耗尽时 streamOnce 直接抛出去，
           * 定时器留在那儿：33ms 后照样 updateLive 一次。如果这时新一轮已经
           * startLive()（store 里是无条件覆盖），上一轮的半截正文就写进了
           * 新一轮的占位气泡（BUG-REVIEW「幽灵气泡」）。
           * bodyMind.drainEvents() 同理 —— 被跳过的那些事件会带到下一轮去。
           */
          if (timer !== undefined) {
            window.clearTimeout(timer)
            timer = undefined
          }
          pendingFlush = false
          // 提示词已经发出去了，它引用的那些事件就算花掉了 —— 抛错时也要清，
          // 否则它们会被带进下一轮的人设里。
          bodyMind.drainEvents()
        })
        flush()
        return streamed
      }

      let result = await streamOnce(activeLimit)
      let truncated = isTruncatedFinish(result.finishReason)
      // 思考把整段输出额度吃光时，服务端回 finish_reason:'length'，正文与 tool_calls
      // 都是空的 —— 过去这里只看「有没有工具」，于是直接结束，工坊一次都没被调用，
      // 用户看到的只是「想到一半停住」。先自己救一次：上限翻倍、原地重发同一个请求，
      // 不改历史、也不把这条截断的回复落库。
      if (truncated && !result.aborted && result.toolCalls.length === 0 && lengthRetries < 2) {
        const bigger = retryCap(outputCap)
        if (bigger !== null) {
          lengthRetries += 1
          activeLimit = bigger
          useAppStore.getState().actions.setNotice(`思考把输出额度用完了，我把上限提到 ${bigger} 再写一次`)
          result = await streamOnce(bigger)
          truncated = isTruncatedFinish(result.finishReason)
        }
      }
      if (truncated) {
        // 救过一次还是撞顶：这次要让人看见，别让它消失在「思考了很久然后什么都没有」里。
        useAppStore.getState().actions.setNotice('已到输出上限，这一轮被截断了。说「继续」我接着写，或在设置里放大「单次最多输出」。')
      }

      const parsed = extractBodyDirectives(result.content || rawContent, true)
      const finalContent = parsed.clean
      /*
       * 模型写的身体指令要真的演出来。
       *
       * README:33 一直写着「开启身体联动后，模型会在回复里写 <body act="spin" say="…" />
       * 这样的指令；深鲸会把标签从正文里拿掉，再让虎鲸转圈 / 下潜 / 说一句台词」。
       * 但这条链路在 API 模式下从来没接上：extractBodyDirectives 的返回值只用到了
       * clean（剥标签），directives 被直接丢掉 —— 于是气泡永远是空的，用户点开
       * 也只看到「正在思考」。这里把它接回去，顺序与本地快捷指令一致：先动身体，再说台词。
       * 只演最后一条：一轮里写多条动作时，前面那些已经没有观看价值了。
       */
      const lastDirective = parsed.directives.length > 0
        ? parsed.directives[parsed.directives.length - 1]
        : undefined
      if (lastDirective !== undefined) {
        stageBridge.current?.perform?.(lastDirective)
        bodyMind.perform(lastDirective)
        if (lastDirective.say !== undefined && lastDirective.say.trim() !== '') {
          bodyMind.speak(lastDirective.say.trim(), 'say', 4200)
        }
      }
      const thinkingMs = reasoning.trim() !== ''
        ? Math.max(1, (reasoningEndedAt ?? Date.now()) - requestStartedAt)
        : undefined

      // 群聊「跳过」：模型不想接话时只回 <pass/>，这一轮不落库、不显示。
      const passed = options.allowPass === true && finalContent.trim() === '<pass/>'

      /*
       * 被停止的那一轮，tool_calls 一个都不能留。
       *
       * 模型吐 tool_calls 是「流式」的：名字先到、参数后到。用户在参数写一半时按停止，
       * deepseek.ts 的 finalizeTools 仍会把这条只有名字的 call 定稿成非空 toolCalls。
       * 一旦它跟着 assistant 消息落库，下一轮请求里就会出现 assistant.tool_calls
       * 却没有配对的 role:'tool' 消息 —— 服务端直接 400，用户下一条消息根本发不出去
       * （BUG-REVIEW T-04）。
       *
       * 「停止」的语义就是这一轮不算数，所以连 workspaceName 那个标签也一起丢掉。
       */
      const usableToolCalls = result.aborted || result.toolCalls.length === 0
        ? undefined
        : result.toolCalls
      const assistant: ChatMessage = {
        id: `msg_${nanoid(10)}`,
        conversationId,
        nodeId: turnNodeId ?? undefined,
        role: 'assistant',
        // 群聊必须记下是谁说的；单聊留空（气泡不显示署名，减少噪音）。
        ...(options.respondAs !== undefined
          ? {
            assistantId: options.respondAs.id,
            assistantName: options.respondAs.name,
            assistantAvatar: options.respondAs.avatar,
          }
          : {}),
        content: finalContent,
        reasoning: (result.reasoning || reasoning).trim() || undefined,
        thinkingMs,
        toolCalls: usableToolCalls,
        // 工具调用行要标出这段对话绑定的项目，别让用户猜文件写去了哪里。
        ...(usableToolCalls !== undefined
          ? { workspaceName: useAppStore.getState().settings.workspaces.find((item) => item.id === workspaceId)?.name }
          : {}),
        createdAt: Date.now(),
        status: result.aborted ? 'aborted' : 'done',
        usage: result.usage,
        // 落库是为了回看时还能知道「这条是被切断的」，界面据此标一句「已到输出上限」。
        ...(truncated ? { truncated: true } : {}),
      }
      useAppStore.getState().actions.endLive()

      const hasSomething = !passed && (
        assistant.content.trim() !== ''
        || (assistant.reasoning ?? '').trim() !== ''
        || (assistant.toolCalls?.length ?? 0) > 0
      )
      if (hasSomething) {
        const target = continueTarget
        continueTarget = undefined
        const existing = target !== undefined
          ? useAppStore.getState().messages.find((item) => item.id === target)
          : undefined
        let stored: ChatMessage
        if (existing !== undefined) {
          /*
           * 续写：并进原消息。
           * 文案直接拼在后面（用户看到的就是「一段更长的回复」），思考也拼起来；
           * 工具调用追加，截断标记按**这一轮**的结果重算 —— 这次写完了就把标记摘掉。
           */
          stored = {
            ...existing,
            content: `${existing.content}${assistant.content}`,
            reasoning: [existing.reasoning, assistant.reasoning]
              .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
              .join('\n') || undefined,
            thinkingMs: (existing.thinkingMs ?? 0) + (assistant.thinkingMs ?? 0) || undefined,
            toolCalls: [...(existing.toolCalls ?? []), ...(assistant.toolCalls ?? [])].length > 0
              ? [...(existing.toolCalls ?? []), ...(assistant.toolCalls ?? [])]
              : undefined,
            status: assistant.status,
            usage: assistant.usage ?? existing.usage,
            ...(truncated ? { truncated: true } : { truncated: undefined }),
          }
          await useAppStore.getState().actions.updateMessage(existing.id, stored)
        } else {
          stored = { ...assistant, ...(target !== undefined ? { continuedFrom: target } : {}) }
          await useAppStore.getState().actions.appendMessage(stored)
        }
        history = [...history, stored]
        lastAssistantId = stored.id
        lastTruncated = stored.truncated === true
      }
      if (!passed && assistant.content.trim() !== '') lastReply = assistant.content

      // 方案甲：动作只由本地指令触发，模型不再驱动身体。
      // 这里只把解析出来的标签从正文里剥掉（防御性，模型万一还是写了也不外泄）。

      /*
       * 用量只在「这一轮真的跑完了」时记。
       * 停止之后继续写用量表，等于让「停止」变成「停止但仍然记账」（T-06）。
       */
      if (!signal.aborted) {
        if (result.usage) {
          void addUsage({
            conversationId,
            model: settings.model,
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
          })
        } else {
          void addUsage({
            conversationId,
            model: settings.model,
            inputTokens: estimateTokens(JSON.stringify(buildRequestMessages({ settings, system: finalSystem, history }))),
            outputTokens: estimateTokens(assistant.content),
          })
        }
      }

      if (result.aborted) {
        stageBridge.current?.pulse('reply')
        break
      }
      if (result.toolCalls.length === 0) {
        stageBridge.current?.pulse('reply')
        break
      }

      let workshopChanged = false
      // 这一轮里模型用 project 参数 / create_project 指到的项目：工具结果把它带回来，
      // 刷新与提示都要用它（而不是只认对话绑定的 workspaceId），否则界面还停在老项目。
      let lastTargetWorkspaceId: string | undefined
      let lastWorkspaceName: string | undefined
      for (const call of result.toolCalls) {
        /*
         * 用户在工具执行到一半时按了停止：剩下的工具不要再跑，但**每条都必须补一条
         * tool 消息并落库**。这条 assistant 消息的 tool_calls 已经写进去了，
         * 少一条配对响应，下一轮请求就是 400（和 T-04 是同一件事的两面）。
         */
        if (signal.aborted) {
          const skipped: ChatMessage = {
            id: `msg_${nanoid(10)}`,
            conversationId,
            role: 'tool',
            content: '已停止，这个工具没有执行。',
            toolCallId: call.id,
            toolName: call.function.name,
            createdAt: Date.now(),
            status: 'done',
          }
          await useAppStore.getState().actions.appendMessage(skipped)
          history = [...history, skipped]
          continue
        }
        // 最后一个参数：参数半截（不是合法 JSON）= 被输出上限切断，绝不执行（见 runTool）。
        // 保持一行是刻意的 —— test/sending-state.test.ts 用文本断言守着「本轮 signal 一路
        // 传到工具调用」这条线，拆成多行就会把它误判成回归。
        const executed = await runTool(call, conversationId, signal, workspaceId, result.truncatedToolCallIds.indexOf(call.id) !== -1, settings, referenceImages, assistant.id)
        if (executed.changed) workshopChanged = true
        if (executed.targetWorkspaceId !== undefined) {
          lastTargetWorkspaceId = executed.targetWorkspaceId
          lastWorkspaceName = executed.workspaceName
        }
        history = [...history, executed.message]
      }
      // 写入落在**这段对话绑定的项目**里，而工坊面板显示的是「当前打开的项目」。
      // 两边不一致时必须把界面切过去，否则 write_file 明明成功了、列表与预览却毫无动静，
      // 用户读到的就是「工坊根本没被调用」（显式带 id 的刷新会顺手切项目，见 store.ts）。
      const shownWorkspace = useAppStore.getState().settings.activeWorkspaceId || DEFAULT_WORKSPACE
      const defaultName = useAppStore.getState().settings.workspaces.find((item) => item.id === workspaceId)?.name ?? '工坊'
      const targetWorkspaceId = lastTargetWorkspaceId ?? workspaceId
      const targetName = lastWorkspaceName
        ?? useAppStore.getState().settings.workspaces.find((item) => item.id === targetWorkspaceId)?.name
        ?? defaultName
      await useAppStore.getState().actions.refreshWorkspace(workspaceId)
      // 模型指了别的项目（args.project / create_project）：真正的落点和对话绑定项目不同，
      // 再按落点刷一次，并强制把界面切过去，预览才看得见这次写入。
      if (targetWorkspaceId !== workspaceId) {
        await useAppStore.getState().actions.refreshWorkspace(targetWorkspaceId)
        await useAppStore.getState().actions.setActiveWorkspace(targetWorkspaceId)
      }
      if (workshopChanged) {
        if (shownWorkspace !== workspaceId) {
          useAppStore.getState().actions.showToast(`工坊已更新：这段对话写在「${targetName}」，界面已切过来`)
        } else {
          // 无论有没有切项目，提示里都带上项目名，别只说一句没头没尾的「工坊已更新」。
          useAppStore.getState().actions.showToast(`工坊已更新：「${targetName}」`)
        }
      }
    }
    if (iteration >= MAX_TOOL_ITERATIONS) {
      useAppStore.getState().actions.setNotice(`工具调用到了 ${MAX_TOOL_ITERATIONS} 轮上限，我先停在这里。说「继续」我接着做剩下的部分。`)
    }

    /*
     * 被停止的这一轮不做收尾记账（T-06）。
     *
     * 不写摘要 / 不抽记忆 / 不自动压缩 —— 压缩会真的再发一次网络请求，
     * 「停止」之后再花一次钱说不过去。
     */
    if (signal.aborted) return { spoke: lastAssistantId !== null }

    await useAppStore.getState().actions.bumpConversation({
      summary: lastReply.replace(/\s+/g, ' ').slice(0, 180),
      model: settings.model,
    }, conversationId)
    await useAppStore.getState().actions.refreshConversations()

    /*
     * 自动续写：被输出上限切断、而且这一轮没有可执行的工具调用时，自动补一次。
     *
     * 为什么值得做：截断率不低（长网页/游戏），而「点继续/打继续」是纯摩擦。
     * 续写走的是同一个 continueFrom 合并路径，所以界面上仍是一条连续回复。
     * 只做一次（options.continueFrom 未设置时才触发），避免弱模型把额度吃进死循环；
     * 可以在设置里关掉，留手动按钮兜底。
     */
    if (
      options.continueFrom === undefined
      && !signal.aborted
      && lastAssistantId !== null
      && lastTruncated
      && options.settings.autoContinue !== false
    ) {
      useAppStore.getState().actions.setNotice('输出被上限截断了，正在自动续写…')
      await runAssistantTurn({
        conversationId,
        history: useAppStore.getState().messages,
        settings: options.settings,
        signal,
        continueFrom: lastAssistantId,
        respondAs: options.respondAs,
        allowPass: options.allowPass,
      })
      return { spoke: lastAssistantId !== null }
    }

    // 定时抽取已删掉：只留「用户自己第二次提到同一件事」这一条宽松兜底。
    // 静默写入，只刷新记忆页数据，不弹提示——记忆要隐身。
    void detectRepeatedMemories({
      conversationId,
      messages: history,
      settings: options.settings,
    }).then((result) => {
      if (result.added + result.updated > 0) {
        void useAppStore.getState().actions.refreshMemories()
      }
    }).catch(() => undefined)
    // 自动压缩：开关关掉时不跑，手动入口（compressNow）仍然可用。
    if (settings.autoCompress) void maybeCompress(conversationId, settings)

    return { spoke: lastAssistantId !== null }
}

/**
 * 手动「继续」：把被截断的那条补完，并进同一条气泡。
 *
 * 和输入框里打「继续」的区别：这条不新建用户消息、不产生第二条助手气泡，
 * 用户点一下就走，看起来是同一段回答继续往下写。
 */
export async function continueTurn(messageId: string): Promise<boolean> {
  if (turnGate.isBusy()) {
    useAppStore.getState().actions.showToast('还在回复中，等这一轮结束再继续')
    return false
  }
  const state = useAppStore.getState()
  const conversationId = state.activeId
  if (conversationId === null) return false
  const target = state.messages.find((item) => item.id === messageId)
  if (target === undefined || target.role !== 'assistant') return false

  const turn = beginTurn()
  if (turn === null) return false
  const signal = turn.abort.signal
  state.actions.setSending(true, conversationId)
  state.actions.setNotice('')
  stageBridge.current?.pulse('think')
  try {
    await runAssistantTurn({
      conversationId,
      history: useAppStore.getState().messages,
      settings: useAppStore.getState().settings,
      signal,
      continueFrom: messageId,
    })
  } catch (error) {
    useAppStore.getState().actions.showToast(errorText(error))
    stageBridge.current?.pulse('error')
  } finally {
    // 续写以前也漏清 turnNodeId，同样按归属复位（T-08）。
    endTurn(turn)
    useAppStore.getState().actions.setSending(false)
    useAppStore.getState().actions.endLive()
  }
  return true
}

/**
 * 项目级工具要读/改 settings，不能只走 executeTool（那一层不该碰 store），
 * 所以在 runTool 这一层直接拦下来。
 */
async function runProjectTool(
  name: string,
  rawArgs: string,
): Promise<{ result: string; targetWorkspaceId?: string; workspaceName?: string }> {
  if (name === 'list_projects') {
    const list = useAppStore.getState().settings.workspaces
    const lines = list.length === 0
      ? '（还没有项目）'
      : list.map((item) => `- ${item.name}（id: ${item.id}）`).join('\n')
    return { result: `当前项目列表：\n${lines}` }
  }
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(rawArgs || '{}') as Record<string, unknown>
  } catch {
    args = {}
  }
  const requestedName = typeof args.name === 'string' ? args.name : ''
  // 复用 createWorkspace 的语义：校验名字、生成 ws_ 新 id、切到新项目并刷新，返回新 id。
  const id = await useAppStore.getState().actions.createWorkspace(requestedName)
  const created = useAppStore.getState().settings.workspaces.find((item) => item.id === id)
  const workspaceName = created?.name ?? requestedName
  return {
    result: `已创建项目「${workspaceName}」（id: ${id}）。接下来写文件时给 write_file 传 project（填 ${id} 或「${workspaceName}」），别再写进老项目。`,
    targetWorkspaceId: id,
    workspaceName,
  }
}

/**
 * 解析 args.project：命中项目 id 或名字就返回那个项目；没带就沿用本轮默认项目。
 * 带了却找不到要报错，绝不悄悄落回默认项目 —— 那正是「新旧代码混进一个项目」的来源。
 */
function resolveFileToolTarget(
  rawArgs: string,
  workspaceId: string,
): { targetWorkspaceId: string; workspaceName?: string } {
  const settings = useAppStore.getState().settings
  const defaultName = settings.workspaces.find((item) => item.id === workspaceId)?.name
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(rawArgs || '{}') as Record<string, unknown>
  } catch {
    args = {}
  }
  const project = args.project
  if (typeof project !== 'string' || project.trim() === '') {
    return { targetWorkspaceId: workspaceId, workspaceName: defaultName }
  }
  const key = project.trim()
  const match = settings.workspaces.find((item) => item.id === key || item.name === key)
  if (match === undefined) throw new Error('项目不存在')
  return { targetWorkspaceId: match.id, workspaceName: match.name }
}

/**
 * 执行一个工具调用。
 *
 * `argsTruncated` 来自流式层：arguments 不是合法 JSON 的调用（被输出上限切断）
 * **一次都不能执行** —— write_file 拿半截内容覆盖工坊里原本好好的文件，
 * 比不写糟糕得多。这里回一条说明让模型重新调用，同时把这次调用留在历史里，
 * 保证 tool_calls 与 tool 结果配对不断。
 */
async function runTool(
  call: ToolCall,
  conversationId: string,
  signal: AbortSignal,
  workspaceId: string,
  argsTruncated: boolean,
  settings: Settings,
  referenceImages: string[],
  assistantId?: string,
): Promise<{
  message: ChatMessage
  changed: boolean
  targetWorkspaceId?: string
  workspaceName?: string
}> {
  const messageId = `msg_${nanoid(10)}`
  let resultText: string
  let changed = false
  let targetWorkspaceId: string | undefined
  let workspaceName: string | undefined
  let mediaDrafts: MediaDraft[] = []
  if (argsTruncated) {
    resultText = '这次调用的参数在输出上限处被截断了（不是合法 JSON），所以没有执行，任何文件都没有被改动。请重新调用一次：一次 write_file 只写一个完整的文件，内容太长就拆成几个文件。'
  } else {
    try {
      if (call.function.name === 'list_projects' || call.function.name === 'create_project') {
        // 项目级工具直接读写 settings，必须拦在 executeTool 之前。
        const project = await runProjectTool(call.function.name, call.function.arguments)
        resultText = project.result
        targetWorkspaceId = project.targetWorkspaceId
        workspaceName = project.workspaceName
      } else if (call.function.name === REMEMBER_TOOL_NAME) {
        // 记忆写入一律静默：失败也只回一句话，绝不把异常抛回对话。
        let args: { text?: unknown; type?: unknown; importance?: unknown } = {}
        try {
          args = JSON.parse(call.function.arguments || '{}') as typeof args
        } catch {
          args = {}
        }
        const outcome = await remember(args, { conversationId })
        resultText = outcome.reply
        // 只刷新记忆页的数据，不弹提示、不打断这一轮。
        if (outcome.changed > 0) void useAppStore.getState().actions.refreshMemories()
      } else if (isMediaToolName(call.function.name)) {
        // 媒体工具必须在「工坊文件工具」的 else 之前分流：executeTool 的三参签名
        // 没有 AbortSignal，也不认识 generate_image/speak，落进去会被当成项目文件操作。
        const outcome = await runMediaTool(call.function.name, call.function.arguments, {
          settings,
          conversationId,
          referenceImages,
          signal,
        })
        resultText = outcome.resultText
        mediaDrafts = outcome.media
      } else if (isCalendarToolName(call.function.name)) {
        // 便签/唤醒工具：由助手在聊天里主动调用，落到 note / wakeSchedules 表。
        // runCalendarTool 内部已 try/catch，失败也只会回一段说明文字。
        const outcome = await runCalendarTool(call.function.name, call.function.arguments, {
          conversationId,
          assistantId,
        })
        resultText = outcome.resultText
        // 新建/提醒类便签可能立刻出现在日历上，顺手刷一下界面数据不必须（日历自己会读库），
        // 这里只提示用户知道助手写了东西。
        if (outcome.resultText.startsWith('已')) useAppStore.getState().actions.showToast(outcome.resultText.slice(0, 60))
      } else if (isMcpToolName(call.function.name)) {
        // MCP 工具走网络；参数解析失败时按空对象调用，别让整轮对话挂掉。
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
        } catch {
          args = {}
        }
        resultText = await callToolByName(call.function.name, args, signal)
      } else {
        // 文件工具：把 args.project 解析成目标项目，覆盖本轮默认项目。
        const route = resolveFileToolTarget(call.function.arguments, workspaceId)
        targetWorkspaceId = route.targetWorkspaceId
        workspaceName = route.workspaceName
        // 项目名喂给 workspace.ts：list_files 表头要带名字，又不把 store 反向塞进那一层。
        setToolWorkspaceName(workspaceName ?? targetWorkspaceId)
        // executeTool 的老签名只认这个 workspaceId 参数，直接把目标项目传下去。
        workspaceId = targetWorkspaceId
        const execution = await executeTool(call.function.name, call.function.arguments, workspaceId)
        resultText = execution.result
        changed = execution.changed
        // 「工坊已更新」这句提示归调用方发（它才知道刷的是哪个项目，见上面那段）。
      }
    } catch (error) {
      resultText = `工具执行失败：${errorText(error)}`
    }
  }
  // 先把媒体写进表，再 append 消息：Chat 渲染时引用必须已经能查到。
  // 被停止时不再写媒体：消息本身照旧要落（保持配对），但字节没必要永久留在库里（T-05）。
  const media: MessageMediaRef[] = []
  if (mediaDrafts.length > 0 && !signal.aborted) {
    try {
      for (const draft of mediaDrafts) {
        const record: MediaRecord = {
          ...draft,
          id: `media_${nanoid(10)}`,
          conversationId,
          messageId,
          createdAt: Date.now(),
        }
        await putMedia(record)
        media.push(mediaRefOf(record))
      }
    } catch (error) {
      resultText = `${resultText}（媒体保存失败：${errorText(error)}）`
    }
  }
  const message: ChatMessage = {
    id: messageId,
    conversationId,
    role: 'tool',
    content: resultText,
    toolCallId: call.id,
    toolName: call.function.name,
    ...(workspaceName !== undefined ? { workspaceName } : {}),
    ...(media.length > 0 ? { media } : {}),
    createdAt: Date.now(),
    status: 'done',
  }
  await useAppStore.getState().actions.appendMessage(message)
  return { message, changed, targetWorkspaceId, workspaceName }
}

/**
 * 重新生成某条助手消息：在同一条消息的节点上再造一个候选，并把旧的候选置为未选中。
 * 之前的历史（到上一条用户消息为止）保持不变。
 */
export async function regenerateAtMessage(messageId: string): Promise<boolean> {
  if (turnGate.isBusy()) return false
  const store = useAppStore.getState()
  const settings = store.settings
  if (hasApiKey(settings) === false) {
    // 用户明确要求重生成，这里必须说清楚为什么做不到；但也不要把他弹走。
    store.actions.showToast('重写需要模型，先填一个 API Key')
    return false
  }
  const conversationId = store.activeId
  if (conversationId === null) return false

  const messages = store.messages
  const targetIndex = messages.findIndex((message) => message.id === messageId)
  if (targetIndex === -1) return false
  const target = messages[targetIndex] as ChatMessage
  if (target.role !== 'assistant') return false

  const nodeId = target.nodeId ?? target.id

  // 从这里开始会改库、会发请求，所以先把 busy 占住：快速双击否则会并发起两轮，
  // 而全局只有一个 activeAbort，先启动的那轮会失去 abort 句柄（BUG-REVIEW P1-3）。
  const turn = beginTurn()
  if (turn === null) return false
  const signal = turn.abort.signal
  turnNodeId = nodeId
  try {
    // 该节点已有的全部候选在库里需要一起「取消选中」，只留新生成的那条。
    const siblings = await listMessageSiblings(conversationId, nodeId)
    for (const sibling of siblings) {
      if (sibling.active !== false) await putMessage({ ...sibling, active: false })
    }
    // 内存里：把这个节点从列表里摘掉（它要被重新生成）。
    const history = messages.filter((message) => (message.nodeId ?? message.id) !== nodeId)

    store.actions.setSending(true, conversationId)
    store.actions.setNotice('')
    store.actions.startLive(conversationId)
    await runAssistantTurn({ conversationId, history, settings, signal, rewrite: 'regenerate' })
  } catch (error) {
    const message = errorText(error)
    useAppStore.getState().actions.endLive()
    useAppStore.getState().actions.showToast(signal.aborted ? '已停止生成' : message)
  } finally {
    endTurn(turn)
    useAppStore.getState().actions.setSending(false)
    useAppStore.getState().actions.endLive()
  }
  // 重新拉一遍，保证榜单/分支计数与库一致。
  await store.actions.openConversation(conversationId)
  return true
}

/**
 * 编辑某条用户消息并重发：改内容后，把这条及其后所有消息作废（作废 = 未选中/删除），
 * 然后从这条位置继续生成。
 */
export async function editAndResend(messageId: string, text: string): Promise<boolean> {
  if (turnGate.isBusy()) return false
  const trimmed = text.trim()
  if (trimmed === '') return false
  const store = useAppStore.getState()
  const settings = store.settings
  if (hasApiKey(settings) === false) {
    // 同上：改完再问一次也得有模型，但别弹页面。
    store.actions.showToast('重发需要模型，先填一个 API Key')
    return false
  }
  const conversationId = store.activeId
  if (conversationId === null) return false

  const messages = store.messages
  const index = messages.findIndex((message) => message.id === messageId)
  if (index === -1) return false
  const target = messages[index] as ChatMessage
  if (target.role !== 'user') return false

  // 和 sendMessage 走同一套模板：库里存的必须是模型真正收到的正文，
  // 否则「编辑重发」一次就把这个不变量破坏了（BUG-REVIEW P1-18）。
  const liveConversation = useAppStore.getState().conversations.find((item) => item.id === conversationId)
  const activeCfg = conversationConfig(useAppStore.getState().settings, liveConversation)
  const outgoing = applyMessageTemplate(activeCfg.messageTemplate, trimmed)

  // 先占住 busy，再动库和请求（同 regenerate，BUG-REVIEW P1-3）。
  const turn = beginTurn()
  if (turn === null) return false
  const signal = turn.abort.signal
  turnNodeId = null
  try {
    // 改这条用户消息的正文（保留 attachments），并删掉它之后的所有消息。
    // 两步在同一个事务里：中途失败不会留下「正文改了、后面的还在」的半截状态。
    const after = messages.slice(index + 1)
    await rewriteMessageAndTruncate(
      { ...target, content: outgoing, status: 'done' },
      after.map((message) => message.id),
    )

    // 内存状态对齐：只保留到这条（含）为止。
    const history = messages.slice(0, index + 1).map((message) =>
      message.id === target.id ? { ...message, content: outgoing } : message,
    )
    await store.actions.openConversation(conversationId)

    store.actions.setSending(true, conversationId)
    store.actions.setNotice('')
    store.actions.startLive(conversationId)
    await runAssistantTurn({ conversationId, history, settings, signal, rewrite: 'edit' })
  } catch (error) {
    const message = errorText(error)
    useAppStore.getState().actions.endLive()
    useAppStore.getState().actions.showToast(signal.aborted ? '已停止生成' : message)
  } finally {
    endTurn(turn)
    useAppStore.getState().actions.setSending(false)
    useAppStore.getState().actions.endLive()
  }
  await store.actions.openConversation(conversationId)
  return true
}
