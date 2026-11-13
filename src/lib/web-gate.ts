import { BUILTIN_MODELS, isWebChatModel, modelInfo } from './models.ts'
import { currentProvider, mirrorProviderFields } from './providers.ts'
import { defaultProviders, type Provider, type Settings } from './types.ts'

/**
 * 网页账号（`deepseek-chat-web` / `deepseek-web` 协议）的总闸。
 *
 * 它和「纸雕虎鲸」是**同一个开关**，默认关闭。关着的时候要做两件事，缺一不可：
 *   1. **不可见** —— 对话页的模型列表里不出现它，设置里也不给「添加网页账号供应商」的入口。
 *   2. **不可用** —— 不管模型是全局选的、助手覆盖的、还是历史对话快照里存的，
 *      最终请求配置都不能落在网页账号路径上。
 *
 * 第 2 条是重点。只做第 1 条会留下一个很难查的状态：界面显示 `deepseek-flash`，
 * 实际仍由 `deepseek-web` 协议处理（`isWebChatProvider` 看的是「模型是网页模型
 * **或** 供应商协议是 deepseek-web」，两者任一成立就算网页模式）。
 *
 * 为什么默认藏起来：这个模型借的是 chat.deepseek.com 的登录态，复杂网络环境下
 * 容易被对方判成异常客户端。默认不暴露，风险就从「默认路径」变成「用户主动开启」。
 *
 * 抽成纯模块是为了能写行为测试 —— store / Chat / engine 都依赖 IndexedDB 与 React。
 */
export function webChatModelVisible(settings: Settings): boolean {
  return settings.webPet === true
}

export interface WebGateChange {
  /** 收敛之后的设置；不需要改动时就是原对象。 */
  settings: Settings
  /** 因为闸门被切走的供应商 id（原来是网页账号供应商）。 */
  switchedProviderId: string | null
  /** 因为闸门被切走的模型 id（原来是网页模型）。 */
  switchedModel: string | null
}

function isWebProvider(provider: Provider): boolean {
  return provider.protocol === 'deepseek-web'
}

/**
 * 挑一个「真实的 API 供应商」。
 *
 * 优先有 Key 的（切过去就能用），其次任意非网页供应商；一个都没有时把内置的官方
 * 供应商补进列表 —— 不删用户数据，重新打开闸门后原来那个网页账号供应商还在。
 */
function pickApiProvider(settings: Settings): { provider: Provider; providers: Provider[] } {
  const apiProviders = settings.providers.filter((item) => !isWebProvider(item))
  const chosen = apiProviders.find((item) => item.apiKey.trim() !== '') ?? apiProviders[0]
  if (chosen !== undefined) return { provider: chosen, providers: settings.providers }
  const fallback = defaultProviders()[0] as Provider
  const already = settings.providers.some((item) => item.id === fallback.id)
  return {
    provider: fallback,
    providers: already ? settings.providers : [...settings.providers, fallback],
  }
}

/**
 * 在当前供应商下挑一个能用的模型。
 *
 * 注意「不能误伤自定义模型名」：供应商的模型列表为空表示用户想填什么就填什么，
 * 这时候原样保留，绝不擅自改成列表第一个。
 */
function pickApiModel(provider: Provider, current: string): string {
  const apiModels = provider.models.filter((id) => !isWebChatModel(id))
  if (!isWebChatModel(current)) {
    if (provider.models.length === 0 || provider.models.includes(current)) return current
    return apiModels[0] ?? current
  }
  return apiModels[0] ?? BUILTIN_MODELS[0]?.id ?? current
}

/**
 * 把设置收敛到「闸门关着时不可能走网页账号」的状态。
 *
 * 幂等：对已经收敛过的设置再跑一遍不会有任何变化。
 */
export function applyWebGate(settings: Settings): WebGateChange {
  if (webChatModelVisible(settings)) {
    return { settings, switchedProviderId: null, switchedModel: null }
  }

  let next = settings
  let switchedProviderId: string | null = null

  // 第一步：退出网页账号供应商（协议层面的闸）。只换模型不换供应商是不够的。
  const provider = currentProvider(next)
  if (isWebProvider(provider)) {
    const picked = pickApiProvider(next)
    next = { ...next, providers: picked.providers, providerId: picked.provider.id }
    switchedProviderId = provider.id
  }

  // 第二步：换掉网页模型（模型层面的闸）。两步都做完，两条判定线才都不成立。
  const active = currentProvider(next)
  const model = pickApiModel(active, next.model)
  const switchedModel = model === next.model ? null : next.model
  next = { ...next, model }

  // 真的换了供应商才镜像 Key / 地址 —— 无条件镜像会把 onboarding 刚写进
  // settings.apiKey 的那把 Key 冲成空串（hasApiKey 两处都读）。
  if (switchedProviderId !== null) next = mirrorProviderFields(next)

  return { settings: next, switchedProviderId, switchedModel }
}

/** 收敛发生了才返回提示语；说清楚发生了什么，以及怎么恢复。 */
export function webGateNotice(change: WebGateChange): string | null {
  if (change.switchedProviderId === null && change.switchedModel === null) return null
  const parts: string[] = []
  if (change.switchedProviderId !== null) {
    parts.push(`已退出网页账号供应商，切到「${currentProvider(change.settings).name}」`)
  }
  if (change.switchedModel !== null) {
    parts.push(`模型已切回「${modelInfo(change.settings.model).id}」`)
  }
  return `网页账号已关闭：${parts.join('，')}。想继续用网页账号，请在助手页打开「纸雕虎鲸」。`
}
