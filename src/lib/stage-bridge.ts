import type { BodyDirective } from './body'
import type { ThemeId } from './types'
import type { GameState } from '../orca/app'
import type { PhotoRecord } from '../orca/photo'

/** 装饰目录条目：宿主自己画选择器用，只要 id 和名字。 */
export interface DecorKindInfo {
  id: string
  name: string
}

/** 虎鲸皮肤：宿主画色卡用。`dark` / `white` 是配色对，画渐变用。 */
export interface SkinInfo {
  id: string
  label: string
  dark: string
  white: string
}

/**
 * 宿主（React）能对 3D 水族馆做的一切。
 *
 * 分两层：
 * - **对话层**：气泡、身体动作、心情。聊天流式输出时驱动。
 * - **布置层**：投喂 / 布置 / 拍照 / 伙伴 / 外观。只在「布置」屏里用。
 *
 * 拿不到 WebGL 时 `stageBridge.current` 是 null，调用方必须先判空，
 * 不能假设它一定在。
 */
export interface StageApi {
  // ---------------------------------------------------------- 对话层
  pulse: (kind: 'send' | 'reply' | 'error' | 'think') => void
  pause: () => void
  resume: () => void
  setTheme: (theme: ThemeId) => void
  setSkin: (skin: string) => void
  /** Drive the model's 3D body from a <body .../> directive. */
  perform?: (directive: BodyDirective) => void
  /** Projected screen point above the orca's head, used by the speech bubble. */
  headPosition?: () => { x: number; y: number; scale: number } | null
  /** Make the orca react as if its body was touched. */
  poke?: () => void

  // ---------------------------------------------------------- 布置层
  /**
   * 进出「布置」屏。离开时必须把投喂模式和布置模式一起收掉，
   * 否则回到聊天页点画布还会往缸里丢食物。
   */
  setRoomMode: (on: boolean) => void
  /** 一屏状态，宿主 UI 的渲染依据。 */
  getGameState: () => GameState
  /** 订阅状态变化；返回退订函数。 */
  onChange: (listener: () => void) => () => void

  /** 投喂模式：上膛后点虎鲸 / 伙伴才会丢 token。 */
  setFeedArmed: (on: boolean) => void
  /** 体型回到原始大小（累计投喂数不清零）。 */
  resetGrowth: () => void

  /** 布置模式：点海底放置选中的装饰，右键删除。 */
  setDecorMode: (on: boolean) => void
  getDecorKinds: () => DecorKindInfo[]
  selectDecor: (kindId: string) => void
  /** 旋转待放置的装饰（手机上替代滚轮）。 */
  rotateGhost: (delta: number) => void
  /** 清空海底布置。 */
  resetDecor: () => void
  setBloomStrength: (strength: number) => void
  /** 动作速度倍率（0.4~1.8）：身体摇摆 / 尾鳍 / 胸鳍 / 体波一起变。 */
  setMotionSpeed: (scale: number) => void

  getSkins: () => SkinInfo[]

  /** 拍一张；返回存进相册的那条记录（没有 WebGL / 被取消时为 null）。 */
  takePhoto: () => Promise<PhotoRecord | null>
  getPhotos: () => PhotoRecord[]
  deletePhoto: (id: string) => void

  setCompanion: (on: boolean) => void
  setSealCompanion: (on: boolean) => void
  setJellyCompanion: (on: boolean) => void
  setOutlines: (on: boolean) => void
  toggleMusic: () => void
}

/** The mounted aquarium exposes a tiny imperative face to the chat layer. */
export const stageBridge: { current: StageApi | null } = { current: null }
