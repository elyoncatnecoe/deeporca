import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildOrcaModel, ORCA_SKINS, type OrcaModel } from './orca/orcaMesh'
import { createAquariumEnvironment, type AquariumEnvironment } from './scene/environment'
import { createPostFX, type PostFX } from './scene/postfx'
import type { ThemeId } from './scene/themes'
import { heightAt } from './scene/terrain'
import { DECOR_CATALOG, createDecorMesh, findDecorKind, type DecorPlacement } from './decor/catalog'
import { loadSave, persistSave, type SaveData } from './persistence'
import { resolveQuality, type QualitySettings } from './quality'
import { createAudioSystem, type AudioSystem } from './audio'
import { createClawdCompanion, CLAWD_NAME, type ClawdCompanion } from './companion/clawd'
import { createSealCompanion, type SealCompanion } from './companion/seal'
import { createJellyCompanion, type JellyCompanion } from './companion/jellyfish'
import { createGlyphField, type GlyphField } from './scene/glyphs'
import {
  COMPANION_EAT_RADIUS,
  createTokenDrop,
  EAT_RADIUS,
  type FeedTarget,
  type TokenDrop,
} from './feed'
import type { AquariumMode } from './ui/index'
import { injectOrcaStyles } from './ui/styles'
import { bodyMind, type BodyDirective, type BodySnapshot } from '../lib/body'
import {
  BLURRY_STYLE,
  PHOTO_QUALITY,
  composeFramedPhoto,
  createPhotoFlash,
  evaluatePhotoQuality,
  loadPhotos,
  makeThumb,
  MAX_PHOTOS,
  persistPhotos,
  pickPhotoEvent,
  type PhotoRecord,
} from './photo'

export interface OrcaAquariumOptions {
  /** Initial scene theme. */
  theme?: ThemeId
  /** Start in the interactive view rather than the ambient backdrop. */
  focus?: boolean
  /**
   * Ambient mode is a *backdrop*: it sits behind a host page, so the canvas
   * must let pointer events through to whatever is underneath. Set this when
   * embedding; a standalone page should leave it off, because then ambient is
   * an idle view the player can still drag around. Defaults to `!focus`.
   */
  background?: boolean
  /** Force a quality tier instead of auto-detecting (used by ?quality=). */
  quality?: QualitySettings
}

/**
 * One screen of state, as the host UI needs to see it.
 *
 * The aquarium already owns every one of these values, but an embedded host
 * draws its own buttons, counters and swatches in React, so it needs a plain
 * snapshot it can diff against instead of reaching into the app's internals or
 * keeping a second copy of the state that can drift.
 */
export interface GameState {
  mode: AquariumMode
  feedArmed: boolean
  /** Size multiplier, 1 = as met. Eased live value, so it lags a feed. */
  growth: number
  /**
   * The size the current `growthFeeds` implies — this is what the host shows.
   * `growth` only catches up to it over the next half second in the render
   * loop, and no event fires during that ease.
   */
  growthTarget: number
  feedCount: number
  growthFeeds: number
  skin: string
  bloomStrength: number
  music: boolean
  companion: boolean
  companionSeal: boolean
  companionJelly: boolean
  outlines: boolean
  /** Action-speed multiplier for the swim/tail/fin animation (0.4~1.8). */
  motionSpeed: number
  decorCount: number
  photoCount: number
}

const DECOR_HALF_W = 22
const DECOR_HALF_D = 15
/**
 * 巡游高度基准。模型原点在身体中心、肚皮位于原点下方 1.81（bodyGeo bbox 实测），
 * 巡游区内沙地最高约 0.4：REST_Y - AMP_Y ≥ 2.76 才能保证肚皮离沙 ≥0.55。
 * 之前 REST_Y=1.6 时目标下沿 1.18，肚皮在 -0.63——这就是"肚皮贴地"。
 */
const ORCA_REST_Y = 3.8
/**
 * 巡游动作（移植自 seaorca.html 的动作模式，仅此而已）：
 *
 * 1. 目标点是低频 Lissajous 曲线（X:Z 频率 1:2，两个分量永不同时为零，
 *    所以目标速度永不过零）；位置用时间常数缓动跟随，而不是硬拷贝。
 * 2. 朝向看向目标路径上 SWIM_LOOK 秒之后的点。注意模型鼻子的局部朝向是
 *    **-X**（bodyGeo 实测长轴在 X、尾巴在 +X，定向截图确认），所以公式是
 *    atan2(dz, -dx) 而不是常见的 atan2(dx, dz)——旧代码用后者，虎鲸一直
 *    横着游，正是"后退"感的根源。
 * 3. 俯仰绑定垂直位移（下潜低头、上浮抬头）。鼻子朝 -X 时俯仰轴是
 *    rotation.z（经 orca.update 的 divePitch 通道），不是 rotation.x。
 */
const SWIM_FX = 0.24
const SWIM_FZ = 0.48
const SWIM_FY = 0.4
const SWIM_AMP_Y = 1.0
const SWIM_LOOK = 0.4
/** Position ease time constant, in seconds. */
const SWIM_EASE_TAU = 0.55
/** Swim amplitude as a fraction of the visible orbit. */
const SWIM_AMPLITUDE = 0.85
/** Ease time constant for heading changes, in seconds. */
const SWIM_TURN_TAU = 0.5
/** Pitch gain: nose dips/rises per unit of vertical distance to cover. */
const SWIM_PITCH_GAIN = 0.9
/**
 * Companion trailing. `LAG` is in seconds of the orca's own path, so the gap
 * stays constant in world units regardless of how fast the orca swims.
 */
const COMPANION_LAG_SECONDS = 1.0
/**
 * Lateral offset so the orca's body does not hide him from the follow camera.
 *
 * Measured rather than guessed: at the phone framing the orca covers a 139x101
 * px box while a 1.5-unit offset moved the companion only 47 px — a 100%
 * overlap. The real requirement scales with how much of the frame the orca
 * occupies, so `applyViewFit` derives it from the visible world width instead
 * of hardcoding a value tuned for one device.
 */
const COMPANION_SIDE_FRACTION = 0.42
const COMPANION_DISTANCE = 1.3
const COMPANION_Y_OFFSET = -0.15
/** Companion height in world units, against the orca's ~3.5. */
const COMPANION_HEIGHT = 1.15
/**
 * The second companion (the GPT seal) trails on the *opposite* flank and a
 * little further back, so inviting both never makes them fight for the same
 * patch of water — they read as a small escort, one on each side.
 *
 * The lag is longer and the flank share a little wider than Clawd's on
 * purpose. Measured in the running build, the two are not symmetric: the side
 * offset is perpendicular to the *view*, so on one flank it partly cancels the
 * along-track lag and on the other it adds to it. With both at 0.42/1.0s the
 * seal ended up ~4 units from a 4.6-unit orca — visually in its tail — while
 * Clawd sat at 7.
 */
const SEAL_HEIGHT = 1.5
const SEAL_Y_OFFSET = -0.5
const SEAL_SIDE_FRACTION = 0.5
const SEAL_LAG_SECONDS = 1.6
/**
 * The jellyfish trails the orca's *lead*, not its flank: a jellyfish does not
 * escort, it drifts above and behind. It therefore rides higher (its tentacles
 * hang instead of standing on the sea floor, so the slot is lifted off the
 * orca's own line) and sits closer to the middle of the frame than the two
 * walking companions, who have to clear the body.
 */
const JELLY_HEIGHT = 1.25
const JELLY_Y_OFFSET = 0.55
const JELLY_SIDE_FRACTION = 0.2
const JELLY_LAG_SECONDS = 1.35

/**
 * 伙伴对 Userlly 冒爱心的节奏。
 *
 * Userlly 代表用户本人，另外三个伙伴会时不时朝它示好。这里只做「随机间隔、
 * 随机发起者」，不跟任何玩法状态挂钩 —— 它是氛围，不是奖励，所以刻意不做成
 * 「点了就冒」：被点的那个动一下、冒句台词，才是点它的反馈。
 *
 * 间隔下限 2.2s：三只伙伴同时在场时，再密就会变成一场爱心雨，反而看不出
 * 是谁在示好。首次延迟短一点，召唤 Userlly 后几秒内就能看到效果。
 */
const HEART_FIRST_DELAY = 1.1
const HEART_GAP_MIN = 2.2
const HEART_GAP_MAX = 5.5
/**
 * 爱心大小（世界单位）。
 *
 * 这个数是按「最远的默认机位」量的：宽屏下相机会退到 ~20 单位外看整片巡游区，
 * 虎鲸（4.6 单位长）只占约 120px，也就是 ~26px/单位。0.4 单位在这里只有 10px
 * —— 实测截图上就是一团认不出来的粉色像素。1.1 单位约 29px，正好是「角色旁边
 * 浮着一个小图标」的比例。
 */
const HEART_SIZE = 1.1
const HEART_LIFE = 2.6

/**
 * 睡觉时的 Zzz。
 *
 * act === 'sleep' / mood sleepy 时 setSleeping(true)，但在此之前 3D 里只是
 * 动作变慢 —— 看不出是在睡觉。头顶持续冒 Z 是唯一一眼就懂的信号。
 *
 * 间隔 0.55~0.85s、大小写交替、每个 Z 活 2.4s：同屏通常有 3~4 个 Z 排成一条
 * 上浮的斜线，既有「持续在睡」的感觉，又不会糊成一片。
 */
const ZZZ_GAP_MIN = 0.55
const ZZZ_GAP_MAX = 0.85
/**
 * Z 的大小（世界单位）。比爱心大：Zzz 是「它睡着了」的唯一信号，得一眼看见；
 * 1.4 单位在最远机位下约 36px，比虎鲸的头略大，三个叠起来就是一条明显上浮的
 * 斜线。
 */
const ZZZ_SIZE = 1.4
const ZZZ_LIFE = 2.4
/** 每个 Z 的水平散开量，避免排成一条笔直的线。 */
const ZZZ_SPREAD = 0.32
/**
 * How hard a companion breaks formation to go and eat.
 *
 * The companions trail a 1–1.6 s-old sample of the orca's path, so a token
 * dropped on one of them lands where the pet *was*, and by the time it has
 * sunk the pet is somewhere else: measured over four tosses, the true closest
 * approach was 2.6–3.0 units, against a 2.0-unit bite radius. Whether the pet
 * got fed was down to luck.
 *
 * The orca does not have this problem because it chases (`nearestToken`), and
 * the fix is to stop treating that as an orca-only privilege. `TAU` eases the
 * interest in, so the pet *swims* to the food over about a third of a second
 * instead of teleporting onto it; `PULL` is how far off its formation slot it
 * is willing to go (0.95 leaves a little of the trail offset in, so the path
 * still curves instead of running dead straight).
 */
const COMPANION_FOOD_TAU = 0.3
const COMPANION_FOOD_PULL = 0.95
/** How far above its slot a companion will climb for a token, in world units. */
const COMPANION_FOOD_RISE = 1.2

/**
 * Runtime quality downgrade.
 *
 * The boot tier is a guess: core count, `deviceMemory` and the GPU string. The
 * only trustworthy signal is how long frames actually take, so the loop
 * averages them and steps down when the device cannot hold ~24fps. Two steps
 * only — 1x rendering, then bloom off — because those are the two levers that
 * can be pulled without rebuilding geometry. There is deliberately no step back
 * up: a device that stalled once stalls again at the next bubble burst, and
 * flickering between tiers looks worse than the lower one.
 */
const SLOW_FRAME_SECONDS = 1 / 24
/** Frames per measurement window. ~2s at 24fps, so one hitch cannot trigger it. */
const DEGRADE_WINDOW_FRAMES = 48
/** Ignore the opening seconds: shader compilation and the first upload are slow. */
const DEGRADE_WARMUP_SECONDS = 2.5

/**
 * Feeding. A dropped token is released this far above the water point it was
 * aimed at and sinks from there while the orca swims over to eat it.
 */
const FEED_DROP_HEIGHT = 5.0
/** Horizontal scatter around the drop point, so repeated tosses do not stack. */
const FEED_SCATTER = 1.2
/** Most tokens in the water at once; the oldest is culled beyond this. */
const MAX_TOKENS = 6

/**
 * Growth. Every token swallowed makes the orca a little bigger, along a curve
 * that saturates: the first few feeds visibly swell it, then it levels off, so
 * a long session ends up with a chunky whale instead of something that
 * outgrows the tank. 1.55x is the ceiling — much past that and the belly starts
 * scraping the sand at the bottom of its swim band.
 */
const GROWTH_MAX = 0.55
/** Feeds to reach ~63% of the way to GROWTH_MAX. */
const GROWTH_TAU = 9
/**
 * How far the swim band rises per unit of growth. The model origin is the body
 * centre, so the belly sinks by 1.81 per unit of scale; lifting the band by 2
 * per unit keeps the same clearance under it at every size.
 */
const GROWTH_LIFT = 2.0
/** Size eases toward the new target instead of snapping, so a bite swells it. */
const GROWTH_EASE_TAU = 0.45

/**
 * Reference basin size used to derive the camera pitch and initial orbit.
 * Generous on purpose: the frame also has to hold the orca *plus* its companion
 * side by side. Framed tightly the orca alone covered 36% of the width and the
 * companion had nowhere to go but behind it.
 */
const BASIN_FIT_HALF_WIDTH = 26
/** Camera height above the look-at target; sets the viewing pitch. */
const CAMERA_HEIGHT = 4.5
const VIEW_FIT_MIN_DISTANCE = 16
const VIEW_FIT_MAX_DISTANCE = 72
/** Camera lift that keeps the orca clear of the top toolbar. */
const FRAME_HEADROOM = 1.4
/** Fraction of the frame the patrol must stay inside (0.85 = 15% margin). */
const VIEW_FIT_MARGIN = 0.85

const SKIN_LABELS: Record<string, string> = {
  classic: '经典蓝',
  night: '星夜黑',
  pink: '草莓粉',
  green: '薄荷绿',
  gold: '土豪金',
}
const skinOptions = Object.entries(ORCA_SKINS).map(([id, s]) => ({
  id,
  label: SKIN_LABELS[id] ?? id,
  dark: '#' + s.dark.toString(16).padStart(6, '0'),
  white: '#' + s.white.toString(16).padStart(6, '0'),
}))

/**
 * Said as the shutter opens. Deliberately free of "look at the camera": the
 * photo is a snapshot of whatever the orca was doing, not a portrait.
 */
const POSE_LINES = ['咔嚓！', '就这样，别动～', '抓拍一张 📸', '嗯？在拍我吗', '这个角度怎么样', '灯光正好…']
const GOOD_LINES = ['耶！这张超好看！✨', '我是最靓的崽~', '完美出片！', '好喜欢这张 💙']
const BACK_LINES = ['哎呀，转过去啦~', '尾巴也算出镜了吧', '哼，不给看正面']
const WIGGLE_LINES = ['晃了一下，糊了糊了', '嘻嘻，动感模糊', '没稳住！再来一张？']
const DAILY_LINES = ['日常抓拍成功 📸', '已存入相册~', '咔嚓，下一张！']
/**
 * What the orca says once it has actually swallowed a dropped token.
 *
 * The food is a token, so the lines lean into it: context windows, model size,
 * billing, being trained. The thank-you is the payoff for the feeding loop, so
 * they stay warm rather than slapstick.
 */
const THANKS_LINES = [
  '这枚 token 有点甜',
  'token 到账，谢谢老板！',
  '嗝，这枚是几 k 的？',
  '我的上下文又长了一点',
  '再来一枚，我还能吃',
  '吃掉 token，变聪明了',
  '谢谢你投喂我 token 💙',
  '一枚 token，一次心跳',
  '我记住你了，存进上下文了',
  '这味道……是 128k 的吧',
]
/** Shown when a token sinks away uneaten. */
const UNEATEN_LINES = ['这枚 token 沉底了…', '没人吃？浪费 token 了', '掉了一枚 token，心疼']
/**
 * Milestone lines: every few tokens the growth is big enough to notice, so it
 * gets its own line instead of another thank-you.
 */
const GROWTH_LINES = ['我好像变大了一圈…', '再喂下去，这个缸就装不下我了', '参数变多了，游起来更带劲']
/**
 * Ordinary petting, for a tap on the orca while feed mode is off. The feeding
 * gag lives in its own mode now, so these are just a happy wriggle.
 */
const PET_LINES = [
  '咕噜～',
  '再摸一下嘛',
  '好舒服…',
  '尾巴别碰，痒！',
  '今天也很可爱吧',
  '我在这里呢 💙',
  '摸摸头，长高高',
  '要不要一起游一会儿',
]
/** The two companions eat their own tokens, with their own thank-yous. */
const CLAWD_THANKS_LINES = [
  'token！我正需要这个',
  '谢谢，我的上下文又长了',
  '这枚是给我写的吗',
  '咔嚓咔嚓（方方的咀嚼声）',
  '吃饱了好帮你干活',
]
const SEAL_THANKS_LINES = [
  '呜～谢谢投喂',
  '这枚 token 很新鲜',
  '吃饱了就能好好回答了',
  '啪叽啪叽（拍鳍）',
  '下次还给我留一枚呀',
]
/**
 * The companion is Claude's mascot, so his lines lean into that: context
 * windows, tokens, prompts, being helpful, a mild existential streak about
 * being a small orange block in an aquarium.
 */
const CLAWD_LINES = [
  '你好！有什么可以帮你的吗',
  '让我想想……嗯，想不出来',
  '这个问题的上下文有点长',
  '我的 token 快用完了',
  '我很有帮助！大概吧',
  '作为一只小螃蟹，我还挺方的',
  '嘘——我在思考',
  '别捏我，我又不是橡皮鸭',
  '需要我帮你写点什么吗',
  '我同意！……我同意什么来着',
  '这个提示词写得不错',
  '咕噜咕噜（气泡音）',
  '虎鲸说得对',
  '我只是一段程序，但我很快乐',
]
/**
 * The seal wears the OpenAI knot, so its lines lean into that: prompts,
 * tokens, models, being a very good assistant despite being a pinniped.
 */
const SEAL_LINES = [
  '咕噜咕噜～',
  '我是海豹，不是海豚',
  '斑纹是天生的，不是我画的',
  '浮上来换口气先',
  '这条思路，我接得住',
  '让我帮你总结一下……汪？',
  '别摸尾巴，痒！',
  '权重全长在背上了',
  '正在为你生成一段浪花…',
  '我在很努力地当一只可爱海豹',
  '要不要我帮你写点什么',
  '虎鲸刚才顶了我一下',
  '海里的上下文有点长',
  '啪叽（拍鳍）',
]
/**
 * The jellyfish companion (Userlly) has no lines at all — by design.
 *
 * 它代表的是**用户本人**：一只会说话的「我」，玩家会觉得被夺舍。这里曾经有
 * 一份 JELLY_LINES / JELLY_THANKS_LINES，现在整体删掉了：点击它只有音效和
 * 鼓伞盖的动作，投喂它也只有中性的系统 toast。
 */

/** The parts of a companion the feeding loop needs: a body and a reaction. */
type FeedingCompanion = {
  readonly group: THREE.Group
  react: () => void
}

export class OrcaAquariumApp {
  readonly domElement: HTMLCanvasElement
  readonly quality: QualitySettings
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly container: HTMLElement
  private readonly photoFlash: HTMLElement
  private photos: PhotoRecord[] = []
  private photoBusy = false
  /**
   * 宿主 Toast 的出口。
   *
   * 引擎里那几十句提示（"Clawd 来啦""回到原来的大小"）原本写进一个 `.orca-toast`
   * div，而那个 div 被宿主的 CSS 藏了 —— 等于所有反馈都静默。现在改成回调，
   * 由宿主决定怎么显示；没接回调时静默丢弃，不报错。
   */
  private toastHandler: ((text: string) => void) | null = null

  private readonly aquarium: AquariumEnvironment
  private readonly postfx: PostFX
  private readonly orca: OrcaModel
  private readonly decorGroup = new THREE.Group()
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly clock = new THREE.Clock()
  /** Seconds of animation time, accumulated from getDelta(). */
  private elapsed = 0

  private save: SaveData
  private mode: AquariumMode
  private focusOpen: boolean
  /**
   * True when this instance is a backdrop behind a host page rather than the
   * page itself. It changes exactly one thing: ambient mode then lets pointer
   * events fall through instead of orbiting the camera (see applyModeToDom).
   */
  private readonly background: boolean
  private theme: ThemeId
  private selectedDecor: string | null = null
  private ghost: THREE.Group | null = null
  /** Tokens currently in the water, oldest first. */
  private readonly feedItems: TokenDrop[] = []
  /**
   * Feed mode. While armed, a click on a pet drops it a token instead of
   * petting it, and the toolbar button carries a ✓. It stays armed until the
   * button is pressed again (or the player leaves interactive mode), so
   * feeding several pets in a row is not five button presses.
   */
  private feedArmed = false
  /**
   * Current size multiplier, 1 = as met. Eases toward the value implied by
   * `save.growthFeeds`, so eating reads as a visible swell and 复原 as a
   * visible shrink rather than a snap.
   */
  private growth = 1
  /** Scratch vector for the orca's nose, refilled every frame. */
  private readonly nosePoint = new THREE.Vector3()
  private disposed = false
  /** Host-driven render suspension (memory/workshop screens cover the tank). */
  private renderPaused = false
  private resizeObserver: ResizeObserver | undefined
  /** Stable identity so the fallback path can remove its own listener. */
  private readonly onContainerResize = (): void => this.resize()
  /** True while a touch/pointer drag is rotating the ghost decor. */
  private ghostDragging = false
  private lastPointer: { x: number; y: number } | null = null
  /** Where the current press started, used to tell a tap from a camera drag. */
  private pointerDownAt: { x: number; y: number } | null = null
  private pointerDragged = false
  /** Where the orca is easing toward this frame. */
  /** Swim orbit half-extents, refitted to the viewport on every resize. */
  private orbitX = 4.5
  private orbitZ = 3.0
  /** Lateral trail offset for the companion, refitted with the viewport. */
  private companionSideOffset = 2.5
  /** Same for the seal, which mirrors to the orca's other flank. */
  private sealSideOffset = 2.5
  /** Same for the jellyfish, which drifts near the middle of the frame. */
  private jellySideOffset = 2.5
  /**
   * Eased 0→1 interest in a live token, per companion. Kept on the app rather
   * than inside the companions so all three share one rule, and so it survives
   * the pets being sent home and re-summoned mid-feed.
   */
  private clawdFoodPull = 0
  private sealFoodPull = 0
  private jellyFoodPull = 0
  /** Rolling frame-time sample feeding the runtime downgrade (see `noteFrame`). */
  private frameSamples = 0
  private frameTimeSum = 0
  private degradeStep = 0

  // Photo-moment / reaction states.
  private poseTimer = 0
  private poseTargetYaw: number | null = null
  private readonly poseAnchor = new THREE.Vector3()
  private shakeTimer = 0
  private happyTimer = 0
  private thoughtEl: HTMLDivElement | null = null
  private thoughtUntil = 0
  /** Body state exposed to the model; see lib/body.ts. */
  private hostScreen = 'home'
  private bodyMood = 'idle'
  private sleeping = false
  private lastTouchAt: number | null = null
  private measuredSpeed = 1
  private lastSpeedSample = 0
  private readonly lastSpeedPos = new THREE.Vector3()
  private speedInitialised = false
  /** Transient body-action offset and timing. */
  private actionUntil = 0
  private actionStarted = 0
  private actionYTarget = 0
  private actionYOffset = 0
  private spinUntil = 0
  private sleepUntil = 0
  private pokeHandler: (() => void) | null = null
  private readonly headAnchor = new THREE.Vector3()
  private readonly headWorld = new THREE.Vector3()
  private readonly tailWorld = new THREE.Vector3()
  private readonly audio: AudioSystem = createAudioSystem()
  /**
   * The clawd companion. Exactly one can ever exist — it is a single toggleable
   * character, not a placeable decoration, so there is no way to add a second.
   */
  private clawd: ClawdCompanion | null = null
  /**
   * The GPT seal companion. Same contract as Clawd: a single lazily-created
   * character toggled by visibility, never a placeable decoration. The two are
   * independent, so both can be out at once — but there can only ever be one
   * of each.
   */
  private seal: SealCompanion | null = null
  /**
   * The jellyfish companion. Third of the set, same contract again: lazily
   * created, toggled by visibility, and independent of the other two.
   */
  private jelly: JellyCompanion | null = null
  /**
   * 漂浮图标（爱心 / Zzz）。挂在场景根上，而不是挂在某个角色下面：
   * 爱心要从伙伴身上飘向 Userlly（跨角色），Zzz 要跟着虎鲸的头走，但不该
   * 被它的姿态、缩放带着一起转。
   */
  private readonly glyphs: GlyphField = createGlyphField()
  /** 下一次冒爱心的场景时间（秒，走 elapsed 时钟）。0 = 还没排。 */
  private nextHeartAt = 0
  /** 下一次冒 Z 的场景时间；0 = 没在睡觉。 */
  private nextZzzAt = 0
  /** Zzz 锚点用的临时向量（虎鲸头顶世界坐标）。 */
  private readonly glyphAnchor = new THREE.Vector3()
  /** 量发起者头顶用的临时包围盒（爱心从这里冒）。 */
  private readonly glyphBox = new THREE.Box3()
  /** Recent orca positions, so the companion can trail faithfully behind. */
  private readonly trail: { x: number; y: number; z: number; yaw: number; t: number }[] = []
  private readonly followPoint = new THREE.Vector3()
  /** Scratch target for a companion heading for its food. */
  private readonly foodPoint = new THREE.Vector3()
  private readonly onKeyDown: (event: KeyboardEvent) => void
  private readonly onVisibilityChange: () => void
  private stopLoop: (() => void) | undefined
  /**
   * Host-side subscribers, fired when a piece of `GameState` changes. The
   * aquarium's own DOM UI updates itself directly, so this exists only so an
   * embedded React host can re-render its controls without polling.
   */
  private readonly changeListeners = new Set<() => void>()

  constructor(container: HTMLElement, options: OrcaAquariumOptions = {}) {
    injectOrcaStyles()
    this.container = container
    this.quality = options.quality ?? resolveQuality()
    this.save = loadSave()
    // Restored size is applied straight away, not eased: on load the orca
    // should already be the whale the player left behind, not shrink in.
    this.growth = this.growthFor(this.save.growthFeeds)
    this.mode = options.focus === false ? 'ambient' : 'interactive'
    this.focusOpen = options.focus ?? true
    this.background = options.background ?? options.focus === false
    this.theme = options.theme ?? 'deep'

    container.classList.add('orca-aquarium-root')
    container.style.position = 'fixed'
    // Spelled out instead of `inset: 0` — the `inset` shorthand is Chrome 87+,
    // and this container is the mount point for hosts (the minitool shell, the
    // demo page) that may not give it any positioning of their own. Assigned
    // through the four physical properties, it works on the Chrome 61 floor.
    container.style.top = '0'
    container.style.right = '0'
    container.style.bottom = '0'
    container.style.left = '0'
    container.style.overflow = 'hidden'
    // The game owns the whole viewport, so the container itself must never
    // swallow input; only the canvas and the controls opt back in.
    container.style.pointerEvents = 'none'
    container.style.touchAction = 'none'

    // No `preserveDrawingBuffer`: that flag forces a full-resolution copy of
    // the framebuffer on every frame, and photos are read out of the post
    // chain's own buffer instead (see PostFX.capture).
    this.renderer = new THREE.WebGLRenderer({ antialias: this.quality.tier !== 'low', alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.maxPixelRatio))
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight)
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.style.pointerEvents = 'auto'
    this.renderer.domElement.style.touchAction = 'none'
    this.domElement = this.renderer.domElement
    container.appendChild(this.domElement)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(
      // A wider lens on the weak tier is deliberate: phones hold the scene in
      // portrait, where the horizontal field is the binding constraint. A wider
      // vertical FOV buys horizontal coverage, which lets the camera stand much
      // closer — otherwise it has to retreat ~60 units and ends up skimming the
      // seabed with a huge flat expanse of sand in the lower frame.
      this.quality.tier === 'low' ? 58 : 48,
      (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight),
      0.1,
      600,
    )
    this.camera.position.set(0, 3.9, 13.5)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 1.5, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.autoRotate = true
    this.controls.autoRotateSpeed = 0.6
    this.controls.minDistance = 11
    this.controls.maxDistance = 36
    this.controls.maxPolarAngle = Math.PI * 0.55
    this.controls.minPolarAngle = Math.PI * 0.15
    this.controls.enablePan = false
    // One finger orbits, two fingers pinch — the defaults, spelled out here
    // because this is now a touch-first game.
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE }
    this.controls.update()
    // Frame the basin for this viewport before the first frame is drawn.
    this.applyViewFit()

    this.aquarium = createAquariumEnvironment(this.scene, this.theme, this.quality)
    this.postfx = createPostFX(this.renderer, this.scene, this.camera, this.quality)
    // Honoured only when the tier actually has a bloom pass; on the low tier
    // the slider is hidden and the strength stays at zero.
    this.postfx.setStrength(this.quality.bloom ? this.save.bloomStrength : 0)

    this.orca = buildOrcaModel()
    this.orca.setSkin(this.save.skin)
    this.orca.setMotionSpeed(this.save.motionSpeed)
    this.orca.group.position.set(0, this.orcaRestY(), 0)
    this.orca.group.rotation.y = -0.35
    this.scene.add(this.orca.group)
    // 图标层：爱心和 Zzz 都在这里，靠精灵自带的 billboard 永远面向镜头。
    this.scene.add(this.glyphs.group)

    // 互动加速（照搬 pet.html）：悬停慢加速 / 单击猛划水后衰减
    //
    // Both are gated on the mode. The canvas now accepts pointer events in the
    // idle view too (so the camera can be dragged after 返回), and without this
    // a click anywhere — including on the tank — would spur the orca into a
    // sprint in what is supposed to be a calm screensaver.
    this.renderer.domElement.addEventListener('pointerenter', () => {
      if (this.mode !== 'ambient') this.orca.setBoost(0.25)
    })
    this.renderer.domElement.addEventListener('pointerleave', () => this.orca.setBoost(0))
    window.addEventListener('click', (event) => {
      // Embedded in the chat app: only a click on the tank itself may spur the
      // orca. Chat buttons and sheets sit above the canvas and must not.
      if (this.mode !== 'ambient' && event.target === this.renderer.domElement) this.orca.addClick()
    })

    this.decorGroup.name = 'decor'
    this.scene.add(this.decorGroup)
    this.applyDecorPlacements()

    // UI
    //
    // 宿主用 React 自己画全部控件（components/room），所以游戏自带的工具条 /
    // 装饰面板 / 相册 / 环境模式小按钮一律不建 —— 它们只会被 CSS 藏掉，留着
    // 是纯死代码，还会让人以为界面上真有两个入口。
    // 留下的只有一次性视觉反馈（拍照闪光）和台词 pill（showThought）。
    this.photoFlash = createPhotoFlash()
    this.photos = loadPhotos()
    container.appendChild(this.photoFlash)

    this.onKeyDown = (event: KeyboardEvent): void => {
      if (this.mode === 'ambient') return
      // The stage is embedded behind a chat UI: Space/P must type text, not
      // take a photo. Never handle keys aimed at an input or the host UI.
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [data-deepsea-ui]')) return
      // Escape is the keyboard way out of feed mode, matching the button.
      if (event.key === 'Escape' && this.feedArmed) {
        this.setFeedArmed(false)
        this.showToast('🪙 投喂已关闭，可以正常互动')
        return
      }
      if (event.key === ' ' || event.key.toLowerCase() === 'p') {
        event.preventDefault()
        void this.takePhoto()
      }
    }
    // A backgrounded page does not need 60fps of GPU work; the loop throttles
    // itself instead (see startLoop) so a phone does not drain its battery
    // while the player is reading a WeChat message.
    this.onVisibilityChange = (): void => {
      this.clock.getDelta()
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange)

    // Browsers only allow audio to start from a user gesture, so the context is
    // created on the first interaction. If music was left on, it resumes then.
    const unlock = (): void => {
      this.audio.unlock()
      if (this.save.music) this.audio.setMusicEnabled(true)
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    // Restore the companions if they were left on. They trail the orca, so
    // they are positioned on the first frame rather than dropped in at the
    // origin.
    if (this.save.companion) this.setCompanion(true)
    if (this.save.companionSeal) this.setSealCompanion(true)
    if (this.save.companionJelly) this.setJellyCompanion(true)
    // The orca always exists, so the outline toggle applies to it directly; the
    // companions pick the setting up at their creation sites above.
    this.setOutlines(this.save.outlines)

    this.bindEvents()
    this.applyModeToDom()
    this.startLoop()
  }

  /**
   * Stop drawing while the host covers the tank with a full-screen surface.
   * The animation loop stays alive, so resuming costs one frame.
   */
  pause(): void {
    this.renderPaused = true
  }

  /** Resume drawing; the clock delta is discarded so no time jump is applied. */
  resume(): void {
    if (!this.renderPaused) return
    this.renderPaused = false
    this.clock.getDelta()
  }

  /**
   * Chat-layer reactions: a nudge on send, a happy squeeze on reply, a small
   * line on failure. The tank is the assistant's body language, not decoration.
   * @param kind - which moment the chat just reached.
   */
  chatPulse(kind: 'send' | 'reply' | 'error' | 'think'): void {
    if (kind === 'send') {
      this.orca.setBoost(0.9)
      this.setBodyMood('curious')
      return
    }
    if (kind === 'reply') {
      this.petOrca(true, false)
      return
    }
    if (kind === 'think') {
      this.setBodyMood('working')
      this.showThought('嗯……', 1800)
      return
    }
    this.orca.setBoost(0)
    this.setBodyMood('blocked')
    this.showThought('咕噜…信号断了', 1800)
  }

  // ------------------------------------------------------------- body link

  /** Which host screen the orca is currently swimming behind. */
  setScreen(screen: string): void {
    this.hostScreen = screen
  }

  /** A compact, honest reading of the body for the model's system prompt. */
  getBodySnapshot(): BodySnapshot {
    return {
      mood: this.bodyMood,
      depth: Math.min(36, Math.max(0.4, (ORCA_REST_Y + 2.2 - this.orca.group.position.y) * 2.6)),
      speed: this.measuredSpeed,
      growth: this.growth,
      sleeping: this.sleeping,
      theme: this.theme,
      clawd: this.clawd?.group.visible === true,
      seal: this.seal?.group.visible === true,
      jelly: this.jelly?.group.visible === true,
      screen: this.hostScreen,
      lastTouchAgo: this.lastTouchAt === null ? null : (Date.now() - this.lastTouchAt) / 1000,
      fed: this.save.growthFeeds,
    }
  }

  /**
   * Where the head is, in viewport pixels, plus a scale hint for the speech
   * bubble. Returns null when the projection is behind the camera.
   */
  getHeadScreenPosition(): { x: number; y: number; scale: number } | null {
    if (this.orca.bodyGeo.boundingBox === null) this.orca.bodyGeo.computeBoundingBox()
    const box = this.orca.bodyGeo.boundingBox
    if (!box || box.isEmpty()) return null
    const width = box.max.x - box.min.x
    this.headAnchor.set(box.min.x + width * 0.34, box.max.y * 0.94 + 0.22, 0)
    this.orca.group.updateWorldMatrix(true, false)
    this.headWorld.copy(this.headAnchor).applyMatrix4(this.orca.group.matrixWorld)
    this.tailWorld.set(box.max.x, box.max.y * 0.4, 0).applyMatrix4(this.orca.group.matrixWorld)

    const rect = this.renderer.domElement.getBoundingClientRect()
    const project = (point: THREE.Vector3): { x: number; y: number; z: number } => {
      point.project(this.camera)
      return {
        x: rect.left + (point.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-point.y * 0.5 + 0.5) * rect.height,
        z: point.z,
      }
    }
    const head = project(this.headWorld)
    if (head.z < -1 || head.z > 1) return null
    const tail = project(this.tailWorld)
    const pixelWidth = Math.hypot(head.x - tail.x, head.y - tail.y)
    if (head.x < -100 || head.x > window.innerWidth + 100 || head.y < -20 || head.y > window.innerHeight + 120) {
      return null
    }
    return {
      x: head.x,
      y: head.y,
      scale: Math.min(1.2, Math.max(0.55, pixelWidth / 380)),
    }
  }

  setBodyMood(mood: string): void {
    const map: Record<string, 'idle' | 'working' | 'needs-input' | 'ready' | 'blocked'> = {
      calm: 'idle',
      curious: 'ready',
      playful: 'ready',
      sleepy: 'needs-input',
      sad: 'blocked',
      excited: 'working',
      working: 'working',
      idle: 'idle',
      ready: 'ready',
      blocked: 'blocked',
    }
    this.bodyMood = mood
    this.orca.setMood(map[mood] ?? 'idle')
    if (mood === 'sleepy') this.setSleeping(true)
    else if (this.sleeping && mood !== 'sleepy') this.setSleeping(false)
  }

  setSleeping(on: boolean): void {
    this.sleeping = on
    this.orca.setSleeping(on)
  }

  /** Execute an inline body directive from the model. */
  perform(directive: BodyDirective): void {
    if (directive.mood !== undefined) this.setBodyMood(directive.mood)
    const act = directive.act ?? ''
    const now = Date.now()
    if (act === 'spin') {
      this.actionStarted = now
      this.spinUntil = now + 1500
      this.orca.setBoost(0.8)
    } else if (act === 'dive') {
      this.actionStarted = now
      this.actionUntil = now + 2400
      this.actionYTarget = -1.15
      this.orca.setBoost(0.55)
    } else if (act === 'surface') {
      this.actionStarted = now
      this.actionUntil = now + 2200
      this.actionYTarget = 1.1
      this.spawnBubbleBurst(6)
    } else if (act === 'nuzzle') {
      this.petOrca(true)
    } else if (act === 'blow') {
      this.spawnBubbleBurst(16)
      this.orca.setBoost(0.35)
    } else if (act === 'sleep') {
      this.setSleeping(true)
      this.setBodyMood('sleepy')
      this.sleepUntil = now + 9000
      this.orca.setBoost(0)
    } else if (act === 'wake') {
      this.sleepUntil = 0
      this.setSleeping(false)
      this.setBodyMood('curious')
      this.orca.setBoost(0.7)
    } else if (act === 'shake') {
      this.shakeTimer = 0.9
      this.spawnBubbleBurst(5)
    } else if (act === 'approach') {
      this.actionStarted = now
      this.actionUntil = now + 1800
      this.actionYTarget = 0.45
      this.orca.setBoost(0.75)
    } else if (act === 'calm') {
      this.actionUntil = 0
      this.actionYTarget = 0
      this.orca.setBoost(0)
      this.setBodyMood('calm')
    } else if (act === 'play') {
      this.actionStarted = now
      this.spinUntil = now + 1200
      this.happyTimer = 0.9
      this.spawnBubbleBurst(11)
      this.orca.setBoost(1)
      this.setBodyMood('playful')
    }
  }

  setPokeHandler(handler: (() => void) | null): void {
    this.pokeHandler = handler
  }

  /** A click on the speech bubble: the same happy squirm as touching the body. */
  poke(): void {
    // The bubble itself already picked a line for this poke, so the host's
    // poke handler must not speak a second, different one over the top.
    this.petOrca(true, false)
  }

  // ------------------------------------------------------------- host bridge

  /**
   * Snapshot of everything the host's controls display.
   *
   * Returned as a fresh object every call: the host is expected to compare it
   * against the previous one, so handing out a live reference would let it miss
   * changes it caused itself.
   */
  getGameState(): GameState {
    return {
      mode: this.mode,
      feedArmed: this.feedArmed,
      growth: this.growth,
      growthTarget: this.growthFor(this.save.growthFeeds),
      feedCount: this.save.feedCount,
      growthFeeds: this.save.growthFeeds,
      skin: this.save.skin,
      bloomStrength: this.save.bloomStrength,
      music: this.save.music,
      companion: this.save.companion,
      companionSeal: this.save.companionSeal,
      companionJelly: this.save.companionJelly,
      outlines: this.save.outlines,
      motionSpeed: this.save.motionSpeed,
      // Count the meshes actually standing on the sand rather than the saved
      // placements: a placement whose kind no longer exists is skipped on load,
      // so the group is the only honest count of what the player can see.
      decorCount: this.decorGroup.children.length,
      photoCount: this.photos.length,
    }
  }

  /** The album, as a copy — the caller may sort or mutate it freely. */
  getPhotos(): PhotoRecord[] {
    return this.photos.slice()
  }

  /** Decor catalogue, reduced to what a host-drawn picker needs. */
  getDecorKinds(): { id: string; name: string }[] {
    return DECOR_CATALOG.map(kind => ({ id: kind.id, name: kind.name }))
  }

  /** Skin swatches, with the colours the host needs to draw a gradient chip. */
  getSkins(): { id: string; label: string; dark: string; white: string }[] {
    // Copied for the same reason as getPhotos: this array is shared by the
    // module, and a host that sorts it in place would reorder our picker too.
    return skinOptions.map(option => ({ ...option }))
  }

  /** Whether the background music is currently on. */
  isMusicEnabled(): boolean {
    return this.audio.isMusicEnabled()
  }

  /**
   * Subscribe to state changes; returns the unsubscribe function.
   *
   * The host UI re-renders from this because most state changes start *inside*
   * the tank (a click on the canvas, a token being eaten) where React has no
   * other way to notice.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  /** Notify hosts that `GameState` moved. Never call this from the render loop. */
  private emitChange(): void {
    for (const fn of this.changeListeners) {
      // One host listener throwing must not take the other listeners, or the
      // frame that triggered the change, down with it.
      try {
        fn()
      } catch {
        /* isolated on purpose */
      }
    }
  }

  // ------------------------------------------------------------------ modes

  setMode(mode: AquariumMode): void {
    this.mode = mode
    if (mode !== 'decorating') this.clearGhost()
    // Feed mode only exists in the interactive view: leaving for decor or the
    // idle view must not leave the button armed behind the scenes.
    if (mode !== 'interactive') this.setFeedArmed(false)
    // Hovering the tank arms a swim boost; leaving for the idle view has to
    // disarm it, or the orca keeps sprinting with no pointer over the canvas.
    if (mode === 'ambient') this.orca.setBoost(0)
    this.applyModeToDom()
    this.emitChange()
  }

  setTheme(theme: ThemeId): void {
    this.theme = theme
    this.aquarium.setTheme(theme)
    this.emitChange()
  }

  setBloomStrength(strength: number): void {
    this.save.bloomStrength = Math.min(1.5, Math.max(0, strength))
    persistSave(this.save)
    this.postfx.setStrength(this.save.bloomStrength)
    this.emitChange()
  }

  setSkin(skin: string): void {
    if (!ORCA_SKINS[skin]) return
    this.save.skin = skin
    persistSave(this.save)
    this.orca.setSkin(skin)
    this.emitChange()
  }

  /** Toggle the background music and remember the choice. */
  toggleMusic(): void {
    const next = !this.audio.isMusicEnabled()
    this.save.music = next
    persistSave(this.save)
    this.audio.setMusicEnabled(next)
    this.showToast(next ? '🎵 音乐已开启' : '🔇 音乐已关闭')
    this.emitChange()
  }

  /**
   * Show or hide the clawd companion. There is exactly one, created lazily and
   * then kept; toggling never creates a second.
   */
  setCompanion(on: boolean): void {
    if (on && !this.clawd) {
      this.clawd = createClawdCompanion(COMPANION_HEIGHT)
      this.clawd.setOutlines(this.save.outlines)
      this.scene.add(this.clawd.group)
      // Start him on the orca so he does not fly in from the origin.
      this.clawd.group.position.copy(this.orca.group.position)
      this.clawd.group.position.z -= COMPANION_DISTANCE
    }
    if (this.clawd) this.clawd.group.visible = on
    this.resetTrailIfIdle()
    this.save.companion = on
    persistSave(this.save)
    this.showToast(on ? '🦀 Clawd 来啦' : '🦀 Clawd 先回家了')
    this.emitChange()
  }

  toggleCompanion(): void {
    this.setCompanion(!this.save.companion)
  }

  /**
   * Show or hide the GPT seal companion. Independent of Clawd — both may swim
   * together — but, like him, it is created once and only ever toggled, so a
   * second seal is structurally impossible.
   */
  setSealCompanion(on: boolean): void {
    if (on && !this.seal) {
      this.seal = createSealCompanion(SEAL_HEIGHT)
      this.seal.setOutlines(this.save.outlines)
      this.scene.add(this.seal.group)
      // Start it on the orca so it does not fly in from the origin.
      this.seal.group.position.copy(this.orca.group.position)
      this.seal.group.position.z -= COMPANION_DISTANCE
    }
    if (this.seal) this.seal.group.visible = on
    this.resetTrailIfIdle()
    this.save.companionSeal = on
    persistSave(this.save)
    this.showToast(on ? '🦭 Seal-GPT 来啦' : '🦭 Seal-GPT 回海里啦')
    this.emitChange()
  }

  toggleSealCompanion(): void {
    this.setSealCompanion(!this.save.companionSeal)
  }

  /**
   * Show or hide the jellyfish companion. Independent of the other two — all
   * three may drift together — and, like them, created once and only toggled,
   * so a second jellyfish is structurally impossible.
   */
  setJellyCompanion(on: boolean): void {
    if (on && !this.jelly) {
      this.jelly = createJellyCompanion(JELLY_HEIGHT)
      this.jelly.setOutlines(this.save.outlines)
      this.scene.add(this.jelly.group)
      // Start it on the orca so it does not fly in from the origin.
      this.jelly.group.position.copy(this.orca.group.position)
      this.jelly.group.position.z -= COMPANION_DISTANCE
    }
    if (this.jelly) this.jelly.group.visible = on
    this.resetTrailIfIdle()
    this.save.companionJelly = on
    persistSave(this.save)
    // 送走 Userlly 时把爱心排期清掉：它不在水里，就没人可示好；下次召唤重新
    // 从 HEART_FIRST_DELAY 起算，而不是接着上次的间隔继续。
    if (!on) this.nextHeartAt = 0
    this.showToast(on ? '💠 Userlly 飘过来啦' : '💠 Userlly 飘回海面了')
    this.emitChange()
  }

  toggleJellyCompanion(): void {
    this.setJellyCompanion(!this.save.companionJelly)
  }

  /**
   * Ink outlines on/off for every character at once. The shells are always
   * built (cheap, and the toggle is instant); they ship hidden and this is the
   * only thing that flips them.
   */
  setOutlines(on: boolean): void {
    this.save.outlines = on
    persistSave(this.save)
    this.orca.setOutlines(on)
    if (this.clawd) this.clawd.setOutlines(on)
    if (this.seal) this.seal.setOutlines(on)
    if (this.jelly) this.jelly.setOutlines(on)
    this.emitChange()
  }

  toggleOutlines(): void {
    this.setOutlines(!this.save.outlines)
    this.showToast(this.save.outlines ? '🖊️ 描边开' : '🖊️ 描边关')
  }

  /**
   * 动作速度。身体摇摆 / 横滚 / 尾鳍 / 胸鳍 / 体波共用一个倍率。
   *
   * 这个开关是给玩家的：同一套动画，有人读作"抖得可爱"，有人读作"抽搐"。
   * 与其替所有人选一个值，不如给一根滑杆 —— 而且它不影响任何玩法判定。
   */
  setMotionSpeed(scale: number): void {
    const next = Math.min(1.8, Math.max(0.4, scale))
    this.save.motionSpeed = next
    persistSave(this.save)
    this.orca.setMotionSpeed(next)
    this.emitChange()
  }

  /**
   * Drop the recorded path only when nobody is following it. Clearing it while
   * one companion is still visible would teleport the other one, because both
   * read their position straight out of this buffer.
   */
  private resetTrailIfIdle(): void {
    const busy =
      this.clawd?.group.visible === true || this.seal?.group.visible === true || this.jelly?.group.visible === true
    if (!busy) this.trail.length = 0
  }

  openFocus(): void {
    this.focusOpen = true
    this.setMode('interactive')
  }

  /**
   * The toolbar's back button.
   *
   * From decorating it goes back to *interactive*, not all the way out to
   * ambient: leaving the decor picker should not also throw away the toolbar.
   * Only an interactive session actually exits.
   *
   * Exiting is not "freezing the page" any more — ambient keeps the camera
   * grabbable and auto-rotating, and leaves the 🐋 button in the corner as the
   * way back in.
   */
  goBack(): void {
    if (this.mode === 'decorating') {
      this.setMode('interactive')
      return
    }
    this.closeFocus()
  }

  closeFocus(): void {
    this.focusOpen = false
    this.setMode('ambient')
  }

  private applyModeToDom(): void {
    const interactive = this.focusOpen || this.mode !== 'ambient'
    /*
     * Ambient is the idle view, not a dead page.
     *
     * It used to switch OrbitControls off *and* drop pointer-events on the
     * canvas, which meant pressing 返回 left the player looking at a tank they
     * could no longer turn — the camera still auto-rotated, so it read as a
     * broken drag rather than a deliberate "hands off" state. Ambient now
     * keeps the camera live (auto-rotating, but grabbable) and only takes the
     * game controls away: taps do nothing because every handler bails on
     * `mode === 'ambient'`, so there is no way to feed or decorate by accident.
     *
     * A *backdrop* instance is the exception. It lives behind a host page and
     * must never eat that page's clicks, so it stays fully inert — that is the
     * one case where the canvas is genuinely transparent to input.
     */
    const passive = this.mode === 'ambient' && this.background
    // The container stays transparent to input at all times — it spans the
    // whole viewport and would otherwise swallow every click meant for the
    // game's own controls. Only the canvas opts in.
    this.domElement.style.pointerEvents = passive ? 'none' : 'auto'
    this.controls.enabled = !passive
    this.controls.autoRotate = this.mode === 'ambient'
    // The game's own toolbar / decor picker / gallery used to be toggled here.
    // They no longer exist: the host draws every control in React, so there is
    // no engine-owned chrome left to show or hide. All that remains is the
    // ghost (the decor preview) — leaving a mode must clear it.
    if (!interactive) this.clearGhost()
  }

  /**
   * 提示信息转投宿主。
   *
   * 引擎里到处在 showToast("Clawd 来啦") 这类反馈；以前写进一个被 CSS 藏掉的
   * div，等于全静默。现在交给宿主决定怎么显示，没接回调就静默丢弃。
   */
  setToastHandler(handler: ((text: string) => void) | null): void {
    this.toastHandler = handler
  }

  private showToast(message: string): void {
    this.toastHandler?.(message)
  }

  // ------------------------------------------------------------------ events

  private bindEvents(): void {
    // ResizeObserver is Chrome 64+. The minitool container's floor is Chrome 61,
    // where the constructor does not exist and this would throw before the first
    // frame — so the observer is an enhancement and `resize` is the baseline.
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(this.onContainerResize)
      this.resizeObserver.observe(this.container)
    } else {
      window.addEventListener('resize', this.onContainerResize)
    }

    window.addEventListener('keydown', this.onKeyDown)

    this.renderer.domElement.addEventListener('pointerdown', (event) => {
      if (this.mode === 'ambient') return
      this.pointerFromEvent(event)
      // Arm a potential tap. Petting is decided on pointerup instead, so the
      // drag that orbits the camera is never mistaken for a stroke.
      this.pointerDownAt = { x: event.clientX, y: event.clientY }
      this.pointerDragged = false
      if (this.mode === 'decorating') {
        this.ghostDragging = true
        this.lastPointer = { x: event.clientX, y: event.clientY }
        this.updateGhost()
        // Right-click removes on desktop; touch users get the ✕ button in the
        // decor picker instead, so a tap here still means "place".
        if (event.button === 2) {
          this.removeDecorAtPointer()
          return
        }
        if (this.selectedDecor) {
          this.placeSelectedDecor(event)
          return
        }
        return
      }
    })

    this.renderer.domElement.addEventListener('pointerup', (event) => {
      if (this.mode !== 'interactive') return
      if (this.pointerDragged || !this.pointerDownAt) return
      // Only treat it as a tap if the finger barely moved.
      const moved = Math.hypot(event.clientX - this.pointerDownAt.x, event.clientY - this.pointerDownAt.y)
      this.pointerDownAt = null
      if (moved > 6) return
      this.pointerFromEvent(event)
      /*
       * Two interactions share the canvas, and feed mode decides what a click
       * means:
       *
       *   armed    — a click on a pet drops it a token; a click on water does
       *              nothing but hint, because "feed" has to be deliberate.
       *   disarmed — a click on a pet pets it, which is the default.
       *
       * It used to be "tap anywhere to feed", so a tap that missed the camera
       * drag dropped food into the tank.
       */
      if (this.feedArmed) {
        if (this.feedAtPointer()) return
        this.showToast('🪙 点一下虎鲸、Clawd、Seal-GPT 或 Userlly 才能投喂')
        return
      }
      if (this.petCompanion()) return
      if (this.petSeal()) return
      if (this.petJelly()) return
      this.petOrca()
    })

    this.renderer.domElement.addEventListener('pointermove', (event) => {
      if (this.pointerDownAt) {
        const moved = Math.hypot(event.clientX - this.pointerDownAt.x, event.clientY - this.pointerDownAt.y)
        if (moved > 6) this.pointerDragged = true
      }
      if (this.mode !== 'decorating') return
      this.pointerFromEvent(event)
      // A second finger reaches the canvas as a plain pointermove; rotating
      // the preview there keeps two-finger input useful without stealing the
      // pinch gesture from OrbitControls.
      if (this.ghostDragging && this.lastPointer && event.pointerType !== 'mouse') {
        this.rotateGhost((event.clientX - this.lastPointer.x) * 0.006)
      }
      if (this.lastPointer) this.lastPointer = { x: event.clientX, y: event.clientY }
      this.updateGhost()
    })

    const endGhostDrag = (): void => {
      this.ghostDragging = false
      this.lastPointer = null
      this.pointerDownAt = null
    }
    this.renderer.domElement.addEventListener('pointerup', endGhostDrag)
    this.renderer.domElement.addEventListener('pointercancel', endGhostDrag)

    this.renderer.domElement.addEventListener('wheel', (event) => {
      if (this.mode !== 'decorating' || !this.ghost) return
      event.preventDefault()
      this.rotateGhost(event.deltaY > 0 ? -0.35 : 0.35)
    }, { passive: false })

    this.renderer.domElement.addEventListener('contextmenu', (event) => {
      if (this.mode === 'decorating') event.preventDefault()
    })
  }

  /** Spin the decor preview. Desktop uses the wheel, touch uses the UI button. */
  rotateGhost(delta: number): void {
    if (this.ghost) this.ghost.rotation.y += delta
  }

  private pointerFromEvent(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth
    const h = this.container.clientHeight || window.innerHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.applyViewFit()
    this.renderer.setSize(w, h)
    this.postfx.setSize(w, h)
  }

  /**
   * Feed one frame's duration into the downgrade decision.
   *
   * Deliberately measured from the *raw* clock delta rather than the clamped
   * one used for animation: clamping at 50ms would hide exactly the stall this
   * is looking for. Frames longer than half a second are dropped instead of
   * counted, because those come from the page being restored or the tab being
   * thawed, not from a slow GPU.
   */
  private noteFrame(rawDt: number): void {
    if (this.degradeStep >= 2) return
    if (this.elapsed < DEGRADE_WARMUP_SECONDS) return
    if (!(rawDt > 0) || rawDt > 0.5) return

    this.frameSamples += 1
    this.frameTimeSum += rawDt
    if (this.frameSamples < DEGRADE_WINDOW_FRAMES) return

    const average = this.frameTimeSum / this.frameSamples
    this.frameSamples = 0
    this.frameTimeSum = 0
    if (average <= SLOW_FRAME_SECONDS) return
    this.degrade()
  }

  /** Step the renderer down one notch; see the constants for the ladder. */
  private degrade(): void {
    this.degradeStep += 1
    if (this.degradeStep === 1) {
      this.renderer.setPixelRatio(1)
      this.postfx.setPixelRatio(1)
      this.resize()
    } else if (this.postfx.bloom) {
      // Disabled rather than removed: the composer skips a disabled pass, and
      // the pass object stays valid for the capture path and the slider.
      this.postfx.bloom.enabled = false
    }
    document.documentElement.dataset.perf = `degraded-${this.degradeStep}`
  }

  /**
   * Frame the basin for the current aspect ratio, and size the orca's swim
   * orbit to match.
   *
   * A perspective camera's FOV is vertical, so a narrow portrait viewport has a
   * very small *horizontal* field. Rather than guess, the required standoff is
   * solved numerically: project the extreme orbit positions and find the closest
   * camera distance that keeps them all inside the frame with margin. That is
   * exact for any aspect ratio.
   *
   * The orbit is sized from the *visible* world width at that distance, which is
   * what makes the swim range feel right on every screen — the camera also
   * follows the orca (see the render loop), so its travel is relative to a
   * moving frame.
   */
  private applyViewFit(): void {
    const aspect = this.camera.aspect
    if (!Number.isFinite(aspect) || aspect <= 0) return

    const pitch = Math.atan2(CAMERA_HEIGHT, BASIN_FIT_HALF_WIDTH)
    const target = this.controls.target
    // Orbit half-extents; refined below once the standoff is known.
    let orbitX = BASIN_FIT_HALF_WIDTH * 0.4
    let orbitZ = BASIN_FIT_HALF_WIDTH * 0.3

    const fits = (distance: number): boolean => {
      this.camera.position.set(
        target.x,
        target.y + Math.sin(pitch) * distance,
        target.z + Math.cos(pitch) * distance,
      )
      this.camera.updateMatrixWorld(true)
      // The orca is ~4.6 long, so its nose reaches past its centre.
      const reach = orbitX + 2.4
      const depth = orbitZ + 2.0
      for (const [cx, cz] of [
        [-reach, -depth], [reach, -depth], [-reach, depth], [reach, depth],
      ] as const) {
        const p = new THREE.Vector3(target.x + cx, this.orcaRestY() + SWIM_AMP_Y + 1.8, target.z + cz).project(this.camera)
        if (Math.abs(p.x) > 1 / VIEW_FIT_MARGIN || Math.abs(p.y) > 1 / VIEW_FIT_MARGIN) return false
      }
      return true
    }

    let lo = VIEW_FIT_MIN_DISTANCE
    let hi = VIEW_FIT_MAX_DISTANCE
    if (fits(lo)) {
      hi = lo
    } else {
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        if (fits(mid)) hi = mid
        else lo = mid
      }
    }

    // Headroom: the toolbar is pinned to the top of the viewport, and the orca's
    // dorsal fin was poking up behind it. Raising the camera by a fixed amount
    // (rather than tilting it) lowers everything in frame without changing the
    // viewing angle.
    this.camera.position.set(
      target.x,
      target.y + Math.sin(pitch) * hi + FRAME_HEADROOM,
      target.z + Math.cos(pitch) * hi,
    )

    // Visible world extent at the orca's depth, then take a comfortable subset
    // of it as the swim orbit.
    // Take a generous share of the visible field as the swim orbit. The orca is
    // ~4.6 units long, so a loop narrower than roughly 3 body lengths reads as
    // circling in a tank rather than roaming.
    const depth = Math.max(1, hi - orbitZ)
    const vFov = (this.camera.fov * Math.PI) / 180
    const visibleHalfH = Math.tan(vFov / 2) * depth
    const visibleHalfW = visibleHalfH * aspect
    orbitX = Math.min(12.0, Math.max(4.0, visibleHalfW * 0.7))
    orbitZ = Math.min(9.0, Math.max(2.5, visibleHalfH * 0.38))
    this.orbitX = orbitX
    this.orbitZ = orbitZ
    // Keep the companions clear of the orca on every screen size. The orca's
    // on-screen half-width scales with how much of the frame it fills, so this
    // is expressed as a fraction of the visible width rather than a constant.
    this.companionSideOffset = Math.max(1.5, visibleHalfW * COMPANION_SIDE_FRACTION)
    this.sealSideOffset = Math.max(1.5, visibleHalfW * SEAL_SIDE_FRACTION)
    this.jellySideOffset = Math.max(0.8, visibleHalfW * JELLY_SIDE_FRACTION)

    // The swim target (Lissajous in startLoop) reads orbitX/orbitZ directly,
    // so a viewport change just re-scales the roam without any rebuild.

    // The camera tracks the orca, so orbit limits only need to keep the player
    // from shoving the view inside the seafloor.
    this.controls.minDistance = Math.max(10, hi * 0.55)
    this.controls.maxDistance = Math.max(34, hi * 1.4)
    this.controls.update()
  }

  // ------------------------------------------------------------------ feeding

  /**
   * The orca's recorded pose `lag` seconds ago. The trail is appended once per
   * frame in startLoop, so a fixed time lag keeps a companion's gap constant in
   * world units no matter how fast the orca happens to be swimming.
   */
  private sampleTrail(t: number, lag: number): { x: number; y: number; z: number; yaw: number; t: number } {
    const wantT = t - lag
    let sample = this.trail[0]
    for (const entry of this.trail) {
      if (entry.t <= wantT) sample = entry
      else break
    }
    return sample
  }

  /**
   * Size for a given number of tokens eaten.
   *
   * Saturating exponential rather than linear: the first token is worth 6% and
   * the tenth only another 25%, which keeps early feeds rewarding while
   * stopping a long session from producing an orca the tank cannot hold.
   */
  private growthFor(feeds: number): number {
    return 1 + GROWTH_MAX * (1 - Math.exp(-Math.max(0, feeds) / GROWTH_TAU))
  }

  /**
   * The orca's resting height, which has to rise as it grows. The model origin
   * is the body centre and the belly hangs 1.81 below it per unit of scale, so
   * without the lift a grown orca would drag its chin through the sand at the
   * bottom of the swim band.
   */
  private orcaRestY(): number {
    return ORCA_REST_Y + (this.growth - 1) * GROWTH_LIFT
  }

  /**
   * How far the nose sticks out ahead of the model origin, in world units.
   *
   * The orca's nose is on local -X (measured; the tail is on +X), so the nose
   * sits at the low end of the body sweep. Used to aim the *nose* at a token
   * instead of the body centre — otherwise the orca stops with the food under
   * its belly and never looks like it is eating. Multiplied by the current
   * growth, because the group is scaled at draw time and the reach scales
   * with it.
   */
  private noseReach(): number {
    return Math.abs(this.orca.bodySwept.xs[0] * this.orca.bodyScale) * this.growth
  }

  /** World-space position of the nose, written into `nosePoint`. */
  private updateNosePoint(): THREE.Vector3 {
    const localX = this.orca.bodySwept.xs[0] * this.orca.bodyScale * this.growth
    const yaw = this.orca.group.rotation.y
    const p = this.orca.group.position
    // Rotating (localX, 0, 0) about +Y by yaw gives (cos·localX, 0, -sin·localX).
    this.nosePoint.set(p.x + Math.cos(yaw) * localX, p.y, p.z - Math.sin(yaw) * localX)
    return this.nosePoint
  }

  /**
   * Drop a token into the water, aimed at the pet that will eat it.
   *
   * `at` is the pet's position; with no argument the token is dropped just
   * above the orca. Either way it falls from `FEED_DROP_HEIGHT` above that
   * point, and the owner comes over to eat it — the eating itself is resolved
   * in the render loop.
   */
  feed(at?: THREE.Vector3, owner: FeedTarget = 'orca'): void {
    if (this.mode === 'ambient') return
    // Feeding from the decor panel would leave the ghost armed and confusing.
    if (this.mode === 'decorating') this.setMode('interactive')

    const anchor = at ?? this.orca.group.position
    const spawn = new THREE.Vector3(
      anchor.x + (Math.random() - 0.5) * FEED_SCATTER,
      // Drop from above the *water surface* the player can see, never from
      // inside the orca.
      Math.max(anchor.y, this.orcaRestY()) + FEED_DROP_HEIGHT,
      anchor.z + (Math.random() - 0.5) * FEED_SCATTER,
    )
    // Settle just above the sand, but never below the orca's swim band — a
    // token it physically cannot reach would just time out. The band rises
    // with the orca, so this has to be read after the growth has settled.
    const floorY = Math.max(heightAt(spawn.x, spawn.z) + 0.7, this.orcaRestY() - SWIM_AMP_Y)

    // Aim the coin's lean at the camera, so its face is presented to the player
    // instead of being caught edge-on. The camera sits behind and above the
    // tank, so its XZ offset from the drop point is the direction to lean
    // toward; the sign convention matches atan2(dx, dz) because the coin's
    // normal starts on +Z after the lean.
    const faceYaw = Math.atan2(
      this.camera.position.x - spawn.x,
      this.camera.position.z - spawn.z,
    )

    const token = createTokenDrop(spawn, floorY, faceYaw, owner)
    this.scene.add(token.group)
    this.feedItems.push(token)
    while (this.feedItems.length > MAX_TOKENS) this.removeToken(this.feedItems[0])

    this.audio.playCoin()
    this.audio.playBubble()
    this.spawnBubbleBurst(5)
  }

  /**
   * Feed mode on/off.
   *
   * Arming drops nothing by itself — it only changes what a click on a pet
   * means. That is the whole point: a token should never land in the tank
   * because a tap meant to drag the camera, and petting should stay the
   * default interaction.
   */
  toggleFeedArmed(): void {
    if (this.mode === 'ambient') return
    // Arming from the decor panel would leave the ghost armed and confusing.
    if (this.mode === 'decorating') this.setMode('interactive')
    this.setFeedArmed(!this.feedArmed)
    this.showToast(
      this.feedArmed ? '🪙 点一下虎鲸 / Clawd / Seal-GPT / Userlly，把 token 喂给它' : '🪙 投喂已关闭，可以正常互动',
    )
    if (this.feedArmed) this.audio.playClicks()
  }

  setFeedArmed(on: boolean): void {
    if (this.feedArmed === on) return
    this.feedArmed = on
    // The cursor is the only in-world hint that the next click means something
    // different from the last one.
    this.domElement.style.cursor = on ? 'crosshair' : ''
    this.emitChange()
  }

  /**
   * Drop a token on whichever pet was clicked. Returns false when the click
   * missed all three, so the caller can nudge the player instead of silently
   * doing nothing.
   */
  private feedAtPointer(): boolean {
    this.raycaster.setFromCamera(this.pointer, this.camera)
    if (this.raycaster.intersectObject(this.orca.group, true).length > 0) {
      this.feed(undefined, 'orca')
      return true
    }
    for (const [companion, owner] of [
      [this.clawd, 'clawd'],
      [this.seal, 'seal'],
      [this.jelly, 'jelly'],
    ] as const) {
      if (!companion || !companion.group.visible) continue
      if (this.raycaster.intersectObject(companion.group, true).length > 0) {
        this.feed(companion.group.position.clone(), owner)
        return true
      }
    }
    return false
  }

  private removeToken(token: TokenDrop): void {
    const index = this.feedItems.indexOf(token)
    if (index >= 0) this.feedItems.splice(index, 1)
    this.scene.remove(token.group)
    token.dispose()
  }

  /**
   * The companion a token belongs to, or null when the token is the orca's —
   * including when its companion has been sent home, because a token nobody
   * can eat would just time out.
   */
  private tokenCompanion(token: TokenDrop): FeedingCompanion | null {
    if (token.owner === 'clawd') return this.clawd?.group.visible ? this.clawd : null
    if (token.owner === 'seal') return this.seal?.group.visible ? this.seal : null
    if (token.owner === 'jelly') return this.jelly?.group.visible ? this.jelly : null
    return null
  }

  /** The token the orca should be heading for: the nearest one that is its own. */
  private nearestToken(): TokenDrop | null {
    let best: TokenDrop | null = null
    let bestDistance = Infinity
    for (const token of this.feedItems) {
      if (token.done) continue
      // A token dropped for a companion is not the orca's to chase; it would
      // otherwise hover over food it is not allowed to eat.
      if (token.owner !== 'orca' && this.tokenCompanion(token)) continue
      const d = token.position.distanceToSquared(this.orca.group.position)
      if (d < bestDistance) {
        bestDistance = d
        best = token
      }
    }
    return best
  }

  /**
   * The token a companion should be swimming toward: the nearest one that is
   * its own and has not been swallowed yet. `consumed` is excluded because the
   * token is still in the water (shrinking) while the pet would otherwise keep
   * nosing at it.
   */
  private companionFood(owner: FeedTarget, at: THREE.Vector3): TokenDrop | null {
    let best: TokenDrop | null = null
    let bestDistance = Infinity
    for (const token of this.feedItems) {
      if (token.done || token.consumed || token.owner !== owner) continue
      const d = token.position.distanceToSquared(at)
      if (d < bestDistance) {
        bestDistance = d
        best = token
      }
    }
    return best
  }

  /**
   * Ease a companion's interest in its own token and, while it cares, slide
   * the follow point off the formation slot and onto the food. Returns the new
   * interest so the caller can keep it in a field.
   *
   * `point` is mutated in place — it is the shared `followPoint` scratch
   * vector, which is rewritten for each pet and for the orca's own target.
   * The rise is capped because a token is dropped 5 units up: uncapped, the
   * pet launches out of its depth band toward the surface, and the follow
   * camera brings the whole tank with it. The token sinks into reach anyway.
   */
  private pullFood(pull: number, owner: FeedTarget, point: THREE.Vector3, dt: number): number {
    const food = this.companionFood(owner, point)
    const next = pull + ((food ? 1 : 0) - pull) * this.expLerp(COMPANION_FOOD_TAU, dt)
    if (food && next > 0.001) {
      this.foodPoint.set(
        food.position.x,
        Math.min(food.position.y, point.y + COMPANION_FOOD_RISE),
        food.position.z,
      )
      point.lerp(this.foodPoint, next * COMPANION_FOOD_PULL)
    }
    return next
  }

  /** Can this token's owner reach it this frame? */
  private tokenReaches(token: TokenDrop, nose: THREE.Vector3): boolean {
    const companion = this.tokenCompanion(token)
    if (!companion) return nose.distanceTo(token.position) < EAT_RADIUS
    return companion.group.position.distanceTo(token.position) < COMPANION_EAT_RADIUS
  }

  /**
   * Advance every token and resolve the eating. Called once per frame from the
   * render loop, after the orca has moved.
   */
  private updateFeeding(t: number, dt: number): void {
    if (this.feedItems.length === 0) return

    const nose = this.updateNosePoint()
    let eaten: TokenDrop | null = null
    let expired: TokenDrop | null = null

    for (const token of this.feedItems) {
      token.update(t, dt)
      // `consumed` — not `done` — is the trigger. A token mid-swallow is still
      // in the water and still next to the nose, so testing `done` here fired
      // the thank-you on every frame of the 0.2s shrink.
      if (eaten === null && !token.consumed && this.tokenReaches(token, nose)) {
        token.consume()
        eaten = token
      }
      // Only a token that was never bitten can "time out"; one that finished
      // its swallow animation also flips `done`, and must not be reported.
      if (expired === null && token.done && !token.consumed) expired = token
    }

    // Remove anything that finished this frame (eaten swallow animations
    // finish on a later frame, so they are culled by the sweep below).
    for (const token of [...this.feedItems]) {
      if (token.done) this.removeToken(token)
    }

    if (eaten) this.onTokenEaten(eaten)
    else if (expired) {
      this.showThought(UNEATEN_LINES[Math.floor(Math.random() * UNEATEN_LINES.length)], 1400)
    }
  }

  /**
   * The payoff: a pet has just swallowed a token.
   *
   * Only the orca grows. The companions are along for the meal — letting them
   * grow too would turn the tank into a size contest, and the whole growth gag
   * is about the whale you are keeping.
   */
  private onTokenEaten(token: TokenDrop): void {
    this.save.lastFeedAt = Date.now()
    this.audio.playMunch()
    this.audio.playChime()
    this.spawnBubbleBurst(6)

    const companion = this.tokenCompanion(token)
    if (companion) {
      companion.react()
      // A token eaten by a companion is still an interaction with it, and the
      // existing pet counters are the natural place to keep that tally.
      if (token.owner === 'clawd') this.save.companionPets += 1
      else if (token.owner === 'seal') this.save.companionSealPets += 1
      else this.save.companionJellyPets += 1
      persistSave(this.save)
      // 只有 Clawd 和 Seal-GPT 会道谢。Userlly 不冒台词 —— 它是用户本人，
      // 替玩家开口就等于夺舍；吃 token 这件事用下面那条中性 toast 交代就够。
      if (token.owner !== 'jelly') {
        const thanks = token.owner === 'clawd' ? CLAWD_THANKS_LINES : SEAL_THANKS_LINES
        this.showThought(thanks[Math.floor(Math.random() * thanks.length)], 1600, companion.group.position)
      }
      this.showToast(
        token.owner === 'clawd'
          ? '🦀 Clawd 吃掉一枚 token'
          : token.owner === 'seal'
            ? '🦭 Seal-GPT 吃掉一枚 token'
            : '💠 Userlly 吃掉一枚 token',
      )
      return
    }

    this.save.feedCount += 1
    this.save.growthFeeds += 1
    persistSave(this.save)
    // The counters just moved and the host draws both of them. Emitted here
    // rather than in the render loop, which only ever eases `growth` toward the
    // value these two imply.
    this.emitChange()

    // Reuse the photo-moment happy pulse: a squash-and-stretch plus a wiggle,
    // which reads as a satisfied wriggle. The growth itself is eased in the
    // render loop, so the bite swells visibly over the next half second.
    this.happyTimer = 0.9
    this.showToast(`🪙 吃掉一枚 token · 体型 ×${this.growthFor(this.save.growthFeeds).toFixed(2)}`)
    // Every fifth token is a visible size step, so it gets its own line.
    const milestone = this.save.growthFeeds % 5 === 0
    const lines = milestone ? GROWTH_LINES : THANKS_LINES
    this.showThought(lines[Math.floor(Math.random() * lines.length)], 1600)
    // All three companions celebrate with it.
    this.clawd?.react()
    this.seal?.react()
    this.jelly?.react()
  }

  /**
   * Put the orca back to the size it was when the player met it.
   *
   * Only the *growth* counter is cleared — `feedCount` is the lifetime tally
   * and survives, so 复原 is "start growing again from scratch", not "forget
   * everything I ever fed you".
   */
  resetGrowth(): void {
    if (this.save.growthFeeds === 0) {
      this.showToast('🐋 它已经是原来的大小啦')
      return
    }
    this.save.growthFeeds = 0
    persistSave(this.save)
    this.audio.playChime()
    this.showToast(`🐋 回到原来的大小（累计吃掉 ${this.save.feedCount} 枚 token）`)
    this.showThought('诶？我怎么变小了', 1500)
    this.emitChange()
  }

  /** Clicking Clawd makes him squeak. Returns true if he was the one hit. */
  private petCompanion(): boolean {
    if (!this.clawd || !this.clawd.group.visible) return false
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObject(this.clawd.group, true).length > 0
    // 和 petSeal 同理：热区小，点偏 26px 以内也算摸到它。
    if (!hit && !this.pointerNear(this.clawd.group, 26)) return false

    this.clawd.react()
    this.save.companionPets += 1
    persistSave(this.save)
    this.audio.playClicks()
    this.showThought(
      CLAWD_LINES[Math.floor(Math.random() * CLAWD_LINES.length)],
      1400,
      this.clawd.group.position,
    )
    return true
  }

  /**
   * 指针是否落在某个物体投影点的 N 像素内（屏幕空间容差）。
   *
   * 为什么需要：海豹只有 1.5 单位高，射线命中区很小；手机上点偏一点就会
   * 「没点中海豹」，然后落到最后的 petOrca() —— 于是出现「点了海豹，虎鲸头顶
   * 冒出台词」。给伙伴加一圈屏幕容差，点偏也算摸到它。
   */
  private pointerNear(group: THREE.Object3D, radiusPx: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const projected = group.position.clone().project(this.camera)
    if (projected.z > 1 || projected.z < -1) return false
    const sx = (projected.x * 0.5 + 0.5) * rect.width
    const sy = (-projected.y * 0.5 + 0.5) * rect.height
    const px = (this.pointer.x * 0.5 + 0.5) * rect.width
    const py = (-this.pointer.y * 0.5 + 0.5) * rect.height
    return Math.hypot(sx - px, sy - py) <= radiusPx
  }

  /** Clicking the seal makes it squeak. Returns true if it was the one hit. */
  private petSeal(): boolean {
    if (!this.seal || !this.seal.group.visible) return false
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObject(this.seal.group, true).length > 0
    // 热区很小：点偏 28px 以内也算摸到海豹，避免落到虎鲸身上。
    if (!hit && !this.pointerNear(this.seal.group, 28)) return false

    this.seal.react()
    this.save.companionSealPets += 1
    persistSave(this.save)
    this.audio.playClicks()
    this.showThought(
      SEAL_LINES[Math.floor(Math.random() * SEAL_LINES.length)],
      1400,
      this.seal.group.position,
    )
    return true
  }

  /**
   * Clicking Userlly makes it pump. Returns true if it was the one hit.
   *
   * 只有音效和鼓伞盖，**永远不冒台词**：它代表用户本人，一说话就成了
   * 玩家被自己的替身夺舍。
   */
  private petJelly(): boolean {
    if (!this.jelly || !this.jelly.group.visible) return false
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObject(this.jelly.group, true).length > 0
    // A jellyfish is mostly empty water: the bell is wide but the body is soft
    // and translucent, so the tap target is widened like the seal's.
    if (!hit && !this.pointerNear(this.jelly.group, 30)) return false

    this.jelly.react()
    this.save.companionJellyPets += 1
    persistSave(this.save)
    this.audio.playClicks()
    return true
  }

  /**
   * Clicking the orca while feed mode is off: a happy wriggle and a line.
   *
   * This is what the click did before tokens existed — the feeding gag has its
   * own mode now, so an ordinary tap should feel like petting an animal again
   * rather than dropping food on it.
   */
  private petOrca(force = false, noteTouch = true): boolean {
    if (!force) {
      this.raycaster.setFromCamera(this.pointer, this.camera)
      if (this.raycaster.intersectObject(this.orca.group, true).length === 0) return false
    }

    this.happyTimer = 0.7
    if (noteTouch) {
      this.lastTouchAt = Date.now()
      bodyMind.note('touch', '用户伸手碰了碰你的身体')
      // 点身体这条路径由宿主的气泡说话（它还会把这次触摸记进身体上下文），
      // 所以这里**不能**再冒一句台词 —— 同一个动作出现两句不一样的话，
      // 玩家会以为是自己点重了。
      this.pokeHandler?.()
    } else {
      // 模型驱动的撒娇（nuzzle 指令、回复时的摆尾）没有气泡路径，用引擎自己的台词。
      this.showThought(PET_LINES[Math.floor(Math.random() * PET_LINES.length)], 1400)
    }
    // 哨音（orca sound.html 那套）而不是原来的短促 chime：被摸的是一头虎鲸，
    // 它该叫一声，而不是像点了个按钮。
    this.audio.playWhistle()
    this.spawnBubbleBurst(4)
    return true
  }

  // ------------------------------------------------------------------ decor

  private applyDecorPlacements(): void {
    for (const child of [...this.decorGroup.children]) {
      this.decorGroup.remove(child)
    }
    for (const placement of this.save.decor) {
      const kind = findDecorKind(placement.kindId)
      if (!kind) continue
      const mesh = createDecorMesh(placement.kindId)
      mesh.position.set(placement.x, heightAt(placement.x, placement.z), placement.z)
      mesh.rotation.y = placement.rotationY
      mesh.userData.placement = placement
      this.decorGroup.add(mesh)
    }
  }

  /**
   * Arm a decor kind for placement. Public because the host draws its own
   * picker; the in-game one calls the very same method.
   */
  selectDecor(kindId: string): void {
    this.clearGhost()
    this.selectedDecor = kindId
    this.ghost = createDecorMesh(kindId)
    this.ghost.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh
        mesh.material = (mesh.material as THREE.Material).clone()
        ;(mesh.material as THREE.MeshStandardMaterial).transparent = true
        ;(mesh.material as THREE.MeshStandardMaterial).opacity = 0.45
        ;(mesh.material as THREE.MeshStandardMaterial).depthWrite = false
      }
    })
    this.ghost.visible = false
    this.scene.add(this.ghost)
    this.emitChange()
  }

  private clearGhost(): void {
    if (this.ghost) {
      this.scene.remove(this.ghost)
      this.ghost = null
    }
    this.selectedDecor = null
  }

  private groundPointFromPointer(): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -heightAt(0, 0))
    const point = new THREE.Vector3()
    const hit = this.raycaster.ray.intersectPlane(plane, point)
    if (!hit) return null
    if (Math.abs(point.x) > DECOR_HALF_W || Math.abs(point.z) > DECOR_HALF_D) return null
    return point
  }

  private updateGhost(): void {
    if (!this.ghost) return
    const point = this.groundPointFromPointer()
    if (!point) {
      this.ghost.visible = false
      return
    }
    this.ghost.visible = true
    this.ghost.position.set(point.x, heightAt(point.x, point.z), point.z)
    if (this.collidesWithDecor(point.x, point.z)) {
      this.ghost.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          ;((obj as THREE.Mesh).material as THREE.MeshStandardMaterial).color.setHex(0xff5566)
        }
      })
    } else {
      this.ghost.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          ;((obj as THREE.Mesh).material as THREE.MeshStandardMaterial).color.setHex(0xffffff)
        }
      })
    }
  }

  private collidesWithDecor(x: number, z: number): boolean {
    const kind = this.selectedDecor ? findDecorKind(this.selectedDecor) : undefined
    const radius = kind?.radius ?? 0.6
    for (const child of this.decorGroup.children) {
      const dx = child.position.x - x
      const dz = child.position.z - z
      const childKind = findDecorKind((child.userData.placement as DecorPlacement | undefined)?.kindId ?? '')
      const childRadius = childKind?.radius ?? 0.6
      if (Math.hypot(dx, dz) < (radius + childRadius) * 0.75) return true
    }
    return false
  }

  private placeSelectedDecor(event: PointerEvent): void {
    if (!this.selectedDecor || !this.ghost) return
    const point = this.groundPointFromPointer()
    if (!point) return
    if (this.collidesWithDecor(point.x, point.z)) {
      this.showToast('这里放不下，换一个位置试试')
      return
    }
    const placement: DecorPlacement = {
      kindId: this.selectedDecor,
      x: point.x,
      z: point.z,
      rotationY: this.ghost.rotation.y,
    }
    this.save.decor.push(placement)
    persistSave(this.save)

    const mesh = createDecorMesh(placement.kindId)
    mesh.position.set(placement.x, heightAt(placement.x, placement.z), placement.z)
    mesh.rotation.y = placement.rotationY
    mesh.userData.placement = placement
    this.decorGroup.add(mesh)
    this.audio.playBubble()
    this.showToast('已放置')
    event.stopPropagation()
    // Placing is a canvas click, so nothing on the host side knows the decor
    // count moved unless we say so.
    this.emitChange()
  }

  private removeDecorAtPointer(): void {
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObject(this.decorGroup, true)
    if (hits.length === 0) return
    let top = hits[0].object
    while (top.parent && top.parent !== this.decorGroup) top = top.parent
    const placement = top.userData.placement as DecorPlacement | undefined
    if (!placement) return
    this.decorGroup.remove(top)
    this.save.decor = this.save.decor.filter(p => p !== placement)
    persistSave(this.save)
    this.showToast('已移除装饰')
    this.emitChange()
  }

  getSave(): SaveData {
    return this.save
  }

  resetDecor(): void {
    this.save.decor = []
    persistSave(this.save)
    this.applyDecorPlacements()
    this.clearGhost()
    this.showToast('海底布置已清空')
    this.emitChange()
  }

  // ------------------------------------------------------------------ photo

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms))
  }

  private flashPhoto(tone: 'gold' | 'paper'): void {
    this.photoFlash.dataset.tone = tone
    this.photoFlash.dataset.active = 'true'
    window.setTimeout(() => {
      this.photoFlash.dataset.active = 'false'
    }, 180)
  }

  /**
   * Take a photo and hand the new album entry back.
   *
   * The return value is for the embedded host, which draws its own gallery: it
   * needs the finished record rather than having to re-read localStorage. `null`
   * means nothing was captured — a shot was already in flight, or it threw.
   */
  async takePhoto(): Promise<PhotoRecord | null> {
    if (this.photoBusy) return null
    this.photoBusy = true
    try {
      // 1. Pose moment: the orca holds still, in whatever attitude it had.
      const event = pickPhotoEvent(this.photos.length === 0)
      this.poseAnchor.copy(this.orca.group.position)
      this.poseTimer = 1.0
      // Hold the heading it already has instead of aiming the nose at the
      // camera. Forcing the turn made every shot the same front-on portrait —
      // the opposite of a snapshot, and it hid the whole "it swam away from
      // you" side of the photo game.
      this.poseTargetYaw = this.orca.group.rotation.y
      this.showThought(POSE_LINES[Math.floor(Math.random() * POSE_LINES.length)], 900)
      await this.delay(330)

      // 2. Shutter: flash, then the orca may playfully spoil the shot.
      this.flashPhoto('paper')
      this.playShutter()
      if (event === 'turnaway') {
        const yaw = Math.atan2(this.camera.position.x - this.orca.group.position.x, this.camera.position.z - this.orca.group.position.z)
        this.poseTargetYaw = yaw + (Math.random() < 0.5 ? 2.9 : -2.9)
      } else if (event === 'wiggle') {
        this.shakeTimer = 0.62
      } else if (event === 'splash') {
        this.spawnBubbleBurst(9)
        this.audio.playBubble()
      }
      await this.delay(240)

      // 3. Capture the fresh frame. This goes through the composer so the
      //    saved photo carries the same bloom and grade the player sees.
      const canvas = this.postfx.capture(this.scene, this.camera)
      const raw = canvas.toDataURL('image/jpeg', 0.92)
      const quality = evaluatePhotoQuality(this.orca.group, this.camera)
      const blurry = event === 'wiggle'
      const framed = await composeFramedPhoto(raw, quality, this.theme, blurry)
      const thumb = await makeThumb(framed)
      const now = new Date()
      const record: PhotoRecord = {
        id: `${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
        dataURL: framed,
        thumbURL: thumb,
        quality,
        theme: this.theme,
        label: blurry ? `${PHOTO_QUALITY[quality].label} · ${BLURRY_STYLE.label}` : PHOTO_QUALITY[quality].label,
        dateLabel: now.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        timestamp: now.getTime(),
        blurry,
      }
      this.photos.push(record)
      if (this.photos.length > MAX_PHOTOS) this.photos = this.photos.slice(-MAX_PHOTOS)
      persistPhotos(this.photos)
      // The album is part of GameState (photoCount) and the host shows its own
      // copy of the shots, so tell it as soon as the record is safely stored.
      this.emitChange()

      // 4. Reaction moment.
      if (quality === 'perfect' || quality === 'closeup') {
        this.happyTimer = 0.9
        this.spawnBubbleBurst(5)
        this.playDing()
        this.flashPhoto('gold')
        this.showThought(GOOD_LINES[Math.floor(Math.random() * GOOD_LINES.length)], 1600)
      } else if (quality === 'back') {
        this.showThought(BACK_LINES[Math.floor(Math.random() * BACK_LINES.length)], 1500)
      } else if (event === 'wiggle') {
        this.showThought(WIGGLE_LINES[Math.floor(Math.random() * WIGGLE_LINES.length)], 1500)
      } else {
        this.showThought(DAILY_LINES[Math.floor(Math.random() * DAILY_LINES.length)], 1400)
      }
      this.showToast(`${PHOTO_QUALITY[quality].emoji} 已存入照片集 · ${PHOTO_QUALITY[quality].label}`)
      return record
    } catch (error) {
      // 以前这里是裸 catch：拍照失败只弹一句「请重试」，日志里什么都没有，
      // 排查时只能靠猜是哪一步炸的（取景 / 回读 / 拼拍立得 / 缩略图）。
      // 留一条 warn，吵不到用户，但能定位。
      console.warn('[orca] takePhoto failed', error)
      this.showToast('拍照失败，请重试')
      return null
    } finally {
      this.photoBusy = false
      this.poseTargetYaw = null
      // Keep a short tail of the pose so the orca eases back into swimming.
      this.poseTimer = Math.min(this.poseTimer, 0.35)
    }
  }

  /** Delete one album entry. Public so the host's own gallery can offer the ✕. */
  deletePhoto(id: string): void {
    this.photos = this.photos.filter(p => p.id !== id)
    persistPhotos(this.photos)
    this.showToast('照片已删除')
    this.emitChange()
  }

  // ------------------------------------------------------------------ feedback

  /**
   * 在屏幕空间冒一句台词（拍照/投喂/伙伴被摸这类一次性反馈）。
   *
   * 定位以前是 `left = clamp(sx, 12, w-240)`：把「pill 的 max-width 240」当成
   * 真实宽度、并且按**左边缘**摆位。手机 CSS 宽约 393px 时 `w-240 = 153`，
   * 于是任何靠右侧的目标（右舷的海豹）台词都被死夹到屏幕左半，正好落在
   * 虎鲸头顶 —— 用户看到的就是「点海豹，话出现在虎鲸头上」。
   * 现在改成：先写文本量出真实宽度 → 以 anchor 投影点为中心摆位 → 夹在视口内，
   * 并把尾巴的横向位置一起算出来（CSS 用 var(--thought-tail-x) 跟随）。
   */
  private showThought(text: string, stayMs = 1500, anchor?: THREE.Vector3): void {
    if (!this.thoughtEl) {
      this.thoughtEl = document.createElement('div')
      this.thoughtEl.className = 'orca-thought'
      this.container.appendChild(this.thoughtEl)
    }
    const projected = (anchor ?? this.orca.group.position).clone().project(this.camera)
    const w = window.innerWidth
    const h = window.innerHeight
    const sx = (projected.x * 0.5 + 0.5) * w
    // 伙伴（海豹/Clawd）比虎鲸低一点，抬得少一些；虎鲸用原来的 150。
    const sy = (-projected.y * 0.5 + 0.5) * h - (anchor ? 90 : 150)
    this.thoughtEl.textContent = text
    // 必须先写文本再量宽度：文本长短决定 pill 多宽，写死 240 会把右侧台词拽到左边。
    const pillW = this.thoughtEl.offsetWidth || 160
    const pillH = this.thoughtEl.offsetHeight || 36
    const margin = 12
    const left = Math.max(margin, Math.min(w - pillW - margin, sx - pillW / 2))
    const top = Math.max(margin, Math.min(h - pillH - margin, sy))
    this.thoughtEl.style.left = `${left}px`
    this.thoughtEl.style.top = `${top}px`
    // 尾巴跟着 anchor 走（左边缘量），夹在圆角之内，不然小圆角会被尾巴戳破。
    const tail = Math.max(14, Math.min(pillW - 14, sx - left))
    this.thoughtEl.style.setProperty('--thought-tail-x', `${tail}px`)
    this.thoughtEl.dataset.show = 'true'
    this.thoughtUntil = performance.now() + stayMs
  }

  private spawnBubbleBurst(count = 7): void {
    const projected = this.orca.group.position.clone().project(this.camera)
    if (projected.z > 1 || projected.z < -1) return
    const w = window.innerWidth
    const h = window.innerHeight
    const sx = (projected.x * 0.5 + 0.5) * w
    const sy = (-projected.y * 0.5 + 0.5) * h
    for (let i = 0; i < count; i++) {
      const bubble = document.createElement('span')
      bubble.className = 'orca-dom-bubble'
      const size = 8 + Math.random() * 14
      bubble.style.width = `${size}px`
      bubble.style.height = `${size}px`
      bubble.style.left = `${sx + (Math.random() - 0.5) * 70}px`
      bubble.style.top = `${sy + (Math.random() - 0.5) * 40}px`
      this.container.appendChild(bubble)
      window.setTimeout(() => bubble.remove(), 1300)
    }
  }

  // ----------------------------------------------------------------- glyphs

  /**
   * 伙伴朝 Userlly 冒爱心。
   *
   * Userlly 代表用户本人，所以虎鲸 / Clawd / Seal-GPT 会时不时朝它示好：
   * 发起者随机、间隔随机，**只有爱心图形，没有任何文字**（一有文字就又成了
   * 台词，而台词在 Userlly 身上是被明令禁止的）。
   *
   * 谁在场谁才能示好 —— Userlly 不在水里就没有对象可示好，另外两个伙伴不在
   * 就只剩虎鲸一个发起者。排期走 elapsed 时钟而不是 setTimeout：页面隐藏时
   * 渲染循环会降频，setTimeout 会在这期间攒下一串爱心，回来的一瞬间全炸出来。
   */
  private updateAdmiration(t: number): void {
    const jelly = this.jelly
    if (!jelly || !jelly.group.visible) {
      this.nextHeartAt = 0
      return
    }
    const givers: THREE.Object3D[] = [this.orca.group]
    if (this.clawd?.group.visible === true) givers.push(this.clawd.group)
    if (this.seal?.group.visible === true) givers.push(this.seal.group)

    if (this.nextHeartAt === 0) {
      this.nextHeartAt = t + HEART_FIRST_DELAY
      return
    }
    if (t < this.nextHeartAt) return
    this.nextHeartAt = t + HEART_GAP_MIN + Math.random() * (HEART_GAP_MAX - HEART_GAP_MIN)

    const giver = givers[Math.floor(Math.random() * givers.length)]
    // 从发起者头顶冒出来，而不是从身体中心：爱心从模型里穿出来会显得很脏。
    this.glyphBox.setFromObject(giver)
    if (this.glyphBox.isEmpty()) return
    this.glyphAnchor.set(
      (this.glyphBox.min.x + this.glyphBox.max.x) * 0.5 + (Math.random() - 0.5) * 0.3,
      this.glyphBox.max.y - 0.06,
      (this.glyphBox.min.z + this.glyphBox.max.z) * 0.5 + (Math.random() - 0.5) * 0.3,
    )
    this.glyphs.spawn('heart', this.glyphAnchor, {
      drift: jelly.group.position,
      size: HEART_SIZE,
      life: HEART_LIFE,
    })
  }

  /**
   * 睡觉时头顶持续冒 Z（Z z z 交替、错峰上浮渐隐）。
   *
   * 醒来那一帧必须清干净：一个 Z 还飘在醒着的虎鲸头顶，看起来像卡住了，
   * 比没有 Zzz 更糟。
   */
  private updateSleepZzz(t: number): void {
    if (!this.sleeping) {
      if (this.nextZzzAt !== 0) {
        this.nextZzzAt = 0
        this.glyphs.clear('zzz')
      }
      return
    }
    // 刚睡着：第一个 Z 立刻冒出来，别让玩家等一个间隔才看到反馈。
    if (this.nextZzzAt === 0) this.nextZzzAt = t
    if (t < this.nextZzzAt) return
    this.nextZzzAt = t + ZZZ_GAP_MIN + Math.random() * (ZZZ_GAP_MAX - ZZZ_GAP_MIN)

    const head = this.headTopWorld(this.glyphAnchor)
    head.x += (Math.random() - 0.5) * ZZZ_SPREAD
    head.z += (Math.random() - 0.5) * ZZZ_SPREAD
    this.glyphs.spawn('zzz', head, { size: ZZZ_SIZE, life: ZZZ_LIFE })
  }

  /**
   * 虎鲸头顶（背鳍上方）的世界坐标，Zzz 从这里冒。
   *
   * 起点比说话气泡的锚点更高：气泡锚点（box.max.y*0.94+0.22）是贴着背鳍顶端的，
   * Z 从那里冒出来时，镜头一转到侧面就会被身体挡住（实测截图里时有时无）。
   * 抬到包围盒顶上再加半个单位，保证 Z 一开始就在剪影外面。
   *
   * 横向仍取鼻端往后 34% 的位置，和气泡锚点一致 —— 玩家眼里的「头」就在那儿。
   */
  private headTopWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.orca.bodyGeo.boundingBox === null) this.orca.bodyGeo.computeBoundingBox()
    const box = this.orca.bodyGeo.boundingBox
    if (!box || box.isEmpty()) return out.set(this.orca.group.position.x, this.orca.group.position.y + 2.0, this.orca.group.position.z)
    const width = box.max.x - box.min.x
    out.set(box.min.x + width * 0.34, box.max.y + 0.5, 0)
    this.orca.group.updateWorldMatrix(true, false)
    return out.applyMatrix4(this.orca.group.matrixWorld)
  }

  // ------------------------------------------------------------------ audio

  private playShutter(): void {
    this.audio.playShutter()
  }

  private playDing(): void {
    this.audio.playChime()
  }

  // ------------------------------------------------------------------ loop

  private expLerp(tau: number, dt: number): number {
    return 1 - Math.exp(-dt / tau)
  }

  private lerpAngle(from: number, to: number, t: number): number {
    let d = (to - from) % (Math.PI * 2)
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    return from + d * t
  }

  private startLoop(): void {
    let frameHandle = 0
    let lastFrameTime = 0
    // When the page is hidden there is nothing to show, so the loop drops to
    // a slow heartbeat instead of burning GPU time at 60fps.
    const idleInterval = this.quality.idleFrameIntervalMs

    const animate = (now: number): void => {
      if (this.disposed) return
      frameHandle = requestAnimationFrame(animate)
      if (this.renderPaused) {
        this.clock.getDelta()
        lastFrameTime = now
        return
      }

      const hidden = document.hidden
      if (hidden && now - lastFrameTime < idleInterval) return
      lastFrameTime = now

      // NOTE: read the delta with getDelta() and accumulate elapsed time by
      // hand. Three's Clock.getElapsedTime() internally calls getDelta(), so
      // calling both in sequence makes the second one return 0 — which silently
      // zeroes every dt-based interpolation in the frame (the orca's easing, the
      // camera follow, decay timers).
      const rawDt = this.clock.getDelta()
      const dt = Math.min(rawDt, 0.05)
      // Only visible frames say anything about the device: the hidden path
      // returns early above, and a frame that skipped the render is fast.
      if (!hidden) this.noteFrame(rawDt)
      this.elapsed += dt
      const t = this.elapsed
      const pose = this.poseTimer > 0
      let divePitch = 0
      const nowMs = Date.now()
      if (this.sleepUntil > 0 && nowMs > this.sleepUntil) {
        this.sleepUntil = 0
        this.setSleeping(false)
        this.setBodyMood('calm')
      }
      const desiredActionY = this.actionUntil > nowMs ? this.actionYTarget : 0
      this.actionYOffset += (desiredActionY - this.actionYOffset) * this.expLerp(0.4, dt)

      if (pose) {
        // Pose moment: hold still and keep the current heading (or turn away
        // from the camera, when the shot is about to be spoiled).
        this.poseTimer -= dt
        // The orca's nose is local -X: facing the camera means turning -X toward
        // (dx, dz), which is atan2(dz, -dx) — not atan2(dx, dz).
        const camYaw = Math.atan2(this.camera.position.z - this.orca.group.position.z, -(this.camera.position.x - this.orca.group.position.x))
        const target = this.poseTargetYaw ?? camYaw
        const k = this.expLerp(0.12, dt)
        this.orca.group.rotation.y = this.lerpAngle(this.orca.group.rotation.y, target, k)
        this.orca.group.position.lerp(this.poseAnchor, k)
        this.orca.group.position.y = this.poseAnchor.y + Math.sin(t * 9) * 0.05
        this.orca.group.rotation.z = Math.sin(t * 12) * 0.04
      } else {
        // 巡游：缓动追踪低频 Lissajous 目标（seaorca.html 的动作模式）。
        //
        // 位置缓动跟随 + 朝向看向前方点 + 俯仰跟随垂直位移。取代旧的定速
        // Catmull-Rom 巡游：那套朝向滞后于切线（急弯读作侧滑/倒游）、Y
        // 硬拷贝（下滑时平着沉）。1:2 的频率比保证目标速度永不过零，
        // 低频保证缓动跟随永不失速——更早一版"缓动追 Lissajous 会停顿"
        // 的失败是目标频率过快，不是这个方法本身。
        //
        // 水里有 token 时，目标点整个换成 token（投喂优先于巡游）——缓动/转向/
        // 俯仰这一整套都不用改，虎鲸看起来就是"发现食物、游过去吃"。
        const food = this.nearestToken()
        const restY = this.orcaRestY()
        // A grown orca roams less: at 1.55x it is a third longer than the tank
        // was framed for, so keeping the same orbit would push its nose out of
        // frame. Shrinking the roam in step also sells "too big for this tank".
        const roam = 1 / this.growth
        const ampX = this.orbitX * SWIM_AMPLITUDE * roam
        const ampZ = this.orbitZ * SWIM_AMPLITUDE * roam
        // The orca rises toward a falling token, but stays inside its own depth
        // band: left unclamped it launches itself at the water surface and the
        // follow camera takes the whole tank with it. The token comes down into
        // reach on its own.
        const targetY = (food
          ? Math.max(restY - SWIM_AMP_Y, Math.min(food.position.y, restY + SWIM_AMP_Y + 1.0))
          : restY + Math.sin(t * SWIM_FY) * SWIM_AMP_Y) + this.actionYOffset

        // Reuse the follow-point scratch vector; the companion block below
        // overwrites it afterwards.
        const target = this.followPoint
        if (food) {
          // Stop the body *centre* short of the jerky by the nose's reach, so
          // the nose lands on the food rather than the belly.
          const dx = food.position.x - this.orca.group.position.x
          const dz = food.position.z - this.orca.group.position.z
          const distance = Math.hypot(dx, dz) || 1
          const reach = this.noseReach()
          target.set(
            food.position.x - (dx / distance) * reach,
            targetY,
            food.position.z - (dz / distance) * reach,
          )
        } else {
          target.set(Math.sin(t * SWIM_FX) * ampX, targetY, Math.cos(t * SWIM_FZ) * ampZ)
        }
        this.orca.group.position.lerp(target, this.expLerp(SWIM_EASE_TAU, dt))

        // Heading: aim at where the target will be SWIM_LOOK seconds from now.
        // The model's nose points along local -X (measured), so a yaw that
        // turns -X toward (dx, dz) is atan2(dz, -dx) — NOT the common
        // atan2(dx, dz), which pointed the nose 90° off and read as drifting
        // sideways/backward.
        // While feeding, look straight at the token — it is a static point, so
        // the "where the target will be" trick is meaningless there.
        const aheadX = food ? food.position.x : Math.sin((t + SWIM_LOOK) * SWIM_FX) * ampX
        const aheadZ = food ? food.position.z : Math.cos((t + SWIM_LOOK) * SWIM_FZ) * ampZ
        const wanted = Math.atan2(
          aheadZ - this.orca.group.position.z,
          -(aheadX - this.orca.group.position.x),
        )
        this.orca.group.rotation.y = this.lerpAngle(
          this.orca.group.rotation.y,
          wanted,
          this.expLerp(SWIM_TURN_TAU, dt),
        )

        // Pitch follows the vertical distance still to cover: nose dips into
        // a dive and lifts into a rise. With the nose on -X the pitch axis is
        // rotation.z (divePitch), not rotation.x (which is roll here).
        divePitch = Math.max(-0.35, Math.min(0.35, (this.orca.group.position.y - targetY) * SWIM_PITCH_GAIN))
      }

      // A model-directed spin is layered on top of the swim heading. The
      // heading is rewritten every frame, so the offset has to be added here
      // rather than stored on the group.
      if (this.spinUntil > nowMs) {
        const progress = 1 - (this.spinUntil - nowMs) / 1500
        this.orca.group.rotation.y += Math.min(1, Math.max(0, progress)) * Math.PI * 2
      }

      // The camera eases after the orca (photo.html does the same), so a modest
      // swim range still reads as travelling rather than idling in place.
      if (!pose) {
        this.controls.target.lerp(this.orca.group.position, this.expLerp(1.1, dt))
      }

      // Companions: all three trail the orca along its own recent path rather than
      // sitting at a fixed offset, so they bank through the same turns. They
      // share one history buffer and one view-relative side vector — Clawd and
      // the seal take a flank each, the jellyfish drifts above and slightly
      // behind, so inviting all three still reads as an escort rather than a
      // pile-up.
      const clawdVisible = this.clawd?.group.visible === true
      const sealVisible = this.seal?.group.visible === true
      const jellyVisible = this.jelly?.group.visible === true
      if (clawdVisible || sealVisible || jellyVisible) {
        this.trail.push({
          x: this.orca.group.position.x,
          y: this.orca.group.position.y,
          z: this.orca.group.position.z,
          // Both companions' own noses are +Z; the orca's is -X. ry - π/2 maps
          // the orca's travel direction onto their +Z so they follow
          // nose-first too (before this, Clawd always drifted sideways behind
          // the orca).
          yaw: this.orca.group.rotation.y - Math.PI / 2,
          t,
        })
        // Keep roughly 2s of history — plenty for the fixed time lags below.
        while (this.trail.length > 2 && t - this.trail[0].t > 2) this.trail.shift()

        // Offset sideways *relative to the camera*, not relative to the orca's
        // heading. The orca swims toward and away from the lens, so an offset
        // along its own flank frequently points along the view axis and
        // collapses to almost nothing on screen (measured: a 2.26-unit flank
        // offset moved the companion just ~22 px). Perpendicular to the view
        // direction it always reads as "beside".
        const forwardX = this.camera.position.x - this.controls.target.x
        const forwardZ = this.camera.position.z - this.controls.target.z
        const forwardLen = Math.hypot(forwardX, forwardZ) || 1
        const sideX = -forwardZ / forwardLen
        const sideZ = forwardX / forwardLen

        if (this.clawd && clawdVisible) {
          const sample = this.sampleTrail(t, COMPANION_LAG_SECONDS)
          const offset = this.companionSideOffset
          this.followPoint.set(
            sample.x + sideX * offset,
            sample.y + COMPANION_Y_OFFSET,
            sample.z + sideZ * offset,
          )
          this.clawdFoodPull = this.pullFood(this.clawdFoodPull, 'clawd', this.followPoint, dt)
          this.clawd.update(t, dt, { position: this.followPoint, yaw: sample.yaw })
        }

        if (this.seal && sealVisible) {
          const sample = this.sampleTrail(t, SEAL_LAG_SECONDS)
          const offset = this.sealSideOffset
          this.followPoint.set(
            sample.x - sideX * offset,
            sample.y + SEAL_Y_OFFSET,
            sample.z - sideZ * offset,
          )
          this.sealFoodPull = this.pullFood(this.sealFoodPull, 'seal', this.followPoint, dt)
          this.seal.update(t, dt, { position: this.followPoint, yaw: sample.yaw })
        }

        if (this.jelly && jellyVisible) {
          // Longer lag than Clawd's but shorter than the seal's: the jellyfish
          // drifts a little behind the whale, not alongside it.
          const sample = this.sampleTrail(t, JELLY_LAG_SECONDS)
          const offset = this.jellySideOffset
          this.followPoint.set(
            sample.x + sideX * offset,
            sample.y + JELLY_Y_OFFSET,
            sample.z + sideZ * offset,
          )
          this.jellyFoodPull = this.pullFood(this.jellyFoodPull, 'jelly', this.followPoint, dt)
          this.jelly.update(t, dt, { position: this.followPoint, yaw: sample.yaw })
        }
      }

      // Feeding: sink the jerkies, and swallow any the nose has reached.
      // Runs after the orca has moved, so the hit test uses this frame's nose.
      this.updateFeeding(t, dt)

      // 图标层：伙伴朝 Userlly 冒爱心，睡觉时头顶冒 Z。两者都排在角色都摆好
      // 位置之后，锚点才拿的是这一帧的真实位置。
      this.updateAdmiration(t)
      this.updateSleepZzz(t)
      this.glyphs.update(t, dt)

      // Playful shake (spoiled photo moment).
      if (this.shakeTimer > 0) {
        this.shakeTimer -= dt
        this.orca.group.rotation.y += Math.sin(this.shakeTimer * 36) * 0.85 * Math.min(1, this.shakeTimer / 0.62)
      }

      // Speed readout for the body prompt. Sampled a few times a second so it
      // is stable enough to describe in words.
      const speedNow = performance.now()
      if (!this.speedInitialised) {
        this.lastSpeedPos.copy(this.orca.group.position)
        this.lastSpeedSample = speedNow
        this.speedInitialised = true
      } else if (speedNow - this.lastSpeedSample > 300) {
        const seconds = (speedNow - this.lastSpeedSample) / 1000
        const distance = this.lastSpeedPos.distanceTo(this.orca.group.position)
        const raw = distance / Math.max(0.05, seconds)
        this.measuredSpeed = Math.min(2, Math.max(0.2, raw * 1.4))
        this.lastSpeedPos.copy(this.orca.group.position)
        this.lastSpeedSample = speedNow
      }

      // Growth eases toward the value implied by the save, so swallowing a
      // token reads as a swell over the next half second and 复原 as a visible
      // shrink, rather than either one snapping in a single frame.
      //
      // The camera is deliberately *not* pulled back to compensate. It was
      // tried (distance × sqrt of the size change) and it worked against the
      // whole point: it held the orca at a near-constant on-screen size, so a
      // fed whale looked barely bigger than a hungry one. The tank has room —
      // at 1.55x the orca is ~35% of the frame width at the default standoff —
      // and the roam shrinks with growth, so nothing leaves the frame.
      this.growth += (this.growthFor(this.save.growthFeeds) - this.growth) * this.expLerp(GROWTH_EASE_TAU, dt)

      // Scale pulse for the happy reaction (a good photo, or eating a token).
      let scale = this.growth
      if (this.happyTimer > 0) {
        this.happyTimer -= dt
        const hk = Math.sin(Math.min(1, 1 - this.happyTimer / 0.9) * Math.PI)
        scale *= 1 + 0.05 * hk
        this.orca.group.rotation.z += Math.sin(t * 16) * 0.07 * hk
      }
      this.orca.group.scale.setScalar(this.orca.update(t, dt, { baseScale: scale, divePitch }))

      // Body undulation shader uniform.
      this.orca.swimUniforms.uTime.value = t

      // Thought bubble auto-hide.
      if (this.thoughtEl && this.thoughtUntil > 0 && performance.now() > this.thoughtUntil) {
        this.thoughtEl.dataset.show = 'false'
        this.thoughtUntil = 0
      }

      this.aquarium.update(t, dt, this.camera, this.orca.group.position)
      this.controls.update()
      this.postfx.render(this.scene, this.camera)
    }
    frameHandle = requestAnimationFrame(animate)
    this.stopLoop = () => cancelAnimationFrame(frameHandle)
  }

  dispose(): void {
    this.disposed = true
    // Drop host subscriptions before tearing anything down: a listener that
    // fires mid-dispose would read half-removed state.
    this.changeListeners.clear()
    this.stopLoop?.()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('resize', this.onContainerResize)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.resizeObserver?.disconnect()
    this.aquarium.dispose()
    this.postfx.dispose()
    this.audio.dispose()
    this.renderer.dispose()
    this.photoFlash.remove()
    this.thoughtEl?.remove()
    this.clawd?.dispose()
    this.seal?.dispose()
    this.jelly?.dispose()
    this.glyphs.dispose()
    for (const token of [...this.feedItems]) this.removeToken(token)
    this.domElement.remove()
    this.container.classList.remove('orca-aquarium-root')
  }
}
