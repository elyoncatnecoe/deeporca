import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Android 软键盘：输入框一聚焦整页「弹到顶部」、拖回来光标和画面错位。
 *
 * 根因（targetSdk 35 强制 edge-to-edge 之后才出现）：
 * 窗口不再因键盘变矮，WebView 默认按 `interactive-widget=resizes-visual` 处理 ——
 * 只缩小「视觉视口」并把它整体上移。而 `.screen` 是 `position: fixed`，
 * 固定定位元素不跟着视觉视口平移，于是：
 *   · 点进输入框，页面看起来跳到顶部；
 *   · 拖回去之后，光标和画面永久错位（视觉视口还停在偏移状态）。
 *
 * 修法是让布局视口本身缩小（`resizes-content`），固定容器跟着缩，浏览器在缩小的
 * 视口里把输入框滚到键盘上方 —— 这时光标与画面天然对齐。
 *
 * 这两条都是「删掉就会复发、而且只有真机才看得出来」的配置，所以用结构断言守着。
 * 真正的行为验证只能靠真机，别指望这组测试能证明修好了。
 */

const INDEX = readFileSync('index.html', 'utf8')
// 注释里会提到 --ime-inset（解释为什么不加它），断言前先剥掉注释，免得误判。
const STYLES = readFileSync('src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

test('viewport 必须声明 interactive-widget=resizes-content', () => {
  const meta = /<meta\s+name="viewport"[\s\S]*?\/>/.exec(INDEX)
  assert.ok(meta !== null, 'index.html 里找不到 viewport meta')
  assert.ok(
    meta[0].includes('interactive-widget=resizes-content'),
    '少了 interactive-widget=resizes-content —— 键盘弹起会改回「平移视觉视口」，固定布局会跳',
  )
})

test('.screen-body 的滚动定位不能再把键盘高度算第二遍', () => {
  const rule = /\.screen-body\s*\{[\s\S]*?\}/.exec(STYLES)
  assert.ok(rule !== null, 'styles.css 里找不到 .screen-body')
  assert.ok(
    !rule[0].includes('--ime-inset'),
    '布局视口已经因键盘缩小了，再按 --ime-inset 预留底部内边距会把输入框推到贴顶',
  )
  assert.ok(rule[0].includes('scroll-padding-bottom'), '.screen-body 丢了 scroll-padding-bottom')
})

test('全屏容器仍然是 fixed + inset:0（换成其它定位方式会让键盘逻辑整体失效）', () => {
  const rule = /\.screen\s*\{[\s\S]*?\}/.exec(STYLES)
  assert.ok(rule !== null, 'styles.css 里找不到 .screen')
  assert.ok(rule[0].includes('position: fixed'), '.screen 不再是 fixed —— 键盘/安全区那套推算是按它设计的')
})
