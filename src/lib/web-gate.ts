import { BUILTIN_MODELS, isWebChatModel, modelInfo } from './models.ts'
import { currentProvider } from './providers.ts'
import type { Settings } from './types.ts'

/**
 * 网页账号模型（`deepseek-chat-web`，走 chat.deepseek.com 的登录态）的可见性闸门。
 *
 * 它和「纸雕虎鲸」是**同一个开关**，默认关闭：
 *   - 关着：前端对话的模型列表里不出现这个选项，设置里也不给「添加网页账号供应商」的入口；
 *     网页窗里也不注入纸雕。
 *   - 打开：模型选项、网页账号功能、纸雕，一次性全回来，和以前完全一样。
 *
 * 为什么默认藏起来：这个模型借用的是 chat.deepseek.com 的登录态，复杂网络环境下
 * 容易被对方判成异常客户端。默认不暴露，风险就从「默认路径」变成「用户主动开启」。
 *
 * 单独抽成模块是为了能写行为测试 —— store / Chat 都依赖 IndexedDB 与 React，
 * node 里跑不起来，而这条判断本身是纯的。
 */
export function webChatModelVisible(settings: Settings): boolean {
  return settings.webPet === true
}

/**
 * 开关关着、但当前模型还停在网页模型上时，应该切去的模型；不需要切时返回 `null`。
 *
 * 不处理这个的话会留下一个很别扭的状态：模型选项被藏了，`settings.model` 却还指着它，
 * 用户看不见自己在用什么，而且仍然在走网页账号那条路。
 *
 * 优先级：当前供应商自己的第一个非网页模型（它才真的发得出去）→ 内置默认模型。
 * 后者只在供应商列表里只剩网页模型（就是那个「网页账号」供应商）时才会用到。
 */
export function webChatFallbackModel(settings: Settings): string | null {
  if (webChatModelVisible(settings)) return null
  if (!isWebChatModel(settings.model)) return null
  const provider = currentProvider(settings)
  const own = provider.models.find((id) => !isWebChatModel(id))
  if (own !== undefined) return own
  return BUILTIN_MODELS[0]?.id ?? null
}

/** 自动切回模型时的常驻提示：说清楚发生了什么，以及怎么恢复。 */
export function webChatFallbackNotice(model: string): string {
  return `网页账号已关闭，模型已切回「${modelInfo(model).id}」。想继续用网页账号，请在助手页打开「纸雕虎鲸」。`
}
