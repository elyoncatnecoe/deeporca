import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Check, ChevronDown, X } from 'lucide-react'

export function IconButton(props: {
  label: string
  onClick?: () => void
  children: ReactNode
  className?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`icon-button ${props.className ?? ''}`}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  )
}

export function ScreenHeader(props: {
  title: string
  subtitle?: string
  onBack: () => void
  actions?: ReactNode
}) {
  return (
    <header className="screen-header">
      <IconButton label="返回" onClick={props.onBack}>
        <ArrowLeft size={19} />
      </IconButton>
      <div className="screen-heading">
        <h1>{props.title}</h1>
        {props.subtitle !== undefined && <p>{props.subtitle}</p>}
      </div>
      <div className="screen-actions">{props.actions}</div>
    </header>
  )
}

/**
 * 「一行一项」的文本域。
 *
 * 别再用 `value={items.join('\n')}` + 每次按键 split/filter 的写法：
 * 行尾那个回车会立刻被 filter 掉，于是**永远加不出第二行**；
 * 需要冒号的请求头更严重 —— 第一个字符还没打完冒号，整行就被丢掉，
 * 看起来就是「敲一下就没了」（BUG-REVIEW P1-15）。
 *
 * 所以这里自己存一份草稿：显示给用户的是他敲的原文，交给上层的是解析后的值。
 * resetKey 变了（比如切到另一个供应商/服务器）才用外部值重置草稿。
 */
export function ListTextarea(props: {
  rows: number
  /** 外部值：只在 resetKey 变化时用来重置草稿。 */
  value: string
  /** 切换编辑对象时用来重置草稿的标识。 */
  resetKey: string
  placeholder?: string
  onText: (text: string) => void
}) {
  const [text, setText] = useState(props.value)
  const lastKey = useRef(props.resetKey)
  useEffect(() => {
    if (lastKey.current === props.resetKey) return
    lastKey.current = props.resetKey
    setText(props.value)
  }, [props.resetKey, props.value])
  return (
    <textarea
      rows={props.rows}
      placeholder={props.placeholder}
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        props.onText(event.target.value)
      }}
    />
  )
}

/** 把「Key: Value」逐行解析成请求头；冒号没打完的行先不生效，但不会被吞掉。 */
export { parseHeaderLines, headerLines } from '../lib/headers'

export function Modal(props: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!props.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open, props.onClose])

  if (!props.open) return null
  /*
   * 弹层挂到 .app 上，而不是留在调用处的 DOM 里。
   *
   * 为什么必须这样：聊天页的 .chat-sheet 带 backdrop-filter，它会把 fixed 后代的
   * 包含块换成自己，再加上 overflow:hidden —— 于是「渲染在气泡里的 Modal」会被裁在
   * 对话面板内，还会被后面的气泡、轮次导航盖住（真机截图里「⋯」菜单后面透出对话内容）。
   * 挂到 .app 而不是 body：主题变量（data-theme）定义在 .app 上，弹层要跟着换色。
   */
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <div className={`modal-card ${props.wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <header className="modal-head">
          <h2>{props.title}</h2>
          <IconButton label="关闭" onClick={props.onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer !== undefined && <footer className="modal-foot">{props.footer}</footer>}
      </div>
    </div>,
    document.querySelector('.app') ?? document.body,
  )
}

export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className={`switch ${props.checked ? 'is-on' : ''}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span />
    </button>
  )
}

export function Chip(props: { active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`chip ${props.active ? 'is-active' : ''}`} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

export function Spinner(props: { small?: boolean }) {
  return <span className={`spinner ${props.small ? 'spinner-small' : ''}`} aria-label="加载中" />
}

export function EmptyState(props: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{props.icon}</div>
      <strong>{props.title}</strong>
      {props.body !== undefined && <p>{props.body}</p>}
      {props.action}
    </div>
  )
}

/* -------------------------------------------------------------- 下拉选择器 */

export type SelectOption = {
  value: string
  /** 主文案，也就是下拉里那一行的标题。 */
  label: string
  /** 第二行小字；原来 option 里「名字 · 说明」的说明部分放这儿。 */
  hint?: string
  /** 能力徽章，例如「看图」「推理」「网页」。 */
  tags?: string[]
  disabled?: boolean
}

type SelectBox = {
  top: number
  left: number
  width: number
  /** 面板自身的最大高度（CSS 上限 320px，贴着视口边缘时会更小）。 */
  maxHeight: number
}

/**
 * App 内自绘的深色下拉，用来替换原生下拉元素。
 *
 * 为什么不用原生 select：Android WebView 里 select 打开的是**系统弹窗**，配色跟
 * Activity/ActionBar 主题（android/app/src/main/res/values/styles.xml 的
 * Theme.AppCompat.DayNight.NoActionBar）走。用户手机是浅色或自动主题时，弹出来
 * 就是一块刺眼的白底，跟我们固定的深海深色界面完全不搭 —— 而且这个颜色我们改
 * 不了。改成 App 内 DOM 绘制后，颜色只由 styles.css 决定，彻底摆脱系统主题。
 *
 * 面板为什么挂到 body（createPortal）而不是原地 absolute：
 *   `.screen-body` 是 `overflow-y: auto` 的滚动容器（styles.css:2302），页内
 *   absolute 面板向下展开会被它裁掉，滚动时也不会跟着走。所以面板用 position:
 *   fixed 挂到 body，位置由触发按钮的 getBoundingClientRect() 算，并监听
 *   resize/scroll（capture，因为滚动发生在 .screen-body 这种内层容器上）重算。
 *
 * 层级：面板 z-index 取 60（styles.css 的 .select-panel）。它挂在 body 下、是
 * .app（position:fixed → 自成层叠上下文）的兄弟节点，所以实际上盖得住 .app 内
 * 所有内容；60 这个值刻意留在 toast(200) 之下，理由见那条 CSS 注释。
 */
export function Select(props: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  className?: string
  footer?: ReactNode
}) {
  const { value, options, onChange } = props
  const disabled = props.disabled === true
  const listId = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [box, setBox] = useState<SelectBox | null>(null)

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined
  const placeholderText = props.placeholder ?? '请选择'

  const firstEnabled = (): number => options.findIndex((option) => option.disabled !== true)

  /** 算面板位置：默认贴触发器下方，下面放不下就翻到上方，左右夹在视口内。 */
  const place = useCallback((): void => {
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (trigger === null || panel === null) return
    const rect = trigger.getBoundingClientRect()
    const gap = 6
    const edge = 10
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 宽度跟随触发器，但别窄到放不下「文案 + 徽章」，也别冲出屏幕。
    const width = Math.min(Math.max(rect.width, 200), vw - edge * 2)
    const left = Math.max(edge, Math.min(rect.left, vw - edge - width))
    // 量「内容想要的高度」：面板 overflow:hidden、列表 overflow-y:auto，
    // 只能用列表的 scrollHeight（不受裁剪），再补上 footer 与边框。
    // 注意这里不直接改 DOM 的 style.width —— React 会在下次渲染时把 style prop
    // 覆盖回去，两者打架。宽度只走 state，经由内联 style 生效。
    const listNode = listRef.current
    const listHeight = listNode !== null ? listNode.scrollHeight : 0
    const footHeight = footRef.current !== null ? footRef.current.offsetHeight : 0
    const contentHeight = listHeight > 0 ? listHeight + footHeight + 2 : 320
    const natural = Math.min(contentHeight, 320)
    const below = vh - rect.bottom - gap - edge
    const above = rect.top - gap - edge
    const dropDown = below >= natural || below >= above
    // 至少留 120px，宁可压住触发器一点，也别只剩一条缝。
    const maxHeight = Math.min(320, Math.max(120, dropDown ? below : above))
    const height = Math.min(natural, maxHeight)
    const top = dropDown ? rect.bottom + gap : Math.max(edge, rect.top - gap - height)
    setBox((prev) => (
      prev !== null && prev.top === top && prev.left === left && prev.width === width && prev.maxHeight === maxHeight
        ? prev
        : { top, left, width, maxHeight }
    ))
  }, [])

  const openAt = (prefer: 'selected' | 'first' | 'last'): void => {
    if (options.length === 0) {
      setActiveIndex(-1)
    } else if (prefer === 'selected') {
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabled())
    } else if (prefer === 'last') {
      setActiveIndex(options.length - 1)
    } else {
      setActiveIndex(firstEnabled())
    }
    // 先置空，等这一帧的 layout effect 量完真实高度再显示，避免闪一下错位置。
    setBox(null)
    setOpen(true)
  }

  const close = (): void => {
    setOpen(false)
    setBox(null)
    triggerRef.current?.focus()
  }

  const commit = (index: number): void => {
    const option = options[index]
    if (option === undefined || option.disabled === true) return
    if (option.value !== value) onChange(option.value)
    setOpen(false)
    setBox(null)
    triggerRef.current?.focus()
  }

  /** 上下移动高亮，跳过 disabled 项。 */
  const move = (step: 1 | -1): void => {
    if (options.length === 0) return
    let next = activeIndex < 0 ? (step === 1 ? -1 : options.length) : activeIndex
    for (let i = 0; i < options.length; i += 1) {
      next = (next + step + options.length) % options.length
      if (options[next]?.disabled !== true) break
    }
    setActiveIndex(next)
  }

  const moveEdge = (edge: 'start' | 'end'): void => {
    if (options.length === 0) return
    if (edge === 'start') {
      const index = firstEnabled()
      if (index >= 0) setActiveIndex(index)
      return
    }
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (options[index]?.disabled !== true) {
        setActiveIndex(index)
        return
      }
    }
  }

  // 打开后量一次位置；选中项变了要重量（触发按钮上的文案宽度会变）。
  // 依赖里不用 options 本身：父组件每次渲染都会新建数组，会让这个 effect 白跑。
  useLayoutEffect(() => {
    if (open) place()
  }, [open, place, value, options.length])

  // 窗口尺寸变化、以及 .screen-body 这类内层容器的滚动，都要重新贴到触发按钮上。
  useEffect(() => {
    if (!open) return
    const onReposition = (): void => place()
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, { capture: true, passive: true })
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', onReposition)
    viewport?.addEventListener('scroll', onReposition)
    return () => {
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
      viewport?.removeEventListener('resize', onReposition)
      viewport?.removeEventListener('scroll', onReposition)
    }
  }, [open, place])

  // 点面板和触发器以外的地方关闭。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (wrapRef.current?.contains(target) === true) return
      if (panelRef.current?.contains(target) === true) return
      setOpen(false)
      setBox(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // 键盘：Esc 关闭、↑↓ 换高亮、Home/End 到首尾、Enter 选中、Tab 让焦点走掉。
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      // 这个监听挂在 document（冒泡阶段），而 Modal 的 Esc 监听挂在 window。
      // document 在 window 之前收到事件，所以这里 stopPropagation 就能让
      // 「下拉开着时按 Esc」只关下拉、不顺手把外层弹窗（Memory 的编辑框）也关掉。
      const swallow = (): void => {
        event.preventDefault()
        event.stopPropagation()
      }
      switch (event.key) {
        case 'Escape':
          swallow()
          close()
          break
        case 'ArrowDown':
          swallow()
          move(1)
          break
        case 'ArrowUp':
          swallow()
          move(-1)
          break
        case 'Home':
          swallow()
          moveEdge('start')
          break
        case 'End':
          swallow()
          moveEdge('end')
          break
        case 'Enter':
        case ' ':
          // 阻止触发按钮把 Enter/Space 当成「再点一次」而把面板关掉。
          swallow()
          commit(activeIndex)
          break
        case 'Tab':
          setOpen(false)
          setBox(null)
          break
        default:
          break
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, activeIndex, options, value])

  // 高亮项滚进可视区。不用 scrollIntoView：面板挂在 body 上，scrollIntoView
  // 会连带把 .screen-body 也滚一下（键盘上下键时整页跟着跳），这里只动列表自己的
  // scrollTop，保证只滚面板内部。
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    const node = optionRefs.current[activeIndex]
    if (list === null || node === null || node === undefined) return
    const listRect = list.getBoundingClientRect()
    const nodeRect = node.getBoundingClientRect()
    if (nodeRect.top < listRect.top) {
      list.scrollTop -= listRect.top - nodeRect.top
    } else if (nodeRect.bottom > listRect.bottom) {
      list.scrollTop += nodeRect.bottom - listRect.bottom
    }
  }, [open, activeIndex])

  return (
    <span ref={wrapRef} className={`select-wrap ${props.className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger ${open ? 'is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-label={props.ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false)
            setBox(null)
            return
          }
          openAt('selected')
        }}
        onKeyDown={(event) => {
          // 面板打开时按键交给 document 上的监听统一处理。
          if (open || disabled) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openAt(event.key === 'ArrowUp' ? 'last' : 'selected')
          }
        }}
      >
        <span className="select-value">
          {selected === undefined ? (
            <span className="select-placeholder">{placeholderText}</span>
          ) : (
            <>
              <span className="select-value-label">{selected.label}</span>
              {selected.hint !== undefined && <span className="select-trigger-hint">· {selected.hint}</span>}
            </>
          )}
        </span>
        <ChevronDown size={15} className="select-chevron" />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          // is-placing：还在量位置的首帧，不可见也不可点，避免闪一下错位置。
          className={`select-panel ${box === null ? 'is-placing' : ''}`}
          style={box === null
            ? { top: 0, left: 0, width: 240, maxHeight: 320 }
            : { top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight }}
        >
          <div ref={listRef} className="select-list" role="listbox" id={listId} aria-label={props.ariaLabel ?? '选项列表'}>
            {options.length === 0 && <div className="select-empty">没有可选项</div>}
            {options.map((option, index) => (
              <button
                // 用「值 + 序号」做 key：供应商自填的模型列表可能有重复 id，
                // 单用 value 会撞 key 警告。
                key={`${option.value}-${index}`}
                ref={(node) => { optionRefs.current[index] = node }}
                type="button"
                role="option"
                id={`${listId}-${index}`}
                aria-selected={option.value === value}
                disabled={option.disabled === true}
                className={`select-option ${index === activeIndex ? 'is-active' : ''} ${option.value === value ? 'is-selected' : ''}`}
                onClick={() => commit(index)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="select-option-main">
                  <span className="select-option-label">{option.label}</span>
                  {option.hint !== undefined && <span className="select-option-hint">{option.hint}</span>}
                </span>
                {option.tags !== undefined && option.tags.length > 0 && (
                  <span className="select-tags">
                    {option.tags.map((tag) => <span key={tag} className="select-tag">{tag}</span>)}
                  </span>
                )}
                {option.value === value && <Check size={14} className="select-check" />}
              </button>
            ))}
          </div>
          {props.footer !== undefined && <div ref={footRef} className="select-foot">{props.footer}</div>}
        </div>,
        document.body,
      )}
    </span>
  )
}
