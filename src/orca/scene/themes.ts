export type ThemeId = 'iceberg' | 'tropical' | 'deep'

/**
 * The water column gradient, as [t, hex] stops. t = 0 is the surface (top of
 * the screen), t = 1 the abyss floor. Drawn as a full-screen gradient behind
 * the whole scene.
 */
export type ColumnStops = ReadonlyArray<readonly [number, number]>

export interface AquariumTheme {
  id: ThemeId
  label: string
  emoji: string
  /** Clear-colour fallback; the full-screen column normally covers it. */
  background: number
  fogColor: number
  fogDensity: number
  /** The vertical gradient. Exactly 8 stops. */
  column: ColumnStops
  /** Surface glint colour — the bright pool where the god rays converge. */
  sunColor: number
  sunGlow: number
  /** Seafloor fill. */
  sandColor: number
  /** Near dunes / boulder clusters. */
  hillColor: number
  /** Far silhouettes melting into the fog. */
  skylineColor: number
  /** God-ray shafts. */
  shaftColor: number
  shaftIntensity: number
  causticColor: number
  causticIntensity: number
  /** Caustic pattern units per world unit. Higher = tighter pools. */
  causticScale: number
  /** Radius of the caustic light pool on the sand, in world units. */
  causticRadius: number
  /** Hemisphere fill on the seabed — how much light arrives from everywhere. */
  ambient: number
  /** Strength of the overhead key light on the seabed. */
  diffuse: number
  /** Depth of the baked curvature occlusion in the sand's creases, 0..1. */
  aoStrength: number
  /** Sand-ripple amplitude on the shading normal. */
  rippleStrength: number
  /** Water surface seen from below: the sky through Snell's window. */
  surfaceTransmit: number
  /** Water surface seen from below: total internal reflection at grazing angles. */
  surfaceReflect: number
  /** How much of the ceiling actually shows, 0..1. */
  surfaceAlpha: number
  bubbleColor: number
  bubbleOpacity: number
  /** Marine snow: fine dust + a sparser glow tier. */
  planktonColor1: number
  planktonColor2: number
  /** Reef corals. */
  coralHues: number[]
  /** Tube sponges — the warm accent of the reef. */
  spongeHues: number[]
  /** Seaweed blades. */
  kelpHues: number[]
  starfishColor: number
  /** Schooling fish body colors. */
  fishHues: number[]
}

/*
 * 三套主题回到初版的三种氛围（用户指定的基准），用现在的渲染质量表达：
 *  - iceberg 雾霭冰山：灰蓝雾雪世界。水柱上深下浅（雾往地平线泛白），雪白
 *    海床、冰白岩丘与海草、暖木色点缀。整个画面是亮的。
 *  - tropical 蜜桃暖阳：晴日青绿泻湖。浓青水柱向下变浅，青绿海床、蜜桃色
 *    丘陵与粉珊瑚、草绿海草。
 *  - deep 奶油暮海：深夜。暗青 navy 水柱，深青海床配亮焦散池，淡蓝发光
 *    海草与鱼群。
 * 与初版的差别只在渲染手段：水柱全屏渐变 + 软光柱 + 双层焦散波光 + 辉光。
 */

const ICEBERG_COLUMN: ColumnStops = [
  [0.0, 0x42667c],
  [0.15, 0x4e748a],
  [0.3, 0x5c8498],
  [0.45, 0x6a94a6],
  [0.6, 0x78a2b2],
  [0.75, 0x86aebc],
  [0.88, 0x92b8c4],
  [1.0, 0x9ec2cc],
]

const TROPICAL_COLUMN: ColumnStops = [
  [0.0, 0x14607a],
  [0.15, 0x18708c],
  [0.3, 0x1e809c],
  [0.45, 0x2790aa],
  [0.6, 0x31a0b6],
  [0.75, 0x3cb0c2],
  [0.88, 0x48beca],
  [1.0, 0x54c8d0],
]

const DEEP_COLUMN: ColumnStops = [
  [0.0, 0x081e30],
  [0.15, 0x0a283c],
  [0.3, 0x0d3248],
  [0.45, 0x113c54],
  [0.6, 0x154660],
  [0.75, 0x19506c],
  [0.88, 0x1d5a78],
  [1.0, 0x216484],
]

export const THEMES: Record<ThemeId, AquariumTheme> = {
  iceberg: {
    id: 'iceberg',
    label: '雾霭冰山',
    emoji: '❄️',
    background: 0x6e9aac,
    fogColor: 0x6e98aa,
    fogDensity: 0.009,
    column: ICEBERG_COLUMN,
    sunColor: 0xeaf8fc,
    sunGlow: 0.3,
    sandColor: 0xa4bcc6,
    hillColor: 0xe8f0f4,
    skylineColor: 0xd8e6ec,
    shaftColor: 0xd8ecf4,
    shaftIntensity: 0.15,
    causticColor: 0xdceef4,
    causticIntensity: 0.34,
    // Overcast ice light: almost all fill, barely any direction. The snow
    // floor is near-white, so the caustic pool has very little headroom left
    // and lands as a faint shimmer rather than a spotlight.
    causticScale: 0.21,
    causticRadius: 32,
    // ambient + diffuse * 0.93 ~= 1.0: flat ground keeps the exact brightness
    // it had before there was a light at all, and only the slopes change.
    ambient: 0.72,
    diffuse: 0.32,
    aoStrength: 0.45,
    rippleStrength: 0.09,
    surfaceTransmit: 0xd6ecf4,
    surfaceReflect: 0x6d97a8,
    surfaceAlpha: 0.22,
    bubbleColor: 0xeef6f8,
    bubbleOpacity: 0.5,
    planktonColor1: 0xf4f0e6,
    planktonColor2: 0xa8d8e8,
    coralHues: [0xc2d4e0, 0xb8ccd8, 0xaec4d4, 0xc8d8e2, 0xb4c8d4, 0xc0d2dc],
    spongeHues: [0xe8d8c8, 0xd8c8b4, 0xd0dce4],
    kelpHues: [0xc4d4dc, 0xb4c8d2, 0xcfdde2],
    starfishColor: 0xf0c8a0,
    fishHues: [0xe8b0a0, 0xa8c8e0, 0xd8c0a0],
  },
  tropical: {
    id: 'tropical',
    label: '蜜桃暖阳',
    emoji: '☀️',
    background: 0x1e809c,
    fogColor: 0x1e809c,
    fogDensity: 0.009,
    column: TROPICAL_COLUMN,
    sunColor: 0xfff2b0,
    sunGlow: 0.35,
    sandColor: 0x7cc8c2,
    hillColor: 0xe8d8b8,
    skylineColor: 0xd4c8a8,
    shaftColor: 0xfff2c8,
    shaftIntensity: 0.17,
    causticColor: 0xe6f4ee,
    causticIntensity: 0.4,
    // A real tropical noon: the strongest directionality of the three, because
    // the water is clear and the sun is high.
    causticScale: 0.21,
    causticRadius: 34,
    ambient: 0.62,
    diffuse: 0.42,
    aoStrength: 0.55,
    rippleStrength: 0.11,
    surfaceTransmit: 0xdff6f4,
    surfaceReflect: 0x1e7f9c,
    surfaceAlpha: 0.3,
    bubbleColor: 0xfbf6e8,
    bubbleOpacity: 0.55,
    planktonColor1: 0xf8ecd4,
    planktonColor2: 0xf0c8a8,
    coralHues: [0xf4a8b8, 0xf0c8a8, 0xdc7759, 0xf4d8b0, 0xe8b8c8, 0xf0a8b0],
    spongeHues: [0xdc7759, 0xe89a80, 0xf0c8a8],
    kelpHues: [0x82b87e, 0x92c488, 0x74a872],
    starfishColor: 0xf0b090,
    fishHues: [0xf0a090, 0xf0c090, 0x90c0a8],
  },
  deep: {
    id: 'deep',
    label: '奶油暮海',
    emoji: '🌊',
    background: 0x113c54,
    fogColor: 0x0e3248,
    fogDensity: 0.011,
    column: DEEP_COLUMN,
    sunColor: 0xa5e6f5,
    sunGlow: 0.35,
    sandColor: 0x2c5870,
    hillColor: 0x48708a,
    skylineColor: 0x3a5c74,
    shaftColor: 0xa5d8ec,
    shaftIntensity: 0.17,
    causticColor: 0xa8d4dc,
    causticIntensity: 0.7,
    // Night: the least fill and the most direction, so the dark sand keeps its
    // shadow side and the caustic pools are the only real light down there.
    causticScale: 0.21,
    causticRadius: 30,
    ambient: 0.44,
    diffuse: 0.6,
    aoStrength: 0.75,
    rippleStrength: 0.1,
    surfaceTransmit: 0x5f9cb8,
    surfaceReflect: 0x0a2436,
    surfaceAlpha: 0.22,
    bubbleColor: 0xcfe4e8,
    bubbleOpacity: 0.5,
    planktonColor1: 0xbcd4de,
    planktonColor2: 0x9ab8cc,
    coralHues: [0x8fb4d4, 0xaac8e0, 0x7fa3c0, 0xc0d8ea, 0x94b8d0, 0xb8d0e4],
    spongeHues: [0x6f95b8, 0x8aa7c4, 0x5d7fa0],
    kelpHues: [0xa8ccd4, 0x98c0ca, 0xb8d8dc],
    starfishColor: 0xf0b898,
    fishHues: [0xbcd8e8, 0xd8b8a8, 0xa8c8d0],
  },
}

export function getTheme(id: ThemeId): AquariumTheme {
  return THEMES[id]
}

/**
 * Per-theme population counts that the scene modules scale by the device tier.
 * These are deliberately not part of `AquariumTheme`: they are a quality
 * concern rather than a palette one, so changing a device tier never has to
 * touch anything a theme author cares about.
 */
export interface ThemeCounts {
  fish: number
  plankton: number
}

const THEME_COUNTS: Record<ThemeId, ThemeCounts> = {
  iceberg: { fish: 90, plankton: 950 },
  tropical: { fish: 100, plankton: 1000 },
  deep: { fish: 105, plankton: 1050 },
}

export function getThemeCounts(id: ThemeId): ThemeCounts {
  return THEME_COUNTS[id]
}
