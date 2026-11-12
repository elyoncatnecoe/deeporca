import type { Provider, ProviderProtocol, Settings } from './types'
import { DEFAULT_PROVIDER_ID, DEFAULT_SETTINGS, defaultProviders } from './types.ts'
import { isWebChatModel } from './models.ts'

/** 当前生效的供应商；找不到就退回第一个（永远存在）。 */
export function currentProvider(settings: Settings): Provider {
  const list = settings.providers ?? []
  const hit = list.find((item) => item.id === settings.providerId)
  if (hit !== undefined) return hit
  return list[0] ?? (defaultProviders()[0] as Provider)
}

/** 这次请求实际用哪个协议。 */
export function currentProtocol(settings: Settings): ProviderProtocol {
  return currentProvider(settings).protocol
}

/**
 * 这个供应商到底支持哪些模型。供应商自己配了就用它自己的，否则回落到内置列表。
 * 这样接中转站时不用手写几十个模型名也能用。
 */
export function providerModels(settings: Settings): string[] {
  const provider = currentProvider(settings)
  if (provider.models.length > 0) return provider.models
  return []
}

/** 模型在这个供应商下是否可用（用于切换供应商后校验模型）。 */
export function modelAvailable(settings: Settings, model: string): boolean {
  const models = providerModels(settings)
  if (models.length === 0) return true
  return models.includes(model)
}

/**
 * 当前是不是「网页账号」模式。
 *
 * 判定以**模型**为准，而不是供应商协议：用户在聊天页右下角选的就是模型，
 * 不能要求他再去供应商页把协议也改成网页账号——那一步没人会想到去做。
 * 供应商协议只是「建供应商时的默认值」，真正决定走哪条路的是 model。
 */
export function isWebChatProvider(settings: Settings): boolean {
  return isWebChatModel(settings.model) || currentProvider(settings).protocol === 'deepseek-web'
}

/**
 * 有没有可用的 key。供应商或 settings 任意一处有就算 ——
 * onboarding／测试连接这类路径只写了 settings.apiKey。
 *
 * 网页账号模式不需要 Key：登录态在网页窗的 Cookie 里。
 */
export function hasApiKey(settings: Settings): boolean {
  if (isWebChatProvider(settings)) return true
  const provider = currentProvider(settings)
  return provider.apiKey.trim() !== '' || settings.apiKey.trim() !== ''
}

export const PROTOCOLS: { id: ProviderProtocol; name: string; hint: string }[] = [
  { id: 'openai', name: 'OpenAI 兼容', hint: '绝大多数中转站与国产模型都用这个' },
  { id: 'anthropic', name: 'Anthropic', hint: 'Claude 官方接口' },
  { id: 'google', name: 'Google', hint: 'Gemini 官方接口' },
  { id: 'deepseek-web', name: '网页账号', hint: '用 chat.deepseek.com 的登录态，不填 Key' },
]

export const PROTOCOL_LABEL: Record<ProviderProtocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  google: 'Google',
  'deepseek-web': '网页账号',
}

/** 按协议拼出对话补全的完整 URL。 */
export function chatEndpoint(provider: Provider): string {
  // 网页账号模式不发 HTTP，这里只用于界面展示。
  if (provider.protocol === 'deepseek-web') return provider.baseUrl || 'https://chat.deepseek.com'
  const base = provider.baseUrl.replace(/\/+$/, '')
  switch (provider.protocol) {
    case 'anthropic':
      return `${base}/v1/messages`
    case 'google':
      // Gemini 的模型名在路径里，由调用方补齐；这里只给前缀。
      return `${base}/v1beta/models`
    default:
      // OpenAI 兼容：允许用户把完整路径写进 baseUrl（有些中转站要求带 /v1）。
      return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  }
}

/** 按协议给出鉴权头。 */
export function chatHeaders(provider: Provider): Record<string, string> {
  const key = provider.apiKey.trim()
  const base: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.protocol === 'anthropic') {
    base['x-api-key'] = key
    base['anthropic-version'] = '2023-06-01'
    // 允许浏览器直连（Electron 里不是必须，但 web 端需要）。
    base['anthropic-dangerous-direct-browser-access'] = 'true'
  } else if (provider.protocol === 'google') {
    base['x-goog-api-key'] = key
  } else {
    base.Authorization = `Bearer ${key}`
  }
  // 用户自定义头最后覆盖，方便接奇怪的中转站。
  return { ...base, ...provider.headers }
}

/**
 * 按 id 只合并指定供应商的字段，其余字段原样保留。
 *
 * 界面层以前是「用组件里那份 providers 快照重建整个数组」，于是只要某个字段
 * （比如刚敲进去的 API Key）只写进了快照的顶层、没写进快照里的 provider，
 * 下一次改另一个字段（比如 API 地址）就会把整个 provider 覆盖回旧值 ——
 * 表现就是「填完 Key 再改一下地址，Key 没了」。改字段一律走这里按 id 合并。
 */
export function patchProvider(
  list: readonly Provider[],
  id: string,
  patch: Partial<Provider>,
): Provider[] {
  return list.map((item) => (item.id === id ? { ...item, ...patch } : item))
}

/** 迁移旧数据：把 apiKey/baseUrl/model 变成一个内置供应商。 */
export function migrateLegacyProvider(settings: Settings): { providers: Provider[]; providerId: string } {
  const existing = settings.providers ?? []
  if (existing.length > 0) {
    const id = existing.some((item) => item.id === settings.providerId)
      ? settings.providerId
      : (existing[0] as Provider).id
    return { providers: existing, providerId: id }
  }
  const base = defaultProviders()[0] as Provider
  return {
    providers: [{ ...base, baseUrl: settings.baseUrl || base.baseUrl, apiKey: settings.apiKey }],
    providerId: DEFAULT_PROVIDER_ID,
  }
}

/**
 * 把「当前供应商」的 key 与 baseUrl 同步回 settings.apiKey / settings.baseUrl。
 *
 * 全应用很多地方直接读这两个字段（key 校验、错误提示、界面显示）。
 * 与其把它们全改成读供应商，不如让它们始终等于当前供应商的值：
 * 语义一致（settings 上的就是「现在生效的」），改动面最小。
 *
 * **这里绝不碰 model**：见 syncProviderToSettings 的注释。
 */
export function mirrorProviderFields(settings: Settings): Settings {
  const provider = currentProvider(settings)
  return { ...settings, apiKey: provider.apiKey, baseUrl: provider.baseUrl }
}

/**
 * 切换供应商后的收敛：镜像 key/地址，并按新供应商的模型列表回落模型。
 *
 * **只在「真的换了供应商」时调用**（providerId 变化、或新建/删除供应商）。
 *
 * 以前这个函数被当成「每次设置变动都跑一遍」的通用同步，于是只要 patch 里带了
 * providers（改 Key、改地址、改模型列表都会带），就会走进下面这段「不在列表就
 * 回落」——用户手填的自定义模型名（claude-3-5-sonnet-20241022、gpt-4.1、
 * deepseek-ai/DeepSeek-V3……）本来就不在任何供应商的 models 列表里，于是：
 *   · 敲 API Key，每敲一个字符模型被改回列表第一个；
 *   · 改 API 地址，模型又被改回去；
 *   · 每次启动 loadSettings 再改一次。
 * 用户看到的就是「自定义模型名根本存不住，还会被别的设置项冲掉」。
 *
 * 现在拆分：改 Key/地址走 mirrorProviderFields（不动 model），只有真的换供应商
 * 才走这里做回落——回落本身是有用的（避免对着新供应商请求一个不存在的模型 404）。
 */
export function syncProviderToSettings(settings: Settings): Settings {
  const provider = currentProvider(settings)
  const fallbackModel = provider.models[0]
  const keepModel = provider.models.length === 0 || provider.models.includes(settings.model)
  return {
    ...mirrorProviderFields(settings),
    // 供应商不支持当前模型时回落到它的第一个模型，避免请求 404。
    model: keepModel || fallbackModel === undefined ? settings.model : fallbackModel,
  }
}

/**
 * 启动时（loadSettings）的收敛：只镜像 key/地址，模型仅在**为空**时回落。
 *
 * 启动不是「切换供应商」，用户上次存下的模型（哪怕是自己手填的名字）必须原样
 * 带回来；只有历史数据里模型字段真的是空串时才需要补一个能用的值。
 */
export function settleProviderOnBoot(settings: Settings): Settings {
  const provider = currentProvider(settings)
  const mirrored = mirrorProviderFields(settings)
  if (settings.model.trim() !== '') return mirrored
  const fallback = provider.models[0] ?? DEFAULT_SETTINGS.model
  return { ...mirrored, model: fallback }
}