/**
 * 「这个模型能不能看图」的唯一判定处。
 *
 * 和 model-catalog.ts 一样的理由单独成模块：这一层不碰 React、不碰 IndexedDB、
 * 不碰 DOM，在 node 里直接跑得起来，于是「闸门为什么把 gpt-4o 判成瞎子」这种
 * 事能进单测。2026-11-03 那个「第三方模型看不见图」的 bug 就是这么漏过去的 ——
 * 旧实现是 BUILTIN_MODELS + 一条 /vision|vl/i，真实的多模态模型名一个都不认，
 * 而界面（模型弹层）读的却是另一份数据，两边各说各话。
 *
 * 两条纪律，改这里之前先读完：
 * 1. 名字启发式**只负责多认一个，绝不负责否决**。认错的代价是「发过去被网关
 *    拒绝」，响亮且可归因；否决的代价是「图片被客户端静默丢掉」，用户看不见、
 *    日志里也没有 —— 那正是这次 bug 的形态。
 * 2. 完全没有依据时乐观当作会看图（网页账号除外）：把判断交给提供商去答。
 */

import { BUILTIN_MODELS, WEB_CHAT_MODEL } from './models.ts'
import type { Provider } from './types.ts'

/** 判定只需要这两项；写成 Pick 是为了测试里能造一个轻量的 provider。 */
export type VisionProvider = Pick<Provider, 'protocol' | 'modelMeta'>

/** 结论从哪一层来 ——「我确认」和「我猜」在界面上不是一回事，文案要跟着变。 */
export type VisionSource = 'override' | 'builtin' | 'name' | 'optimistic'

export type VisionVerdict = { sees: boolean; source: VisionSource }

/**
 * 模型名里的视觉线索，按**家族**列。每条都写清依据，不追求穷尽：
 * 漏掉一个名字只是少一枚徽章，闸门照样会乐观地发出去（见文件头纪律 2）。
 */
const VISION_NAME_HINTS: readonly RegExp[] = [
  /vision/i,                        // moonshot-v1-vision-8k、gpt-4-vision-preview
  /vl/i,                            // 各家「视觉」的缩写都是这两个字母：qwen3-vl、cogvlm、internvl
  /multimodal|multi-modal|omni/i,   // 名字里直接写明多模态 / omni
  /gpt-4/i,                         // OpenAI 4 这一代全收图（只有最早那条纯文本 gpt-4 例外，而多认无害）
  /(?:^|[-_./])4o(?:[-_./]|$)/i,    // gpt-4o、gpt-4o-mini
  /claude/i,                        // Claude 从 3 起全系收图
  /gemini/i,                        // Gemini 1.5 起全系收图
  /\d+v(?:[-_./]|$)/i,              // glm-4v-plus、glm-4.1v 这类「数字 + V」结尾
  /(?:^|[-_./])v(?:[-_./]|$)/i,     // MiniCPM-V 这种单独占一段的「V」
  /kimi/i,                          // Kimi 这一代默认带图
  /doubao/i,                        // 豆包（字节）多模态线
]

/**
 * 只看名字猜。纯字符串函数，models.ts 的徽章和这里的判定共用它 ——
 * 一份规则，两处显示，不会再出现「弹层说看图、附件说不能看图」。
 */
export function detectVisionByName(id: string): boolean {
  if (id === '') return false
  for (const hint of VISION_NAME_HINTS) {
    if (hint.test(id)) return true
  }
  return false
}

/**
 * 某个供应商下的某个模型能否接收图片。
 *
 * 优先级（先定的先赢）：手动覆写 -> 内置表 -> 加宽的名字启发式 -> 乐观默认。
 * 网页账号那条要放在最前面：它根本不走 HTTP，「发不出去」是事实而不是猜测，
 * 所以连手动覆写都不能把它翻成「会看图」。
 */
export function visionOf(provider: VisionProvider | null | undefined, modelId: string): VisionVerdict {
  if (modelId === WEB_CHAT_MODEL || provider?.protocol === 'deepseek-web') {
    return { sees: false, source: 'builtin' }
  }
  // 手动覆写是三态的：false 也是用户说的话，必须能赢过内置表和启发式。
  const override = provider?.modelMeta?.[modelId]?.vision
  if (typeof override === 'boolean') return { sees: override, source: 'override' }
  const builtin = BUILTIN_MODELS.find((model) => model.id === modelId)
  if (builtin !== undefined) return { sees: builtin.vision === true, source: 'builtin' }
  if (detectVisionByName(modelId)) return { sees: true, source: 'name' }
  return { sees: true, source: 'optimistic' }
}

/** 只要结论的简写；需要知道依据时用 visionOf。 */
export function seesImages(provider: VisionProvider | null | undefined, modelId: string): boolean {
  return visionOf(provider, modelId).sees
}

/** 判定依据的人话。聊天页的提示和模型目录那一行共用，措辞不会分叉。 */
export function visionSourceLabel(source: VisionSource): string {
  if (source === 'override') return '手动设置'
  if (source === 'builtin') return '内置表'
  if (source === 'name') return '模型名'
  return '未确认'
}
