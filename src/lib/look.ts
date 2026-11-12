import type { QualityId, ThemeId } from './types'

export interface ToneOption {
  id: ThemeId
  name: string
  hint: string
}

/**
 * App 界面色调。
 *
 * 和 3D 海底主题**解绑**：同一个 id 在三套配色里挑，但两边各存各的字段
 * （`settings.appTone` / `settings.aquariumTheme`），换海底不会顺手换掉界面。
 * 没有新增配色 —— 就是原本那三套，只是现在能自由组合。
 */
export const APP_TONES: ToneOption[] = [
  { id: 'deep', name: '深海', hint: '默认的蓝黑' },
  { id: 'iceberg', name: '雾霭', hint: '冷白冰川' },
  { id: 'tropical', name: '暖阳', hint: '蜜桃珊瑚' },
]

/**
 * 3D 海底场景主题。
 *
 * 名字沿用参考实现（orca-aquarium-shell）里的标签，所以从游戏过来的人
 * 一眼认得出来；emoji 也照抄，布置屏的主题卡直接用它。
 */
export const SEA_THEMES: Array<ToneOption & { emoji: string }> = [
  { id: 'deep', name: '奶油暮海', hint: '默认的深蓝暮色', emoji: '🌊' },
  { id: 'iceberg', name: '雾霭冰山', hint: '冷白冰川', emoji: '❄️' },
  { id: 'tropical', name: '蜜桃暖阳', hint: '蜜桃珊瑚', emoji: '☀️' },
]

export const QUALITIES: Array<{ id: QualityId; name: string }> = [
  { id: 'auto', name: '自动' },
  { id: 'low', name: '省电' },
  { id: 'medium', name: '均衡' },
  { id: 'high', name: '高清' },
]
