import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp } from 'lucide-react'
import type { Turn } from '../lib/turns'

/**
 * 轮次导航（Turn navigation）。
 * 两个成熟实现各取所长：
 * - DeepSeek Harness 的 TurnNavigator：等距横杠 + 悬停预览，适合宽屏精确点到某一轮；
 * - RikkaHub 的 MessageJumper：四个拇指大小的按钮（置顶/上一轮/下一轮/置底），
 *   适合小屏 —— 它干脆放弃了「每轮一根」，因为手指点不准 10px 的横杠。
 * 我们按**实测可用高度**自动切换：装得下就上横杠，装不下就退化成四键。
 *
 * 高度一律「实测可用高度 + 内容需求」两边夹，不写死上限：
 * 对话面板有 peek(46%) / half(72%) / full 三档，手机上 peek 档 `.turn-nav`
 * 只剩 180px 出头，任何写死的上限（以前是 420）都会让导轨比容器还高，
 * flex 居中后上下同时溢出，被面板的 overflow:hidden 裁掉，再被导轨的
 * mask 渐变吃掉首尾横杠 —— 看起来就是「缩到最小高度时上下错位」。
 */

/** 相邻横杠的固定间距（与 Harness 的 TURN_SPACING_PX 一致）。 */
const TURN_SPACING_PX = 10
/** 导轨上下留白。 */
const RAIL_INSET_PX = 6
/** 少于这么多轮就不显示导航，避免两根杠闪来闪去。 */
const MIN_TURNS = 3
/** 每根横杠至少要占这么高才值得用横杠形态（太少会挤成一坨）。 */
const MIN_MARK_PITCH_PX = 7

/**
 * 导轨的**视觉**上限：横杠铺满整屏反而不好瞄，Harness 也是这个量级。
 * 注意它只是上限之一，最终高度还要和实测可用高度取 min（见 railHeight），
 * 所以它永远不会把导轨撑出面板。
 */
const RAIL_MAX_PX = 420

/**
 * `.turn-nav-rail` 的 mask-image 渐变带宽度。styles.css 里是
 * `linear-gradient(#0000 0, #000 18px, #000 calc(100% - 18px), #0000 100%)`，
 * 即上下各 18px 由全透明过渡到不透明；横杠落在这一段里会被渐变「吃掉」，
 * 这就是「边缘那根横杠看着没对齐 / 点不到」的直接原因。
 * 所以导轨高度要在横杠区之外**再加**这两条带，让首尾横杠都落在不透明区里。
 *
 * 为什么用常量而不是量出来：这个值写在 styles.css（本任务禁止改动）里，
 * 而且没有可靠的运行时读法 —— getComputedStyle().maskImage 返回的是渐变字符串，
 * 解析它比一个带注释的常量更脆。它是设计定值，不是算出来的尺寸。
 */
const RAIL_FADE_PX = 18

/**
 * `.turn-nav` 的上下定位量，对应 styles.css 的 `top: 84px / bottom: 120px`。
 * 只在量不到 `.turn-nav` 自身盒高时兜底用（compact 形态没有这个盒子）。
 */
const NAV_TOP_PX = 84
const NAV_BOTTOM_PX = 120

interface Props {
  turns: Turn[]
  /** 当前视野顶部的锚点消息 id，变化时高亮对应横杠。 */
  activeAnchorId: string | null
  onLeft: boolean
  onJump: (anchorId: string) => void
  /** 跳到最顶/最底（四键形态用）。 */
  onJumpEdge?: (edge: 'top' | 'bottom') => void
}

export function TurnNavigator(props: Props) {
  const { turns, activeAnchorId, onLeft, onJump, onJumpEdge } = props
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [compact, setCompact] = useState(false)
  /** 面板留给导轨的实际可用高度（`.turn-nav` 的盒高）；0 表示还没量到。 */
  const [availableHeight, setAvailableHeight] = useState(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const activeIndex = useMemo(() => {
    const index = turns.findIndex((turn) => turn.anchorId === activeAnchorId)
    return index === -1 ? null : index
  }, [turns, activeAnchorId])

  const count = turns.length
  const show = count >= MIN_TURNS

  // ---------------------------------------------------------------- 导轨几何
  // 全部从两个量夹出来：「横杠需要多少」和「面板给得出多少」。
  // 横杠区本身的高度（含上下留白）。
  const marksHeight = count * TURN_SPACING_PX + RAIL_INSET_PX * 2
  // 导轨理想高度 = 横杠区 + 上下两条渐变带（否则首尾横杠永远半透明）。
  const wantedRailHeight = marksHeight + RAIL_FADE_PX * 2
  // 三重夹紧：设计上限 420 / 实测可用高度 / 还没量到时先按上限渲染一帧
  // （下面的 useLayoutEffect 会在 paint 之前用真实值纠正，用户看不到这一帧）。
  //
  // 为什么必须夹 availableHeight，而不是继续只用 420：
  //   peek 档可用高度 ≈ 面板高(388) - 84 - 120 ≈ 184px，420 这个上限形同虚设，
  //   导轨高度只由「轮数」决定，和面板还剩多少空间无关。于是：
  //   1) 面板 220ms 高度过渡期间（peek↔half↔full），导轨按旧高度渲染，
  //      比正在变矮的容器高，`.turn-nav` 是 flex + align-items:center，
  //      超出的部分上下对称溢出，被 `.chat-sheet` 的 overflow:hidden 裁掉；
  //   2) 就算没溢出，导轨也总是紧贴可用高度（17 轮：10×17+12 = 182 撑满 182），
  //      一点余量都不剩，再叠上 mask 吃掉首尾各 18px，两端横杠必然发虚错位。
  //   量着面板算，三档之间切换就自动跟着变，也不需要为每个档位写魔数。
  const railHeight =
    availableHeight > 0
      ? Math.min(wantedRailHeight, RAIL_MAX_PX, availableHeight)
      : Math.min(wantedRailHeight, RAIL_MAX_PX)
  // 横杠容器的盒子高度：内容比导轨矮就撑满导轨（好让横杠整体垂直居中），
  // 比导轨高就按内容撑开 —— `.turn-nav-rail` 是 overflow-y:auto，多的部分自己滚，
  // 这是「极小空间下宁可少显示几根」的降级路径。
  const marksBoxHeight = Math.max(wantedRailHeight, railHeight)
  // 横杠起始偏移 = 居中留白 + 顶部渐变带（保证第一根落在不透明区里）。
  const marksTop = (marksBoxHeight - wantedRailHeight) / 2 + RAIL_FADE_PX

  // 太小就退化成四键（RikkaHub 那套）。
  // 判据只用两个**实测尺寸**，不依赖 media query：
  // 容器太窄（面板本身就窄 = 手机/窄屏），或者可用高度装不下所有横杠。
  // 之前用 matchMedia 判断，在 CDP 视口模拟下 change 事件不可靠、状态会错位，
  // 换成 ResizeObserver 观察到的真实宽高最稳。
  useLayoutEffect(() => {
    if (!show) return
    const node = rootRef.current
    if (node === null) return
    const measure = (): void => {
      const sheet = node.closest('.chat-sheet') ?? node.parentElement
      const sheetHeight = sheet?.clientHeight ?? 0
      // 可用高度：优先量 `.turn-nav` 自己的盒高 —— 它就是 top:84 / bottom:120
      // 夹出来的那块空间，CSS 以后改了上下定位量也能自动跟上，不用同步常量。
      // compact 形态的 root 是 `.turn-nav-compact`（top:50% + translateY，
      // 没有 bottom，盒高等于四个键叠起来），量它没有意义，
      // 所以退回「面板高度 - 上下定位量」。
      const isCompactRoot = node.classList.contains('turn-nav-compact')
      const navHeight = isCompactRoot ? 0 : node.clientHeight
      // 兜底：面板高度 - 上下定位量。
      const sheetAvailable = sheetHeight > 0 ? sheetHeight - NAV_TOP_PX - NAV_BOTTOM_PX : 0
      const available = navHeight > 0 ? navHeight : sheetAvailable
      if (available <= 0) return
      setAvailableHeight(available)

      // 注意要量**对话面板**的宽度，不是这个 22px 宽的导轨自己。
      const width = sheet?.clientWidth ?? 0
      // 面板宽度 < 420 基本就是手机竖屏：手指点不中 10px 的横杠，直接上四键。
      if (width > 0 && width < 420) {
        setCompact(true)
        return
      }
      // 横杠装不下，或每根分不到 7px（挤成一坨、点不准）时也退化。
      // 这里用 available（面板给得出的高度）而不是 node.clientHeight：
      // compact 形态下 node 是四键堆，拿它判断会来回抖。
      setCompact(marksHeight > available || available / count < MIN_MARK_PITCH_PX)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    const sheet = node.closest('.chat-sheet')
    if (sheet !== null) observer.observe(sheet)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
    // compact 也要进依赖：形态切换后 root 换了元素，观察目标得跟着换，
    // 否则 ResizeObserver 还盯着已经卸载的旧节点。
    // peek → half → full 由 observer 观察 `.chat-sheet` 触发重算。
  }, [show, count, compact, marksHeight])

  // 当前横杠滚出可视区时，把导轨自己滚过去（Harness 也是这么做的）。
  useEffect(() => {
    if (compact || activeIndex === null || scrollerRef.current === null) return
    const scroller = scrollerRef.current
    // 横杠整体下移了 marksTop（顶部渐变带 + 居中留白），目标位置要算进去。
    const target = marksTop + activeIndex * TURN_SPACING_PX
    const mid = scroller.scrollTop + scroller.clientHeight / 2
    if (Math.abs(target - mid) > scroller.clientHeight / 2 - TURN_SPACING_PX) {
      scroller.scrollTo({ top: target - scroller.clientHeight / 2, behavior: 'smooth' })
    }
  }, [activeIndex, compact, marksTop])

  const jump = useCallback((turn: Turn) => { onJump(turn.anchorId) }, [onJump])

  const step = useCallback((delta: number) => {
    const from = activeIndex ?? 0
    const next = Math.min(turns.length - 1, Math.max(0, from + delta))
    const turn = turns[next]
    if (turn !== undefined) onJump(turn.anchorId)
  }, [activeIndex, turns, onJump])

  if (!show) return null

  const previewTurn = previewIndex === null ? null : turns[previewIndex]

  if (compact) {
    return (
      <div className="turn-nav turn-nav-compact" data-side={onLeft ? 'left' : 'right'} ref={rootRef}>
        <button
          type="button"
          className="turn-nav-key"
          aria-label="回到最开始"
          disabled={activeIndex === 0}
          onClick={() => onJumpEdge?.('top')}
        >
          <ChevronsUp size={16} />
        </button>
        <button
          type="button"
          className="turn-nav-key"
          aria-label="上一轮"
          disabled={activeIndex === 0}
          onClick={() => step(-1)}
        >
          <ArrowUp size={16} />
        </button>
        <button
          type="button"
          className="turn-nav-key"
          aria-label="下一轮"
          disabled={activeIndex !== null && activeIndex >= turns.length - 1}
          onClick={() => step(1)}
        >
          <ArrowDown size={16} />
        </button>
        <button
          type="button"
          className="turn-nav-key"
          aria-label="跳到最后"
          onClick={() => onJumpEdge?.('bottom')}
        >
          <ChevronsDown size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className="turn-nav" data-side={onLeft ? 'left' : 'right'} ref={rootRef}>
      {previewTurn !== null && (
        <div className="turn-nav-preview" role="status">
          <strong>{previewTurn.prompt === '' ? `第 ${previewTurn.index} 轮` : previewTurn.prompt}</strong>
          {previewTurn.reply !== '' && <span>{previewTurn.reply}</span>}
        </div>
      )}
      <div
        className="turn-nav-rail"
        ref={scrollerRef}
        style={{ height: `${railHeight}px` }}
        role="navigation"
        aria-label="轮次导航"
      >
        <div className="turn-nav-marks" style={{ height: `${marksBoxHeight}px` }}>
          {turns.map((turn, index) => (
            <button
              key={turn.anchorId}
              type="button"
              className="turn-nav-mark"
              data-active={activeIndex === index ? 'true' : undefined}
              data-preview={previewIndex === index && activeIndex !== index ? 'true' : undefined}
              style={{ top: `${marksTop + RAIL_INSET_PX + index * TURN_SPACING_PX}px` }}
              aria-label={`跳转到第 ${turn.index} 轮`}
              aria-current={activeIndex === index ? 'true' : undefined}
              onMouseEnter={() => setPreviewIndex(index)}
              onMouseLeave={() => setPreviewIndex(null)}
              onFocus={() => setPreviewIndex(index)}
              onBlur={() => setPreviewIndex(null)}
              onClick={() => jump(turn)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
