import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Share } from '@capacitor/share'
import { StatusBar, Style } from '@capacitor/status-bar'
import { GALLERY_ALBUM, base64ToBytes, splitDataUrl } from './photo-store'
import type { DeepSeaBridge } from './global'

interface SecureStorePlugin {
  get: () => Promise<{ value: string | null }>
  set: (options: { value: string }) => Promise<void>
  remove: () => Promise<void>
}

interface WebChatPlugin {
  launch: (options: { url: string; css: string; js?: string }) => Promise<void>
}

/** 原生剪贴板（见 DeepSeaClipboardPlugin.java）：网页里读不到剪贴板时用它兜底。 */
interface ClipboardPlugin {
  read: () => Promise<{ text: string }>
  write: (options: { text: string }) => Promise<void>
}

/**
 * 原生相册（见 DeepSeaGalleryPlugin.java）。
 *
 * 为什么必须自己写一个：Capacitor Filesystem v7 的 Directory 枚举里没有 Pictures，
 * 公共目录在 targetSdk 35 的 scoped storage 下根本写不进去，而主 WebView 又没有
 * DownloadListener（`a[download]` 点了静默无事发生）。唯一能把图放进系统相册的办法
 * 就是原生 MediaStore.Images 插入（API 29+ 免权限）。
 */
interface GalleryPlugin {
  saveImage: (options: { base64: string; mimeType?: string; fileName?: string; album?: string }) => Promise<{ uri: string }>
}

const Secure = registerPlugin<SecureStorePlugin>('DeepSeaSecure')
const WebChat = registerPlugin<WebChatPlugin>('DeepSeaWebChat')
const ClipboardNative = registerPlugin<ClipboardPlugin>('DeepSeaClipboard')
const Gallery = registerPlugin<GalleryPlugin>('DeepSeaGallery')

export const isAndroid = Capacitor.getPlatform() === 'android'
export const isElectron = typeof window !== 'undefined' && window.deepsea !== undefined
export const isWeb = !isAndroid && !isElectron

const bridge = (): DeepSeaBridge | undefined => (typeof window === 'undefined' ? undefined : window.deepsea)

export async function secureGet(): Promise<string | null> {
  const native = bridge()
  if (native) return native.secureGet()
  if (isAndroid) {
    try {
      return (await Secure.get()).value
    } catch {
      return localStorage.getItem('deepsea.apiKey')
    }
  }
  return localStorage.getItem('deepsea.apiKey')
}

export async function secureSet(value: string): Promise<void> {
  const native = bridge()
  if (native) return native.secureSet(value)
  if (isAndroid) {
    try {
      await Secure.set({ value })
      return
    } catch {
      localStorage.setItem('deepsea.apiKey', value)
      return
    }
  }
  localStorage.setItem('deepsea.apiKey', value)
}

export async function secureRemove(): Promise<void> {
  const native = bridge()
  if (native) return native.secureRemove()
  if (isAndroid) {
    try {
      await Secure.remove()
      return
    } catch {
      localStorage.removeItem('deepsea.apiKey')
      return
    }
  }
  localStorage.removeItem('deepsea.apiKey')
}

/**
 * 读剪贴板文本。
 *
 * 安卓上网页里拿不到：`document.execCommand('paste')` 被浏览器禁用，
 * `navigator.clipboard.readText()` 在 Android WebView 里也不可靠，
 * 所以走原生 ClipboardManager（DeepSeaClipboardPlugin）。
 * 桌面端（Electron）先用 navigator.clipboard，失败返回空串。
 */
export async function readClipboardText(): Promise<string> {
  if (isAndroid) {
    try {
      const result = await ClipboardNative.read()
      return result.text ?? ''
    } catch {
      /* 落到下面的网页实现 */
    }
  }
  try {
    return await navigator.clipboard.readText()
  } catch {
    return ''
  }
}

/** 写剪贴板文本。成功返回 true。 */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (isAndroid) {
    try {
      await ClipboardNative.write({ text })
      return true
    } catch {
      /* 落到下面的网页实现 */
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export type WebChatTarget = 'electron' | 'android' | 'external'

/**
 * Open the official DeepSeek web chat in a real top-level WebView/window.
 * The site sends `frame-ancestors 'none'`, so an iframe is not an option.
 */
export async function openWebChat(css: string, js = ''): Promise<WebChatTarget> {
  const native = bridge()
  if (native) {
    await native.openWebChat(css, js)
    return 'electron'
  }
  if (isAndroid) {
    await WebChat.launch({ url: 'https://chat.deepseek.com/', css, js })
    return 'android'
  }
  window.open('https://chat.deepseek.com/', '_blank', 'noopener,noreferrer')
  return 'external'
}

export async function openExternal(url: string): Promise<void> {
  const native = bridge()
  if (native) {
    await native.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function downloadInBrowser(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export async function saveTextFile(name: string, content: string, mime = 'text/plain'): Promise<boolean> {
  const native = bridge()
  if (native) return native.saveFile(name, content)
  if (isAndroid) {
    try {
      const result = await Filesystem.writeFile({
        path: `DeepSea/${name}`,
        data: content,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
        recursive: true,
      })
      await Share.share({ title: name, url: result.uri })
      return true
    } catch {
      downloadInBrowser(name, content, mime)
      return true
    }
  }
  downloadInBrowser(name, content, mime)
  return true
}

/**
 * 把一张图片存出去（拍照查看器唯一的出口）。
 *
 * 三条路都必须有，因为这三端的「保存」根本不是一件事：
 * - **Android**：原生插件写进系统相册 Pictures/深鲸（API 29+ 免权限）。失败就退到
 *   Filesystem 缓存 + 系统分享面板 —— 缓存目录在 FileProvider 的 cache-path 里，
 *   SharePlugin 只吃 `file:` URI，所以必须先落盘再分享。注意**不传 encoding**：
 *   Capacitor 缺省按 base64 解，传了 UTF8 就会把 base64 当文本写进去。
 * - **Electron**：必须走新的二进制 IPC `file:saveImage`。旁边的 `file:save` 是
 *   `writeFileSync(..., 'utf8')`，把 base64 递过去会得到一个「扩展名是 .jpg 的文本文件」，
 *   双击打不开 —— 这正是以前那种「提示保存成功、其实存的是字符串」的坑。
 * - **纯浏览器**：解码成字节再包 Blob 下载（不是文本 blob，理由同上）。
 * @returns 'gallery' 进了系统相册；'shared' 走了分享面板；'downloaded' 落成本地文件；'failed' 全挂了。
 */
export async function saveImage(name: string, dataURL: string): Promise<'gallery' | 'shared' | 'downloaded' | 'failed'> {
  const parts = splitDataUrl(dataURL)
  if (parts === null) return 'failed'
  const native = bridge()
  if (native) {
    if (typeof native.saveImageFile !== 'function') return 'failed'
    try {
      return (await native.saveImageFile(name, parts.base64)) === true ? 'downloaded' : 'failed'
    } catch {
      return 'failed'
    }
  }
  if (isAndroid) {
    try {
      await Gallery.saveImage({ base64: parts.base64, mimeType: parts.mime, fileName: name, album: GALLERY_ALBUM })
      return 'gallery'
    } catch {
      // 权限被拒（API 23–28）、存储不可用、写失败，都从这里退到分享面板，
      // 不能再静默 —— 静默就是用户以为没存上、其实什么都没发生。
    }
    return (await shareImageFile(name, parts.base64)) === true ? 'shared' : 'failed'
  }
  return downloadImage(name, parts.base64, parts.mime) === true ? 'downloaded' : 'failed'
}

/**
 * 分享一张图片。拿不到分享面板（桌面浏览器 / Electron）就退化成「保存」，
 * 退路也要给个明确的返回值，界面上说得清到底发生了什么。
 */
export async function shareImage(name: string, dataURL: string): Promise<'shared' | 'saved' | 'failed'> {
  const parts = splitDataUrl(dataURL)
  if (parts === null) return 'failed'
  if (isAndroid) {
    return (await shareImageFile(name, parts.base64)) === true ? 'shared' : 'failed'
  }
  const native = bridge()
  if (native) {
    const saved = await saveImage(name, dataURL)
    return saved === 'failed' ? 'failed' : 'saved'
  }
  try {
    const file = new File([base64ToBytes(parts.base64)], name, { type: parts.mime })
    const canShare = typeof navigator.canShare === 'function' ? navigator.canShare({ files: [file] }) : false
    if (typeof navigator.share === 'function' && canShare) {
      await navigator.share({ files: [file], title: name })
      return 'shared'
    }
  } catch {
    /* 用户取消或者这个内核不支持文件分享，往下走下载 */
  }
  return downloadImage(name, parts.base64, parts.mime) === true ? 'saved' : 'failed'
}

/** 写进缓存目录再交给系统分享面板（SharePlugin 只接受 file: URI）。 */
async function shareImageFile(name: string, base64: string): Promise<boolean> {
  try {
    const result = await Filesystem.writeFile({
      path: `DeepSea/${name}`,
      data: base64,
      directory: Directory.Cache,
      recursive: true,
    })
    await Share.share({ title: name, url: result.uri })
    return true
  } catch {
    return false
  }
}

/** 浏览器下载：解码成字节再包 Blob，文本 blob 出来的图片是打不开的。 */
function downloadImage(name: string, base64: string, mime: string): boolean {
  try {
    const blob = new Blob([base64ToBytes(base64)], { type: mime })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return true
  } catch {
    return false
  }
}

/**
 * 应用「前台 ↔ 后台」变化。Android 上息屏、切走、回来都走这里。
 *
 * 为什么需要：WebView 页面在后台会被系统降频，时间长一点还可能被冻结、
 * 丢弃 GPU 上下文甚至回收渲染进程；回到前台时如果什么都不做，用户看到的就是
 * 「3D 黑屏 / 工坊预览不动了 / 莫名其妙回到首页」。这个订阅让上层有机会自救：
 * 恢复动画、重建丢掉的 WebGL、重挂工坊预览 iframe。
 *
 * 返回取消订阅函数。桌面/浏览器用 document.visibilitychange 兜底。
 */
export function onAppStateChange(handler: (active: boolean) => void): () => void {
  let disposed = false
  let removeNative: (() => void) | null = null
  if (isAndroid) {
    App.addListener('appStateChange', ({ isActive }) => {
      if (!disposed) handler(isActive)
    })
      .then((handle) => {
        if (disposed) void handle.remove()
        else removeNative = () => void handle.remove()
      })
      .catch(() => undefined)
  }
  const onVisibility = (): void => {
    if (!disposed) handler(!document.hidden)
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    disposed = true
    document.removeEventListener('visibilitychange', onVisibility)
    if (removeNative !== null) removeNative()
  }
}

/**
 * 让用户挑一个文本文件并读回来。取消时返回 null。
 *
 * Electron 走原生对话框（bridge.openFile）；浏览器/安卓退化成隐藏的 file input。
 * 任何一步失败都返回 null，由调用方给出提示 —— 不要把异常抛到 UI 层。
 */
export async function openTextFile(accept = '.json,application/json'): Promise<string | null> {
  const native = bridge()
  if (native?.openFile !== undefined) {
    try {
      const text = await native.openFile(accept)
      return typeof text === 'string' ? text : null
    } catch {
      return null
    }
  }
  return new Promise<string | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file === undefined) {
        finish(null)
        return
      }
      const reader = new FileReader()
      reader.onload = () => finish(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => finish(null)
      reader.readAsText(file)
    })
    // 用户点取消不会触发 change；用 focus 回来后的一点延迟兜底。
    window.addEventListener('focus', () => window.setTimeout(() => finish(null), 800), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

export async function shareText(title: string, text: string): Promise<void> {
  if (isAndroid) {
    try {
      await Share.share({ title, text })
      return
    } catch {
      /* user cancelled or share unavailable */
    }
  }
  const navigatorWithShare = navigator as Navigator & {
    share?: (data: { title?: string; text?: string }) => Promise<void>
  }
  if (navigatorWithShare.share) {
    try {
      await navigatorWithShare.share({ title, text })
      return
    } catch {
      /* cancelled */
    }
  }
  await saveTextFile(`${title}.txt`, text)
}

/**
 * 分享一份 Markdown 文档。
 *
 * 和 shareText 的区别只有降级路径：系统分享不可用时（桌面 Electron 没有
 * navigator.share），存成 .md 而不是 .txt —— 后缀决定了用户双击时用什么打开。
 * @returns 'shared' 表示走系统分享，'saved' 表示存成了文件，'cancelled' 表示用户取消。
 */
export async function shareMarkdown(
  fileName: string,
  markdown: string,
  title = '对话',
): Promise<'shared' | 'saved' | 'cancelled'> {
  if (isAndroid) {
    try {
      await Share.share({ title, text: markdown })
      return 'shared'
    } catch {
      /* 用户取消或不可用，往下走保存 */
    }
  }
  const navigatorWithShare = navigator as Navigator & {
    share?: (data: { title?: string; text?: string }) => Promise<void>
  }
  if (navigatorWithShare.share) {
    try {
      await navigatorWithShare.share({ title, text: markdown })
      return 'shared'
    } catch {
      /* 取消 */
    }
  }
  const safeName = fileName.toLowerCase().endsWith('.md') ? fileName : `${fileName}.md`
  const saved = await saveTextFile(safeName, markdown, 'text/markdown')
  return saved ? 'saved' : 'cancelled'
}

export async function haptic(kind: 'light' | 'medium' = 'light'): Promise<void> {
  if (!isAndroid) return
  try {
    await Haptics.impact({ style: kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light })
  } catch {
    /* haptics are optional */
  }
}

export async function appVersion(): Promise<string> {
  const native = bridge()
  if (native) return native.version
  if (isAndroid) {
    try {
      const info = await App.getInfo()
      return info.version
    } catch {
      return '0.1.0'
    }
  }
  return '0.1.0'
}

export async function prepareNativeShell(): Promise<void> {
  if (!isAndroid) return
  try {
    await StatusBar.setStyle({ style: Style.Dark })
    await StatusBar.setBackgroundColor({ color: '#04141d' })
  } catch {
    /* status bar is best effort */
  }
}

export async function keepAwake(awake: boolean): Promise<void> {
  // Kept as one seam so a native keep-awake plugin can replace the no-op later.
  void awake
}
