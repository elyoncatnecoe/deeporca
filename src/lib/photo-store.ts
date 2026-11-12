import type { PhotoQuality, PhotoRecord } from '../orca/photo'
import type { ThemeId } from '../orca/scene/themes'

/**
 * 照片持久化的纯逻辑：不碰 DOM、不碰 IndexedDB，所以能直接在 `node --test` 里跑真断言
 * （src/orca/photo.ts 引 THREE，测试导不进来，这就是把它单独拆一个文件的原因）。
 *
 * 为什么要拆：一条照片记录同时带全尺寸 dataURL 和缩略图，8 张轻松几 MB，
 * 全塞 localStorage 会撞配额（WebView 约 5MB），而写失败被原来的 catch {} 吞掉了 ——
 * 用户视角就是「照片存不下来」。现在字节进 IndexedDB（db.ts 的 photos 表），
 * localStorage 只留元数据 + 缩略图（KB 级），失败还会冒出来（见 onPhotosStoreError）。
 *
 * 元数据必须能同步读：引擎的 loadPhotos() 是同步调用的（app.ts 不在本次改动范围内），
 * 所以相册首屏靠 localStorage 的元数据 + 缩略图就能画出来，大图字节异步水合后补上。
 */

/** 相册上限：一次旅行拍 8 张够用了，再多就是把配额往死里压。 */
export const MAX_PHOTOS = 8

/** 旧键：整条记录连大图一起塞 localStorage。只读，迁移成功后删掉。 */
export const PHOTO_STORAGE_KEY = 'orca-aquarium-shell:photos:v1'

/** 新键：只有元数据 + 缩略图；大图字节在 IndexedDB 的 photos 表。 */
export const PHOTO_META_KEY = 'orca-aquarium-shell:photos:meta:v2'

/** 存到系统相册时的目录名（MediaStore 的 RELATIVE_PATH = Pictures/深鲸）。 */
export const GALLERY_ALBUM = '深鲸'

/** localStorage 里那份轻量元数据（缩略图很小，留着才能同步出首屏）。 */
export interface PhotoMeta {
  id: string
  quality: PhotoQuality
  theme: ThemeId
  label: string
  dateLabel: string
  timestamp: number
  blurry?: boolean
  thumbURL: string
}

/** IndexedDB photos 表的一行：只装最肥的那份大图。 */
export interface PhotoBytes {
  id: string
  dataURL: string
  savedAt: number
}

/** 存盘结果：失败必须带一句能给人看的话，别再 return void 把异常吞了。 */
export interface PhotosPersistResult {
  ok: boolean
  error?: string
}

const QUALITY_IDS = ['closeup', 'perfect', 'back', 'daily'] as const
const THEME_IDS = ['iceberg', 'tropical', 'deep'] as const

export function isPhotoQuality(value: unknown): value is PhotoQuality {
  return typeof value === 'string' && (QUALITY_IDS as readonly string[]).indexOf(value) !== -1
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).indexOf(value) !== -1
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 记录里的元数据部分（大图丢掉，缩略图留着）。 */
export function photoMetaOf(record: PhotoRecord): PhotoMeta {
  const meta: PhotoMeta = {
    id: record.id,
    quality: isPhotoQuality(record.quality) ? record.quality : 'daily',
    theme: isThemeId(record.theme) ? record.theme : 'iceberg',
    label: text(record.label),
    dateLabel: text(record.dateLabel),
    timestamp: typeof record.timestamp === 'number' ? record.timestamp : 0,
    thumbURL: text(record.thumbURL),
  }
  if (record.blurry === true) meta.blurry = true
  return meta
}

/** 整个相册的元数据，顺手按上限截尾（留最新的 MAX_PHOTOS 张）。 */
export function photoMetasOf(photos: readonly PhotoRecord[]): PhotoMeta[] {
  return photos.slice(-MAX_PHOTOS).map(photoMetaOf)
}

/** 元数据 + 可选字节 -> 一条完整记录（字节没水合上来时 dataURL 就是空串）。 */
export function photoRecordOf(meta: PhotoMeta, dataURL = ''): PhotoRecord {
  const record: PhotoRecord = {
    id: meta.id,
    dataURL,
    thumbURL: meta.thumbURL,
    quality: meta.quality,
    theme: meta.theme,
    label: meta.label,
    dateLabel: meta.dateLabel,
    timestamp: meta.timestamp,
  }
  if (meta.blurry === true) record.blurry = true
  return record
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 解析元数据键。
 * 返回 null 表示「这个键不可用」（没有 / 不是数组 / 一条都不成形状）——
 * 调用方要靠它区分「真的没有照片」和「还没迁移」，这一步不能猜。
 */
export function parsePhotoMetas(raw: unknown): PhotoMeta[] | null {
  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) return null
  const metas: PhotoMeta[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id === '') continue
    const meta: PhotoMeta = {
      id: record.id,
      quality: isPhotoQuality(record.quality) ? record.quality : 'daily',
      theme: isThemeId(record.theme) ? record.theme : 'iceberg',
      label: text(record.label),
      dateLabel: text(record.dateLabel),
      timestamp: typeof record.timestamp === 'number' ? record.timestamp : 0,
      thumbURL: text(record.thumbURL),
    }
    if (record.blurry === true) meta.blurry = true
    metas.push(meta)
  }
  return metas.slice(-MAX_PHOTOS)
}

/**
 * 解析旧键（photos:v1）里的全尺寸记录，用于首启迁移。
 * 老数据可能没有缩略图（更早的版本没写过），就退回大图，至少相册不是空的。
 */
export function parseLegacyPhotoRecords(raw: unknown): PhotoRecord[] | null {
  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) return null
  const records: PhotoRecord[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id === '') continue
    // 没有大图的条目等于没有照片，丢掉：旧版配额炸掉时写出过半截记录，留着只会显示成破图。
    if (typeof record.dataURL !== 'string' || record.dataURL === '') continue
    const thumb = typeof record.thumbURL === 'string' && record.thumbURL !== '' ? record.thumbURL : record.dataURL
    records.push({
      id: record.id,
      dataURL: record.dataURL,
      thumbURL: thumb,
      quality: isPhotoQuality(record.quality) ? record.quality : 'daily',
      theme: isThemeId(record.theme) ? record.theme : 'iceberg',
      label: text(record.label),
      dateLabel: text(record.dateLabel),
      timestamp: typeof record.timestamp === 'number' ? record.timestamp : 0,
      blurry: record.blurry === true ? true : undefined,
    })
  }
  return records.slice(-MAX_PHOTOS)
}

/**
 * 挑出真要写进 IndexedDB 的行。
 * dataURL 为空代表这条只是元数据（字节还没从库里水合上来），
 * 拿空串去覆盖会把好好的照片写没 —— 这是这一步唯一的坑。
 */
export function photoBytesOf(photos: readonly PhotoRecord[]): PhotoBytes[] {
  const rows: PhotoBytes[] = []
  for (const photo of photos.slice(-MAX_PHOTOS)) {
    if (typeof photo.dataURL !== 'string' || photo.dataURL === '') continue
    rows.push({ id: photo.id, dataURL: photo.dataURL, savedAt: photo.timestamp })
  }
  return rows
}

/** 把库里的字节合到记录上（返回新数组：React 要的是新引用，不是原地改）。 */
export function withPhotoBytes(photos: readonly PhotoRecord[], bytes: ReadonlyMap<string, string>): PhotoRecord[] {
  return photos.map((photo) => {
    if (typeof photo.dataURL === 'string' && photo.dataURL !== '') return photo
    const found = bytes.get(photo.id)
    if (found === undefined || found === '') return photo
    return { ...photo, dataURL: found }
  })
}

/** 库里那些「相册里已经没有了」的 id（被删的、被 8 张上限挤掉的），要一并删掉。 */
export function stalePhotoIds(known: readonly string[], kept: readonly PhotoRecord[]): string[] {
  const keep = new Set(kept.map((photo) => photo.id))
  const stale: string[] = []
  for (const id of known) if (!keep.has(id)) stale.push(id)
  return stale
}

/** 配额写满的判定：WebView 抛 DOMException code 22，老 WebKit 用 1014，名字里也带 quota。 */
export function isStorageQuotaError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown }
  if (typeof candidate.name === 'string' && /quota/i.test(candidate.name)) return true
  return candidate.code === 22 || candidate.code === 1014
}

/** 系统相册 / 磁盘上的文件名：日期可读，重名由 MediaStore 自己加 (1) 后缀。 */
export function photoFileName(record: { id: string; timestamp: number }, ext = 'jpg'): string {
  const stamp = new Date(record.timestamp)
  if (Number.isNaN(stamp.getTime())) return 'deepsea-' + String(record.id).slice(0, 8) + '.' + ext
  const pad = (value: number): string => (value < 10 ? '0' + value : String(value))
  const parts = [
    stamp.getFullYear(),
    pad(stamp.getMonth() + 1),
    pad(stamp.getDate()),
    '-',
    pad(stamp.getHours()),
    pad(stamp.getMinutes()),
    pad(stamp.getSeconds()),
  ].join('')
  return '深鲸-' + parts + '.' + ext
}

/** data URL 拆出来的三段。 */
export interface DataUrlParts {
  /** 例如 image/jpeg。没写前缀时按 image/jpeg 处理（引擎 toDataURL 就是它）。 */
  mime: string
  /** 去掉前缀的纯 base64。 */
  base64: string
  /** 由 mime 推的扩展名，只用来起文件名。 */
  ext: string
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * 拆 data URL：`data:image/jpeg;base64,xxx` -> { mime, base64, ext }。
 *
 * 拍照那条一定是 canvas.toDataURL('image/jpeg') 的产物，但这条路径以后会被别处复用
 * （工坊导出的图、附件），所以前缀缺失、大小写混写、没带 ;base64 都要有明确行为：
 * 解不出来就返回 null，由调用方报「保存失败」，绝不能把半截字符串当图片写进文件。
 */
export function splitDataUrl(dataURL: string): DataUrlParts | null {
  if (typeof dataURL !== 'string' || dataURL === '') return null
  const comma = dataURL.indexOf(',')
  if (comma < 0) return null
  const body = dataURL.slice(comma + 1)
  if (body === '') return null
  const head = dataURL.slice(0, comma)
  if (!head.startsWith('data:')) {
    // 裸 base64（有人直接把 atob 那段递进来）：只能按 JPEG 猜。
    return { mime: 'image/jpeg', base64: body, ext: 'jpg' }
  }
  const meta = head.slice('data:'.length)
  if (!/;base64/i.test(meta)) return null
  const mime = meta.split(';')[0].trim() || 'image/jpeg'
  const ext = EXT_BY_MIME[mime.toLowerCase()] ?? 'jpg'
  return { mime, base64: body, ext }
}

/**
 * base64 -> 字节。
 * atob 给的是「一个字符一个字节」的二进制串，必须逐字符铺进 Uint8Array；
 * 直接把那个字符串塞给 Blob([...]) 会按 UTF-8 重新编码，>0x7F 的字节全被打散，
 * 写出来的 JPEG 就打不开了（web 分支以前就吃过这个亏）。
 * 返回类型写成 Uint8Array<ArrayBuffer>：DOM 的 BlobPart 要的就是它，
 * 默认的 Uint8Array<ArrayBufferLike>（可能是 SharedArrayBuffer）过不了类型检查。
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/\s/g, ''))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/* -------------------------------------------------- 端口与相册 store */

/** 键值端口（localStorage 的形状）。单测里塞一个 Map 就能跑真断言。 */
export interface PhotoKv {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/** 字节表端口（IndexedDB 的形状）。list 要能回读，迁移必须先校验写进去再删旧键。 */
export interface PhotoRowPort {
  list: () => Promise<PhotoBytes[]>
  put: (rows: readonly PhotoBytes[]) => Promise<void>
  remove: (ids: readonly string[]) => Promise<void>
}

export interface PhotoDeps {
  kv: PhotoKv
  rows: PhotoRowPort
}

/**
 * 同步读元数据（引擎的 loadPhotos() 与首屏都走它）。
 * 没有新键就退回旧键：旧格式整条记录本来就带大图，能直接显示，
 * 迁移在后台补，不会让用户先盯着一片空相册。
 * 这里**不剥大图**：万一手快在迁移跑完之前就删了一张，persistAlbum 拿到的还是
 * 旧格式那条，会顺手把它的字节写进库 —— 谁也丢不了。
 */
export function readAlbumMeta(kv: PhotoKv): PhotoRecord[] {
  const metas = parsePhotoMetas(kv.getItem(PHOTO_META_KEY))
  if (metas !== null) return metas.map((meta) => photoRecordOf(meta))
  const legacy = parseLegacyPhotoRecords(kv.getItem(PHOTO_STORAGE_KEY))
  return legacy === null ? [] : legacy
}

/**
 * 首启迁移：旧 localStorage 里的大图 -> IndexedDB，**校验写成功之后**才删旧键。
 * 顺序很要紧：写字节 -> 回读校验 -> 落元数据 -> removeItem。
 * 任何一步没成，旧键原样留着，下次开机再迁一遍 —— 宁可重复迁移，也不能迁一半把照片删了。
 *
 * 新键已经存在时绝不能拿旧列表覆盖它：那是上一次迁移中途失败的情况，
 * 期间用户可能已经删过 / 拍过，元数据以新键为准，这里只把还在相册里的字节搬进库。
 */
export async function migrateLegacyPhotos(deps: PhotoDeps): Promise<PhotosPersistResult> {
  const raw = deps.kv.getItem(PHOTO_STORAGE_KEY)
  if (raw === null) return { ok: true }
  const legacy = parseLegacyPhotoRecords(raw)
  const records = legacy === null ? [] : legacy
  const existing = parsePhotoMetas(deps.kv.getItem(PHOTO_META_KEY))
  const kept = existing === null ? records : records.filter((record) => existing.some((meta) => meta.id === record.id))
  try {
    await deps.rows.put(photoBytesOf(kept))
    const stored = await deps.rows.list()
    const ids = new Set(stored.map((row) => row.id))
    const missing = kept.filter((record) => record.dataURL !== '' && !ids.has(record.id))
    if (missing.length > 0) {
      // 没校验过就不删旧键，下次接着迁。
      return { ok: false, error: '照片搬不进数据库，先删几张腾地方' }
    }
    if (existing === null) deps.kv.setItem(PHOTO_META_KEY, JSON.stringify(photoMetasOf(records)))
    deps.kv.removeItem(PHOTO_STORAGE_KEY)
    return { ok: true }
  } catch {
    return { ok: false, error: '照片搬不进数据库，先删几张腾地方' }
  }
}

/** 读整个相册：元数据给顺序和标签，库里的行给大图。 */
export async function readAlbum(deps: PhotoDeps): Promise<PhotoRecord[]> {
  const metas = parsePhotoMetas(deps.kv.getItem(PHOTO_META_KEY))
  if (metas !== null && metas.length > 0) {
    const stored = await deps.rows.list()
    const bytes = new Map(stored.map((row) => [row.id, row.dataURL]))
    return metas.map((meta) => photoRecordOf(meta, bytes.get(meta.id) ?? ''))
  }
  return readAlbumMeta(deps.kv)
}

/**
 * 写相册：元数据 + 缩略图回 localStorage（引擎那份要同步读），大图进 IndexedDB，
 * 顺手清掉相册里已经不存在的字节（删过的、被 8 张上限挤掉的）。
 * 两个端口都不许抛：失败以 PhotosPersistResult 返回，并记进下面的 store 状态。
 */
export async function writeAlbum(photos: readonly PhotoRecord[], deps: PhotoDeps): Promise<PhotosPersistResult> {
  const records = photos.slice(-MAX_PHOTOS)
  let error: string | undefined
  try {
    deps.kv.setItem(PHOTO_META_KEY, JSON.stringify(photoMetasOf(records)))
  } catch (writeError) {
    error = isStorageQuotaError(writeError) ? PHOTOS_FULL_MESSAGE : '照片没能存下来，重启后可能会丢'
  }
  try {
    await deps.rows.put(photoBytesOf(records))
    const stored = await deps.rows.list()
    const stale = stalePhotoIds(stored.map((row) => row.id), records)
    if (stale.length > 0) await deps.rows.remove(stale)
  } catch {
    error = error ?? PHOTOS_FULL_MESSAGE
  }
  return error === undefined ? { ok: true } : { ok: false, error }
}

/** 相册快照里那些「id -> 大图字节」的索引，给引擎那份缺字节的记录补上。 */
export function photoBytesIndex(photos: readonly PhotoRecord[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const photo of photos) if (photo.dataURL !== '') index.set(photo.id, photo.dataURL)
  return index
}

/** 存不下了统一这一句：短、看得懂、带下一步动作。 */
export const PHOTOS_FULL_MESSAGE = '照片存不下了，先删几张'

export interface PhotosStoreSnapshot {
  /** 已经读过一次盘（迁移 + 水合），UI 可以信任 photos 是完整的一份。 */
  hydrated: boolean
  /** 相册（含从 IndexedDB 补上的大图字节）。 */
  photos: PhotoRecord[]
  /** 最近一次落盘的失败原因；写成功就清空。 */
  error: string | null
}

let snapshot: PhotosStoreSnapshot = { hydrated: false, photos: [], error: null }
const storeListeners = new Set<() => void>()
/** 所有落盘操作串成一条队：并发写会互相把对方的行当成「相册里没有了」而删掉。 */
let storeQueue: Promise<unknown> = Promise.resolve()

function emitStore(): void {
  for (const listener of Array.from(storeListeners)) {
    // 一个订阅者抛错不能带走别人（引擎 onChange 那边是同样的写法）。
    try {
      listener()
    } catch {
      /* 隔离 */
    }
  }
}

function patchStore(patch: Partial<PhotosStoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  emitStore()
}

/** 订阅相册落盘结果（水合完成 / 写失败）。返回退订函数。 */
export function onPhotosStoreChange(listener: () => void): () => void {
  storeListeners.add(listener)
  return () => storeListeners.delete(listener)
}

export function getPhotosStoreSnapshot(): PhotosStoreSnapshot {
  return snapshot
}

function enqueueStore<T>(task: () => Promise<T>): Promise<T> {
  const next = storeQueue.then(task, task)
  // 队列本身永远不带着 rejection 往下传：上面已经兜过底了。
  storeQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/** 水合：迁移旧数据 + 从库里读大图 + 刷新快照。并发调用共享同一次排队。 */
export function hydratePhotos(deps: PhotoDeps): Promise<void> {
  return enqueueStore(async () => {
    try {
      const migrated = await migrateLegacyPhotos(deps)
      const photos = await readAlbum(deps)
      patchStore({ hydrated: true, photos, error: migrated.ok ? snapshot.error : migrated.error ?? null })
    } catch {
      // 读盘炸了也不能让相册空着：退回同步的元数据（缩略图还在，看得见面目）。
      patchStore({ hydrated: true, photos: readAlbumMeta(deps.kv), error: PHOTOS_FULL_MESSAGE })
    }
  })
}

/** 落盘 + 刷新快照：UI 那句「存不下了，先删几张」就是从 snapshot.error 来的。 */
export function persistAlbum(photos: readonly PhotoRecord[], deps: PhotoDeps): Promise<PhotosPersistResult> {
  return enqueueStore(async () => {
    const result = await writeAlbum(photos, deps)
    let photos2 = snapshot.photos
    try {
      photos2 = await readAlbum(deps)
    } catch {
      /* 保留上一次读到的那份 */
    }
    patchStore({ hydrated: true, photos: photos2, error: result.ok ? null : result.error ?? PHOTOS_FULL_MESSAGE })
    return result
  })
}

/** 单测用：把模块级状态清干净，免得用例之间互相串。 */
export function resetPhotosStore(): void {
  snapshot = { hydrated: false, photos: [], error: null }
  storeQueue = Promise.resolve()
  storeListeners.clear()
}
