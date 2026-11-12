import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '../lib/store'
import { readClipboardText, writeClipboardText } from '../lib/platform'

/**
 * App 内自绘的文本编辑工具条：复制 / 剪切 / 粘贴 / 全选 / 删除。
 *
 * 为什么自己画：Android 系统的文本选择工具条（FloatingActionMode）在某些 ROM 上会
 * 渲染成整块白色面板盖住界面。实测改主题、钉死 colorBackgroundFloating 都救不回来
 * （2026-11-01 真机），所以主界面 WebView 把系统工具条压掉了（DeepSeaWebView.java），
 * 由这条自绘工具条接管；粘贴走原生剪贴板插件（DeepSeaClipboardPlugin）。
 *
 * 三类编辑上下文，动作集不同：
 *   field = <input>/<textarea>          → 复制 剪切 粘贴 全选 删除
 *   rich  = [contenteditable]（CodeMirror 工坊编辑器）→ 复制 剪切 粘贴 全选 删除
 *   page  = 普通只读文本                → 复制 全选
 * 没有选区时只给「粘贴 / 全选」（粘贴到光标处）。
 *
 * 触发：有选区时自动出现 / 长按 ≥420ms / contextmenu（桌面右键）。
 * 定位：锚在被编辑元素本身（不是选区），优先贴其上方，空间不够翻到下方，
 *       并夹在视口与所在 Modal 卡片之内，避免压住输入框和标题。
 */
type Field = HTMLInputElement | HTMLTextAreaElement
type Kind = 'field' | 'rich' | 'page'

type BarState = {
  /** 锚点矩形（视口坐标） */
  anchor: { left: number; top: number; bottom: number; width: number }
  kind: Kind
  hasSelection: boolean
}

const LONG_PRESS_MS = 420
const BAR_HEIGHT = 38
/** 工具条与被锚定元素之间的间距 */
const BAR_OFFSET = 8
/** 还没量到真实宽度时的兜底值 */
const FALLBACK_WIDTH = 216

function isTextField(element: Element | null): element is Field {
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) {
    const type = element.type
    return type !== 'checkbox' && type !== 'radio' && type !== 'range' && type !== 'file' && type !== 'color'
  }
  return false
}

/** 当前编辑目标：输入框 / 可编辑区（含 CodeMirror）/ 都没有。 */
function currentTarget(): { kind: 'field' | 'rich'; el: HTMLElement } | null {
  const active = document.activeElement
  if (isTextField(active)) return { kind: 'field', el: active }
  if (active instanceof HTMLElement) {
    const rich = active.closest('[contenteditable="true"]')
    if (rich instanceof HTMLElement) return { kind: 'rich', el: rich }
  }
  // 焦点可能不在编辑区（例如手指拖手柄），从选区反查
  const selection = window.getSelection()
  const anchorNode = selection?.anchorNode ?? null
  const element = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null
  const rich = element?.closest('[contenteditable="true"]') ?? null
  if (rich instanceof HTMLElement) return { kind: 'rich', el: rich }
  return null
}

function fieldSelection(field: Field): { start: number; end: number; text: string } {
  const start = field.selectionStart ?? 0
  const end = field.selectionEnd ?? 0
  return { start, end, text: field.value.slice(start, end) }
}

function selectedText(): string {
  const selection = window.getSelection()
  return selection === null ? '' : selection.toString()
}

/**
 * 把值写进输入框并触发 React 的 onChange。
 *
 * 直接改 el.value 不会让 React 收到变更（它监听的是原生 setter 之后的 input 事件），
 * 所以要用原型上的 setter 绕过 React 对 value 的追踪。
 */
function setFieldValue(field: Field, next: string, caret: number): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) {
    field.value = next
    return
  }
  setter.call(field, next)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  try {
    field.setSelectionRange(caret, caret)
  } catch {
    /* number/date 这类输入框不支持 setSelectionRange */
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function rectOf(element: Element): BarState['anchor'] {
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }
}

export function SelectionCopyBar() {
  const [bar, setBar] = useState<BarState | null>(null)
  /** 量出来的真实宽度；定位要用它来居中。 */
  const [width, setWidth] = useState(0)
  const barRef = useRef<HTMLDivElement | null>(null)
  /** 触发工具条时的编辑目标：点按钮会让输入框失焦，得先记住它。 */
  const targetRef = useRef<{ kind: 'field' | 'rich'; el: HTMLElement } | null>(null)
  const selectionTimer = useRef<number | undefined>(undefined)
  const pressTimer = useRef<number | undefined>(undefined)
  const pressPoint = useRef<{ x: number; y: number } | null>(null)

  const hide = (): void => {
    setBar(null)
    setWidth(0)
  }

  const showForTarget = (target: { kind: 'field' | 'rich'; el: HTMLElement }): void => {
    targetRef.current = target
    const hasSelection = target.kind === 'field'
      ? fieldSelection(target.el as Field).text !== ''
      : selectedText() !== ''
    setBar({ anchor: rectOf(target.el), kind: target.kind, hasSelection })
  }

  const showForPage = (anchor?: BarState['anchor']): void => {
    targetRef.current = null
    let rect = anchor
    if (rect === undefined) {
      const selection = window.getSelection()
      if (selection === null || selection.rangeCount === 0) return
      const rangeRect = selection.getRangeAt(0).getBoundingClientRect()
      rect = { left: rangeRect.left, top: rangeRect.top, bottom: rangeRect.bottom, width: rangeRect.width }
    }
    setBar({ anchor: rect, kind: 'page', hasSelection: selectedText() !== '' })
  }

  /** 选区/长按/右键 → 决定给哪种上下文。 */
  const showFromSelection = (point?: { x: number; y: number }): void => {
    const target = currentTarget()
    if (target !== null) {
      // 输入框获得焦点、光标挪一下也会触发 selectionchange。那种情况**没有真的选中文字**，
      // 不该弹工具条 —— 否则在设置页敲完字、切到对话页，它会一直浮在屏幕中间压住 popover。
      // 长按/右键（带 point 或走 showForTarget）仍然照弹，粘贴/全选还是找得到。
      const hasSelection = target.kind === 'field'
        ? fieldSelection(target.el as Field).text !== ''
        : selectedText() !== ''
      if (!hasSelection && point === undefined) return
      showForTarget(target)
      return
    }
    const text = selectedText()
    if (text.trim() === '') {
      // 没有选区也没有编辑目标：长按空白处不弹，避免误触
      if (point === undefined) return
      return
    }
    showForPage()
  }

  useEffect(() => {
    const onSelectionChange = (): void => {
      if (selectionTimer.current !== undefined) window.clearTimeout(selectionTimer.current)
      // 选区在拖动过程中会连续变化，稍等一下再定位，避免工具条抖动。
      selectionTimer.current = window.setTimeout(() => showFromSelection(), 30)
    }

    const onTouchStart = (event: TouchEvent): void => {
      const node = event.target as Node | null
      if (barRef.current !== null && node !== null && barRef.current.contains(node)) return
      if (event.touches.length !== 1) {
        window.clearTimeout(pressTimer.current)
        return
      }
      const touch = event.touches[0]
      if (touch === undefined) return
      pressPoint.current = { x: touch.clientX, y: touch.clientY }
      if (pressTimer.current !== undefined) window.clearTimeout(pressTimer.current)
      pressTimer.current = window.setTimeout(() => {
        const point = pressPoint.current
        if (point === null) return
        showFromSelection(point)
      }, LONG_PRESS_MS)
    }

    const cancelPress = (): void => {
      if (pressTimer.current !== undefined) window.clearTimeout(pressTimer.current)
      pressTimer.current = undefined
    }

    const onContextMenu = (event: Event): void => {
      event.preventDefault()
      const mouse = event as MouseEvent
      const point = {
        x: Number.isFinite(mouse.clientX) && mouse.clientX > 0 ? mouse.clientX : undefined,
        y: Number.isFinite(mouse.clientY) && mouse.clientY > 0 ? mouse.clientY : undefined,
      }
      const target = currentTarget()
      if (target !== null) {
        showForTarget(target)
        return
      }
      if (selectedText() !== '') showForPage()
      else if (point.x !== undefined && point.y !== undefined) {
        showForPage({ left: point.x, top: point.y, bottom: point.y, width: 0 })
      }
    }

    const onScrollOrResize = (): void => hide()

    /**
     * 点工具条以外的地方就收起来。
     *
     * 为什么必须加：工具条只在「选区变化 / 滚动 / 改窗口大小」时收，用户在一个输入框里
     * 敲完字（敲字会触发 selectionchange）然后切到别的页面，它会一直浮在屏幕中间 ——
     * 实测会正好压在对话页的模型 popover 和导出弹层上。点在编辑目标自己身上不藏，
     * 那种情况用户是在定位光标，藏了反而碍事。
     */
    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null
      if (node === null) return
      if (barRef.current !== null && barRef.current.contains(node)) return
      const target = currentTarget()
      if (target !== null && target.el.contains(node)) return
      hide()
    }

    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', cancelPress, { passive: true })
    document.addEventListener('touchend', cancelPress)
    document.addEventListener('touchcancel', cancelPress)
    document.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)

    return () => {
      if (selectionTimer.current !== undefined) window.clearTimeout(selectionTimer.current)
      if (pressTimer.current !== undefined) window.clearTimeout(pressTimer.current)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', cancelPress)
      document.removeEventListener('touchend', cancelPress)
      document.removeEventListener('touchcancel', cancelPress)
      document.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 换页面就收起来：工具条不认识路由，留着会飘到下一个页面上（比如对话页的 popover）。
  const screen = useAppStore((state) => state.screen)
  useEffect(() => {
    hide()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen])

  // 量真实宽度：动作数不同宽度不同，写死会偏。
  useLayoutEffect(() => {
    if (bar === null) return
    const measured = barRef.current?.offsetWidth ?? 0
    if (measured > 0 && Math.abs(measured - width) > 1) setWidth(measured)
  }, [bar, width])

  const toast = (message: string): void => {
    useAppStore.getState().actions.showToast(message)
  }

  const fieldTarget = (): Field | null => {
    const target = targetRef.current
    if (target === null || target.kind !== 'field') return null
    return target.el as Field
  }

  const richTarget = (): HTMLElement | null => {
    const target = targetRef.current
    if (target === null || target.kind !== 'rich') return null
    return target.el
  }

  /** 把焦点放回编辑目标，execCommand 才有作用对象。 */
  const focusTarget = (): void => {
    const target = targetRef.current
    if (target === null) return
    try {
      target.el.focus({ preventScroll: true })
    } catch {
      /* 忽略 */
    }
  }

  const doCopy = async (): Promise<void> => {
    hide()
    const field = fieldTarget()
    if (field !== null) {
      const { text } = fieldSelection(field)
      if (text === '') return
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      if (!ok) ok = await writeClipboardText(text)
      if (ok) toast('已复制')
      return
    }
    const text = selectedText()
    if (text === '') return
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    if (!ok) ok = await writeClipboardText(text)
    if (ok) toast('已复制')
  }

  const doCut = async (): Promise<void> => {
    hide()
    const field = fieldTarget()
    if (field !== null) {
      const { start, end, text } = fieldSelection(field)
      if (text === '') return
      let ok = false
      try {
        ok = document.execCommand('cut')
      } catch {
        ok = false
      }
      if (!ok) {
        ok = await writeClipboardText(text)
        if (ok) setFieldValue(field, field.value.slice(0, start) + field.value.slice(end), start)
      }
      if (ok) toast('已剪切')
      return
    }
    const rich = richTarget()
    if (rich === null) return
    const text = selectedText()
    if (text === '') return
    focusTarget()
    let ok = false
    try {
      ok = document.execCommand('cut')
    } catch {
      ok = false
    }
    if (!ok) {
      ok = await writeClipboardText(text)
      if (ok) {
        try {
          document.execCommand('delete')
        } catch {
          /* 忽略 */
        }
      }
    }
    if (ok) toast('已剪切')
  }

  const doPaste = async (): Promise<void> => {
    hide()
    const text = await readClipboardText()
    if (text === '') {
      toast('剪贴板是空的，或者没有读取权限')
      return
    }
    const field = fieldTarget()
    if (field !== null) {
      const { start, end } = fieldSelection(field)
      const next = field.value.slice(0, start) + text + field.value.slice(end)
      try {
        field.focus({ preventScroll: true })
      } catch {
        /* 忽略 */
      }
      setFieldValue(field, next, start + text.length)
      return
    }
    if (richTarget() !== null) {
      focusTarget()
      try {
        // contenteditable（含 CodeMirror）走 insertText 最稳：它触发 beforeinput，
        // 编辑器自己的状态与撤销栈都能跟上。
        document.execCommand('insertText', false, text)
      } catch {
        toast('这个编辑器里没法粘贴')
      }
    }
  }

  const doDelete = (): void => {
    hide()
    const field = fieldTarget()
    if (field !== null) {
      const { start, end, text } = fieldSelection(field)
      if (text === '') return
      setFieldValue(field, field.value.slice(0, start) + field.value.slice(end), start)
      return
    }
    if (richTarget() === null) return
    focusTarget()
    try {
      document.execCommand('delete')
    } catch {
      /* 忽略 */
    }
  }

  const doSelectAll = (): void => {
    const field = fieldTarget()
    if (field !== null) {
      try {
        field.focus({ preventScroll: true })
      } catch {
        /* 忽略 */
      }
      try {
        field.setSelectionRange(0, field.value.length)
      } catch {
        /* 不支持的输入类型 */
      }
      showForTarget({ kind: 'field', el: field })
      return
    }
    const rich = richTarget()
    if (rich !== null) {
      focusTarget()
      const range = document.createRange()
      range.selectNodeContents(rich)
      const selection = window.getSelection()
      if (selection !== null) {
        selection.removeAllRanges()
        selection.addRange(range)
      }
      showForTarget({ kind: 'rich', el: rich })
      return
    }
    try {
      document.execCommand('selectAll')
    } catch {
      /* 忽略 */
    }
    showForPage()
  }

  if (bar === null) return null

  const actions: Array<{ id: string; label: string; run: () => void }> = []
  if (bar.kind === 'page') {
    if (bar.hasSelection) actions.push({ id: 'copy', label: '复制', run: () => void doCopy() })
    actions.push({ id: 'all', label: '全选', run: doSelectAll })
  } else {
    if (bar.hasSelection) {
      actions.push({ id: 'copy', label: '复制', run: () => void doCopy() })
      actions.push({ id: 'cut', label: '剪切', run: () => void doCut() })
    }
    actions.push({ id: 'paste', label: '粘贴', run: () => void doPaste() })
    actions.push({ id: 'all', label: '全选', run: doSelectAll })
    if (bar.hasSelection) actions.push({ id: 'delete', label: '删除', run: doDelete })
  }
  if (actions.length === 0) return null

  // 定位：贴锚点上方；空间不够翻到下方；夹在视口和所在 Modal 之内。
  const barWidth = width > 0 ? width : FALLBACK_WIDTH
  const modal = targetRef.current?.el.closest('.modal-card') ?? null
  const bounds = modal !== null ? modal.getBoundingClientRect() : null
  const minLeft = Math.max(8, bounds?.left ?? 8) + 6
  const maxLeft = Math.min(window.innerWidth - 8, bounds?.right ?? window.innerWidth) - 6
  const centerX = bar.anchor.left + bar.anchor.width / 2
  const left = clamp(centerX - barWidth / 2, minLeft, maxLeft - barWidth)
  const above = bar.anchor.top - BAR_OFFSET - BAR_HEIGHT
  const below = bar.anchor.bottom + BAR_OFFSET
  const minTop = Math.max(8, bounds?.top ?? 8) + 6
  const maxTop = Math.min(window.innerHeight - 8, bounds?.bottom ?? window.innerHeight) - 6 - BAR_HEIGHT
  const top = clamp(above >= minTop ? above : below, minTop, maxTop)

  return (
    <div
      ref={barRef}
      className="selection-copy"
      style={{ left: `${left}px`, top: `${top}px`, visibility: width > 0 ? 'visible' : 'hidden' }}
      // 按下就阻止默认行为：否则编辑区会失焦，粘贴/剪切就没了作用对象。
      onMouseDown={(event) => event.preventDefault()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="selection-copy-item"
          onMouseDown={(event) => event.preventDefault()}
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}