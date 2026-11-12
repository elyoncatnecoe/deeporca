/*
 * Device capability tiering for the standalone game.
 *
 * Phones are far weaker than desktops and this scene is draw-call heavy, so
 * every scene builder scales its counts by a single resolved tier. The tier is
 * resolved once at boot, before the renderer exists, so the renderer and the
 * post chain can be configured to match from their very first frame.
 *
 * Override for debugging / screenshots: ?quality=low|medium|high
 */

export type QualityTier = 'low' | 'medium' | 'high'

export interface QualitySettings {
  tier: QualityTier
  /** devicePixelRatio cap — the single biggest fill-rate lever on phones. */
  maxPixelRatio: number
  /** UnrealBloomPass is the most expensive pass; low tier drops it entirely. */
  bloom: boolean
  /** A full-screen grade pass still costs a read + write of every pixel. */
  colorGrade: boolean
  /** Ceilings for photo capture, so a tall/retina screen cannot force a huge readback. */
  captureMaxWidth: number
  captureMaxHeight: number
  /** Global scalers applied on top of the per-theme counts in themes.ts. */
  plankton: number
  fish: number
  bubble: number
  kelp: number
  coral: number
  starfish: number
  rock: number
  /** Sand hills, ruin pillars, chests and skyline silhouettes. */
  prop: number
  skyline: number
  /** Frame interval used while the page is in the background. */
  idleFrameIntervalMs: number
}

const TIERS: Record<QualityTier, Omit<QualitySettings, 'tier'>> = {
  low: {
    // Mobile WebView budget: the low tier renders at 1x, everything else is
    // capped at 1.5x. At 2x a 900x640 window already needs 2.3M pixels, which
    // is over the drawing-buffer budget, so 2 is never used.
    maxPixelRatio: 1,
    bloom: false,
    colorGrade: true,
    captureMaxWidth: 1280,
    captureMaxHeight: 1600,
    plankton: 0.35,
    fish: 0.45,
    bubble: 0.4,
    kelp: 0.35,
    coral: 0.45,
    starfish: 0.4,
    rock: 0.5,
    prop: 0.45,
    skyline: 0.4,
    idleFrameIntervalMs: 1000,
  },
  medium: {
    maxPixelRatio: 1.5,
    bloom: true,
    colorGrade: true,
    captureMaxWidth: 1600,
    captureMaxHeight: 1600,
    plankton: 0.7,
    fish: 0.75,
    bubble: 0.75,
    kelp: 0.7,
    coral: 0.8,
    starfish: 0.7,
    rock: 0.8,
    prop: 0.75,
    skyline: 0.7,
    idleFrameIntervalMs: 500,
  },
  high: {
    maxPixelRatio: 1.5,
    bloom: true,
    colorGrade: true,
    captureMaxWidth: 1920,
    captureMaxHeight: 1600,
    plankton: 1,
    fish: 1,
    bubble: 1,
    kelp: 1,
    coral: 1,
    starfish: 1,
    rock: 1,
    prop: 1,
    skyline: 1,
    idleFrameIntervalMs: 250,
  },
}

/** Scale a base count by the tier, never dropping below `floor`. */
export function scaledCount(base: number, scale: number, floor = 0): number {
  return Math.max(floor, Math.round(base * scale))
}

interface NavigatorWithMemory extends Navigator {
  deviceMemory?: number
}

function readRendererString(): string {
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : gl.getParameter(gl.RENDERER)
    // Free the throwaway context immediately; browsers cap live GL contexts.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return typeof name === 'string' ? name.toLowerCase() : ''
  } catch {
    return ''
  }
}

function detectTier(): QualityTier {
  if (typeof window === 'undefined') return 'high'

  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const navigatorWithMemory = navigator as NavigatorWithMemory
  const cores = navigatorWithMemory.hardwareConcurrency || 4
  const memory = navigatorWithMemory.deviceMemory ?? 4
  const renderer = readRendererString()

  // Software rasterizers and known weak mobile GPUs: always low.
  if (/swiftshader|llvmpipe|software|basic render/.test(renderer)) return 'low'
  if (/mali-4|mali-t[0-6]|adreno \(tm\) [1-4]\d\d|powervr sgx/.test(renderer)) return 'low'

  if (coarsePointer) {
    // Phones and tablets. Only recent flagships get the medium tier.
    if (cores >= 6 && memory >= 4) return 'medium'
    return 'low'
  }

  // Desktop: anything with a real GPU and a few cores is fine at full quality.
  if (cores <= 2 || memory <= 2) return 'low'
  if (cores >= 8 && memory >= 8) return 'high'
  return 'medium'
}

function readOverride(): QualityTier | null {
  if (typeof window === 'undefined') return null
  try {
    const value = new URLSearchParams(window.location.search).get('quality')
    if (value === 'low' || value === 'medium' || value === 'high') return value
  } catch {
    // location may be unavailable in exotic embeds; fall through to detection.
  }
  return null
}

let cached: QualitySettings | null = null

export function resolveQuality(): QualitySettings {
  if (cached) return cached
  const tier = readOverride() ?? detectTier()
  cached = { tier, ...TIERS[tier] }
  return cached
}

/** Coarse-pointer devices get touch affordances instead of hover ones. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false
  return (window.matchMedia?.('(pointer: coarse)').matches ?? false) || 'ontouchstart' in window
}
