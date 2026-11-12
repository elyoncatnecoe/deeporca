import * as THREE from 'three'

/*
 * 漂浮图标：爱心（伙伴对 Userlly 示好）和 Zzz（虎鲸睡觉）。
 *
 * 两者其实是同一个动作 —— 从某个位置冒出来、上浮、渐隐 —— 只是图案不同，
 * 所以做成一套系统，而不是在 app.ts 里给两处效果各写一遍精灵动画。
 *
 * 几个实现上的选择：
 *
 *  - 用 THREE.Sprite 而不是朝相机的平面 mesh：Sprite 天生永远面向相机，
 *    爱心和 Z 在任意镜头角度都得是正的，自己每帧算 billboard 四元数是白干。
 *  - 图案只画一次（CanvasTexture），每个精灵只克隆自己的 SpriteMaterial：
 *    渐隐要改 opacity，而 opacity 是材质级参数，共享材质会让所有爱心一起淡出。
 *  - 精灵池固定大小、循环复用。这套效果每秒都可能触发，运行期不再分配新对象，
 *    也就不会给 GC 添麻烦；池满了顶掉最老的那个，视觉上察觉不到。
 *  - 画布留 128px 且不设 sRGB 编码：本项目整体是非托管色彩空间（见 seal.ts 的
 *    斑点贴图），canvas 的颜色会原样落到屏幕上。
 */

export type GlyphKind = 'heart' | 'zzz'

export interface GlyphOptions {
  /** 上浮过程中朝这个世界点靠一点，用来让爱心飘向 Userlly。 */
  drift?: THREE.Vector3
  /** 图标在世界单位下的大小。 */
  size?: number
  /** 存活秒数。 */
  life?: number
}

export interface GlyphField {
  group: THREE.Group
  spawn: (kind: GlyphKind, at: THREE.Vector3, options?: GlyphOptions) => void
  /** 立刻清掉某一类（不传就全部）；醒来时残留的 Z 必须马上消失。 */
  clear: (kind?: GlyphKind) => void
  update: (t: number, dt: number) => void
  dispose: () => void
}

/** 池子大小。同时活着的图标远少于这个数，纯属保险。 */
const POOL_SIZE = 24
const TEXTURE_SIZE = 128

/** 默认大小与寿命，调用方一般只改大小。 */
const DEFAULT_SIZE = 0.45
const DEFAULT_LIFE = 2.4
/** 上浮速度（世界单位/秒）。 */
const RISE_SPEED = 0.55
/** 横向摆动幅度，让 Zzz 不是一根直线上的一串。 */
const SWAY = 0.05
/** 爱心朝 drift 点靠拢的最大比例（0.4 = 走完时横向靠近 40%）。 */
const DRIFT_LEAN = 0.4

/* ------------------------------------------------------------------ *
 * 图案
 * ------------------------------------------------------------------ */

/** 心形：两段对称的三次贝塞尔勾出上缘两瓣，底部收成一个尖。 */
function drawHeart(ctx: CanvasRenderingContext2D): void {
  ctx.save()
  ctx.translate(TEXTURE_SIZE / 2, TEXTURE_SIZE / 2)
  ctx.beginPath()
  ctx.moveTo(0, 46)
  ctx.bezierCurveTo(-52, 8, -44, -40, -16, -40)
  ctx.bezierCurveTo(-5, -40, 0, -31, 0, -23)
  ctx.bezierCurveTo(0, -31, 5, -40, 16, -40)
  ctx.bezierCurveTo(44, -40, 52, 8, 0, 46)
  ctx.closePath()
  const fill = ctx.createLinearGradient(0, -40, 0, 46)
  // 偏亮的玫红：海底整体是冷蓝，饱和度不够的粉色在深水里会读成脏灰色。
  fill.addColorStop(0, '#ff9dbb')
  fill.addColorStop(1, '#ff2f6b')
  ctx.fillStyle = fill
  ctx.fill()
  // 墨线：和 toon.ts 的描边一个思路 —— 扁平色块得有一圈深色边才像手绘。
  ctx.lineWidth = 7
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(20, 32, 46, 0.55)'
  ctx.stroke()
  // 左瓣上的一点高光，让爱心看起来是鼓的而不是一张贴纸。
  ctx.beginPath()
  ctx.ellipse(-19, -24, 9, 6, -0.5, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
  ctx.fill()
  ctx.restore()
}

/** 字母 Z（大小写各一张）：先描墨边再填色，边才会完整包在外面。 */
function drawLetter(ctx: CanvasRenderingContext2D, letter: string): void {
  ctx.save()
  ctx.translate(TEXTURE_SIZE / 2, TEXTURE_SIZE / 2)
  ctx.font = 'bold 92px "Segoe UI", Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 10
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(20, 32, 46, 0.6)'
  ctx.strokeText(letter, 0, 4)
  ctx.fillStyle = '#eaf6ff'
  ctx.fillText(letter, 0, 4)
  ctx.restore()
}

function makeTexture(draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = TEXTURE_SIZE
  canvas.height = TEXTURE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('glyph texture: 2d context unavailable')
  draw(ctx)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  return texture
}

/* ------------------------------------------------------------------ *
 * 场
 * ------------------------------------------------------------------ */

interface LiveGlyph {
  sprite: THREE.Sprite
  material: THREE.SpriteMaterial
  kind: GlyphKind
  active: boolean
  age: number
  life: number
  readonly from: THREE.Vector3
  readonly drift: THREE.Vector3
  hasDrift: boolean
  size: number
  rise: number
  sway: number
  phase: number
  tilt: number
  /** 当前挂的贴图标识，用来避免重复触发材质重编（见 spawn）。 */
  mapId: string
}

export function createGlyphField(): GlyphField {
  const group = new THREE.Group()
  group.name = 'glyphs'

  // 无 document 的环境（单元测试、SSR 预渲染）里直接退化成空场：这些效果是纯装饰，
  // 没有理由让整棵场景树因为画不出贴图就崩掉。
  const canDraw = typeof document !== 'undefined'
  const textures: THREE.CanvasTexture[] = []
  if (canDraw) {
    textures.push(makeTexture(drawHeart))
    textures.push(makeTexture((ctx) => drawLetter(ctx, 'Z')))
    textures.push(makeTexture((ctx) => drawLetter(ctx, 'z')))
  }
  const heartTexture = textures[0]
  const bigZTexture = textures[1]
  const smallZTexture = textures[2]

  const glyphs: LiveGlyph[] = []
  for (let i = 0; i < POOL_SIZE; i++) {
    const material = new THREE.SpriteMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // 海里有雾（environment 里的 fog），图标是前景提示，不该跟着远景一起发灰。
      fog: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.visible = false
    // 图标只在角色身边冒一下，包围球判断没有意义，还容易在贴边时被剔掉。
    sprite.frustumCulled = false
    group.add(sprite)
    glyphs.push({
      sprite,
      material,
      kind: 'heart',
      active: false,
      age: 0,
      life: DEFAULT_LIFE,
      from: new THREE.Vector3(),
      drift: new THREE.Vector3(),
      hasDrift: false,
      size: DEFAULT_SIZE,
      rise: RISE_SPEED,
      sway: SWAY,
      phase: 0,
      tilt: 0,
      mapId: '',
    })
  }

  /** Zzz 的大小写交替：大写开头、后面两个小写，读起来才像「Z z z」。 */
  let zFlip = 0

  const deactivate = (glyph: LiveGlyph): void => {
    glyph.active = false
    glyph.sprite.visible = false
    glyph.material.opacity = 0
  }

  const spawn = (kind: GlyphKind, at: THREE.Vector3, options: GlyphOptions = {}): void => {
    if (!canDraw) return
    let slot = glyphs.find((glyph) => !glyph.active)
    if (!slot) {
      // 池满：顶掉最老的那个。它已经接近完全透明，换掉看不出来。
      slot = glyphs.reduce((oldest, glyph) => (glyph.age / glyph.life > oldest.age / oldest.life ? glyph : oldest))
    }
    const glyph = slot
    glyph.kind = kind
    glyph.active = true
    glyph.age = 0
    glyph.life = options.life ?? DEFAULT_LIFE
    glyph.size = options.size ?? DEFAULT_SIZE
    glyph.from.copy(at)
    glyph.hasDrift = options.drift !== undefined
    if (options.drift) glyph.drift.copy(options.drift)
    glyph.rise = RISE_SPEED * (0.85 + Math.random() * 0.3)
    glyph.sway = kind === 'zzz' ? SWAY * 1.6 : SWAY * 0.7
    glyph.phase = Math.random() * Math.PI * 2
    // 爱心歪一点更像手绘贴纸；Z 保持正立，斜着的 Z 不好认。
    glyph.tilt = kind === 'heart' ? (Math.random() - 0.5) * 0.5 : 0

    // 贴图只在「这个槽位换了图案」时才重编材质。每次 spawn 都无条件
    // needsUpdate 会让休眠时每 0.7 秒重编一次着色器（睡着的鲸旁边每秒卡一下），
    // 而实际上大多数时候槽位里还是同一种图案。
    const nextMap = kind === 'heart' ? 'heart' : zFlip++ % 3 === 0 ? 'z-big' : 'z-small'
    if (glyph.mapId !== nextMap) {
      glyph.mapId = nextMap
      glyph.material.map = nextMap === 'heart' ? heartTexture ?? null : (nextMap === 'z-big' ? bigZTexture : smallZTexture) ?? null
      glyph.material.needsUpdate = true
    }
    glyph.material.opacity = 0
    glyph.sprite.position.copy(at)
    glyph.sprite.scale.setScalar(glyph.size * 0.4)
    glyph.sprite.visible = true
    glyph.sprite.renderOrder = 4
  }

  const update = (_t: number, dt: number): void => {
    for (const glyph of glyphs) {
      if (!glyph.active) continue
      glyph.age += dt
      if (glyph.age >= glyph.life) {
        deactivate(glyph)
        continue
      }
      const k = glyph.age / glyph.life

      // 弹出、上浮、渐隐三段分开算：
      // 前 12% 快速弹出（爱心是「蹦」出来的，慢慢涨大就变成果冻了），
      // 后 38% 淡出。前 62% 保持满不透明：不透明的时间太短，屏幕上就只是一闪
      // 而过的粉点，看不出是颗爱心。
      const pop = Math.min(1, k / 0.12)
      const swell = 1 + 0.12 * k
      const fadeIn = Math.min(1, k / 0.08)
      const fadeOut = k < 0.62 ? 1 : Math.max(0, 1 - (k - 0.62) / 0.38)

      const lean = glyph.hasDrift ? DRIFT_LEAN * Math.min(1, k * k * (3 - 2 * k)) : 0
      const x = glyph.from.x + (glyph.drift.x - glyph.from.x) * lean
      const z = glyph.from.z + (glyph.drift.z - glyph.from.z) * lean
      glyph.sprite.position.set(
        x + Math.sin(glyph.age * 2.1 + glyph.phase) * glyph.sway,
        glyph.from.y + glyph.rise * glyph.age,
        z + Math.cos(glyph.age * 1.7 + glyph.phase) * glyph.sway * 0.8,
      )
      glyph.sprite.scale.setScalar(glyph.size * pop * swell)
      glyph.material.opacity = fadeIn * fadeOut
      glyph.material.rotation = glyph.tilt + Math.sin(glyph.age * 1.6 + glyph.phase) * 0.08
    }
  }

  return {
    group,
    spawn,
    clear: (kind?: GlyphKind) => {
      for (const glyph of glyphs) {
        if (!glyph.active) continue
        if (kind === undefined || glyph.kind === kind) deactivate(glyph)
      }
    },
    update,
    dispose: () => {
      for (const glyph of glyphs) {
        glyph.material.dispose()
        glyph.material.map = null
      }
      for (const texture of textures) texture.dispose()
      group.clear()
    },
  }
}
