import { useEffect } from 'react'
import { useAppStore } from '../lib/store'

/**
 * 欣赏模式里唯一还看得见的东西。
 *
 * 为什么是圆点而不是双击 / 长按：这两种手势大部分人根本猜不到，
 * 一旦「隐藏全部菜单」之后找不到回来的路，整个 App 看起来就像卡死了
 * （参考实现在这个问题上踩过两次）。所以留一个一直在角落的小圆点，
 * 平时压到很淡，鼠标移上去才亮起来 —— 不打扰欣赏，但随时点得回去。
 */
export function ZenDot() {
  const zen = useAppStore((state) => state.zen)
  const actions = useAppStore((state) => state.actions)

  useEffect(() => {
    if (!zen) return
    // 桌面端的兜底：Esc 也能出来。
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') actions.setZen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zen, actions])

  if (!zen) return null
  return (
    <button
      type="button"
      className="zen-dot"
      aria-label="退出欣赏模式"
      title="退出欣赏模式"
      onClick={() => actions.setZen(false)}
    />
  )
}
