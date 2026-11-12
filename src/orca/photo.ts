import * as THREE from 'three'
import { getTheme, type ThemeId } from './scene/themes'
import { deletePhotoRows, listPhotoRows, putPhotoRows } from '../lib/db'
import {
  hydratePhotos,
  persistAlbum,
  readAlbumMeta,
  type PhotoDeps,
  type PhotosPersistResult,
} from '../lib/photo-store'

// MAX_PHOTOS / 两个存储键名都定义在 photo-store.ts（引擎和宿主共用一份，别在这儿再写一遍）。
export { GALLERY_ALBUM, MAX_PHOTOS, PHOTO_META_KEY, PHOTO_STORAGE_KEY } from '../lib/photo-store'

export type PhotoQuality = 'closeup' | 'perfect' | 'back' | 'daily'

/**
 * A photo-taking "moment": the orca either poses nicely, or playfully
 * spoils the shot at the last moment (turnaway / wiggle / splash).
 */
export type PhotoEvent = 'pose' | 'turnaway' | 'wiggle' | 'splash'

/** Weighted photo-moment picker. The very first shot always poses cleanly. */
export function pickPhotoEvent(firstPhoto: boolean): PhotoEvent {
  if (firstPhoto) return 'pose'
  const roll = Math.random()
  if (roll < 0.12) return 'turnaway'
  if (roll < 0.26) return 'wiggle'
  if (roll < 0.38) return 'splash'
  return 'pose'
}

export interface PhotoRecord {
  id: string
  dataURL: string
  thumbURL: string
  quality: PhotoQuality
  theme: ThemeId
  label: string
  dateLabel: string
  timestamp: number
  /** True when the shot caught a shake rather than a pose (blurred frame). */
  blurry?: boolean
}

/**
 * Frame treatment per quality. `frame` is the outer Polaroid colour; the
 * optional flags drive the canvas effects applied to the snapshot itself, so a
 * spoiled shot looks spoiled in the saved file too — not just in the gallery.
 */
export const PHOTO_QUALITY: Record<
  PhotoQuality,
  {
    label: string
    emoji: string
    frame: string
    stamp: string
    tone: 'gold' | 'paper'
    /** Real downscale-upscale blur, for a shaken shot. */
    blur?: boolean
    /** Per-pixel desaturation, for a shot of the orca's back. */
    grayscale?: boolean
    /** Slap a playful emoji over the middle of the frame. */
    stampEmoji?: boolean
  }
> = {
  closeup: { label: '贴贴特写', emoji: '💙', frame: '#9fc9e8', stamp: 'CLOSE UP', tone: 'gold' },
  perfect: { label: '完美瞬间', emoji: '✨', frame: '#f2c14e', stamp: 'PERFECT', tone: 'gold' },
  back: { label: '背影远眺', emoji: '🌊', frame: '#9fb4c8', stamp: 'BACK VIEW', tone: 'paper', grayscale: true },
  daily: { label: '日常抓拍', emoji: '📷', frame: '#f0d9b8', stamp: 'DAILY', tone: 'paper' },
}

/** Applied when the shutter caught a shake rather than a pose. */
export const BLURRY_STYLE = {
  label: '哎呀糊了',
  emoji: '🌫️',
  frame: '#d8d2c6',
  stamp: 'BLURRY',
  tone: 'paper' as const,
  blur: true,
}

/**
 * 相册的落盘位置。
 *
 * 以前这里只有一行 localStorage.setItem，而且 catch 是空的：一条照片记录同时带
 * 全尺寸 dataURL 和缩略图，8 张轻松几 MB，WebView 那约 5MB 的配额一超就
 * **静默丢掉整个相册** —— 用户报的「拍照存不下来」，一半是这条。
 *
 * 现在拆成两层：元数据 + 缩略图（KB 级）留在 localStorage，因为引擎的 loadPhotos()
 * 必须同步返回（app.ts 不在本次改动范围内）；大图字节进 IndexedDB（db.ts 的 photos 表）。
 * 读写逻辑全在 photo-store.ts（纯函数、能单测），这个文件只负责把两个端口接上。
 */
const photoDeps: PhotoDeps = {
  kv: {
    getItem: (key) => {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    // 故意不吞：photo-store 要靠这个异常区分「存不下」和「存好了」。
    setItem: (key, value) => {
      localStorage.setItem(key, value)
    },
    removeItem: (key) => {
      try {
        localStorage.removeItem(key)
      } catch {
        /* 隐私模式下 remove 也可能炸：下次开机重演一遍迁移即可 */
      }
    },
  },
  rows: {
    list: () => listPhotoRows(),
    put: (rows) => putPhotoRows(rows),
    remove: (ids) => deletePhotoRows(ids),
  },
}

/**
 * Evaluate the shot using the live scene state. This is a deterministic
 * quality check (not random): screen position, camera distance and whether
 * the orca is facing the camera decide the label.
 */
export function evaluatePhotoQuality(orcaGroup: THREE.Group, camera: THREE.PerspectiveCamera): PhotoQuality {
  const ndc = orcaGroup.position.clone().project(camera)
  if (ndc.z > 1 || ndc.z < -1) return 'daily'
  const screenDist = Math.hypot(ndc.x, ndc.y)
  const cameraDist = orcaGroup.position.distanceTo(camera.position)
  // The orca's nose is local -X: its facing direction is (-cos ry, 0, sin ry).
  const forward = new THREE.Vector3(-Math.cos(orcaGroup.rotation.y), 0, Math.sin(orcaGroup.rotation.y))
  const toCamera = new THREE.Vector3().subVectors(camera.position, orcaGroup.position).setY(0)
  const angle = toCamera.lengthSq() > 1e-6 ? forward.angleTo(toCamera.normalize()) : 0

  if (cameraDist < 5.8 && screenDist < 0.30 && angle < 0.55) return 'closeup'
  if (screenDist < 0.24 && angle < 0.62) return 'perfect'
  if (angle > 2.35) return 'back'
  return 'daily'
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** Downscale-then-upscale box blur — a real blur, unlike a flat grey wash. */
function blurCanvas(source: HTMLCanvasElement, amount: number): HTMLCanvasElement {
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.round(source.width / amount))
  small.height = Math.max(1, Math.round(source.height / amount))
  const smallCtx = small.getContext('2d')!
  smallCtx.imageSmoothingEnabled = true
  smallCtx.drawImage(source, 0, 0, small.width, small.height)

  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const outCtx = out.getContext('2d')!
  outCtx.imageSmoothingEnabled = true
  outCtx.drawImage(small, 0, 0, out.width, out.height)
  return out
}

/** True per-pixel desaturation, for the "only got its back" shot. */
function grayscaleCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const ctx = out.getContext('2d')!
  ctx.drawImage(source, 0, 0)
  const frame = ctx.getImageData(0, 0, out.width, out.height)
  const d = frame.data
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0
    d[i] = lum
    d[i + 1] = lum
    d[i + 2] = lum
  }
  ctx.putImageData(frame, 0, 0)
  return out
}

const SILLY_STAMPS = ['😜', '🤪', '😝', '🐟', '💦', '🫧']

/**
 * Compose a paper-flat "拍立得" frame around the raw WebGL snapshot:
 * solid paper fills, flat offset shadow, theme pill and quality stamp.
 * No gradients anywhere — this matches the paper-flat shell UI.
 *
 * Layout is a real Polaroid: coloured outer frame → thin white mat → photo →
 * caption band. Different qualities get a different frame colour and treatment,
 * so a roll of photos reads like a set of collectibles rather than one repeated
 * template.
 */
export async function composeFramedPhoto(
  rawDataURL: string,
  quality: PhotoQuality,
  themeId: ThemeId,
  blurry = false,
): Promise<string> {
  const img = await loadImage(rawDataURL)
  // A shaken shot keeps its composition quality but gets the blurred frame, so
  // the label stays honest about what the camera saw.
  const q = blurry ? { ...PHOTO_QUALITY[quality], ...BLURRY_STYLE } : PHOTO_QUALITY[quality]
  const theme = getTheme(themeId)

  const maxW = 960
  const scale = Math.min(1, maxW / img.width)
  const pw = Math.max(1, Math.round(img.width * scale))
  const ph = Math.max(1, Math.round(img.height * scale))
  const mat = 8 // white mat between the frame and the photo
  const side = 22
  const top = 22
  const footer = 78
  const w = pw + side * 2
  const h = ph + top + footer

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  // Outer frame in the quality's own colour.
  ctx.fillStyle = q.frame
  ctx.fillRect(0, 0, w, h)

  // Solid offset shadow behind the photo card.
  ctx.fillStyle = 'rgba(70, 60, 45, 0.16)'
  ctx.fillRect(side + 5, top + 7, pw + mat * 2, ph + mat * 2)

  // White mat.
  ctx.fillStyle = '#fffdf8'
  ctx.fillRect(side, top, pw + mat * 2, ph + mat * 2)

  // The snapshot itself, optionally degraded to match how the shot went.
  const box = document.createElement('canvas')
  box.width = pw
  box.height = ph
  box.getContext('2d')!.drawImage(img, 0, 0, pw, ph)
  let picture: HTMLCanvasElement = box
  if (q.blur) picture = blurCanvas(box, 12)
  if (q.grayscale) picture = grayscaleCanvas(picture)
  ctx.drawImage(picture, side + mat, top + mat)

  if (q.stampEmoji) {
    // Playful sticker slapped over the middle of the frame.
    const size = Math.max(36, Math.round(pw * 0.22))
    ctx.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      SILLY_STAMPS[Math.floor(Math.random() * SILLY_STAMPS.length)],
      side + mat + pw / 2,
      top + mat + ph / 2,
    )
    ctx.textBaseline = 'alphabetic'
  }

  // Quality decorations: flat paper-cut corners / dashes (平涂).
  if (quality === 'perfect') {
    const tab = 22
    ctx.fillStyle = '#fffdf8'
    ctx.fillRect(side, top, tab, 5)
    ctx.fillRect(side + pw + mat * 2 - tab, top, tab, 5)
    ctx.fillRect(side, top + ph + mat * 2 - 5, tab, 5)
    ctx.fillRect(side + pw + mat * 2 - tab, top + ph + mat * 2 - 5, tab, 5)
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = 2
    ctx.strokeRect(side + 2.5, top + 2.5, pw + mat * 2 - 5, ph + mat * 2 - 5)
  } else if (quality === 'closeup') {
    const tab = 22
    ctx.fillStyle = '#fffdf8'
    ctx.fillRect(side, top, tab, 5)
    ctx.fillRect(side + pw + mat * 2 - tab, top, tab, 5)
    ctx.fillRect(side, top + ph + mat * 2 - 5, tab, 5)
    ctx.fillRect(side + pw + mat * 2 - tab, top + ph + mat * 2 - 5, tab, 5)
  } else if (quality === 'back') {
    ctx.setLineDash([6, 5])
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(side + 3, top + 3, pw + mat * 2 - 6, ph + mat * 2 - 6)
    ctx.setLineDash([])
  }

  /*
   * 页脚两行、左右分栏。
   *
   * 以前主题胶囊画在 footerBase+0..22，而质量标签的基线在 footerBase+23，
   * 两块正好叠在一起 —— 用户看到的就是「✨ 完美瞬间」压在「🏔 雾霭冰山」
   * 胶囊上（2026-11-03 截图报障）。现在：
   *   第一行：左 = 质量标签，右 = 主题胶囊（同一水平线，永不重叠）
   *   第二行：左 = 水族馆署名，右 = 日期 + 编号
   */
  const footerBase = top + ph + mat * 2
  const pillText = `${theme.emoji} ${theme.label}`
  ctx.font = '12px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  const pillW = Math.max(60, ctx.measureText(pillText).width + 20)
  const pillH = 22
  const pillX = w - side - pillW
  const pillY = footerBase + 6
  roundedRectPath(ctx, pillX, pillY, pillW, pillH, pillH / 2)
  ctx.fillStyle = 'rgba(255,253,248,0.92)'
  ctx.fill()
  ctx.fillStyle = '#3d392f'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(pillText, pillX + 10, pillY + pillH / 2)

  // 第一行左侧：质量标签（胶囊右移后这里腾出来了）。
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.fillRect(side, footerBase + 12, 10, 10)
  ctx.fillStyle = '#3d392f'
  ctx.font = '600 16px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(`${q.emoji} ${q.label}`, side + 18, footerBase + 23)

  // 第二行：署名 + 日期/编号（日期从第一行挪下来，避免和胶囊抢位置）。
  const dateLabel = new Date().toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  ctx.fillStyle = '#9a9486'
  ctx.font = '11px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('虎鲸水族馆', side, footerBase + 46)
  ctx.textAlign = 'right'
  ctx.fillText(`${dateLabel} · #${q.stamp}`, w - side, footerBase + 46)

  return canvas.toDataURL('image/jpeg', 0.88)
}

export async function makeThumb(dataURL: string, width = 220): Promise<string> {
  const img = await loadImage(dataURL)
  const scale = width / img.width
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.72)
}

/**
 * 同步读出相册（元数据 + 缩略图；大图字节可能还是空串）。
 *
 * 引擎在构造时就要拿到一份能用的列表，所以这个签名保持同步。大图由 hydratePhotos()
 * 在后台从 IndexedDB 补上，补完通知订阅者 —— 宿主侧 useGameState 订阅了这个事件，
 * 引擎这边不需要（也不该）被原地改：app.ts 的 deletePhoto 是
 * `this.photos = this.photos.filter(...)`，整个数组会被换掉，宿主原地写回的字节会丢。
 *
 * 首启时旧键 photos:v1 还在，那份记录本来就读不出大图（或读得出但没迁完），
 * readAlbumMeta 会直接退回旧键的整条记录，所以不会出现「升级后相册先空一秒」。
 */
export function loadPhotos(): PhotoRecord[] {
  void hydratePhotos(photoDeps)
  return readAlbumMeta(photoDeps.kv)
}

/**
 * 落整个相册：元数据 + 缩略图回 localStorage，大图进 IndexedDB，
 * 顺带清掉相册里已经不存在的字节（删过的、被 8 张上限挤掉的）。
 *
 * 以前是 `catch {}`：写失败和写成功对界面完全一样。现在返回结果，
 * 并且 photo-store 会把失败记进快照（onPhotosStoreChange），界面能说
 * 「照片存不下了，先删几张」。这里不抛异常 —— 调用点是 app.ts 里的裸语句。
 */
export function persistPhotos(photos: PhotoRecord[]): Promise<PhotosPersistResult> {
  return persistAlbum(photos, photoDeps)
}

/**
 * 催一次相册水合（迁移 + 从 IndexedDB 读大图）。引擎构造时已经催过一次，
 * 宿主侧再催一次是兜底：并发调用会在 photo-store 里排成一条队，不会互相踩。
 */
export function requestPhotosHydration(): Promise<void> {
  return hydratePhotos(photoDeps)
}

/**
 * 相册 store 的读端：宿主 UI 用它拿「带大图的那一份」并订阅水合 / 写失败。
 * （宿主不能只信 getPhotos()：引擎那一份是同步的元数据，大图要靠这里补。）
 */
export {
  getPhotosStoreSnapshot,
  onPhotosStoreChange,
  photoBytesIndex,
  withPhotoBytes,
  type PhotosStoreSnapshot,
} from '../lib/photo-store'

export function createPhotoFlash(): HTMLElement {
  const flash = document.createElement('div')
  flash.className = 'orca-photo-flash'
  return flash
}

/*
 * 这里原本还有上游那份 DOM 相册：createPhotoGallery / PhotoGallery / savePhotoToAlbum，
 * 靠 window.xhs.miniTool.saveImageToPhotosAlbum 存图（见上面 git 历史或上游
 * orca-aquarium-shell）。它在本仓库里是彻底的死代码：
 *   - app.ts 写明「宿主用 React 自己画控件，游戏自带相册一律不建」，全 src 零调用点；
 *   - Capacitor 的 WebView 永远不会注入 window.xhs，所以那句「保存到相册」恒返回 unsupported。
 * 留着它才是本次 bug 的成因之一：看上去有保存功能，实际一条可达的路都没有。
 * 现在查看器和保存都在宿主侧 —— src/components/room/PhotoViewer.tsx 负责界面，
 * src/lib/platform.ts 的 saveImage 负责三端（原生 MediaStore / Electron 二进制 IPC / 浏览器下载）。
 * 与上游的这条差异记在 docs/UPSTREAM.md。ui/styles.ts 里那几行 .orca-photo-gallery /
 * .orca-photo-modal 的 CSS 这次没动：那个文件不在本次改动范围内，样式也不会被命中。
 */
