import { db } from './db'

export type AvatarRole = 'user' | 'assistant'

/** 头像统一裁成方图，气泡和设置页共用同一个尺寸。 */
export const AVATAR_EDGE = 128
/** data URL 字符数上限；超了继续降质，降到底还超就拒绝。 */
export const AVATAR_MAX_CHARS = 64 * 1024

const STORE_KEY = (role: AvatarRole): string => 'avatar:' + role

const cache: Record<AvatarRole, string | null> = { user: null, assistant: null }
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

/**
 * 自定义头像。只存本机 IndexedDB 的 settings 表，不进备份、不上行 API：
 * 换设备就没有，这是刻意的取舍。
 */
export const avatarStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get(role: AvatarRole): string | null {
    return cache[role]
  },
  /** 启动时读一次；头像读不出来不该拖垮别的功能。 */
  async hydrate(): Promise<void> {
    try {
      const database = await db()
      const rows = await Promise.all([
        database.get('settings', STORE_KEY('user')),
        database.get('settings', STORE_KEY('assistant')),
      ])
      const [user, assistant] = rows
      cache.user = typeof user?.value === 'string' ? user.value : null
      cache.assistant = typeof assistant?.value === 'string' ? assistant.value : null
      notify()
    } catch (error) {
      cache.user = null
      cache.assistant = null
      notify()
    }
  },
  async set(role: AvatarRole, dataUrl: string): Promise<void> {
    cache[role] = dataUrl
    notify()
    const database = await db()
    await database.put('settings', { key: STORE_KEY(role), value: dataUrl })
  },
  async clear(role: AvatarRole): Promise<void> {
    cache[role] = null
    notify()
    const database = await db()
    await database.delete('settings', STORE_KEY(role))
  },
}

/** 备份导出时跳过这些 key：头像只存本机。 */
export function isAvatarKey(key: string): boolean {
  return key.startsWith('avatar:')
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('这张图片读不了'))
    }
    image.src = url
  })
}

/** 读进来 → 居中裁方 → 缩到 128 → 编成 webp。 */
export async function fileToAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('得选一张图片')
  const image = await loadImage(file)
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_EDGE
  canvas.height = AVATAR_EDGE
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('浏览器不支持画布')
  context.imageSmoothingQuality = 'high'

  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width === 0 || height === 0) {
    // SVG 之类没有内在尺寸的图，直接拉满。
    context.drawImage(image, 0, 0, AVATAR_EDGE, AVATAR_EDGE)
  } else {
    const edge = Math.min(width, height)
    context.drawImage(
      image,
      Math.round((width - edge) / 2),
      Math.round((height - edge) / 2),
      edge,
      edge,
      0,
      0,
      AVATAR_EDGE,
      AVATAR_EDGE,
    )
  }

  let quality = 0.92
  let dataUrl = canvas.toDataURL('image/webp', quality)
  while (dataUrl.length > AVATAR_MAX_CHARS && quality > 0.4) {
    quality -= 0.12
    dataUrl = canvas.toDataURL('image/webp', quality)
  }
  if (dataUrl.length > AVATAR_MAX_CHARS) throw new Error('这张图太花了，缩不下来')
  return dataUrl
}
