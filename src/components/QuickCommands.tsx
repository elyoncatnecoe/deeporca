import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Command } from 'lucide-react'
import './quick-commands.css'

/**
 * 快捷指令弹窗（聊天页头部入口）。
 *
 * 为什么要有它：虎鲸的动作指令和几个常用工具指令都是「短句 + 明确动词」，
 * 不该逼用户靠记忆拼句子。面板把能用的句子摊开，点一下替用户把字打进输入框。
 *
 * 铁律：**只填不发**。这里是输入法的延伸，不是发送按钮 —— 用户点完往往还要补一句
 * 「顺便说下今天的事」，自动发出去就把话切断了。
 */

/** 面板宽度：和 .model-popover(272px) 一个量级；手机上由 place() 再夹进屏幕。 */
const PANEL_WIDTH = 300
const MAX_PANEL_HEIGHT = 420
/** 面板与按钮之间、与屏幕边缘之间留的缝。 */
const GAP = 8
const EDGE = 10

/**
 * 虎鲸动作：这些短词由 lib/commands.ts 的 parseCommand 在本地命中，客户端直接驱动
 * 身体并回一句预制台词 —— 不花 token、也不走 API，所以值得单独一组。
 *
 * 这里没有读 ACT_LABELS：那份是「显示名」（spin 显示成「转圈」），而能命中的口语
 * 短语是 SPECS 里的第一个 key（「转个圈」）。面板要展示的是用户待会儿真正说出口的词。
 */
const ACT_COMMANDS = [
  '转个圈',
  '下潜',
  '上浮',
  '蹭蹭',
  '吐泡泡',
  '睡觉',
  '醒来',
  '甩水',
  '凑近',
  '安静',
  '玩耍',
] as const

/**
 * 常用指令：label 给人扫一眼，text 是真正填进输入框的句子（明着写出来，不搞暗箱）。
 *
 * label 里用泛称「助手」而不是某个具体名字：这几条是通用工具指令，换哪个助手都成立，
 * 写死名字反而在换了助手之后读着别扭（也没必要为此做名字判定）。
 * 注意与上面的「虎鲸动作」区分：那一组是**身体动画**，只有虎鲸本体有，所以固定叫虎鲸。
 */
const TOOL_COMMANDS: ReadonlyArray<{ label: string; text: string }> = [
  { label: '让助手写网页', text: '帮我写一个能直接玩的小网页游戏，先问我想玩什么。' },
  { label: '让助手记住当前记忆', text: '记住：' },
  { label: '总结这段对话', text: '把上面这段对话总结成几条要点。' },
  { label: '解释刚才那段代码', text: '解释一下刚才那段代码在做什么。' },
  { label: '拆成待办清单', text: '把这件事拆成可以照着做的待办清单。' },
]

interface PanelBox {
  top: number
  left: number
  width: number
  maxHeight: number
}

export function QuickCommands(props: {
  /** 只负责把文本塞进输入框（写入 + 聚焦由 Chat 统一做），不提供发送能力。 */
  onInsert: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  /** null = 还在量位置的首帧，面板不可见也不可点，免得闪一下错位置。 */
  const [box, setBox] = useState<PanelBox | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()

  /**
   * 算面板位置：贴按钮下方，左右夹在视口内。
   *
   * 面板挂在 body 上（position: fixed），所以位置只能由这里量好写进内联 style ——
   * 和 ui.tsx 的 Select 面板同一套做法；CSS 里只写外观，不写 top/left，避免两处打架。
   */
  const place = useCallback((): void => {
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (trigger === null || panel === null) return
    const rect = trigger.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(PANEL_WIDTH, vw - EDGE * 2)
    // 右对齐按钮再夹回视口：手机上头部按钮贴着右边，按按钮左边缘对齐会冲出屏幕。
    const left = Math.max(EDGE, Math.min(rect.right - width, vw - EDGE - width))
    // 首帧的 offsetHeight 还带着兜底的 maxHeight，判断上下有没有空间够用了。
    const natural = Math.min(panel.offsetHeight > 0 ? panel.offsetHeight : MAX_PANEL_HEIGHT, MAX_PANEL_HEIGHT)
    const below = vh - rect.bottom - GAP - EDGE
    const above = rect.top - GAP - EDGE
    // 头部在页面最上面，正常永远是往下展开；留个翻上去的分支防止以后被挪到别处。
    const dropDown = below >= natural || below >= above
    const maxHeight = Math.min(MAX_PANEL_HEIGHT, Math.max(140, dropDown ? below : above))
    const top = dropDown ? rect.bottom + GAP : Math.max(EDGE, rect.top - GAP - Math.min(natural, maxHeight))
    setBox((prev) => (
      prev !== null && prev.top === top && prev.left === left && prev.width === width && prev.maxHeight === maxHeight
        ? prev
        : { top, left, width, maxHeight }
    ))
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  // 窗口尺寸、软键盘弹出（visualViewport 变化）、内层容器滚动都要重新贴回按钮。
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

  // 点面板和触发器以外的地方关闭。面板是 portal，得单独判断，别只看按钮的祖先链。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) === true) return
      if (panelRef.current?.contains(target) === true) return
      setOpen(false)
      setBox(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // Esc 关闭并把焦点还给按钮。挂在 document 冒泡阶段：document 早于 window 收到事件，
  // stopPropagation 顺手拦住 Chat 里「Esc 退出多选」那条 window 监听，一次 Esc 只关一层。
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      setBox(null)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      setBox(null)
      return
    }
    // 先清位置，等这一帧的 layout effect 量完真实尺寸再显示。
    setBox(null)
    setOpen(true)
  }

  const pick = (text: string): void => {
    props.onInsert(text)
    // 插完就收起：这时输入框已经拿回焦点（Chat 那边负责），面板继续开着既挡视线，
    // 又会让用户下一次点输入框被「点外面关闭」白吃一次点击。
    setOpen(false)
    setBox(null)
  }

  /** 方向键在菜单项之间移动焦点；面板是 role="menu"，键盘用户不该被困在触发按钮上。 */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    if (items.length === 0) return
    const key = event.key
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
    event.preventDefault()
    const current = items.findIndex((item) => item === document.activeElement)
    let next: number
    if (key === 'Home') next = 0
    else if (key === 'End') next = items.length - 1
    else if (key === 'ArrowDown') next = (current + 1) % items.length
    else next = (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <>
      {/*
        这里没用 ui.tsx 的 IconButton：它只收 label/onClick，放不下 aria-expanded 和
        aria-controls，而弹层入口必须让读屏知道「展开/收起」。样式沿用 .icon-button，
        外观和旁边几个头部按钮完全一致。
      */}
      <button
        ref={triggerRef}
        type="button"
        className={`icon-button quick-cmd-trigger${open ? ' is-open' : ''}`}
        aria-label="快捷指令"
        title="快捷指令"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' || open) return
          event.preventDefault()
          setBox(null)
          setOpen(true)
          // 面板这一帧才挂载，等挂上去再把焦点交给第一项。
          requestAnimationFrame(() => {
            panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
          })
        }}
      >
        <Command size={18} />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          className={`quick-cmd-panel${box === null ? ' is-placing' : ''}`}
          style={box === null
            ? { top: 0, left: 0, width: PANEL_WIDTH, maxHeight: MAX_PANEL_HEIGHT }
            : { top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight }}
        >
          <div id={menuId} className="quick-cmd-menu" role="menu" aria-label="快捷指令" onKeyDown={onMenuKeyDown}>
            <div className="quick-cmd-group" role="group" aria-label="虎鲸动作">
              <p className="quick-cmd-group-title">
                {/* 固定叫「虎鲸动作」：这一组是身体动画，只有虎鲸本体有，与当前助手名无关。 */}
                <span>虎鲸动作</span>
                <small>本地执行 · 不花 token</small>
              </p>
              <div className="quick-cmd-chips">
                {ACT_COMMANDS.map((act) => (
                  <button key={act} type="button" role="menuitem" className="quick-cmd-chip" onClick={() => pick(act)}>
                    {act}
                  </button>
                ))}
              </div>
            </div>

            <div className="quick-cmd-group" role="group" aria-label="常用指令">
              <p className="quick-cmd-group-title">
                <span>常用指令</span>
                <small>填进输入框再改</small>
              </p>
              <div className="quick-cmd-list">
                {TOOL_COMMANDS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    className="quick-cmd-item"
                    onClick={() => pick(item.text)}
                  >
                    <strong>{item.label}</strong>
                    <small>{item.text}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="quick-cmd-note">点一条只会填进输入框，发不发送由你决定</p>
        </div>,
        document.body,
      )}
    </>
  )
}