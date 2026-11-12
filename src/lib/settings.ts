import { getAllSettings, putSetting } from './db'
import {
  DEFAULT_ASSISTANT_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_SETTINGS,
  DEFAULT_WEB_PET_PROMPT,
  DEFAULT_WORKSPACE,
  defaultAssistants,
  defaultProviders,
  type Assistant,
  type AssistantAvatarKind,
  type AssistantRegex,
  type ImageApiConfig,
  type McpServerConfig,
  type MediaApiProtocol,
  type Provider,
  type QuickMessage,
  type QualityId,
  type Settings,
  type SpeechApiConfig,
  type ThemeId,
  type ThinkingEffort,
  type Workspace,
} from './types'
import { migrateLegacyProvider, settleProviderOnBoot } from './providers'
import { clampNumber, resolveProtocol } from './normalize'
import { secureGet, secureRemove, secureSet } from './platform'

/**
 * 内置助手头像的白名单 key。
 *
 * 刻意写成字面量而不是 import avatar-defaults（那里 `?raw` 引入了 .svg）：
 * settings.ts 会被 node 单测直接 import，而 node 不认识 .svg 后缀，
 * 会整条链挂掉。真正的头像映射仍在 avatar-defaults.ts，这里只校验 key 合法。
 */
const BUILTIN_AVATAR_KEYS = ['deeporca', 'clawd', 'sealgpt']

/** 各供应商的 key，按 providerId 索引。 */
let cachedKeys: Record<string, string> = {}
/** 媒体 API 的 Key 使用保留槽位名，避免和 provider id 撞名。 */
const MEDIA_IMAGE_KEY = 'media:image'
const MEDIA_SPEECH_KEY = 'media:speech'
/** 上次写入安全存储的原始 blob，用来判断要不要重写。 */
let cachedKeyBlob = ''

const THEMES: readonly ThemeId[] = ['deep', 'iceberg', 'tropical']
const QUALITIES: readonly QualityId[] = ['auto', 'low', 'medium', 'high']
const EFFORTS: readonly ThinkingEffort[] = ['off', 'low', 'high', 'max']
const IMAGE_PROTOCOLS: readonly MediaApiProtocol[] = ['openrouter', 'openai', 'gemini', 'aliyun']
const SPEECH_PROTOCOLS: readonly MediaApiProtocol[] = ['openrouter', 'openai', 'gemini', 'minimax', 'aliyun', 'elevenlabs']
const SPEECH_FORMATS: readonly SpeechApiConfig['format'][] = ['mp3', 'wav', 'opus']

/** 请求头只保留字符串值，去掉继承属性/数组等脏形状。 */
function normalizeHeaders(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, value as string]),
  )
}

/**
 * 生图 API 的收敛。
 *
 * 关键：必须和 DEFAULT_SETTINGS.imageApi 做浅合并。sanitize 的 `{ ...DEFAULT_SETTINGS, ...raw }`
 * 只保证顶层字段存在，如果 raw.imageApi 是个老对象/半截对象，直接覆盖会让
 * `extraHeaders` / `timeoutMs` 变成 undefined，后续请求里就炸。
 */
function normalizeImageApi(raw: unknown): ImageApiConfig {
  const base = DEFAULT_SETTINGS.imageApi
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...base, extraHeaders: {} }
  }
  const item = raw as Record<string, unknown>
  const protocol = IMAGE_PROTOCOLS.includes(item.protocol as MediaApiProtocol)
    ? (item.protocol as MediaApiProtocol)
    : base.protocol
  const defaultSize = typeof item.defaultSize === 'string' && item.defaultSize.trim() !== ''
    ? item.defaultSize.trim().slice(0, 32)
    : base.defaultSize
  const rawTimeout = Number(item.timeoutMs)
  return {
    enabled: item.enabled === true,
    protocol,
    baseUrl: (typeof item.baseUrl === 'string' ? item.baseUrl : base.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
    model: typeof item.model === 'string' ? item.model.trim().slice(0, 128) : '',
    defaultSize,
    quality: typeof item.quality === 'string' ? item.quality.trim().slice(0, 16) : '',
    extraHeaders: normalizeHeaders(item.extraHeaders),
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0
      ? clampNumber(rawTimeout, 30000, 600000, base.timeoutMs)
      : base.timeoutMs,
  }
}

/** 语音 API 的收敛（规则同 normalizeImageApi）。 */
function normalizeSpeechApi(raw: unknown): SpeechApiConfig {
  const base = DEFAULT_SETTINGS.speechApi
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...base, extraHeaders: {} }
  }
  const item = raw as Record<string, unknown>
  const protocol = SPEECH_PROTOCOLS.includes(item.protocol as MediaApiProtocol)
    ? (item.protocol as MediaApiProtocol)
    : base.protocol
  const format = SPEECH_FORMATS.includes(item.format as SpeechApiConfig['format'])
    ? (item.format as SpeechApiConfig['format'])
    : base.format
  const rawTimeout = Number(item.timeoutMs)
  return {
    enabled: item.enabled === true,
    protocol,
    baseUrl: (typeof item.baseUrl === 'string' ? item.baseUrl : base.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
    model: typeof item.model === 'string' ? item.model.trim().slice(0, 128) : '',
    voice: typeof item.voice === 'string' && item.voice.trim() !== '' ? item.voice.trim().slice(0, 64) : base.voice,
    format,
    speed: clampNumber(item.speed, 0.25, 4, base.speed),
    extraHeaders: normalizeHeaders(item.extraHeaders),
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0
      ? clampNumber(rawTimeout, 30000, 600000, base.timeoutMs)
      : base.timeoutMs,
  }
}

/** 默认虎鲸名；也是「用户还没给它起过名字」的判据。 */
const DEFAULT_ORCA_NAME = '深鲸'

/**
 * 拆分前的老格式。这两个键只可能出现在老库里，sanitize 负责迁移走再从结果里删掉。
 */
type LegacySettings = Partial<Settings> & {
  /** 拆分前只有一个主题，同时管 App 配色和 3D 场景。 */
  theme?: ThemeId
  /** 拆分前虎鲸的名字；现在名字挂在助手上。 */
  orcaName?: string
}

function isTheme(value: unknown): value is ThemeId {
  return THEMES.includes(value as ThemeId)
}

/**
 * 自定义颜色只认 `#rrggbb`。
 *
 * 这个值最终会被写进 `.app` 的内联 CSS 变量，所以不能把任意字符串原样放过：
 * 脏值（半截颜色、`red; background: …` 这种、老版本留下的对象）统一收敛成
 * null = 「没有自定义」，界面退回 data-tone 预设。三位简写顺手展开成六位，
 * `<input type="color">` 只吃六位。
 */
export function normalizeHexColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`
  }
  return /^#[0-9a-f]{6}$/.test(text) ? text : null
}

/**
 * 对话底图的体积上限（dataURL 字符数）。
 *
 * 1600px / JPEG 0.82 一般落在 200~500K 字符，这里留足余量但挡住「有人手动往
 * IndexedDB 里塞一张原图」的情况 —— 那是几 MB 的字符串，每次保存设置都要
 * 整个 structured clone 一遍，界面会明显卡顿。
 */
export const MAX_CHAT_BACKDROP_CHARS = 2_000_000

/** 底图：必须是 data:image/ 开头的字符串，且不能超过体积上限。 */
function normalizeChatBackdrop(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text.startsWith('data:image/')) return null
  if (text.length > MAX_CHAT_BACKDROP_CHARS) return null
  return text
}

/** 只认正整数：0 / 负数 / 字符串都当没给，和 model-catalog 的解析口径保持一致。 */
function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * 收敛模型元信息：只留「键还在模型列表里（或就是当前正在用的模型）、值为对象、
 * 各字段类型正确」的条目。
 *
 * 模型从目录里删掉后，它的元信息就没有意义了；手改过 IndexedDB 的脏数据也不该
 * 让界面渲染出 NaN 或者一个空的第二行。这些都是纯展示用的附加信息，脏了静默丢掉
 * 即可 —— 不能因为一条元信息坏了就让整个供应商读不出来。
 *
 * `keepId` 是 settings.model：目录外手填的 id 也要能带覆写，否则「给自定义模型
 * 打开/关掉看图」这个功能对最容易用到它的场景（中转站手填模型名）直接失效。
 * 刻意**不**把它顺手追加进 provider.models —— 改写模型字段正是当年
 * 「自定义模型名存不住」那个 bug 的元凶（见 providers.ts:154-179 的注释）。
 */
function normalizeModelMeta(raw: unknown, models: readonly string[], keepId: string): Provider['modelMeta'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const allowed = new Set(models)
  const out: Record<string, NonNullable<Provider['modelMeta']>[string]> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(id) && id !== keepId) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const meta: NonNullable<Provider['modelMeta']>[string] = {}
    if (typeof entry.name === 'string' && entry.name.trim() !== '') meta.name = entry.name.trim().slice(0, 64)
    if (isPositiveInt(entry.contextWindow)) meta.contextWindow = entry.contextWindow
    if (isPositiveInt(entry.maxTokens)) meta.maxTokens = entry.maxTokens
    // 三态：`false` 是用户明确说「这个模型不用发图」，和「没填」是两回事。
    // 以前只认 `=== true`，等于把关掉看图这个选项在落库这一步抹掉了。
    if (typeof entry.vision === 'boolean') meta.vision = entry.vision
    if (Object.keys(meta).length === 0) continue
    out[id] = meta
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 过滤脏数据，保证每个供应商的结构完整、id 不重复、至少留一个。 */
function normalizeProviders(list: Provider[], keepModelId: string): Provider[] {
  const seen = new Set<string>()
  const out: Provider[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const id = typeof item.id === 'string' && item.id !== '' ? item.id : `provider_${out.length + 1}`
    if (seen.has(id)) continue
    seen.add(id)
    const models = Array.isArray(item.models)
      ? item.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim())
      : []
    out.push({
      id,
      name: (typeof item.name === 'string' && item.name.trim() !== '' ? item.name : '未命名供应商').slice(0, 32),
      // 顺手修历史数据：老版本不认 'deepseek-web'，会把它改写成 'openai' 再存回去。
      // 这种被改坏的供应商有个明确特征 —— 模型列表里只有网页模型。
      // 认出来的就还原成网页账号，否则用户那边永远停在一个「要填 Key 的网页账号」上。
      protocol: resolveProtocol(item.protocol, models),
      baseUrl: (typeof item.baseUrl === 'string' ? item.baseUrl : '').replace(/\/+$/, ''),
      apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
      models,
      // 元信息挂在模型 id 上，所以必须在 models 定稿之后过滤。
      modelMeta: normalizeModelMeta(item.modelMeta, models, keepModelId),
      // 历史思考回灌是供应商级开关：没开就是关，任何脏值都当关。
      // normalizeProviders 是逐字段重建对象的，新字段不加这一行就会在冷启动时被抹掉。
      includeHistoryReasoning: item.includeHistoryReasoning === true ? true : undefined,
      headers: typeof item.headers === 'object' && item.headers !== null && !Array.isArray(item.headers)
        ? Object.fromEntries(
          Object.entries(item.headers as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
        : {},
      enabled: item.enabled !== false,
    })
  }
  return out.length > 0 ? out : defaultProviders()
}

/**
 * 把库里的原始设置收敛成合法值。导出只为测试用（loadSettings 内部会调）。
 */
export function sanitize(raw: Partial<Settings>): Settings {
  const legacyRaw = raw as LegacySettings
  const settings: Settings = { ...DEFAULT_SETTINGS, ...raw, apiKey: '' }
  // 主题拆成两个字段：老库里只有 `theme`，两个新字段都还没有时就都继承它，
  // 升级前后看到的画面不变；之后各自独立校验，脏值退回 deep。
  const legacyTheme = isTheme(legacyRaw.theme) ? legacyRaw.theme : undefined
  const aquariumTheme = legacyRaw.aquariumTheme ?? legacyTheme
  const appTone = legacyRaw.appTone ?? legacyTheme
  settings.aquariumTheme = isTheme(aquariumTheme) ? aquariumTheme : 'deep'
  settings.appTone = isTheme(appTone) ? appTone : 'deep'
  // 外观自定义：颜色/底图都是「有就用、脏就当没有」，默认是 null 而不是布尔式的
  // 「默认开」—— 没自定义时界面必须完全跟着 data-tone 预设走。
  settings.customAccent = normalizeHexColor(settings.customAccent)
  settings.customBubble = normalizeHexColor(settings.customBubble)
  settings.chatBackdrop = normalizeChatBackdrop(settings.chatBackdrop)
  settings.chatBackdropOpacity = clampNumber(settings.chatBackdropOpacity, 0, 1, DEFAULT_SETTINGS.chatBackdropOpacity)
  if (!QUALITIES.includes(settings.quality)) settings.quality = 'auto'
  if (!EFFORTS.includes(settings.thinkingEffort)) settings.thinkingEffort = 'high'
  settings.webAvatar = settings.webAvatar !== false
  settings.webPet = settings.webPet !== false
  // 纸雕助手默认提示词：老数据没有这一项，补默认；脏值也退回默认，避免复制出空串。
  settings.webPetPrompt = typeof settings.webPetPrompt === 'string' && settings.webPetPrompt.trim() !== ''
    ? settings.webPetPrompt.slice(0, 4000)
    : DEFAULT_WEB_PET_PROMPT
  settings.embodiment = settings.embodiment !== false
  // 老数据没有这个字段时按「开」处理，保持升级后的行为和升级前一致。
  settings.autoCompress = settings.autoCompress !== false
  settings.autoContinue = settings.autoContinue !== false
  settings.contextBudget = clampNumber(settings.contextBudget, 4000, 64000, 32000)
  // 单次输出上限填的是**正文预算**：推理模型的 reasoning_content 与 content 共用同一个
  // max_tokens，真正发出去的值由 budget.ts 再加上思考预留。
  // 0 = 「自动」= 干脆不发这个字段（对齐上游「留空表示无限制」），所以 0 必须原样放过 ——
  // 交给 clampNumber 会被夹成 256，那就是一次静默的行为改变。
  // 上限从 16384 抬到 65536：目录里 32K/64K 输出的模型不该被我们自己的输入框砍到 16K。
  settings.maxTokens = Number(settings.maxTokens) === 0
    ? 0
    : clampNumber(settings.maxTokens, 256, 65536, 8192)
  settings.temperature = clampNumber(settings.temperature, 0, 1.5, 0.7)
  settings.memoryTokenBudget = clampNumber(settings.memoryTokenBudget, 200, 16000, 800)
  settings.baseUrl = (settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, '')

  // 供应商：老数据只有单个 apiKey/baseUrl，迁移成一个内置供应商。
  // 注意 apiKey 此时还是空的（key 在安全存储里），后面 loadSettings 会填。
  const legacy = migrateLegacyProvider(settings)
  // 当前正在用的那个模型也要保住元信息（它可能是目录外手填的 id，见上面 normalizeModelMeta）。
  const keepModelId = typeof settings.model === 'string' ? settings.model : ''
  settings.providers = normalizeProviders(legacy.providers, keepModelId)
  settings.providerId = legacy.providerId

  // 媒体 API：老数据没有这两个字段时用默认值（默认关闭）；半截对象也要补齐默认值。
  settings.imageApi = normalizeImageApi((raw as Partial<Settings>).imageApi)
  settings.speechApi = normalizeSpeechApi((raw as Partial<Settings>).speechApi)

  // 对话面板宽度：null 表示默认；有值就夹在合理区间里，避免窄屏上存了个放不下的数。
  if (settings.sheetWidth !== null && settings.sheetWidth !== undefined) {
    const width = Number(settings.sheetWidth)
    settings.sheetWidth = Number.isFinite(width) ? Math.round(Math.max(360, Math.min(1800, width))) : null
  } else {
    settings.sheetWidth = null
  }

  // 助手：老数据没有这一项时补一个默认的，保证永远至少有一个可选。
  const storedAssistants = Array.isArray(settings.assistants) ? settings.assistants : []
  const assistants = storedAssistants
    .filter((item): item is Assistant => typeof item === 'object' && item !== null && typeof item.id === 'string')
    .map((item) => ({
      ...item,
      name: (item.name || '未命名').slice(0, 32),
      avatar: (item.avatar || '🐋').slice(0, 8),
      // 头像三态收敛：脏值退回 emoji，内置 key 必须在白名单里，上传图限长。
      avatarKind: (item.avatarKind === 'builtin' || item.avatarKind === 'image' ? item.avatarKind : 'emoji') as AssistantAvatarKind,
      avatarBuiltin: typeof item.avatarBuiltin === 'string' && BUILTIN_AVATAR_KEYS.includes(item.avatarBuiltin)
        ? item.avatarBuiltin
        : undefined,
      avatarImage: typeof item.avatarImage === 'string' && item.avatarImage.startsWith('data:image/') && item.avatarImage.length <= 64 * 1024
        ? item.avatarImage
        : undefined,
      systemPrompt: typeof item.systemPrompt === 'string' ? item.systemPrompt : '',
      model: typeof item.model === 'string' ? item.model : '',
      temperature: Number.isFinite(item.temperature) ? item.temperature : -1,
      thinkingEffort: item.thinkingEffort === undefined ? '' : item.thinkingEffort,
      presetMessages: Array.isArray(item.presetMessages)
        ? item.presetMessages.filter((text): text is string => typeof text === 'string')
        : [],
      quickMessages: Array.isArray(item.quickMessages)
        ? item.quickMessages
          .filter((msg): msg is QuickMessage => typeof msg === 'object' && msg !== null && typeof msg.id === 'string')
          .map((msg) => ({
            id: msg.id,
            title: (typeof msg.title === 'string' ? msg.title : '').slice(0, 24),
            content: typeof msg.content === 'string' ? msg.content : '',
          }))
        : [],
      messageTemplate: typeof item.messageTemplate === 'string' ? item.messageTemplate : '',
      regexes: Array.isArray(item.regexes)
        ? item.regexes
          .filter((rule): rule is AssistantRegex => typeof rule === 'object' && rule !== null && typeof rule.id === 'string')
          .map((rule) => ({
            id: rule.id,
            name: (typeof rule.name === 'string' ? rule.name : '').slice(0, 24),
            enabled: rule.enabled !== false,
            find: typeof rule.find === 'string' ? rule.find : '',
            replace: typeof rule.replace === 'string' ? rule.replace : '',
          }))
        : [],
      recentChats: typeof item.recentChats === 'boolean' ? item.recentChats : null,
      timeReminder: typeof item.timeReminder === 'boolean' ? item.timeReminder : null,
      memoryEnabled: typeof item.memoryEnabled === 'boolean' ? item.memoryEnabled : null,
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Date.now(),
    }))
  settings.assistants = assistants.length > 0 ? assistants : defaultAssistants()

  // 助手总开关：默认**开**。老用户本来就在用助手+记忆，升级后不该突然失忆；
  // 想回到纯净对话的人可以自己一键关掉（关掉即不注入人设、不读写记忆）。
  settings.assistantsEnabled = settings.assistantsEnabled !== false

  // 主动唤醒：逐字段收敛，防止存了个离谱的频率把用户刷屏。
  const wake = (raw as Partial<Settings>).proactiveWake
  settings.proactiveWake = {
    enabled: wake?.enabled === true,
    minIntervalMinutes: clampNumber(wake?.minIntervalMinutes, 30, 60 * 24 * 7, DEFAULT_SETTINGS.proactiveWake.minIntervalMinutes),
    maxPerDay: Math.round(clampNumber(wake?.maxPerDay, 1, 24, DEFAULT_SETTINGS.proactiveWake.maxPerDay)),
    notify: wake?.notify !== false,
  }

  const selected = settings.assistants[0]
  if (selected === undefined) {
    settings.assistantId = DEFAULT_ASSISTANT_ID
  } else if (!settings.assistants.some((item) => item.id === settings.assistantId)) {
    settings.assistantId = selected.id
  }

  // 名字迁移：老版本的 `orcaName` 是虎鲸的名字，现在名字归到助手上。
  // 只在「用户真的改过」（不是默认的「深鲸」）、并且第一个助手还没被起过名字时
  // 才搬过去 —— 否则会把用户已经在助手页改好的名字冲掉。
  const legacyOrcaName = typeof legacyRaw.orcaName === 'string' ? legacyRaw.orcaName.trim().slice(0, 24) : ''
  const first = settings.assistants[0]
  // 「未命名」是上面规范化给空名字的兜底值，同样说明这个名字不是用户起的。
  const firstName = first === undefined ? '' : first.name.trim()
  const unnamed = firstName === '' || firstName === DEFAULT_ORCA_NAME || firstName === 'DeepOrca' || firstName === '未命名'
  if (first !== undefined && unnamed && legacyOrcaName !== '' && legacyOrcaName !== DEFAULT_ORCA_NAME) {
    settings.assistants = [{ ...first, name: legacyOrcaName }, ...settings.assistants.slice(1)]
  }
  // MCP 服务器：过滤脏项，id 去重。
  const storedMcp = Array.isArray(settings.mcpServers) ? settings.mcpServers : []
  const seenMcp = new Set<string>()
  settings.mcpServers = storedMcp
    .filter((item): item is McpServerConfig => typeof item === 'object' && item !== null && typeof item.id === 'string')
    .filter((item) => {
      if (seenMcp.has(item.id)) return false
      seenMcp.add(item.id)
      return true
    })
    .map((item) => ({
      id: item.id,
      name: (typeof item.name === 'string' ? item.name : '未命名').slice(0, 32),
      transport: item.transport === 'sse' ? 'sse' : item.transport === 'stdio' ? 'stdio' : 'streamable_http',
      url: typeof item.url === 'string' ? item.url.trim() : '',
      command: typeof item.command === 'string' ? item.command.trim() : '',
      args: Array.isArray(item.args)
        ? item.args.filter((arg): arg is string => typeof arg === 'string')
        : [],
      headers: typeof item.headers === 'object' && item.headers !== null && !Array.isArray(item.headers)
        ? Object.fromEntries(
          Object.entries(item.headers as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
        : {},
      enabled: item.enabled !== false,
      // 没配过策略时默认「每次都问」—— 接陌生服务器的安全默认值。
      defaultPolicy: item.defaultPolicy === 'never' ? 'never' : 'always',
      toolPolicies: typeof item.toolPolicies === 'object' && item.toolPolicies !== null && !Array.isArray(item.toolPolicies)
        ? Object.fromEntries(
          Object.entries(item.toolPolicies as Record<string, unknown>)
            .filter(([, v]) => v === 'always' || v === 'never')
            .map(([k, v]) => [k, v as 'always' | 'never']),
        )
        : {},
    }))

  // 工坊项目：老数据没有这一项，补一个「默认项目」；activeWorkspaceId 必须真实存在。
  const storedWorkspaces = Array.isArray(settings.workspaces) ? settings.workspaces : []
  const seenWorkspace = new Set<string>()
  const workspaces = storedWorkspaces
    .filter((item): item is Workspace => typeof item === 'object' && item !== null && typeof item.id === 'string' && item.id !== '')
    .filter((item) => {
      if (seenWorkspace.has(item.id)) return false
      seenWorkspace.add(item.id)
      return true
    })
    .map((item) => ({
      id: item.id,
      name: (typeof item.name === 'string' && item.name.trim() !== '' ? item.name : '未命名项目').slice(0, 24),
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Date.now(),
    }))
  if (!workspaces.some((item) => item.id === DEFAULT_WORKSPACE)) {
    const now = Date.now()
    workspaces.unshift({ id: DEFAULT_WORKSPACE, name: '默认项目', createdAt: now, updatedAt: now })
  }
  settings.workspaces = workspaces
  if (!workspaces.some((item) => item.id === settings.activeWorkspaceId)) {
    settings.activeWorkspaceId = DEFAULT_WORKSPACE
  }

  // 迁移完就把老键彻底删掉：persistSettings 存的是整个对象，
  // 留着它们等于每次启动都重新迁移一遍，永远停在老格式上。
  delete (settings as LegacySettings).theme
  delete (settings as LegacySettings).orcaName

  return settings
}

export async function loadSettings(): Promise<Settings> {
  const raw = await getAllSettings()
  const stored = (raw.app ?? {}) as Partial<Settings>
  const blob = (await secureGet()) ?? ''
  cachedKeys = parseKeyBlob(blob)
  const settings = sanitize(stored)
  // 把安全存储里的 key 填回各个供应商与媒体 API。
  const providers = settings.providers.map((provider) => ({
    ...provider,
    apiKey: cachedKeys[provider.id] ?? '',
  }))
  return withProviderSync({
    ...settings,
    providers,
    imageApi: { ...settings.imageApi, apiKey: cachedKeys[MEDIA_IMAGE_KEY] ?? '' },
    speechApi: { ...settings.speechApi, apiKey: cachedKeys[MEDIA_SPEECH_KEY] ?? '' },
  })
}

export async function persistSettings(settings: Settings): Promise<void> {
  // 所有供应商的 key 序列化进同一个安全槽位，平台层不用改。
  const keys: Record<string, string> = {}
  for (const provider of settings.providers) {
    const key = provider.apiKey.trim()
    if (key !== '') keys[provider.id] = key
  }
  // 生图/语音是独立 API，Key 也进同一个加密 blob（安全存储只有一个槽位，
  // 不要按能力拆多个 get/set；保留键避免和 provider id 撞名）。
  const imageKey = settings.imageApi.apiKey.trim()
  if (imageKey !== '') keys[MEDIA_IMAGE_KEY] = imageKey
  const speechKey = settings.speechApi.apiKey.trim()
  if (speechKey !== '') keys[MEDIA_SPEECH_KEY] = speechKey
  const blob = JSON.stringify(keys)
  // providers / 媒体配置要落库（名称/地址/模型列表都是普通设置），但里面的 apiKey
  // 属于机密，已单独写进安全存储，这里剥掉再存，避免明文进 IndexedDB。
  const strippedProviders = settings.providers.map(({ apiKey: _omit, ...rest }) => rest)
  const strippedImageApi = { ...settings.imageApi, apiKey: '' }
  const strippedSpeechApi = { ...settings.speechApi, apiKey: '' }
  const { apiKey: _apiKey, ...rest } = settings
  await putSetting('app', {
    ...rest,
    providers: strippedProviders,
    imageApi: strippedImageApi,
    speechApi: strippedSpeechApi,
  })
  if (blob !== cachedKeyBlob) {
    if (blob === '{}') await secureRemove()
    else await secureSet(blob)
    cachedKeyBlob = blob
    cachedKeys = keys
  }
}

/** 老版本存的是裸 key 字符串，这里兼容两种格式。 */
function parseKeyBlob(blob: string): Record<string, string> {
  if (blob === '') return {}
  if (!blob.startsWith('{')) {
    // 旧格式：单个 key，迁移到内置供应商。
    return { [DEFAULT_PROVIDER_ID]: blob }
  }
  try {
    const parsed = JSON.parse(blob) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, string> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '') out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * sanitize 之后统一做一次「供应商 ↔ settings」同步。
 *
 * 启动只镜像 key/地址，模型仅在为空时回落 —— 启动不是「切换供应商」，
 * 用户存下的模型（含手填的自定义模型名）必须原样带回来。
 */
function withProviderSync(settings: Settings): Settings {
  return settleProviderOnBoot(settings)
}

export function maskKey(key: string): string {
  if (key.length <= 10) return key === '' ? '未填写' : '••••••'
  return `${key.slice(0, 4)}••••••${key.slice(-4)}`
}
