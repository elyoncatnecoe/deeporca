import { detectVisionByName, visionOf } from './capability.ts'

/** 内置模型的一处定义：设置页的下拉、聊天页的快速切换都读这里。 */
export type ModelInfo = {
  id: string
  hint: string
  tags: string[]
  vision?: boolean
}

export const BUILTIN_MODELS: ModelInfo[] = [
  { id: 'deepseek-flash', hint: '快，能看图', tags: ['看图'], vision: true },
  // README「已知限制」那条（:163）一直对外承诺 v4-pro 支持看图，而内置表在判定链里
  // 是**赢过乐观默认**的一层 —— 标漏了就等于把我们自己的旗舰模型判成瞎子。
  // 有单测锁住这条（test/model-vision.test.ts）。
  { id: 'deepseek-v4-pro', hint: '最强，适合难题', tags: ['旗舰', '看图'], vision: true },
  { id: 'deepseek-chat', hint: '旧版对话', tags: ['旧版'] },
  { id: 'deepseek-reasoner', hint: '旧版推理', tags: ['推理'] },
]

/** 网页账号模式：用 chat.deepseek.com 的登录态，不花 Key 的钱。 */
export const WEB_CHAT_MODEL_INFO: ModelInfo = {
  id: 'deepseek-chat-web',
  hint: '网页账号，免 Key，支持图片附件',
  tags: ['网页'],
}

export const MODEL_IDS = BUILTIN_MODELS.map((model) => model.id)

/** 网页账号模式下唯一可选的模型 id。 */
export const WEB_CHAT_MODEL = WEB_CHAT_MODEL_INFO.id

export function modelInfo(id: string): ModelInfo {
  if (id === WEB_CHAT_MODEL) return WEB_CHAT_MODEL_INFO
  return BUILTIN_MODELS.find((model) => model.id === id) ?? {
    id,
    hint: '自定义模型名',
    tags: ['自定义'],
    // 判据挪进 capability.ts：那里还有一份乐观默认，而这里**只能**按名字猜 ——
    // 它拿不到供应商，看不到手动覆写，所以只可能给个家族级的猜测。
    // 设置页的徽章读的就是这个字段，于是它和聊天页的闸门共用同一条规则。
    vision: detectVisionByName(id),
  }
}

export function modelLabel(id: string): string {
  const info = modelInfo(id)
  return info.id + ' · ' + info.hint
}

/**
 * @deprecated 请用 capability.ts 的 `visionOf(provider, id)`。
 *
 * 这个壳只为兼容旧调用点保留：它只有一个裸 id，**结构上就看不到**供应商的
 * `modelMeta` 手动覆写，也看不到「这个供应商是网页账号」——2026-11-03 那次
 * 「第三方模型看不见图」正是它当闸门造成的。新代码一律带 provider 判定。
 */
export function modelSeesImages(id: string): boolean {
  // 走同一个 visionOf：没有 provider 上下文时它的行为是「内置表 + 名字 + 乐观」，
  // 与闸门同源，不会再出现「这里说不行、那里说行」。
  return visionOf(undefined, id).sees
}

/** 这个模型是不是「网页账号」——它不支持工具调用；图片附件需登录态上传。 */
export function isWebChatModel(id: string): boolean {
  return id === WEB_CHAT_MODEL
}

/**
 * 模型名的「能不能用」级校验。
 *
 * 刻意**不**限制字符集：各家的模型 id 长什么样都有——`claude-3-5-sonnet-20241022`、
 * `gpt-4.1`（带点）、`deepseek-ai/DeepSeek-V3`（带斜杠）、`models/gemini-1.5-pro`
 * （带斜杠和点）。用 `^[-_\w]+$` 这类正则会把它们全判成非法，等于把「自定义模型」
 * 这个功能废掉。这里只拦真正发不出去的东西：空串、含空白、超长。
 */
export function checkModelId(raw: string): { ok: boolean; model: string; reason?: string } {
  const model = raw.trim()
  if (model === '') return { ok: false, model, reason: '模型名不能为空' }
  if (/\s/.test(model)) return { ok: false, model, reason: '模型名里不能有空格' }
  if (model.length > 128) return { ok: false, model, reason: '模型名太长了（最多 128 个字符）' }
  return { ok: true, model }
}

/**
 * 模型名是否落在当前供应商声明的模型列表里。
 *
 * 列表为空表示「这个供应商不限制」（沿用内置表），一律算通过。
 * 只用于界面提示，不做任何自动改写——改写就是「自定义模型名存不住」的元凶。
 */
export function modelInProviderList(providerModels: readonly string[], model: string): boolean {
  if (providerModels.length === 0) return true
  return providerModels.includes(model)
}