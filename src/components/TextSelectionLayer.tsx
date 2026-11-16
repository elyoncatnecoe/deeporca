import { useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react'
import { isAndroid, writeClipboardText } from '../lib/platform'
import { useAppStore } from '../lib/store'

/**
 * 自绘文本选择（仅 Android 主界面使用）。
 *
 * 为什么要自绘：Android WebView 91 的原生选择手柄 / FloatingActionMode 会在
 * 部分 ROM 上闪白块，且主题改不动（见 DeepSeaWebView / SelectionMenuSuppressor）。
 * 所以主界面把消息区的原生选择关掉（user-select:none），由这里自己实现：
 *   · 长按 → 选中光标下的词/句（caretRangeFromPoint 自己算）；
 *   · 画高亮 + 两个可拖手柄；
 *   · 弹出「复制 / 全选」工具条（编辑框仍由 SelectionCopyBar 负责）。
 * 全程不触发原生 ActionMode，因此没有白屏来源。
 */

type DomPoint = { node: Node; offset: number }
type SelState = {
  range: Range
  rects: Array<{ left: number; top: number; width: number; height: number }>
  text: string
  toolbar: { left: number; top: number }
  start: DomPoint
  end: DomPoint
}

const SELECT_ROOT = '.bubble-body, .reasoning'
const LONG_PRESS_MS = 450
const MOVE_TOLERANCE = 10

function caretPointAt(x: number, y: number): DomPoint | null {
  const anyDoc = document as unknown as {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  if (typeof anyDoc.caretRangeFromPoint === 'function') {
    const range = anyDoc.caretRangeFromPoint(x, y)
    if (range !== null) return { node: range.startContainer, offset: range.startOffset }
  }
  if (typeof anyDoc.caretPositionFromPoint === 'function') {
    const pos = anyDoc.caretPositionFromPoint(x, y)
    if (pos !== null) return { node: pos.offsetNode, offset: pos.offset }
  }
  return null
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

/** 把一个光标点扩成一个「词」：连续字母/数字/汉字算一个词，标点断开。 */
function wordAround(point: DomPoint): { start: DomPoint; end: DomPoint } {
  let { node, offset } = point
  if (node.nodeType !== Node.TEXT_NODE) {
    return { start: { node, offset }, end: { node, offset } }
  }
  const data = (node as Text).data
  let start = Math.min(offset, data.length)
  let end = start
  // 光标可能停在字符右侧；两侧都试一下。
  const isWord = (index: number): boolean => index >= 0 && index < data.length && WORD_CHAR.test(data[index] as string)
  if (!isWord(start) && isWord(start - 1)) start -= 1
  end = start
  if (!isWord(start)) {
    // 点在标点/空白上：退化为只选这一个字符。
    return { start: { node, offset: start }, end: { node, offset: Math.min(start + 1, data.length) } }
  }
  while (start > 0 && isWord(start - 1)) start -= 1
  while (end < data.length && isWord(end)) end += 1
  return { start: { node, offset: start }, end: { node, offset: end } }
}

function buildRange(a: DomPoint, b: DomPoint): Range | null {
  const range = document.createRange()
  try {
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
    return range
  } catch {
    try {
      range.setStart(b.node, b.offset)
      range.setEnd(a.node, a.offset)
      return range
    } catch {
      return null
    }
  }
}

function rectsOf(range: Range): SelState['rects'] {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const raw = Array.from(range.getClientRects())
  const out: SelState['rects'] = []
  for (const rect of raw) {
    if (rect.width <= 0 || rect.height <= 0) continue
    // 防御：某些 range 会返回一个覆盖整屏的矩形（就是之前“整屏绿蒙版”的来源），丢掉它。
    if (rect.width > vw * 1.02 || rect.height > vh * 0.6) continue
    const left = Math.max(0, Math.min(rect.left, vw))
    const top = Math.max(0, Math.min(rect.top, vh))
    const right = Math.max(0, Math.min(rect.left + rect.width, vw))
    const bottom = Math.max(0, Math.min(rect.top + rect.height, vh))
    if (right - left < 1 || bottom - top < 1) continue
    out.push({ left, top, width: right - left, height: bottom - top })
  }
  if (out.length === 0) {
    const box = range.getBoundingClientRect()
    if (box.width > 0 && box.height > 0 && box.width <= vw * 1.02 && box.height <= vh * 0.6) {
      out.push({ left: Math.max(0, box.left), top: Math.max(0, box.top), width: Math.min(box.width, vw), height: Math.min(box.height, vh) })
    }
  }
  return out
}

export function TextSelectionLayer() {
  const [sel, setSel] = useState<SelState | null>(null)
  const containerRef = useRef<Element | null>(null)
  const dragRef = useRef<'start' | 'end' | null>(null)
  const pressTimer = useRef<number | undefined>(undefined)
  const pressStart = useRef<{ x: number; y: number } | null>(null)
  const activeRef = useRef(false)
  const screen = useAppStore((state) => state.screen)

  useEffect(() => {
    if (!isAndroid) return
    document.body.classList.add('ds-custom-select')
    return () => document.body.classList.remove('ds-custom-select')
  }, [])

  const clear = (): void => {
    activeRef.current = false
    dragRef.current = null
    containerRef.current = null
    setSel(null)
  }

  const updateFromPoints = (start: DomPoint, end: DomPoint): void => {
    const range = buildRange(start, end)
    if (range === null) return
    const rects = rectsOf(range)
    if (rects.length === 0) return
    const first = rects[0]
    const toolbar = { left: Math.max(8, Math.min(first.left, window.innerWidth - 200)), top: Math.max(8, first.top - 48) }
    setSel({ range, rects, text: range.toString(), toolbar, start, end })
  }

  useEffect(() => {
    if (!isAndroid) return

    const rootsOf = (target: EventTarget | null): Element | null => {
      const el = target instanceof Element ? target : null
      return el === null ? null : el.closest(SELECT_ROOT)
    }

    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        window.clearTimeout(pressTimer.current)
        return
      }
      const target = event.target as Element | null
      // 工具条/手柄上的手势不在这里处理。
      if (target !== null && target.closest('.ds-sel-ui, .selection-copy')) return
      const root = rootsOf(target)
      if (root === null) return
      const touch = event.touches[0]
      if (touch === undefined) return
      pressStart.current = { x: touch.clientX, y: touch.clientY }
      window.clearTimeout(pressTimer.current)
      pressTimer.current = window.setTimeout(() => {
        const start = pressStart.current
        if (start === null) return
        const point = caretPointAt(start.x, start.y)
        if (point === null) return
        containerRef.current = root
        const word = wordAround(point)
        activeRef.current = true
        dragRef.current = 'end'
        updateFromPoints(word.start, word.end)
      }, LONG_PRESS_MS)
    }

    const onTouchMove = (event: TouchEvent): void => {
      const touch = event.touches[0]
      if (touch === undefined) return
      const start = pressStart.current
      if (!activeRef.current) {
        // 还没进入选择：移动超过阈值就当作滚动，取消长按。
        if (start !== null && (Math.abs(touch.clientX - start.x) > MOVE_TOLERANCE || Math.abs(touch.clientY - start.y) > MOVE_TOLERANCE)) {
          window.clearTimeout(pressTimer.current)
        }
        return
      }
      // 已在选择：拖动延长（默认拖末端）。
      if (dragRef.current === null) return
      const point = caretPointAt(touch.clientX, touch.clientY)
      if (point === null) return
      setSel((current) => {
        if (current === null) return current
        const startPt = dragRef.current === 'start' ? point : current.start
        const endPt = dragRef.current === 'end' ? point : current.end
        const range = buildRange(startPt, endPt)
        if (range === null) return current
        const rects = rectsOf(range)
        if (rects.length === 0) return current
        const first = rects[0]
        return {
          range,
          rects,
          text: range.toString(),
          toolbar: { left: Math.max(8, Math.min(first.left, window.innerWidth - 200)), top: Math.max(8, first.top - 48) },
          start: startPt,
          end: endPt,
        }
      })
    }

    const onTouchEnd = (): void => {
      window.clearTimeout(pressTimer.current)
      pressStart.current = null
      dragRef.current = null
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (!activeRef.current) return
      const target = event.target as Element | null
      if (target !== null && target.closest('.ds-sel-ui, .selection-copy')) return
      clear()
    }

    const onScroll = (): void => {
      if (!activeRef.current) return
      setSel((current) => {
        if (current === null) return current
        const rects = rectsOf(current.range)
        if (rects.length === 0) return null
        const first = rects[0]
        return { ...current, rects, toolbar: { left: Math.max(8, Math.min(first.left, window.innerWidth - 200)), top: Math.max(8, first.top - 48) } }
      })
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('touchend', onTouchEnd)
    document.addEventListener('touchcancel', onTouchEnd)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.clearTimeout(pressTimer.current)
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('touchcancel', onTouchEnd)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [])

  useEffect(() => {
    clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen])

  useEffect(() => {
    if (!isAndroid) return
    if (sel === null) {
      document.body.classList.remove('ds-custom-selecting')
      return
    }
    document.body.classList.add('ds-custom-selecting')
  }, [sel])

  if (!isAndroid || sel === null) return null

  const toast = (message: string): void => {
    useAppStore.getState().actions.showToast(message)
  }

  const doCopy = async (): Promise<void> => {
    const text = sel.text
    if (text === '') return
    const ok = await writeClipboardText(text)
    toast(ok ? '已复制' : '复制失败')
  }

  const doSelectAll = (): void => {
    const root = containerRef.current
    if (root === null) return
    const range = document.createRange()
    range.selectNodeContents(root)
    const rects = rectsOf(range)
    if (rects.length === 0) return
    const first = rects[0]
    setSel({
      range,
      rects,
      text: range.toString(),
      toolbar: { left: Math.max(8, Math.min(first.left, window.innerWidth - 200)), top: Math.max(8, first.top - 48) },
      start: { node: root, offset: 0 },
      end: { node: root, offset: root.childNodes.length },
    })
  }

  const startHandle = (which: 'start' | 'end') => (event: ReactTouchEvent): void => {
    event.stopPropagation()
    dragRef.current = which
  }

  const moveHandle = (which: 'start' | 'end') => (event: ReactTouchEvent): void => {
    if (dragRef.current !== which) return
    event.stopPropagation()
    const touch = event.touches[0]
    if (touch === undefined) return
    const point = caretPointAt(touch.clientX, touch.clientY)
    if (point === null) return
    setSel((current) => {
      if (current === null) return current
      const startPt = which === 'start' ? point : current.start
      const endPt = which === 'end' ? point : current.end
      const range = buildRange(startPt, endPt)
      if (range === null) return current
      const rects = rectsOf(range)
      if (rects.length === 0) return current
      const first = rects[0]
      return {
        range,
        rects,
        text: range.toString(),
        toolbar: { left: Math.max(8, Math.min(first.left, window.innerWidth - 200)), top: Math.max(8, first.top - 48) },
        start: startPt,
        end: endPt,
      }
    })
  }

  const endHandle = (): void => {
    dragRef.current = null
  }

  const firstRect = sel.rects[0]
  const lastRect = sel.rects[sel.rects.length - 1] ?? firstRect

  return (
    <>
      <div className="ds-sel-layer" aria-hidden="true">
        {sel.rects.map((rect, index) => (
          <div
            key={`${index}-${rect.left}-${rect.top}`}
            className="ds-sel-hi"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          />
        ))}
      </div>
      <div
        className="ds-sel-handle ds-sel-ui"
        style={{ left: firstRect.left, top: firstRect.top - 3 }}
        onTouchStart={startHandle('start')}
        onTouchMove={moveHandle('start')}
        onTouchEnd={endHandle}
        onTouchCancel={endHandle}
      />
      <div
        className="ds-sel-handle ds-sel-ui"
        style={{ left: lastRect.left + lastRect.width, top: lastRect.top + lastRect.height - 21 }}
        onTouchStart={startHandle('end')}
        onTouchMove={moveHandle('end')}
        onTouchEnd={endHandle}
        onTouchCancel={endHandle}
      />
      <div className="ds-sel-toolbar ds-sel-ui" style={{ left: sel.toolbar.left, top: sel.toolbar.top }}>
        <button type="button" className="ds-sel-toolbar-item" onMouseDown={(e) => e.preventDefault()} onClick={() => void doCopy()}>
          复制
        </button>
        <button type="button" className="ds-sel-toolbar-item" onMouseDown={(e) => e.preventDefault()} onClick={doSelectAll}>
          全选
        </button>
      </div>
    </>
  )
}
