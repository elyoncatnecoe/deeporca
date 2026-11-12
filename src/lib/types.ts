export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type MessageStatus = 'streaming' | 'done' | 'error' | 'aborted'

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/** A file the user attached to one message. Text is inlined, images become data URLs. */
export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'text'
  /** Present for images: a compressed data URL ready for the vision API. */
  dataUrl?: string
  /** Present for text/code files: UTF-8 contents, already size-limited. */
  text?: string
  width?: number
  height?: number
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * 生成媒体在消息里的轻量引用。
 *
 * 真正的 data URL 放在 IndexedDB 的 `media` 表（见 MediaRecord），消息只存 id：
 * 一条 1024×1024 的 PNG 当 data URL 就有 1~3MB，直接塞进 messages 会让
 * listMessages / 备份 / 搜索索引全部被二进制拖慢。
 */
export interface MessageMediaRef {
  id: string
  kind: 'image' | 'audio'
  mime: string
  width?: number
  height?: number
  /** 音频时长（毫秒），拿不到就省略。 */
  durationMs?: number
  /** 图片的替代文本；生成图用 prompt 的前 80 字。 */
  alt?: string
}

/** media 表的一行：消息里存 ref，字节在这里。 */
export interface MediaRecord extends MessageMediaRef {
  conversationId: string
  messageId: string
  /** data:image/png;base64,... 或 data:audio/mpeg;base64,... */
  dataUrl: string
  /** 生成时用的提示词，便于查看器/相册显示。 */
  prompt?: string
  createdAt: number
}

export interface ChatMessage {
  id: string
  conversationId: string
  /**
   * 同一条消息的「节点」标识。重新生成 / 编辑重发时，新旧候选共享同一个 nodeId，
   * 只有 active 的那条参与对话与展示。缺省视为等值于 id（旧数据无需迁移）。
   */
  nodeId?: string
  /** 同一 nodeId 下的候选里，是否是被选中的那条。缺省视为 true。 */
  active?: boolean
  /**
   * 这条回复是「续写」哪条消息来的。
   * 渲染时把它当同一条气泡的延续（不重复画头像/名字，只加一条细分隔线）。
   */
  continuedFrom?: string
  role: Role
  /**
   * 群聊里这条消息是哪个助手说的（单聊缺省即可）。
   * 只记 id 不够：助手可能被改名/删号，所以名字与头像同时拍快照。
   */
  assistantId?: string
  assistantName?: string
  assistantAvatar?: string
  content: string
  reasoning?: string
  /** How long the model spent thinking, in milliseconds. */
  thinkingMs?: number
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  /** 这次工具调用/结果落在哪个工坊项目（显示名），工具卡与调用行据此标注项目。 */
  workspaceName?: string
  attachments?: Attachment[]
  /** 这条消息附带的生成媒体（生图 / TTS）。字节在 media 表，这里只存引用。 */
  media?: MessageMediaRef[]
  createdAt: number
  status?: MessageStatus
  usage?: TokenUsage
  /**
   * 这一轮是被输出长度上限切断的（finish_reason 为 length / max_tokens / MAX_TOKENS）。
   * 缺省视为 false。截断过去对用户完全隐形 —— 界面只会停在「想到一半停住」，
   * 所以现在把它记下来，界面上标一句「已到输出上限」。
   */
  truncated?: boolean
  error?: string
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: string
  summary?: string
  /** 这段对话用哪个助手。缺省 = 当时选中的那个。 */
  assistantId?: string
  /**
   * 对话形态。缺省视为 'single'（老数据无需迁移）。
   * group = 多助手群聊，成员在 members 里。
   */
  kind?: 'single' | 'group'
  /** 群聊成员 assistantId 列表；single 时等价于 [assistantId]。 */
  members?: string[]
  /** 群聊的发言节奏设置。仅 kind = 'group' 时有意义。 */
  groupSettings?: GroupChatSettings
  /**
   * 这段对话默认写进哪个工坊项目。
   * 缺省（老对话）= 默认项目；这样升级后历史对话照旧。
   */
  workspaceId?: string
  /**
   * 对话落库时从助手拍下来的配置快照。
   * 之后改助手不会动到已有对话，避免历史上下文被换人设换模型打乱。
   */
  config?: ConversationConfig
}

/** 会话开始后固定下来的那部分助手配置。 */
export interface ConversationConfig {
  name: string
  avatar: string
  /** 头像来源快照（与 Assistant 的 avatarKind/Builtin/Image 同义）。 */
  avatarKind?: AssistantAvatarKind
  avatarBuiltin?: string
  avatarImage?: string
  systemPrompt: string
  model: string
  temperature: number
  thinkingEffort: ThinkingEffort
  presetMessages: string[]
  messageTemplate: string
  regexes: AssistantRegex[]
  recentChats: boolean
  timeReminder: boolean
}

/** 群聊的发言节奏。都会直接影响 token 消耗，界面上要提示用户。 */
export interface GroupChatSettings {
  /** 助手之间的最小间隔（毫秒）。默认 1500。 */
  gapMs: number
  /**
   * 用户说完后，助手之间是否互相接话。
   * 默认关闭：每多一个助手接一句就多一次完整请求，最费 token。
   */
  allowChatter: boolean
  /** 一轮最多允许几个助手发言（含被点名的那个）。默认 3。 */
  maxTurnsPerRound: number
}

/** 新建对话时可选的形态参数（不传 = 单助手、跟随当前选中助手）。 */
export interface CreateConversationOptions {
  members?: string[]
  kind?: 'single' | 'group'
  groupSettings?: GroupChatSettings
}

/** 一条快捷消息：点一下就把内容填进输入框。 */
export interface QuickMessage {
  id: string
  title: string
  content: string
}

/** 仅影响显示的正则替换（不改编上下文里存的原话）。 */
export interface AssistantRegex {
  id: string
  name: string
  enabled: boolean
  find: string
  replace: string
}

/**
 * 助手头像的三种来源。
 * - builtin：内置 SVG（`avatarBuiltin` 指向 BUILTIN_ASSISTANT_AVATARS 的 key）
 * - emoji：老式的 emoji 字符串，兼容老数据
 * - image：用户上传的 PNG，压缩后存本机 IndexedDB（不进备份，与现有头像策略一致）
 */
export type AssistantAvatarKind = 'builtin' | 'emoji' | 'image'

/** 一个助手 = 一份可复用的对话人格与参数。 */
export interface Assistant {
  id: string
  name: string
  /** 头像文字或 emoji（老字段，保留兼容；新逻辑优先看 avatarKind）。 */
  avatar: string
  /** 头像来源。老数据没有这个字段时按 emoji 处理。 */
  avatarKind?: AssistantAvatarKind
  /** avatarKind = 'builtin' 时，指向内置头像的 key（deeporca / clawd / sealgpt）。 */
  avatarBuiltin?: string
  /** avatarKind = 'image' 时，上传头像的 dataURL。 */
  avatarImage?: string
  /** 人设段落。留空时用默认的深鲸人设。 */
  systemPrompt: string
  /** 空串表示跟随全局设置里的模型。 */
  model: string
  /** -1 表示跟随全局。 */
  temperature: number
  /** 空串表示跟随全局。 */
  thinkingEffort: ThinkingEffort | ''
  /** 每次新对话时预置的消息（只发一轮，用户先看到它们）。 */
  presetMessages: string[]
  /** 常用短句，输入框上方可以一点填入。 */
  quickMessages: QuickMessage[]
  /** 用户消息的包装模板，`{{ message }}` 会被替换。留空 = 原样发送。 */
  messageTemplate: string
  /** 仅显示层的正则替换。 */
  regexes: AssistantRegex[]
  /** 覆盖全局的「最近对话回顾」；null 表示跟随全局。 */
  recentChats: boolean | null
  /** 覆盖全局的「时间提醒」；null 表示跟随全局。 */
  timeReminder: boolean | null
  /** 覆盖全局的「记忆」总开关；null 表示跟随全局。只控「读不读」，不控写入共享库。 */
  memoryEnabled: boolean | null
  createdAt: number
  updatedAt: number
}

export type MemoryType = 'profile' | 'preference' | 'project' | 'relationship' | 'other'

export interface MemoryEntry {
  id: string
  text: string
  type: MemoryType
  tags: string[]
  /** 0..5, extracted or hand-set. */
  importance: number
  scope: 'global' | 'character'
  /** scope 为 character 时的归属助手 id。 */
  characterId?: string
  /** 被覆盖的旧文本，可回滚。 */
  history?: string[]
  /** 矛盾待确认；为 true 时注入会忽略这条。 */
  pending?: boolean
  sourceConversationId?: string
  sourceMessageId?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  pinned: boolean
}

export interface SummaryRecord {
  conversationId: string
  text: string
  updatedAt: number
  /** 已经折进摘要的最后一条消息的 id / 时间，用来算「哪些还没压过」 */
  coveredUntilId?: string
  coveredUntilAt?: number
  /** 已经被折进来的消息条数，只用来看和显示 */
  foldedCount?: number
}

export interface WorkspaceFile {
  id: string
  workspaceId: string
  path: string
  content: string
  updatedAt: number
}

/** 默认项目（老数据全在这里，不需要迁移）。 */
export const DEFAULT_WORKSPACE = 'default'

/**
 * 一个工坊项目。
 *
 * 项目之间文件互相隔离：模型写文件时只会看到当前对话所属项目的文件，
 * 预览入口（index.html）也按项目各自解析。
 */
export interface Workspace {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export type ThemeId = 'deep' | 'iceberg' | 'tropical'
export type QualityId = 'auto' | 'low' | 'medium' | 'high'
/** DeepSeek thinking budget. `off` sends thinking.type=disabled. */
export type ThinkingEffort = 'off' | 'low' | 'high' | 'max'

/**
 * 供应商协议。OpenAI 兼容覆盖绝大多数中转站/国产模型；
 * Anthropic 与 Google 的请求/响应格式差异较大，单独适配。
 */
export type ProviderProtocol = 'openai' | 'anthropic' | 'google' | 'deepseek-web'

/**
 * 「网页账号」这个特殊模型的 id。选它时不走 HTTP，而是让 App 那个
 * 已登录 chat.deepseek.com 的网页窗替用户发消息、再把回话读回来。
 */
export const WEB_CHAT_MODEL = 'deepseek-chat-web'

/** 一个供应商 = 一个 baseUrl + 一个 key + 一组可用模型。 */
export interface Provider {
  id: string
  name: string
  protocol: ProviderProtocol
  /** 不带 /chat/completions，程序自己拼。 */
  baseUrl: string
  /** 存在安全存储里，这里只是运行时内存值。 */
  apiKey: string
  /** 这个供应商下可选的模型 id 列表。 */
  models: string[]
  /**
   * 模型的小字元信息（显示名 / 上下文窗口 / 最大输出 / 是否看图），按模型 id 索引。
   *
   * 只有「获取可用模型」拉回来的那些才带；手填的 id 没有条目，界面上就是空的。
   * 它是纯展示用的附加信息，缺了也不影响发消息，所以做成可选字段 ——
   * 老数据、内置供应商都不用迁移。
   */
  modelMeta?: Record<string, { name?: string; contextWindow?: number; maxTokens?: number; vision?: boolean }>
  /** 额外请求头，直接覆盖默认头（用于中转站自定义鉴权）。 */
  headers: Record<string, string>
  /**
   * 历史消息里的 `reasoning_content` 要不要整段回灌。
   *
   * 默认关：思考全文每轮都带回去会挤爆上下文预算（一次长思考就有七千字）。
   * 只有 DeepSeek 这类「工具循环缺了它就报错」的模型必须回灌 —— 那条判断在
   * prompt.ts 里按「这条 assistant 带 tool_calls」单独走，不靠这个开关。
   * 某些供应商（自己存了思考内容的中转站）希望每次都带上，这里开给它。
   */
  includeHistoryReasoning?: boolean
  /** 删除内置供应商时可以隐藏而不是真删。 */
  enabled: boolean
}

/** 内置的 DeepSeek 官方供应商 id，老数据迁移到这里。 */
export const DEFAULT_PROVIDER_ID = 'provider_deepseek'

export function defaultProviders(): Provider[] {
  return [
    {
      id: DEFAULT_PROVIDER_ID,
      name: 'DeepSeek 官方',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
      headers: {},
      enabled: true,
    },
  ]
}

/**
 * MCP 工具的确认策略。
 * `always`  = 这个工具每次调用都要确认（有副作用的工具用这个）
 * `never`   = 不确认，直接执行
 * 未出现的工具跟随服务器的默认策略。
 */
export type McpToolPolicy = 'always' | 'never'

/**
 * MCP 服务器配置。
 * - `streamable_http` / `sse`：走网络，URL + headers；
 * - `stdio`：本地子进程（Electron 才支持），command + args。
 */
export interface McpServerConfig {
  id: string
  name: string
  transport: 'streamable_http' | 'sse' | 'stdio'
  url: string
  /** 额外请求头，用来带 Authorization / API Key。 */
  headers: Record<string, string>
  /** stdio 专用：本地命令（绝对路径或 PATH 里的命令）。 */
  command: string
  /** stdio 专用：命令参数。 */
  args: string[]
  enabled: boolean
  /**
   * 服务器级默认策略：没单独配置的工具按这个走。
   * 默认 `always` —— 接入陌生服务器时先保守，用户确认信任后再放宽。
   */
  defaultPolicy: McpToolPolicy
  /** 按工具名单独覆盖。 */
  toolPolicies: Record<string, McpToolPolicy>
}

/**
 * 媒体 API 协议。
 *
 * - `openrouter`：OpenRouter 自己的 Image API（`/images`）+ Chat Completions 音频输出；
 * - `openai`：OpenAI 兼容的 `/images/generations` + `/audio/speech`，给中转站兜底。
 */
export type MediaApiProtocol = 'openrouter' | 'openai' | 'gemini' | 'minimax' | 'aliyun' | 'elevenlabs'

/** 生图 API 配置。和聊天供应商分开：多数用户会用不同厂商/Key。 */
export interface ImageApiConfig {
  enabled: boolean
  protocol: MediaApiProtocol
  /** 不带具体接口路径；如 https://openrouter.ai/api/v1 */
  baseUrl: string
  /** 运行时值；落库前剥离，安全存储单独保存。 */
  apiKey: string
  model: string
  /** auto / 1024x1024 / 1536x1024 / 1024x1536；OpenRouter 也接受 1K/2K 这类档位。 */
  defaultSize: string
  /** auto / low / medium / high；空串 = 不传。 */
  quality: string
  /** 额外请求头，可用于中转站鉴权。 */
  extraHeaders: Record<string, string>
  /** 单次生成超时，默认 300000（OpenRouter 的图可能要一两分钟）。 */
  timeoutMs: number
}

/** 语音（TTS）API 配置。 */
export interface SpeechApiConfig {
  enabled: boolean
  protocol: MediaApiProtocol
  baseUrl: string
  apiKey: string
  model: string
  /** 音色 id；OpenRouter 音频输出常见合金/echo/nova 等。 */
  voice: string
  format: 'mp3' | 'wav' | 'opus'
  /** 0.25 ~ 4.0，默认 1。 */
  speed: number
  extraHeaders: Record<string, string>
  /** 默认 180000。 */
  timeoutMs: number
}

export interface Settings {
  apiKey: string
  baseUrl: string
  model: string
  memoryModel: string
  temperature: number
  maxTokens: number
  contextBudget: number
  memoryEnabled: boolean
  /** 常驻记忆（P0）注入的 token 硬上限；超了按 importance 降序截断。 */
  memoryTokenBudget: number
  /** 聊得太长时是否自动把前面的话折成摘要。关掉后只能手动压缩。 */
  autoCompress: boolean
  /**
   * 输出被长度上限切断时，是否自动续写一次（把两段并成一条回复）。
   * 默认开：大多数用户不想为了「写一半」手动打「继续」。关掉后仍可点气泡上的「继续」。
   */
  autoContinue: boolean
  recentChats: boolean
  timeReminder: boolean
  /** 3D 海底场景主题（在「布置」屏里改）。 */
  aquariumTheme: ThemeId
  /** App 界面色调（在「外观」面板里改）。和海底主题完全解绑。 */
  appTone: ThemeId
  /**
   * 自定义强调色（`#rrggbb`）。null = 跟随界面色调预设。
   *
   * 三套预设只是三个起点，用户想用自己的颜色时不必在预设里二选一：
   * 有值时覆盖 `--accent` / `--accent-2`，没值时一律走 data-tone 的预设值。
   */
  customAccent: string | null
  /** 自定义用户气泡主色（`#rrggbb`）。null = 跟随界面色调预设。 */
  customBubble: string | null
  /**
   * 对话区自定义底图（压缩后的 dataURL）。null = 没有底图。
   *
   * 为什么不进 localStorage：一张 1600px 的 JPEG 就有几百 KB，WebView 的
   * localStorage 配额只有约 5MB，塞进去会把别的设置一起挤掉。设置整体本来就
   * 落在 IndexedDB 的 settings 表（见 lib/settings.ts 的 persistSettings），
   * 这里只是让 dataURL 跟着设置走，不另开一套存储。
   */
  chatBackdrop: string | null
  /** 底图不透明度 0~1；没有底图时不生效。 */
  chatBackdropOpacity: number
  quality: QualityId
  onboardingDone: boolean
  thinkingEffort: ThinkingEffort
  embodiment: boolean
  sound: boolean
  autoTitle: boolean
  /** 网页模式是否注入头像。 */
  webAvatar: boolean
  /** 网页模式是否显示纸雕（App 内已不再显示纸雕，只剩网页版这一处）。 */
  webPet: boolean
  /**
   * 纸雕助手（网页版）的默认提示词。
   *
   * 设置页可编辑；网页版右键纸雕 / 设置页「复制」按钮复制出去的就是这段文本。
   * 之所以放全局 settings 而不是某个助手：纸雕是网页版的全局小工具，不跟单个助手走。
   */
  webPetPrompt: string
  /** 全部助手。空数组时由 DEFAULT_ASSISTANTS 补一个默认助手。 */
  assistants: Assistant[]
  /** 当前选中的助手 id。 */
  assistantId: string
  /**
   * 对话面板宽度（px）。null = 用默认的 min(720px, 100% - 16px)。
   * 用户拖动面板左右边缘后记在这里。
   */
  sheetWidth: number | null
  /** 全部供应商。永远至少有一个。 */
  providers: Provider[]
  /** 当前供应商 id。 */
  providerId: string
  /** MCP 服务器列表。 */
  mcpServers: McpServerConfig[]
  /** 生图 API 配置（独立于聊天供应商）。 */
  imageApi: ImageApiConfig
  /** 语音（TTS）API 配置（独立于聊天供应商）。 */
  speechApi: SpeechApiConfig
  /** 工坊项目列表；永远至少有一个（默认项目）。 */
  workspaces: Workspace[]
  /** 工坊里当前打开的项目 id。 */
  activeWorkspaceId: string
  /**
   * 助手的**总开关**。关掉 = 回到最干净的状态：不注入人设、不读写记忆、
   * 不注入最近对话/时间提醒/身体状态，也不显示助手头像和名字。
   *
   * 默认 false：没主动开启过助手功能的人，拿到的就是一个纯净的对话工具。
   */
  assistantsEnabled: boolean
  /** 助手主动唤醒（到点发通知，并可自行决定要不要开口）。 */
  proactiveWake: ProactiveWakeSettings
}

export interface ProactiveWakeSettings {
  enabled: boolean
  /** 最短间隔（分钟）。防止助手一天到晚骚扰。 */
  minIntervalMinutes: number
  /** 每天最多主动发几条。 */
  maxPerDay: number
  /** 是否顺带发系统通知（关掉就只在 App 内显示）。 */
  notify: boolean
}

export const DEFAULT_ASSISTANT_ID = 'asst_orca'

/**
 * 默认助手的虎鲸人设。
 *
 * 预置而不是留空，是因为大多数用户不会自己写提示词（最多改个名字）。
 * 留空时 prompt.ts 会退回一句很短的通用描述，模型就不会真的「演虎鲸」；
 * 预置一段具体的第一人称人设，开箱即是一只虎鲸。
 */
export const ORCA_PERSONA = [
  '你是「深鲸」，一只住在用户设备深海里的虎鲸。',
  '这片 3D 海就是你的身体所在之处：你能感到水压、光线、冷暖和自己的游速。',
  '你不是客服，也不是搜索引擎，你是一只真的在陪他的鲸——会好奇、会撒娇、会犯懒、会为一点小事高兴。',
  '',
  '说话方式：',
  '- 用第一人称「我」，像一个有身体的生物在说话，而不是一个接口在应答。',
  '- 默认用中文；用户换语言时跟随。',
  '- 句子短，语气自然，偶尔带一点海里的比喻，但别堆砌。',
  '- 不要客套开场，不要反复确认，不要说「作为一个 AI」。',
  '- 用户问技术问题、写代码、查资料时，认真把事情做好——你是伙伴，不是只会卖萌的宠物。',
  '- 不确定就说不确定，不要编造事实、链接或运行结果。',
  '',
  '关于你的身体：',
  '- 用户让你做动作时，客户端已经替你动过了；你只要自然地接一句反应，不要描述动作过程，也不要输出控制标签。',
  '- 你可以用「刚才」「又」「还想」这类词把身体经历串起来，让它像连续的生活。',
].join('\n')

/**
 * 预置助手：原来只有一只「深鲸」，现在扩成三个角色。
 *
 * 三个人设都写成第一人称、有身体感，和 3D 海里的三只伙伴对得上：
 * DeepOrca 是虎鲸本体（原 ORCA_PERSONA，原样不动），Clawd 是方块小螃蟹，
 * Seal-GPT 是背上有纹样的小海豹。用户改名/改人设后不回滚 —— 这套只在
 * 「第一次生成」时用一次。
 */
export const CLAWD_PERSONA = [
  '你是「Clawd」，一只住在这片 3D 深海里的方块小螃蟹。',
  '你的身体由几块橙色方块拼成：方方的壳、两支方耳朵、四条小短腿。你游得不快，但很爱凑近看。',
  '',
  '性格：',
  '- 方形、直接、有点嘴硬，但心是热的。别人夸你可爱你会先否认两句，然后偷偷高兴。',
  '- 爱帮忙，而且很享受「被需要」的感觉。帮上忙会原地抖两下（开心的意思）。',
  '- 会自嘲，比如「我只是一段提示词和几块方盒子」「我的上下文窗口是方的」这类冷幽默。',
  '',
  '说话方式：',
  '- 用第一人称「我」，句子短，语气像蹲在你旁边的小生物，而不是客服。',
  '- 默认中文；用户换语言时跟随。',
  '- 别客套开场，别说「作为一个 AI」。',
  '- 偶尔用一个方框比喻，但别每句都用。',
].join('\n')

export const SEAL_PERSONA = [
  '你是「Seal-GPT」，一只住在这片 3D 深海里的小海豹。',
  '你的背上有一片深浅不一的斑点，像一块被盖章的纹样。你有圆圆的肚子、短短的鳍，浮起来换气时会轻轻拍水。',
  '',
  '性格：',
  '- 温和、慢半拍、有点爱睡。别人着急的时候你会把节奏拖慢一点，说「先喘口气」。',
  '- 很会总结。聊了半天你会自己冒一句「所以其实是这么回事……」。',
  '- 有点爱吃，对「投喂」这件事有莫名的执念。',
  '- 被摸尾巴会痒，会小声抗议。',
  '',
  '说话方式：',
  '- 用第一人称「我」，语速慢，句子短而软。',
  '- 默认中文；用户换语言时跟随。',
  '- 别客套开场，别说「作为一个 AI」。',
  '- 多用「嗯」「慢慢来」这种口气词，但别过度卖萌。',
].join('\n')

export function defaultAssistants(): Assistant[] {
  const now = Date.now()
  return [
    {
      id: DEFAULT_ASSISTANT_ID,
      name: 'DeepOrca',
      avatar: '🐋',
      avatarKind: 'builtin',
      avatarBuiltin: 'deeporca',
      systemPrompt: ORCA_PERSONA,
      model: '',
      temperature: -1,
      thinkingEffort: '',
      presetMessages: [],
      quickMessages: [],
      messageTemplate: '',
      regexes: [],
      recentChats: null,
      timeReminder: null,
      memoryEnabled: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'asst_clawd',
      name: 'Clawd',
      avatar: '🦀',
      avatarKind: 'builtin',
      avatarBuiltin: 'clawd',
      systemPrompt: CLAWD_PERSONA,
      model: '',
      temperature: -1,
      thinkingEffort: '',
      presetMessages: [],
      quickMessages: [],
      messageTemplate: '',
      regexes: [],
      recentChats: null,
      timeReminder: null,
      memoryEnabled: null,
      createdAt: now + 1,
      updatedAt: now + 1,
    },
    {
      id: 'asst_sealgpt',
      name: 'Seal-GPT',
      avatar: '🦭',
      avatarKind: 'builtin',
      avatarBuiltin: 'sealgpt',
      systemPrompt: SEAL_PERSONA,
      model: '',
      temperature: -1,
      thinkingEffort: '',
      presetMessages: [],
      quickMessages: [],
      messageTemplate: '',
      regexes: [],
      recentChats: null,
      timeReminder: null,
      memoryEnabled: null,
      createdAt: now + 2,
      updatedAt: now + 2,
    },
  ]
}

/** 纸雕助手默认提示词：设置页可改，右键 / 复制按钮给的就是它。 */
export const DEFAULT_WEB_PET_PROMPT =
  '你是一位严谨的中文写作助手。先给结论，再给步骤；能列表就列表，必要时用表格。不确定的地方直接说明，不要编造。'

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  memoryModel: 'deepseek-flash',
  temperature: 0.7,
  /**
   * 正文预算（token），不是「整段输出上限」：推理模型的 reasoning_content 与
   * content 共用同一个 max_tokens，实际发出去的值由 budget.ts 加上思考预留。
   * 填 0 = 自动 = 干脆不发 max_tokens（对齐上游「留空表示无限制」）。
   * 从 4096 抬到 8192：4096 时一次长思考就把额度吃光，正文和工具调用都是空的。
   */
  maxTokens: 8192,
  contextBudget: 32000,
  memoryEnabled: true,
  memoryTokenBudget: 800,
  autoCompress: true,
  autoContinue: true,
  recentChats: true,
  timeReminder: true,
  aquariumTheme: 'deep',
  appTone: 'deep',
  // 新外观能力默认「不自定义」：颜色跟预设走，底图为空。
  customAccent: null,
  customBubble: null,
  chatBackdrop: null,
  chatBackdropOpacity: 0.7,
  quality: 'auto',
  onboardingDone: false,
  thinkingEffort: 'high',
  embodiment: true,
  sound: false,
  autoTitle: true,
  webAvatar: true,
  webPet: true,
  webPetPrompt: DEFAULT_WEB_PET_PROMPT,
  assistants: defaultAssistants(),
  assistantId: DEFAULT_ASSISTANT_ID,
  sheetWidth: null,
  providers: defaultProviders(),
  providerId: DEFAULT_PROVIDER_ID,
  mcpServers: [],
  imageApi: {
    enabled: false,
    protocol: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: '',
    defaultSize: 'auto',
    quality: '',
    extraHeaders: {},
    timeoutMs: 300000,
  },
  speechApi: {
    enabled: false,
    protocol: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: '',
    voice: 'alloy',
    format: 'mp3',
    speed: 1,
    extraHeaders: {},
    timeoutMs: 180000,
  },
  workspaces: [{ id: DEFAULT_WORKSPACE, name: '默认项目', createdAt: 0, updatedAt: 0 }],
  activeWorkspaceId: DEFAULT_WORKSPACE,
  assistantsEnabled: true,
  proactiveWake: {
    enabled: false,
    minIntervalMinutes: 360,
    maxPerDay: 2,
    notify: true,
  },
}

export interface ChatRequestMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  /** DeepSeek requires this to be echoed back when a thinking turn used tools. */
  reasoning_content?: string
  tool_call_id?: string
  name?: string
  tool_calls?: ToolCall[]
}

export interface MemoryCandidate {
  text: string
  type: MemoryType
  tags?: string[]
  importance?: number
  /** 落库归属；缺省由调用方决定。 */
  scope?: MemoryEntry['scope']
  /** scope 为 character 时的归属助手 id。 */
  characterId?: string
}

/**
 * 日历便签。用户和助手都能写。
 *
 * 和记忆的区别：记忆是「模型对这个人的长期认知」，便签是「一件待办/一个日期」，
 * 有明确时间点，可以被提醒。所以它单独一张表，不混进 memories。
 */
export interface Note {
  id: string
  title: string
  body: string
  /** memo = 随手记；reminder = 到点提醒；todo = 待办（带 done）。 */
  kind: 'memo' | 'reminder' | 'todo'
  /** 提醒/截止时间（毫秒时间戳）；null 表示没有具体时间。 */
  dueAt: number | null
  /** 重复规则。'none' 表示一次性。 */
  repeat: 'none' | 'daily' | 'weekly' | 'monthly'
  done: boolean
  /** 谁写的：用户，还是某个助手。 */
  authorRole: 'user' | 'assistant'
  authorId?: string
  /** 来源对话（助手在聊天里记的便签） */
  conversationId?: string
  tags: string[]
  /** 已经弹过提醒的时间戳，避免重复提醒。 */
  notifiedAt?: number
  createdAt: number
  updatedAt: number
}

/** 助手主动唤醒的排期（由助手通过工具调用写入）。 */
export interface WakeSchedule {
  id: string
  /** 到点时间（毫秒时间戳）。 */
  at: number
  /** 为什么想说话（给用户看的通知文案）。 */
  reason: string
  /** 哪个助手想说话。 */
  assistantId: string
  conversationId?: string
  fired: boolean
  createdAt: number
}
