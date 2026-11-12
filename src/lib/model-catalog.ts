/**
 * 「获取可用模型」的纯逻辑层：拼地址、拼鉴权头、解析各家返回、发请求。
 *
 * 单独成模块的理由和 normalize.ts 一样 —— 这一层不碰 React、不碰 IndexedDB，
 * 在 node 里直接跑得起来，于是「URL 怎么拼、脏数据怎么丢」这些最容易写错又最难
 * 手测的部分可以进单测。界面（ModelCatalog / ModelPicker）只负责显示与勾选。
 */

import type { Provider, ProviderProtocol } from './types.ts'
import { chatHeaders } from './providers.ts'
import { netRequest } from './net.ts'

/** 从提供商那里拉到的一个模型。字段都可缺省 —— 各家给的东西不一样。 */
export type DiscoveredModel = {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  vision?: boolean
}

/** 拉取结果。失败一律给中文 reason，不抛异常 —— 界面直接拿去显示。 */
export type CatalogResult = { ok: true; models: DiscoveredModel[] } | { ok: false; reason: string }

/** Provider.modelMeta 里单条元信息的类型。 */
export type ModelMeta = NonNullable<Provider['modelMeta']>[string]

const DEFAULT_TIMEOUT_MS = 15_000
/** 响应体上限：模型列表撑不到这么大，超了多半是给错了地址（返回了一整个网页）。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024
const WEB_REASON = '网页账号没有可获取的模型列表'
const EMPTY_REASON = '该提供商没有列出任何模型，请手动添加。'
const SHAPE_REASON = '该地址的模型列表格式无法识别，请手动添加模型'
const TOO_BIG_REASON = '响应超过 4MB，无法解析'
const NO_BASE_URL_REASON = '请先填写 API 地址，再获取。'

/**
 * 把用户填的地址收敛成「站点根」，各家再自己拼路径。
 *
 * 有人会把完整的 /chat/completions 甚至 /v1 直接贴进来（中转站的文档常这么写），
 * 所以先把这两段剥掉，否则会拼出 /v1/chat/completions/models 这种必然 404 的地址。
 */
function siteRoot(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '')
  const chatPath = '/chat/completions'
  if (base.endsWith(chatPath)) base = base.slice(0, -chatPath.length).replace(/\/+$/, '')
  return base
}

/**
 * 按协议拼出「列出模型」的完整 URL；返回 null 表示这个协议没有这个接口。
 *
 * - openai 兼容：{base}/models（base 带不带 /v1 由用户决定，原样保留）
 * - anthropic：{base}/v1/models?limit=1000，base 上多出来的那个 /v1 要先剥掉
 * - google：{base}/v1beta/models
 * - 网页账号：没有 HTTP 接口
 */
export function modelsEndpoint(provider: Pick<Provider, 'protocol' | 'baseUrl'>): string | null {
  if (provider.protocol === 'deepseek-web') return null
  const base = siteRoot(provider.baseUrl)
  if (base === '') return null
  switch (provider.protocol) {
    case 'anthropic': {
      // 只剥一个：https://x/v1/v1 这种明显是用户写错了，替他兜底反而更难排查。
      const root = base.endsWith('/v1') ? base.slice(0, -3).replace(/\/+$/, '') : base
      return `${root}/v1/models?limit=1000`
    }
    case 'google':
      return `${base}/v1beta/models`
    default:
      return `${base}/models`
  }
}

/**
 * 列模型用的请求头：复用对话那套鉴权（x-api-key / x-goog-api-key / Bearer），
 * 只去掉 Content-Type（GET 没有请求体，带上它有些网关会当成预检请求处理），
 * 再补一个 accept。用户自定义头最后覆盖，和中转站的玩法保持一致。
 */
export function catalogHeaders(provider: Provider): Record<string, string> {
  const headers = chatHeaders(provider)
  delete headers['Content-Type']
  return { ...headers, accept: 'application/json', ...provider.headers }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** 只认正整数：0 / 负数 / 字符串一律当没给，免得界面上显示「上下文 0」。 */
function pickPositiveInt(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  }
  return undefined
}

/**
 * 取出「模型数组」这一层。data[] 优先（OpenAI / Anthropic），否则 models
 * （Google 是数组，少数中转站给的是 {id: {...}} 的字典）。
 *
 * 返回 null 表示整体形状不认识 —— 调用方据此区分「格式不对」和「列表是空的」，
 * 这两种情况给用户的下一步操作完全不一样（改地址 vs 手填模型）。
 */
function extractEntries(json: unknown): unknown[] | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const root = json as Record<string, unknown>
  if (Array.isArray(root.data)) return root.data
  if (Array.isArray(root.models)) return root.models
  const dict = asRecord(root.models)
  if (dict === null) return null
  return Object.entries(dict).map(([key, value]) => ({ id: key, ...(asRecord(value) ?? {}) }))
}

/** 取模型 id：Google 的 id 藏在 name 里，形如 models/gemini-1.5-pro。 */
function modelId(protocol: ProviderProtocol, entry: Record<string, unknown>): string {
  if (protocol === 'google') {
    const raw = pickString(entry, ['name', 'id'])
    if (raw === undefined) return ''
    return raw.startsWith('models/') ? raw.slice('models/'.length) : raw
  }
  return pickString(entry, ['id']) ?? ''
}

/**
 * 是否有视觉能力。各家写法五花八门（OpenRouter 的 architecture.input_modalities、
 * 有的给 capabilities.vision、有的给 supports_vision），认不出来就当没有。
 */
function pickVision(entry: Record<string, unknown>): boolean | undefined {
  const modalities = asRecord(entry.architecture)?.input_modalities
  if (Array.isArray(modalities) && modalities.includes('image')) return true
  if (asRecord(entry.capabilities)?.vision === true) return true
  if (entry.supports_vision === true) return true
  return undefined
}

function describeModel(protocol: ProviderProtocol, id: string, entry: Record<string, unknown>): DiscoveredModel {
  const limit = asRecord(entry.limit)
  const topProvider = asRecord(entry.top_provider)
  // Google 的 name 是资源名（models/xxx），拿它当显示名只是重复一遍 id，所以跳过。
  const name = protocol === 'google'
    ? pickString(entry, ['display_name', 'displayName'])
    : pickString(entry, ['name', 'display_name', 'displayName'])
  // inputTokenLimit / outputTokenLimit 是 Google 官方字段，别名表里没有，但只有它有。
  const contextWindow = pickPositiveInt(entry, ['contextWindow', 'context_window', 'context_length', 'max_input_tokens', 'inputTokenLimit'])
    ?? (limit !== null ? pickPositiveInt(limit, ['context']) : undefined)
  const maxTokens = pickPositiveInt(entry, ['maxTokens', 'max_output_tokens', 'max_tokens', 'outputTokenLimit'])
    ?? (topProvider !== null ? pickPositiveInt(topProvider, ['max_completion_tokens']) : undefined)
  const model: DiscoveredModel = { id }
  if (name !== undefined) model.name = name
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  const vision = pickVision(entry)
  if (vision !== undefined) model.vision = vision
  return model
}

/**
 * 解析模型列表响应。
 *
 * **不排序、不过滤**：embedding / tts / rerank 也照原样返回，由用户在弹窗里自己勾。
 * 按 id 去重保序（顺序是提供商给的顺序，用户看起来最自然）。
 */
export function parseCatalog(protocol: ProviderProtocol, json: unknown): DiscoveredModel[] {
  const entries = extractEntries(json)
  if (entries === null) return []
  const out: DiscoveredModel[] = []
  const seen = new Set<string>()
  for (const raw of entries) {
    const entry = asRecord(raw)
    if (entry === null) continue
    const id = modelId(protocol, entry)
    if (id === '') continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(describeModel(protocol, id, entry))
  }
  return out
}

/** 把 token 数压成人一眼能读的样子：128000 → 128K，1048576 → 1M。 */
function compactTokens(value: number): string {
  if (value < 1000) return String(value)
  const mega = value >= 1_000_000
  const scaled = value / (mega ? 1_000_000 : 1000)
  // 大数取整就够准了；小数位只在「8.2K」这种个位数时才需要。
  const shown = scaled >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10
  return `${Number.isInteger(shown) ? shown : shown.toFixed(1)}${mega ? 'M' : 'K'}`
}

/**
 * 元信息拼成一行小字（显示名 · 上下文 128K · 输出 8K · 看图）。
 *
 * 目录里手填的模型没有元信息，这里返回空串 —— 界面留一行空位，别显示「未知」。
 */
export function modelMetaText(
  meta: { name?: string; contextWindow?: number; maxTokens?: number; vision?: boolean } | undefined,
): string {
  if (meta === undefined) return ''
  const parts: string[] = []
  if (meta.name !== undefined && meta.name !== '') parts.push(meta.name)
  if (meta.contextWindow !== undefined) parts.push(`上下文 ${compactTokens(meta.contextWindow)}`)
  if (meta.maxTokens !== undefined) parts.push(`输出 ${compactTokens(meta.maxTokens)}`)
  if (meta.vision === true) parts.push('看图')
  return parts.join(' · ')
}

/** 把拉回来的一个模型收成元信息条目：没给的字段不留键（否则界面会读到 undefined 以为有值）。 */
function metaOf(model: DiscoveredModel): ModelMeta {
  const entry: ModelMeta = {}
  if (model.name !== undefined) entry.name = model.name
  if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow
  if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens
  if (model.vision !== undefined) entry.vision = model.vision
  return entry
}

/**
 * 把拉回来的模型并进目录：列表**只追加**（已有的 id 不重复、也不因为提供商这次
 * 没列出来就删掉 —— 目录里可能有用户手填的自定义 id），元信息**只补缺、不覆盖**。
 *
 * 元信息为什么要补：以前对已存在的 id 是整条 `continue`，于是手填过、或者第一次
 * 拉取时提供商还没报能力的模型，永远拿不到 `vision` —— 而判定看图正是读它。
 * 为什么不覆盖：`vision` 这一键从此是用户的手动开关（模型目录那一行的三态按钮
 * 写的就是它），重新「获取」绝不能把它翻回去；显示名同理（用户可能改过）。
 */
export function mergeCatalogModels(
  provider: Pick<Provider, 'models' | 'modelMeta'>,
  found: readonly DiscoveredModel[],
): { models: string[]; modelMeta: Provider['modelMeta'] } {
  const models = [...provider.models]
  const meta: Record<string, ModelMeta> = { ...(provider.modelMeta ?? {}) }
  for (const model of found) {
    if (!models.includes(model.id)) models.push(model.id)
    const incoming = metaOf(model)
    const current = meta[model.id]
    if (current === undefined) {
      if (Object.keys(incoming).length > 0) meta[model.id] = incoming
      continue
    }
    const next: ModelMeta = { ...current }
    if (next.name === undefined && incoming.name !== undefined) next.name = incoming.name
    if (next.contextWindow === undefined && incoming.contextWindow !== undefined) {
      next.contextWindow = incoming.contextWindow
    }
    if (next.maxTokens === undefined && incoming.maxTokens !== undefined) next.maxTokens = incoming.maxTokens
    if (typeof next.vision !== 'boolean' && incoming.vision !== undefined) next.vision = incoming.vision
    meta[model.id] = next
  }
  return { models, modelMeta: Object.keys(meta).length > 0 ? meta : undefined }
}

/** 从目录里删掉一个模型；它的元信息也一起删（否则会一直躺在设置里）。 */
export function removeCatalogModel(
  provider: Pick<Provider, 'models' | 'modelMeta'>,
  id: string,
): { models: string[]; modelMeta: Provider['modelMeta'] } {
  const models = provider.models.filter((item) => item !== id)
  const meta: Record<string, ModelMeta> = {}
  for (const [key, value] of Object.entries(provider.modelMeta ?? {})) {
    if (key !== id) meta[key] = value
  }
  return { models, modelMeta: Object.keys(meta).length > 0 ? meta : undefined }
}

/**
 * 去提供商那里要一份模型列表。
 *
 * 所有失败都收敛成 { ok: false, reason }，界面直接把 reason 显示成红字即可；
 * 手动添加模型的入口不受影响 —— 拉不到列表不代表这个供应商不能用。
 */
export async function fetchProviderModels(
  provider: Provider,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CatalogResult> {
  if (provider.protocol === 'deepseek-web') return { ok: false, reason: WEB_REASON }
  const url = modelsEndpoint(provider)
  if (url === null) return { ok: false, reason: NO_BASE_URL_REASON }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // 默认 15 秒，文案里跟着这个数走（测试里传更短的超时也不会写出「0 秒」）。
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  // 外部取消（离开供应商页、切到别的供应商）要立刻断开，不必等到超时。
  const outer = options.signal
  const relayAbort = (): void => controller.abort()
  if (outer !== undefined) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', relayAbort, { once: true })
  }

  try {
    // 走 net.ts：列模型这一步同样会被 CORS 拦（第三方接口基本不带 ACAO），
    // 在 WebView 里直接 fetch 只会得到一句 Failed to fetch，用户根本拉不到模型目录。
    const response = await netRequest({
      url,
      method: 'GET',
      headers: catalogHeaders(provider),
      signal: controller.signal,
      timeoutMs,
    })
    if (response.status >= 400) {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: `${url} 返回 ${response.status}，请检查 API Key` }
      }
      return { ok: false, reason: `${url} 返回 ${response.status}` }
    }
    // 先看声明的长度，能省掉一次几 MB 的下载；拿不到（头没暴露）就按实际读完再量。
    const declared = Number(response.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return { ok: false, reason: TOO_BIG_REASON }
    }
    if (response.text.length > MAX_BODY_BYTES) return { ok: false, reason: TOO_BIG_REASON }
    let json: unknown
    try {
      json = JSON.parse(response.text) as unknown
    } catch {
      return { ok: false, reason: `${url} 的响应不是 JSON` }
    }
    // 形状不认识 和 列表为空 是两件事：前者多半是地址填错了，后者是真的没模型。
    if (extractEntries(json) === null) return { ok: false, reason: SHAPE_REASON }
    const models = parseCatalog(provider.protocol, json)
    if (models.length === 0) return { ok: false, reason: EMPTY_REASON }
    return { ok: true, models }
  } catch {
    if (timedOut) return { ok: false, reason: `请求超时（${seconds} 秒），请检查地址或网络` }
    if (outer?.aborted === true) return { ok: false, reason: '已取消' }
    return { ok: false, reason: `无法连接到 ${url}` }
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', relayAbort)
  }
}