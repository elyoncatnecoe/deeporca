import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { Armchair, ImagePlus, Palette, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { APP_TONES } from '../lib/look'
import { MAX_CHAT_BACKDROP_CHARS } from '../lib/settings'
import { useAppStore } from '../lib/store'
import type { ThemeId } from '../lib/types'
import { ScreenHeader, Spinner } from './ui'

/*
 * 外观面板：首页右上角那枚调色盘打开的页面。
 *
 * 为什么单独开一屏，而不是塞回设置页：这里改的全是「看一眼就变」的东西
 * （配色、底图、界面色调），设置页那边是「填一次就不动」的连接与数据。
 * 混在一起时用户为了换个颜色要翻过大半屏 Key 和备份按钮。
 *
 * 三项能力都走 `actions.setSettings`，改完立刻落库、立刻生效，没有「保存」按钮。
 */

/** 三套预设的强调色 / 用户气泡色。和 styles.css 的 :root 与 [data-tone] 规则一一对应。 */
const TONE_ACCENT: Record<ThemeId, string> = {
  deep: '#ff9b7a',
  iceberg: '#9fd8ea',
  tropical: '#ffb27a',
}

const TONE_BUBBLE: Record<ThemeId, string> = {
  deep: '#ffb195',
  iceberg: '#a9d6e5',
  tropical: '#ffcf9f',
}

/* ------------------------------------------------------------ 颜色工具 */

/** `#rrggbb` → 三元组。调用方保证是 sanitize 过的合法值（见 settings.ts）。 */
function rgbOf(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function hexOf(red: number, green: number, blue: number): string {
  const part = (value: number): string => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')
  return `#${part(red)}${part(green)}${part(blue)}`
}

/** amount < 0 变暗，> 0 变亮；用来从一个颜色推出渐变第二个色标。 */
function shade(hex: string, amount: number): string {
  const [red, green, blue] = rgbOf(hex)
  if (amount < 0) {
    const k = 1 + amount
    return hexOf(red * k, green * k, blue * k)
  }
  return hexOf(red + (255 - red) * amount, green + (255 - green) * amount, blue + (255 - blue) * amount)
}

function alphaOf(hex: string, alpha: number): string {
  const [red, green, blue] = rgbOf(hex)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

/** 相对亮度（sRGB 近似）：决定气泡上的字该用深色还是浅色。 */
function luminanceOf(hex: string): number {
  const [red, green, blue] = rgbOf(hex)
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
}

/**
 * 把用户选的颜色翻译成 `.app` 上的内联 CSS 变量。
 *
 * 内联样式优先级高于 `.app[data-tone='…']` 这条规则，所以自定义色能盖住预设；
 * 两个颜色都是 null 时返回 undefined —— 那时一个变量都不写，界面原样跟预设走。
 *
 * 只覆盖强调色和用户气泡这两组变量，不碰 `--aqua`：青绿辅助色在很多地方是
 * 「在深色底上当文字色」用的（链接、选中态、代码高亮），让用户随手挑一个
 * 深色就能把这些字变得看不清，收益不值这个风险。
 */
export function appearanceStyle(accent: string | null, bubble: string | null): CSSProperties | undefined {
  const vars: Record<string, string> = {}
  if (accent !== null) {
    vars['--accent'] = accent
    vars['--accent-2'] = shade(accent, -0.12)
  }
  if (bubble !== null) {
    vars['--bubble-user-from'] = bubble
    vars['--bubble-user-to'] = shade(bubble, -0.1)
    // 气泡上的字：浅色气泡配深棕，深色气泡配近白 —— 用户挑什么颜色都不会看不清。
    const ink = luminanceOf(bubble) > 0.56 ? '#2b1a12' : '#f2fbfd'
    vars['--bubble-user-ink'] = ink
    vars['--bubble-user-ink-soft'] = alphaOf(ink, 0.62)
    vars['--bubble-user-ink-faint'] = alphaOf(ink, 0.45)
    vars['--bubble-user-shadow'] = alphaOf(bubble, 0.18)
  }
  if (Object.keys(vars).length === 0) return undefined
  return vars as CSSProperties
}

/* ---------------------------------------------------------- 底图压缩 */

/** 最长边。和附件图一致（见 lib/attachments.ts），再大在对话面板里也看不出差别。 */
const BACKDROP_MAX_EDGE = 1600
const BACKDROP_QUALITY = 0.82
/**
 * 压缩后的体积上限（dataURL 字符数）。
 *
 * 取 sanitize 上限的六成：留出余量，免得刚存进去的图在下次启动时被
 * `normalizeChatBackdrop` 判成超大值直接丢掉 —— 那对用户就是「图没了」。
 */
const BACKDROP_TARGET_CHARS = Math.floor(MAX_CHAT_BACKDROP_CHARS * 0.6)

/** 读图。优先 createImageBitmap；老 WebView 不支持时退回 <img>。 */
async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      /* HEIC / 老内核：往下走 <img> 那条路，还是不行就抛文案 */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('这张图读不了；iPhone 的 HEIC 请先转成 JPG / PNG'))
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

function encodeBackdrop(source: CanvasImageSource, width: number, height: number, quality: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('这台设备没法处理图片')
  // JPEG 没有透明通道：先铺一层深海底色，透明 PNG 转出来才不会是一坨黑。
  context.fillStyle = '#04141d'
  context.fillRect(0, 0, width, height)
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', quality)
}

/**
 * 本地图片 → 对话底图。
 *
 * 一律重编码成 JPEG：用户随手选的照片动辄几 MB，原样存进 IndexedDB 会让
 * 「保存设置」每次都要克隆一个巨大的字符串，界面直接卡住。
 */
async function fileToBackdrop(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('得选一张图片')
  const source = await loadBitmap(file)
  const naturalWidth = source instanceof HTMLImageElement ? source.naturalWidth : source.width
  const naturalHeight = source instanceof HTMLImageElement ? source.naturalHeight : source.height
  // 0 尺寸（比如某些 SVG）：直接按目标边长画。
  const longest = Math.max(naturalWidth, naturalHeight, 1)
  const scale = Math.min(1, BACKDROP_MAX_EDGE / longest)
  let width = Math.max(1, Math.round((naturalWidth || longest) * scale))
  let height = Math.max(1, Math.round((naturalHeight || longest) * scale))

  let quality = BACKDROP_QUALITY
  let dataUrl = encodeBackdrop(source, width, height, quality)
  // 花哨的照片压不进目标体积：先降质，再降边长，宁可糊一点也不撑爆存储。
  while (dataUrl.length > BACKDROP_TARGET_CHARS && quality > 0.5) {
    quality -= 0.08
    dataUrl = encodeBackdrop(source, width, height, quality)
  }
  if (dataUrl.length > BACKDROP_TARGET_CHARS) {
    width = Math.max(1, Math.round(width * 0.7))
    height = Math.max(1, Math.round(height * 0.7))
    dataUrl = encodeBackdrop(source, width, height, 0.72)
  }
  if ('close' in source) source.close()
  if (dataUrl.length > MAX_CHAT_BACKDROP_CHARS) throw new Error('这张图压完还是太大，换一张试试')
  return dataUrl
}

/* -------------------------------------------------------------- 面板 */

export function AppearanceScreen() {
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [opacity, setOpacity] = useState(settings.chatBackdropOpacity)
  /**
   * 不透明度先改本地值（滑杆立刻跟手），停手 220ms 才落库。
   *
   * 底图是几百 KB 的 dataURL，而 setSettings 每次都要把整份设置 structured clone
   * 进 IndexedDB；拖动时每一格都写一次，等于几十次大对象写入，滑杆会明显发涩。
   */
  const pendingOpacity = useRef<number | null>(null)
  const opacityTimer = useRef<number | null>(null)

  const flushOpacity = (): void => {
    if (opacityTimer.current !== null) {
      window.clearTimeout(opacityTimer.current)
      opacityTimer.current = null
    }
    const pending = pendingOpacity.current
    pendingOpacity.current = null
    if (pending !== null) void actions.setSettings({ chatBackdropOpacity: pending })
  }

  // 关掉面板时把没来得及落库的那个值补上，否则最后 220ms 的拖动会丢。
  // 依赖留空是有意的：flushOpacity 只碰 ref 和稳定的 store actions。
  useEffect(() => flushOpacity, [])

  const commitOpacity = (value: number): void => {
    setOpacity(value)
    pendingOpacity.current = value
    if (opacityTimer.current !== null) window.clearTimeout(opacityTimer.current)
    opacityTimer.current = window.setTimeout(flushOpacity, 220)
  }

  const pickBackdrop = (): void => {
    fileRef.current?.click()
  }

  const onBackdropFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    // 清掉 value：同一个文件再选一次也要能触发 change（用户可能换走又换回来）。
    event.target.value = ''
    if (file === undefined) return
    setBusy(true)
    try {
      const dataUrl = await fileToBackdrop(file)
      await actions.setSettings({ chatBackdrop: dataUrl })
      actions.showToast('对话底图已换上')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '这张图用不了')
    } finally {
      setBusy(false)
    }
  }

  const clearBackdrop = async (): Promise<void> => {
    await actions.setSettings({ chatBackdrop: null })
    actions.showToast('底图已清掉')
  }

  const accentValue = settings.customAccent ?? TONE_ACCENT[settings.appTone]
  const bubbleValue = settings.customBubble ?? TONE_BUBBLE[settings.appTone]
  const backdrop = settings.chatBackdrop
  const backdropKb = backdrop === null ? 0 : Math.round((backdrop.length * 3) / 4 / 1024)

  return (
    <div className="screen appearance-screen">
      <div className="screen-panel">
        <ScreenHeader
          title="外观"
          subtitle="配色、底图、界面色调 · 改完立刻生效"
          onBack={() => actions.setScreen('home')}
        />

        <div className="screen-body appearance-body">
          <section className="settings-card">
            <h2><Palette size={17} /> 界面色调</h2>
            <p className="settings-hint">
              只改 App 自己的强调色和气泡配色。海底主题、虎鲸皮肤、光效和画质都在「布置」里 ——
              两边已经解绑，换一个不会带着另一个一起变。
            </p>
            <div className="theme-grid">
              {APP_TONES.map((tone) => (
                <button
                  key={tone.id}
                  type="button"
                  className={`theme-card theme-${tone.id} ${settings.appTone === tone.id ? 'is-active' : ''}`}
                  onClick={() => void actions.setSettings({ appTone: tone.id })}
                >
                  <span />
                  <strong>{tone.name}</strong>
                  <small>{tone.hint}</small>
                </button>
              ))}
            </div>
            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => actions.setScreen('room')}>
                <Armchair size={15} /> 去布置海底
              </button>
            </div>
          </section>

          <section className="settings-card">
            <h2><Sparkles size={17} /> 自定义配色</h2>
            <p className="settings-hint">
              换掉强调色和你的气泡颜色，和上面的三套色调可以叠着用：没选的时候跟着色调走，
              选了就以你为准。只覆盖强调色与气泡，页面底色还是海底那套。
            </p>

            <div className="appearance-color-row">
              <div className="appearance-color-copy">
                <strong>强调色</strong>
                <small>{settings.customAccent === null ? '跟随界面色调' : settings.customAccent}</small>
              </div>
              <input
                type="color"
                className="appearance-color-input"
                aria-label="自定义强调色"
                value={accentValue}
                onChange={(event) => void actions.setSettings({ customAccent: event.target.value })}
              />
              <button
                type="button"
                className="ghost-button appearance-color-reset"
                onClick={() => void actions.setSettings({ customAccent: null })}
                disabled={settings.customAccent === null}
              >
                <RefreshCw size={13} /> 跟随预设
              </button>
            </div>

            <div className="appearance-color-row">
              <div className="appearance-color-copy">
                <strong>我的气泡</strong>
                <small>{settings.customBubble === null ? '跟随界面色调' : settings.customBubble}</small>
              </div>
              <input
                type="color"
                className="appearance-color-input"
                aria-label="自定义用户气泡颜色"
                value={bubbleValue}
                onChange={(event) => void actions.setSettings({ customBubble: event.target.value })}
              />
              <button
                type="button"
                className="ghost-button appearance-color-reset"
                onClick={() => void actions.setSettings({ customBubble: null })}
                disabled={settings.customBubble === null}
              >
                <RefreshCw size={13} /> 跟随预设
              </button>
            </div>

            <div className="appearance-preview" aria-hidden="true">
              <span className="appearance-preview-bubble">这样能看清吗？</span>
              <span className="appearance-preview-note">气泡上的字会自动换成深色或浅色</span>
            </div>
          </section>

          <section className="settings-card">
            <h2><ImagePlus size={17} /> 对话底图</h2>
            <p className="settings-hint">
              选一张本地图片铺在对话面板后面。会先压到最长边 1600、JPEG 0.82 再存进本机数据库，
              所以不会撑爆存储；底图只在这台设备上，不进备份。
            </p>

            {backdrop === null ? (
              <div className="appearance-backdrop-empty">
                <span>还没有底图</span>
                <button type="button" className="ghost-button" onClick={pickBackdrop} disabled={busy}>
                  {busy ? <Spinner small /> : <ImagePlus size={15} />} 选一张图片
                </button>
              </div>
            ) : (
              <>
                <div
                  className="appearance-backdrop-preview"
                  style={{ backgroundImage: `url(${backdrop})` }}
                  role="img"
                  aria-label="当前对话底图预览"
                />
                <div className="inline-actions">
                  <button type="button" className="ghost-button" onClick={pickBackdrop} disabled={busy}>
                    {busy ? <Spinner small /> : <ImagePlus size={15} />} 换一张
                  </button>
                  <button type="button" className="ghost-button is-danger" onClick={() => void clearBackdrop()}>
                    <Trash2 size={14} /> 清除底图
                  </button>
                </div>
                <label className="field">
                  <span>不透明度 {Math.round(opacity * 100)}% · {backdropKb} KB</span>
                  <input
                    type="range"
                    className="appearance-range"
                    min={10}
                    max={100}
                    step={1}
                    value={Math.round(opacity * 100)}
                    onChange={(event) => commitOpacity(Number(event.target.value) / 100)}
                  />
                </label>
                <p className="settings-hint">
                  底图上盖了一层暗色遮罩，保证文字还看得清；照片太花就往左拉一点。
                </p>
              </>
            )}

            {/* 真正的文件选择器：按钮点它，样式不可控的原生控件就藏起来。 */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="visually-hidden"
              onChange={(event) => void onBackdropFile(event)}
            />
          </section>
        </div>
      </div>
    </div>
  )
}
