import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * UI 第 4 轮的回归锁（2026-11-04）。
 *
 * 三条都是「真机上才看得出来」的问题，所以用源码文本断言 + 关键数值断言锁住：
 *   1. peek 档右侧四键压在输入框上沿 —— compact 导航必须锚在 84/120 那条消息带里；
 *   2. 布置栏图标空白 —— 标签不能再依赖 emoji 字形（🪙/🪸 老 WebView 没有）；
 *   3. 点海豹台词跑到虎鲸头上 —— showThought 必须按实测宽度居中，不能夹死 w-240。
 */

const CSS = readFileSync('src/styles.css', 'utf8')
const APP = readFileSync('src/orca/app.ts', 'utf8')
const ROOM = readFileSync('src/components/room/RoomScreen.tsx', 'utf8')
const PANELS = readFileSync('src/components/room/panels.tsx', 'utf8')

/** 去掉注释，避免注释里提到旧值把断言骗过去。 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

/** 取出 CSS 里某个选择器的第一条规则体。 */
function cssRule(css: string, selector: string): string {
  const start = css.indexOf(selector)
  if (start === -1) return ''
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return open === -1 || close === -1 ? '' : css.slice(open + 1, close)
}

test('peek 档轮次导航锚在消息带里（top:84 / bottom:120 + 带内居中）', () => {
  const rule = codeOnly(cssRule(CSS, '.turn-nav-compact {'))
  assert.ok(rule.includes('top: 84px'), 'compact 导航没有用 top:84px 对齐消息带')
  assert.ok(rule.includes('bottom: 120px'), 'compact 导航没有用 bottom:120px 避开输入框')
  assert.ok(rule.includes('justify-content: center'), '四键没有在带内垂直居中')
  assert.ok(!rule.includes('translateY(-50%)'), '还在用相对整块面板的 translateY 居中（会压输入框）')
  assert.ok(!rule.includes('top: 50%'), '还在相对整块面板居中')
})

test('触屏/窄屏下四键堆不超过 peek 档可用高度（4×34+3×6=154）', () => {
  const narrow = CSS.slice(CSS.indexOf('@media (max-width: 600px)'))
  assert.ok(narrow.includes('.turn-nav-compact .turn-nav-key { width: 34px; height: 34px; }'), '窄屏没有收紧键尺寸')
  assert.ok(narrow.includes('.turn-nav-compact { gap: 6px; }'), '窄屏没有收紧间距')
  assert.ok(4 * 34 + 3 * 6 <= 160, '四键堆必须 ≤ peek 档消息带（约 160px）')
})

test('布置栏标签用 lucide 图标，不再依赖 emoji 字形', () => {
  const code = codeOnly(ROOM)
  assert.ok(code.includes('Coins'), '投喂标签没有换图标')
  assert.ok(code.includes('Shapes'), '布置标签没有换图标')
  assert.ok(code.includes('Camera'), '拍照标签没有换图标')
  assert.ok(code.includes('Users'), '伙伴标签没有换图标')
  assert.ok(code.includes('Palette'), '外观标签没有换图标')
  assert.ok(!/emoji: '🪙'/.test(code), 'TABS 里还留着老 WebView 画不出的 emoji')
  assert.ok(!/emoji: '🪸'/.test(code), 'TABS 里还留着老 WebView 画不出的 emoji')
  assert.ok(code.includes('<item.Icon'), '标签没有把图标组件渲染出来')

  const css = codeOnly(cssRule(CSS, '.room-tab svg {'))
  assert.ok(css.includes('18px'), '.room-tab svg 没有给尺寸（SVG 不自带大小）')

  // 面板里的 CTA / 伙伴名同样不能依赖 emoji
  const panels = codeOnly(PANELS)
  assert.ok(panels.includes('<Coins size={20}'), '投喂 CTA 还是 emoji')
  assert.ok(panels.includes('<Shapes size={20}'), '布置 CTA 还是 emoji')
  assert.ok(panels.includes('<Camera size={20}'), '拍照 CTA 还是 emoji')
  assert.ok(!panels.includes('🪙'), 'panels 里还留着 🪙')
  assert.ok(!panels.includes('🪸'), 'panels 里还留着 🪸')
})

test('showThought 按实测宽度居中，不再把 left 夹死到 w-240', () => {
  const code = codeOnly(APP)
  const start = code.indexOf('private showThought(')
  assert.ok(start > 0, '找不到 showThought')
  const body = code.slice(start, start + 1200)
  assert.ok(body.includes('offsetWidth'), '没有先量 pill 的真实宽度')
  assert.ok(body.includes('sx - pillW / 2'), '没有以 anchor 投影点为中心摆位')
  assert.ok(body.includes('--thought-tail-x'), '没有把尾巴位置算出来')
  assert.ok(!body.includes('Math.min(w - 240, sx)'), '还在用写死的 240 夹 left（点海豹会跑到虎鲸头上）')
})

test('尾巴位置由 CSS 变量控制（app.ts 算，样式表跟随）', () => {
  const tail = codeOnly(cssRule(CSS, '.stage .orca-thought::after {'))
  assert.ok(tail.includes('var(--thought-tail-x'), '尾巴还钉在固定 left:22px')
})

test('点偏一点也算摸到伙伴，不会落到虎鲸身上', () => {
  const code = codeOnly(APP)
  assert.ok(code.includes('pointerNear('), '没有屏幕空间容差')
  const seal = code.slice(code.indexOf('private petSeal('), code.indexOf('private petSeal(') + 700)
  assert.ok(seal.includes('pointerNear(this.seal.group'), '海豹没有用容差判定')
  const clawd = code.slice(code.indexOf('private petCompanion('), code.indexOf('private petCompanion(') + 700)
  assert.ok(clawd.includes('pointerNear(this.clawd.group'), 'Clawd 没有用容差判定')
})