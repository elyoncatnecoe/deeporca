import { create } from 'zustand'
import { nanoid } from 'nanoid'
import {
  deleteConversation as deleteConversationRecord,
  deleteFilesByWorkspace,
  deleteMemory,
  deleteMessageNode,
  forkConversationUpTo,
  listConversations,
  listFiles,
  listMemories,
  listMessageSiblings,
  listMessages,
  putConversation,
  putMessage,
  putMemory,
  rebuildSearchIndex,
  clearConversations,
  clearMemories,
} from './db'
import { loadSettings, persistSettings } from './settings'
import { findAssistant, resolveAssistantConfig } from './assistant'
import { mirrorProviderFields, patchProvider, syncProviderToSettings } from './providers'
import { reconcileServers, setPolicyWriter } from './mcp-registry'
import { memoryCount } from './memory'
import { syncWebChatContext } from './web-context'
import { seedWorkspaceIfEmpty } from './workshop-sample'
import {
  copyWorkspaceFile as copyWorkspaceFileRecord,
  duplicateWorkspaceFiles,
  moveWorkspaceFile as moveWorkspaceFileRecord,
  renameWorkspaceFile as renameWorkspaceFileRecord,
} from './workspace'
import { stageBridge } from './stage-bridge'
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKSPACE,
  type Assistant,
  type ChatMessage,
  type Conversation,
  type ConversationConfig,
  type CreateConversationOptions,
  type MemoryEntry,
  type MemoryType,
  type Provider,
  type Settings,
  type Workspace,
  type WorkspaceFile,
} from './types'

export type Screen = 'home' | 'chat' | 'room' | 'memory' | 'workshop' | 'settings' | 'onboarding' | 'assistants' | 'providers' | 'mcp' | 'media' | 'appearance' | 'calendar'

/**
 * 上次停留的界面。只存页面名（不存业务数据），用于 WebView 被系统回收重载后
 * 回到原来的页面，而不是一律跳回首页。
 */
const LAST_SCREEN_KEY = 'deepsea.lastScreen'

/** 允许被恢复的界面：onboarding 永远不恢复，chat 需要重新打开对话后再落位。 */
const RESTORABLE_SCREENS: readonly Screen[] = ['home', 'chat', 'room', 'memory', 'workshop', 'settings', 'assistants', 'providers', 'mcp', 'media', 'appearance', 'calendar']

function readLastScreen(): string {
  try {
    return localStorage.getItem(LAST_SCREEN_KEY) ?? ''
  } catch {
    return ''
  }
}
export type SheetSize = 'peek' | 'half' | 'full'

export interface LiveTurn {
  id: string
  conversationId: string
  content: string
  reasoning: string
  startedAt: number
}

interface AppState {
  ready: boolean
  /** 启动过程中没成功的那一段（空串表示一切正常）。 */
  bootError: string
  settings: Settings
  conversations: Conversation[]
  activeId: string | null
  messages: ChatMessage[]
  live: LiveTurn | null
  sending: boolean
  /** 这一轮发送属于哪段对话：生成中切到别的对话时，占位气泡不该跟过去。 */
  sendingId: string | null
  screen: Screen
  sheet: SheetSize
  toast: string
  /** Non-message banner shown at the top of the chat (e.g. dropped history). */
  notice: string
  memoryTotal: number
  memories: MemoryEntry[]
  workspaceFiles: WorkspaceFile[]
  previewVersion: number
  historyOpen: boolean
  /**
   * 欣赏模式：藏起所有菜单，只看海。
   *
   * 纯瞬时 UI 状态，和 historyOpen 一样不落库 —— 下次启动该是正常的界面，
   * 而不是一口什么都没有的缸。
   */
  zen: boolean
  draft: string
  actions: {
    boot: () => Promise<void>
    /** 启动彻底失败时也要放开界面，并说明原因。 */
    failBoot: (message: string) => void
    clearBootError: () => void
    setScreen: (screen: Screen) => void
    setSheet: (sheet: SheetSize) => void
    setHistoryOpen: (open: boolean) => void
    /** 进出欣赏模式（只影响界面，不落库）。 */
    setZen: (on: boolean) => void
    setDraft: (draft: string) => void
    setSettings: (patch: Partial<Settings>) => Promise<void>
    createConversation: (title?: string, opts?: CreateConversationOptions) => Promise<string>
    openConversation: (id: string) => Promise<void>
    removeConversation: (id: string) => Promise<void>
    appendMessage: (message: ChatMessage) => Promise<void>
    updateMessage: (id: string, patch: Partial<ChatMessage>) => Promise<void>
    /** 删掉一条消息所在的整个节点（含全部分支候选）。 */
    deleteMessage: (id: string) => Promise<void>
    /** 在同一节点的候选之间切换。delta 为 -1/+1。 */
    switchBranch: (id: string, delta: number) => Promise<void>
    /** 从某条消息分叉出一条新的独立对话，并切过去。 */
    forkFromMessage: (id: string) => Promise<void>
    /** 新建一个助手并选中它。 */
    addAssistant: (patch?: Partial<Assistant>) => Promise<string>
    /** 更新一个助手。 */
    updateAssistant: (id: string, patch: Partial<Assistant>) => Promise<void>
    /** 删掉一个助手（至少保留一个）。 */
    removeAssistant: (id: string) => Promise<void>
    /** 切换当前选中的助手。 */
    selectAssistant: (id: string) => Promise<void>
    /** 助手总开关：关掉即回到纯净对话（不注入人设/记忆）。 */
    setAssistantsEnabled: (on: boolean) => Promise<void>
    /** 更新单个供应商的字段（按 id 合并，不会覆盖其他字段）。 */
    updateProvider: (id: string, patch: Partial<Provider>) => Promise<void>
    bumpConversation: (patch: Partial<Conversation>, conversationId?: string) => Promise<void>
    /**
     * 改「这段对话」的配置快照（模型 / 思考强度这些聊天页能现场切的）。
     *
     * 为什么需要它：对话创建时会把助手配置拍成快照，引擎每轮读的是快照。
     * 聊天页以前只写全局 settings，于是「切到关闭思考」对当前对话完全没用
     * （界面显示关了、请求还在思考）。切模型同理。
     */
    patchConversationConfig: (patch: Partial<ConversationConfig>, conversationId?: string) => Promise<void>
    startLive: (conversationId: string) => void
    updateLive: (patch: Partial<Pick<LiveTurn, 'content' | 'reasoning'>>) => void
    endLive: () => void
    setSending: (sending: boolean, conversationId?: string) => void
    refreshConversations: () => Promise<void>
    refreshMemories: () => Promise<void>
    /**
     * 刷新工坊文件列表。
     * 不带参数 = 跟着「当前打开的项目」；显式带 id = 按那个项目刷新，
     * 并且把工坊切过去（引擎写的是对话绑定的项目，界面停在别处时那次写入会看不见）。
     */
    refreshWorkspace: (workspaceId?: string) => Promise<void>
    /** 切换工坊项目（同时刷新文件列表）。 */
    setActiveWorkspace: (id: string) => Promise<void>
    /** 新建一个工坊项目并切过去。 */
    createWorkspace: (name: string) => Promise<string>
    /** 项目改名。 */
    renameWorkspace: (id: string, name: string) => Promise<void>
    /** 删掉一个项目（连同它的文件）；至少保留一个。 */
    deleteWorkspace: (id: string) => Promise<void>
    /** 重命名当前项目里的一个文件。 */
    renameWorkspaceFile: (oldPath: string, newPath: string) => Promise<void>
    /** 把一个文件挪到另一个项目。 */
    moveWorkspaceFile: (path: string, targetWorkspaceId: string) => Promise<void>
    /** 复制整个项目（含全部文件）成一个新项目；返回新项目 id。 */
    duplicateWorkspace: (name: string) => Promise<string>
    /** 在当前项目里复制一份文件副本（不删原件）。 */
    copyWorkspaceFile: (oldPath: string, newPath: string) => Promise<void>
    /**
     * 把「当前对话」重绑到某个项目。
     *
     * conversation.workspaceId 是创建时的快照，之后永不改写；一段绑到别的项目的新对话
     * 无论怎么切界面都够不到老项目。这个 action 让对话内可以换写入目标。
     */
    setConversationWorkspace: (workspaceId: string) => Promise<void>
    deleteMemoryEntry: (id: string) => Promise<void>
    saveMemoryEntry: (memory: MemoryEntry) => Promise<void>
    clearAllChats: () => Promise<void>
    clearAllMemories: () => Promise<void>
    showToast: (message: string) => void
    setNotice: (message: string) => void
  }
}

let toastTimer: number | undefined
/**
 * 打开对话的请求代数。
 *
 * 连点两个历史项时，先发的那次可能后回来；只有最后一次点击算数，
 * 否则界面会停在错误的那段对话上（BUG-REVIEW P1-2）。
 */
let openSeq = 0

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  bootError: '',
  settings: DEFAULT_SETTINGS,
  conversations: [],
  activeId: null,
  messages: [],
  live: null,
  sending: false,
  sendingId: null,
  screen: 'home',
  sheet: 'half',
  toast: '',
  notice: '',
  memoryTotal: 0,
  memories: [],
  workspaceFiles: [],
  previewVersion: 0,
  historyOpen: false,
  zen: false,
  draft: '',
  actions: {
    async boot() {
      // 启动链路上任何一步失败都不能把用户永久按在开屏画面上（BUG-REVIEW P1-6）：
      // 设置读不出来就用默认值，列表读不出来就当空，至少让人进得去设置页自救。
      let settings: Settings = DEFAULT_SETTINGS
      let bootError = ''
      try {
        settings = await loadSettings()
      } catch (error) {
        bootError = `读取设置失败：${describeError(error)}`
      }

      let conversations: Conversation[] = []
      let memories: MemoryEntry[] = []
      let files: WorkspaceFile[] = []
      try {
        const loaded = await Promise.all([listConversations(), listMemories(), listFiles()])
        conversations = loaded[0]
        memories = loaded[1]
        files = loaded[2]
      } catch (error) {
        const detail = `读取本地数据失败：${describeError(error)}`
        bootError = bootError === '' ? detail : `${bootError}；${detail}`
      }

      // 无论上面成败，界面都要放开。
      set({
        ready: true,
        bootError,
        settings,
        conversations,
        memories,
        memoryTotal: memories.length,
        workspaceFiles: files,
        screen: settings.onboardingDone ? 'home' : 'onboarding',
      })

      // 下面都是「有更好、没有也能用」的后置步骤，失败只记日志。
      try {
        // 恢复到上次所在界面（渲染进程被回收重载时尤其重要）。
        const saved = readLastScreen()
        if (settings.onboardingDone && saved !== '' && RESTORABLE_SCREENS.includes(saved as Screen)) {
          if (saved === 'chat') {
            const recent = sortConversations(conversations)[0]
            if (recent !== undefined) void get().actions.openConversation(recent.id).catch(() => undefined)
          } else if (saved !== 'home') {
            set({ screen: saved as Screen })
          }
        }
        stageBridge.current?.setTheme(settings.aquariumTheme)
        // v1 → v2 升级后老消息还没有倒排索引，开机后台补一次；不阻塞界面。
        void rebuildSearchIndex().catch((error) => console.warn('[search] index rebuild skipped', error))
        // MCP 服务器按配置连一次；连不上只影响它自己，不会挡住启动。
        void reconcileServers(settings.mcpServers).catch((error) => console.warn('[mcp] connect skipped', error))
        // 「总是允许」时把策略写回设置，下次不再问同一个工具。
        setPolicyWriter((serverId, toolName) => {
          const current = get().settings
          const mcpServers = current.mcpServers.map((server) =>
            server.id === serverId
              ? { ...server, toolPolicies: { ...server.toolPolicies, [toolName]: 'never' as const } }
              : server,
          )
          void get().actions.setSettings({ mcpServers })
        })
      } catch (error) {
        console.warn('[boot] 启动后置步骤失败', error)
      }
    },

    failBoot(message) {
      // 连 boot() 自己的兜底都抛了：至少把界面放开，并说清楚发生了什么。
      set({ ready: true, bootError: message })
    },

    clearBootError() {
      set({ bootError: '' })
    },

    setScreen(screen) {
      // 记住上次所在界面：Android 在后台待久了可能回收 WebView 渲染进程，
      // 重新加载后如果一律回首页，用户会觉得「工坊/设置莫名其妙丢了现场」。
      // 只存页面名，不存任何业务数据；onboarding 不记。
      try {
        if (screen === 'onboarding') localStorage.removeItem(LAST_SCREEN_KEY)
        else localStorage.setItem(LAST_SCREEN_KEY, screen)
      } catch {
        /* 存不下就算了，这只是体验优化 */
      }
      set({ screen, historyOpen: false })
    },

    setSheet(sheet) {
      set({ sheet })
    },

    setHistoryOpen(historyOpen) {
      set({ historyOpen })
    },

    setZen(zen) {
      set({ zen })
    },

    setDraft(draft) {
      set({ draft })
    },

    async setSettings(patch) {
      let next = { ...get().settings, ...patch }
      // 只有「真的换了供应商」才做模型回落（避免对着新供应商请求不存在的模型）。
      // 改 Key / 改地址 / 改模型列表只镜像字段，绝不能顺手改 model ——
      // 否则用户手填的自定义模型名会被一次次冲成列表第一个（见 providers.ts）。
      //
      // 判据是「providerId 的值真的变了」，不是「patch 里带了 providerId」：
      // 供应商页删除任意一个供应商时都会把 providerId 一起传下来（哪怕没变），
      // 只看有没有传的话，删掉一个无关供应商也会把自定义模型名重置。
      const providerChanged = patch.providerId !== undefined && patch.providerId !== get().settings.providerId
      if (providerChanged) {
        next = syncProviderToSettings(next)
      } else if (patch.providers !== undefined) {
        next = mirrorProviderFields(next)
      }
      set({ settings: next })
      await persistSettings(next)
      if (patch.aquariumTheme !== undefined) stageBridge.current?.setTheme(next.aquariumTheme)
      // 助手设定 / 记忆相关变了，就把人设与记忆重新推给网页窗，
      // 否则网页账号那边还在用旧人设说话。
      if (patch.assistants !== undefined || patch.assistantId !== undefined || patch.memoryTokenBudget !== undefined) {
        void syncWebChatContext(next, get().memories).catch(() => undefined)
      }
      // MCP 配置变了就按新配置对齐连接（新增的连上、删掉的断开）。
      if (patch.mcpServers !== undefined) {
        void reconcileServers(next.mcpServers).catch((error) => console.warn('[mcp] reconcile failed', error))
      }
    },

    async createConversation(title = '新的对话', opts?: CreateConversationOptions) {
      // 新对话也是一种「切换」：把代数推一格，让还在路上的 openConversation 作废，
      // 否则它回来时会把刚建好的对话盖掉。
      openSeq += 1
      const settings = get().settings
      // 群聊：第一个成员作为「主助手」，config 快照也用它（引擎按成员各算各的）。
      const firstId = opts?.members?.[0] ?? settings.assistantId
      const assistant = findAssistant(settings, firstId)
      const conversation: Conversation = {
        id: `conv_${nanoid(10)}`,
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: resolveAssistantConfig(settings, assistant).model,
        assistantId: assistant.id,
        ...(opts?.kind === 'group' ? {
          kind: 'group' as const,
          members: opts.members ?? [assistant.id],
          groupSettings: opts.groupSettings ?? { gapMs: 1500, allowChatter: false, maxTurnsPerRound: 3 },
        } : {}),
        // 新对话跟着「工坊里当前打开的项目」走，之后模型写文件就落在这里。
        workspaceId: settings.activeWorkspaceId || DEFAULT_WORKSPACE,
        // 落库那一刻拍快照：之后改助手不会影响这段对话。
        config: resolveAssistantConfig(settings, assistant),
      }
      await putConversation(conversation)

      // 助手的预置消息：新对话一开始就摆在那里，用户直接接着聊。
      const config = resolveAssistantConfig(settings, assistant)
      const presets: ChatMessage[] = config.presetMessages.map((text, index) => ({
        id: `msg_${nanoid(10)}`,
        conversationId: conversation.id,
        role: 'assistant',
        content: text,
        createdAt: Date.now() + index,
        status: 'done',
      }))
      for (const message of presets) await putMessage(message)

      set((state) => ({
        conversations: sortConversations([conversation, ...state.conversations]),
        activeId: conversation.id,
        messages: presets,
        live: null,
        screen: 'chat',
        sheet: state.sheet === 'peek' ? 'half' : state.sheet,
      }))
      return conversation.id
    },

    async openConversation(id) {
      const conversation = get().conversations.find((item) => item.id === id)
      if (conversation === undefined) return
      const seq = (openSeq += 1)
      const messages = await listMessages(id)
      // 读库期间又点了别的对话（或者新建了一条）：这次结果作废，
      // 不能让「先发后到」的那次把界面按在旧对话上（BUG-REVIEW P1-2）。
      if (seq !== openSeq) return
      set({ activeId: id, messages, screen: 'chat', historyOpen: false, live: null })
    },

    async removeConversation(id) {
      await deleteConversationRecord(id)
      set((state) => {
        const conversations = state.conversations.filter((item) => item.id !== id)
        const activeId = state.activeId === id ? null : state.activeId
        return {
          conversations,
          activeId,
          messages: activeId === null ? [] : state.messages,
          screen: activeId === null ? 'home' : state.screen,
        }
      })
    },

    async appendMessage(message) {
      await putMessage(message)
      // 只有「这条消息属于当前正在看的对话」才进列表。
      // 生成过程中切到别的对话时，旧对话的回复、工具结果、摘要都不能落到
      // 新对话的列表里 —— 那会让人以为新对话凭空多了几句话，后续删除/分叉
      // 还会打到错误的对象上（BUG-REVIEW P1-1）。切回去时会从库里重新读。
      set((state) => (
        state.activeId === message.conversationId
          ? { messages: [...state.messages, message] }
          : {}
      ))
      const conversation = get().conversations.find((item) => item.id === message.conversationId)
      if (conversation !== undefined) {
        const next = { ...conversation, updatedAt: Date.now() }
        await putConversation(next)
        set((state) => ({
          conversations: sortConversations(state.conversations.map((item) => (item.id === next.id ? next : item))),
        }))
      }
    },

    async updateMessage(id, patch) {
      const message = get().messages.find((item) => item.id === id)
      if (message === undefined) return
      const next = { ...message, ...patch }
      await putMessage(next)
      set((state) => ({ messages: state.messages.map((item) => (item.id === id ? next : item)) }))
    },

    async deleteMessage(id) {
      const conversationId = get().activeId
      if (conversationId === null) return
      const message = get().messages.find((item) => item.id === id)
      if (message === undefined) return
      const nodeId = message.nodeId ?? message.id
      const removed = await deleteMessageNode(conversationId, nodeId)
      const removedSet = new Set(removed)
      set((state) => ({ messages: state.messages.filter((item) => !removedSet.has(item.id)) }))
    },

    async switchBranch(id, delta) {
      const conversationId = get().activeId
      if (conversationId === null) return
      const message = get().messages.find((item) => item.id === id)
      if (message === undefined) return
      const nodeId = message.nodeId ?? message.id
      const siblings = await listMessageSiblings(conversationId, nodeId)
      if (siblings.length <= 1) return
      const currentIndex = siblings.findIndex((item) => item.id === id)
      if (currentIndex === -1) return
      const nextIndex = (currentIndex + delta + siblings.length) % siblings.length
      const next = siblings[nextIndex] as ChatMessage
      // 只改选中标记，内容不动。
      for (const sibling of siblings) {
        const active = sibling.id === next.id
        if ((sibling.active !== false) !== active) await putMessage({ ...sibling, active })
      }
      const nextActive: ChatMessage = { ...next, active: true }
      // 列表里这个节点原本占一个位置，换成新选中的那条（内容、id、时间都会变）。
      set((state) => ({
        messages: state.messages.map((item) =>
          (item.nodeId ?? item.id) === nodeId ? nextActive : item,
        ),
      }))
    },

    async forkFromMessage(id) {
      const sourceId = get().activeId
      if (sourceId === null) return
      const message = get().messages.find((item) => item.id === id)
      if (message === undefined) return
      const source = get().conversations.find((item) => item.id === sourceId)
      const baseTitle = source?.title ?? '新的对话'
      const title = `${baseTitle.slice(0, 20)} · 分叉`.slice(0, 30)
      try {
        const { id: newId } = await forkConversationUpTo(sourceId, id, title, get().settings.model)
        const conversations = await listConversations()
        const messages = await listMessages(newId)
        // 分叉也是一次切换：让还在路上的 openConversation 作废。
        openSeq += 1
        set({ conversations, activeId: newId, messages, live: null, screen: 'chat', historyOpen: false })
        get().actions.showToast('已经从这条分叉出一条新对话')
      } catch (error) {
        get().actions.showToast(error instanceof Error ? error.message : '分叉失败')
      }
    },

    async addAssistant(patch) {
      const now = Date.now()
      const assistant: Assistant = {
        id: `asst_${nanoid(10)}`,
        name: patch?.name ?? '新助手',
        avatar: patch?.avatar ?? '🐋',
        systemPrompt: patch?.systemPrompt ?? '',
        model: patch?.model ?? '',
        temperature: patch?.temperature ?? -1,
        thinkingEffort: patch?.thinkingEffort ?? '',
        presetMessages: patch?.presetMessages ?? [],
        quickMessages: patch?.quickMessages ?? [],
        messageTemplate: patch?.messageTemplate ?? '',
        regexes: patch?.regexes ?? [],
        recentChats: patch?.recentChats ?? null,
        timeReminder: patch?.timeReminder ?? null,
        memoryEnabled: patch?.memoryEnabled ?? null,
        createdAt: now,
        updatedAt: now,
      }
      await get().actions.setSettings({
        assistants: [...get().settings.assistants, assistant],
        assistantId: assistant.id,
      })
      return assistant.id
    },

    async updateAssistant(id, patch) {
      const assistants = get().settings.assistants.map((item) =>
        item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
      )
      await get().actions.setSettings({ assistants })
    },

    async removeAssistant(id) {
      const assistants = get().settings.assistants
      if (assistants.length <= 1) {
        get().actions.showToast('至少留一个助手')
        return
      }
      const next = assistants.filter((item) => item.id !== id)
      const first = next[0]
      const patch: Partial<Settings> = { assistants: next }
      if (get().settings.assistantId === id && first !== undefined) patch.assistantId = first.id
      await get().actions.setSettings(patch)
    },

    async selectAssistant(id) {
      await get().actions.setSettings({ assistantId: id })
    },

    async setAssistantsEnabled(on) {
      await get().actions.setSettings({ assistantsEnabled: on })
    },

    async updateProvider(id, patch) {
      // 基准必须是「当前 store 里的 providers」，不是界面组件的草稿快照：
      // 用快照重建会把快照里没有的字段（典型是刚输入的 apiKey）覆盖成空，
      // 于是「填完 Key 再改地址」就会把 Key 清掉。
      await get().actions.setSettings({ providers: patchProvider(get().settings.providers, id, patch) })
    },

    async bumpConversation(patch, conversationId) {
      // 明确指定对话就用它，没指定才用「当前打开的」。
      // 生成中切换对话时，本轮摘要/标题必须落回自己那段对话（BUG-REVIEW P1-1）。
      const id = conversationId ?? get().activeId
      if (id === null) return
      const conversation = get().conversations.find((item) => item.id === id)
      if (conversation === undefined) return
      const next = { ...conversation, ...patch, updatedAt: Date.now() }
      await putConversation(next)
      set((state) => ({
        conversations: sortConversations(state.conversations.map((item) => (item.id === id ? next : item))),
      }))
    },

    async patchConversationConfig(patch, conversationId) {
      const id = conversationId ?? get().activeId
      if (id === null) return
      const state = get()
      const conversation = state.conversations.find((item) => item.id === id)
      if (conversation === undefined) return
      // 没有快照的老对话：先用「当前助手现算」补一份，再合并 patch。
      const base = conversation.config !== undefined
        ? conversation.config
        : resolveAssistantConfig(state.settings, findAssistant(state.settings, conversation.assistantId))
      const config: ConversationConfig = { ...base, ...patch }
      const next: Conversation = {
        ...conversation,
        config,
        updatedAt: Date.now(),
        // Conversation.model 是列表/排序里用的冗余字段，跟着快照一起更新。
        ...(patch.model !== undefined ? { model: patch.model } : {}),
      }
      await putConversation(next)
      set((current) => ({
        conversations: sortConversations(current.conversations.map((item) => (item.id === id ? next : item))),
      }))
    },

    startLive(conversationId) {
      set({
        live: {
          id: `live_${nanoid(8)}`,
          conversationId,
          content: '',
          reasoning: '',
          startedAt: Date.now(),
        },
      })
    },

    updateLive(patch) {
      const live = get().live
      if (live === null) return
      set({ live: { ...live, ...patch } })
    },

    endLive() {
      set({ live: null })
    },

    setSending(sending, conversationId) {
      // 一起记下「这一轮属于哪段对话」：生成中切走时，正在思考的占位气泡
      // 不该出现在别人家的对话里（BUG-REVIEW P1-1）。
      set((state) => ({
        sending,
        sendingId: sending ? (conversationId ?? state.sendingId) : null,
      }))
    },

    async refreshConversations() {
      set({ conversations: await listConversations() })
    },

    async refreshMemories() {
      const memories = await listMemories()
      set({ memories, memoryTotal: memories.length })
      // 记忆变了，网页账号那边的人设前缀也要跟着变。
      void syncWebChatContext(get().settings, memories).catch(() => undefined)
    },

    async refreshWorkspace(workspaceId) {
      const active = get().settings.activeWorkspaceId || DEFAULT_WORKSPACE
      // 显式带 id：按那个项目刷新，同时把工坊切过去。
      // 引擎的 write_file 落在**这段对话绑定的项目**里，工坊面板读的却是
      // settings.activeWorkspaceId —— 不一致时那次写入成功了但谁也看不见，
      // 用户就只能得出「工坊没被调用」的结论。
      const target = workspaceId || active
      if (workspaceId !== undefined && target !== active) {
        await get().actions.setSettings({ activeWorkspaceId: target })
      }
      // 只有默认项目种范例；用户自己新建的项目应该是空的。
      if (target === DEFAULT_WORKSPACE) await seedWorkspaceIfEmpty(target)
      const all = await listFiles(target)
      // `.` 开头的内部占位文件（种子标记）不该出现在文件列表里。
      const files = all.filter((file) => !file.path.startsWith('.'))
      set({ workspaceFiles: files, previewVersion: get().previewVersion + 1 })
    },

    async setActiveWorkspace(id) {
      if (!get().settings.workspaces.some((item) => item.id === id)) return
      await get().actions.setSettings({ activeWorkspaceId: id })
      await get().actions.refreshWorkspace()
    },

    async createWorkspace(name) {
      const trimmed = name.trim().slice(0, 24)
      if (trimmed === '') throw new Error('项目名不能为空')
      const now = Date.now()
      const workspace: Workspace = { id: `ws_${nanoid(8)}`, name: trimmed, createdAt: now, updatedAt: now }
      await get().actions.setSettings({
        workspaces: [...get().settings.workspaces, workspace],
        activeWorkspaceId: workspace.id,
      })
      await get().actions.refreshWorkspace()
      return workspace.id
    },

    async renameWorkspace(id, name) {
      const trimmed = name.trim().slice(0, 24)
      if (trimmed === '') throw new Error('项目名不能为空')
      const workspaces = get().settings.workspaces.map((item) => (
        item.id === id ? { ...item, name: trimmed, updatedAt: Date.now() } : item
      ))
      await get().actions.setSettings({ workspaces })
    },

    async deleteWorkspace(id) {
      const workspaces = get().settings.workspaces
      if (workspaces.length <= 1) throw new Error('至少要保留一个项目')
      if (!workspaces.some((item) => item.id === id)) return
      // 文件跟着项目一起删：留着就是无主垃圾，没有任何入口能看到它们。
      await deleteFilesByWorkspace(id)
      const next = workspaces.filter((item) => item.id !== id)
      const activeWorkspaceId = get().settings.activeWorkspaceId === id
        ? DEFAULT_WORKSPACE
        : get().settings.activeWorkspaceId
      await get().actions.setSettings({ workspaces: next, activeWorkspaceId })
      await get().actions.refreshWorkspace()
    },

    async renameWorkspaceFile(oldPath, newPath) {
      const workspaceId = get().settings.activeWorkspaceId || DEFAULT_WORKSPACE
      await renameWorkspaceFileRecord(oldPath, newPath, workspaceId)
      await get().actions.refreshWorkspace()
    },

    async moveWorkspaceFile(path, targetWorkspaceId) {
      const from = get().settings.activeWorkspaceId || DEFAULT_WORKSPACE
      await moveWorkspaceFileRecord(path, from, targetWorkspaceId)
      await get().actions.refreshWorkspace()
    },

    async duplicateWorkspace(name) {
      const trimmed = name.trim().slice(0, 24)
      if (trimmed === '') throw new Error('项目名不能为空')
      const from = get().settings.activeWorkspaceId || DEFAULT_WORKSPACE
      const now = Date.now()
      const workspace: Workspace = { id: `ws_${nanoid(8)}`, name: trimmed, createdAt: now, updatedAt: now }
      await get().actions.setSettings({
        workspaces: [...get().settings.workspaces, workspace],
        activeWorkspaceId: workspace.id,
      })
      // 逐条按新 id 重算主键写库，保留老项目里可能存在的非 ASCII 路径。
      await duplicateWorkspaceFiles(from, workspace.id)
      await get().actions.refreshWorkspace()
      return workspace.id
    },

    async copyWorkspaceFile(oldPath, newPath) {
      const workspaceId = get().settings.activeWorkspaceId || DEFAULT_WORKSPACE
      await copyWorkspaceFileRecord(oldPath, newPath, workspaceId)
      await get().actions.refreshWorkspace()
    },

    async setConversationWorkspace(workspaceId) {
      const id = get().activeId
      if (id === null) return
      const conversation = get().conversations.find((item) => item.id === id)
      if (conversation === undefined) return
      // 只改 workspaceId 与 updatedAt：模型/温度这些配置快照和写入目标无关，别动。
      const next = { ...conversation, workspaceId, updatedAt: Date.now() }
      await putConversation(next)
      set((state) => ({
        conversations: state.conversations.map((item) => (item.id === id ? next : item)),
      }))
    },

    async deleteMemoryEntry(id) {
      await deleteMemory(id)
      await get().actions.refreshMemories()
    },

    async saveMemoryEntry(memory) {
      await putMemory(memory)
      await get().actions.refreshMemories()
    },

    async clearAllChats() {
      await clearConversations()
      // 只有在聊天页才需要退出去 —— 在设置页清空的用户接下来多半要导入备份，
      // 把他踢回首页会打断这个流程。
      set((state) => ({
        conversations: [],
        activeId: null,
        messages: [],
        live: null,
        screen: state.screen === 'chat' ? 'home' : state.screen,
      }))
    },

    async clearAllMemories() {
      await clearMemories()
      set({ memories: [], memoryTotal: 0 })
    },

    showToast(message) {
      if (toastTimer !== undefined) window.clearTimeout(toastTimer)
      set({ toast: message })
      toastTimer = window.setTimeout(() => set({ toast: '' }), 2800)
    },

    setNotice(message) {
      // A persistent banner: dropping or failing to compress history must stay
      // visible until the next send replaces it, not blink for 2.8 seconds.
      set({ notice: message })
    },
  },
}))

/**
 * 一个节点的分支信息（供气泡显示 ‹ n/m ›）。返回 null 表示只有一个候选、不显示。
 * count 与 index 都以「按落库时间排序」为基准。
 */
export async function branchInfo(conversationId: string, message: ChatMessage): Promise<{ index: number; count: number } | null> {
  const nodeId = message.nodeId ?? message.id
  const siblings = await listMessageSiblings(conversationId, nodeId)
  if (siblings.length <= 1) return null
  const index = siblings.findIndex((item) => item.id === message.id)
  if (index === -1) return null
  return { index: index + 1, count: siblings.length }
}

export async function refreshMemoryTotal(): Promise<number> {  const total = await memoryCount()
  useAppStore.setState({ memoryTotal: total })
  return total
}

export function memoryTypeTitle(type: MemoryType): string {
  switch (type) {
    case 'profile': return '关于你'
    case 'preference': return '偏好'
    case 'project': return '项目'
    case 'relationship': return '相处'
    default: return '其他'
  }
}
