import test from 'node:test'
import assert from 'node:assert/strict'
import { nextUpdatableAt } from '../src/components/useThrottleMarkdownRender.ts'

/**
 * Markdown 流式节流的纯函数部分（P0）。
 *
 * 规则：渲染一次花了 elapsed 毫秒，下一次至少要等 elapsed × 2 毫秒后才允许
 * 再渲染；等待时长封顶 2000ms。这里**故意写死字面量**而不是引用模块里的常量 ——
 * 否则把 RATE 改成 1、把封顶删掉，用例会跟着常量一起变，永远绿（测不出回归）。
 */

test('渲染越慢，下一次允许更新得越晚（按耗时 ×2）', () => {
  // 渲染耗时 100ms → 下一次允许在 200ms 之后：1100 + 200 = 1300。
  assert.equal(nextUpdatableAt(1000, 1100), 1300)
})

test('等待时长封顶 2000ms，不会因为一次慢渲染卡死很久', () => {
  // 单次渲染 5 秒，按倍数会等 10 秒；必须被 2000ms 截住：5000 + 2000。
  assert.equal(nextUpdatableAt(0, 5000), 7000)
})

test('几乎瞬时完成时，间隔也很短（不人为加延迟）', () => {
  assert.equal(nextUpdatableAt(1000, 1001), 1003)
})

test('时间倒退（时钟抖动）不会算出负数间隔', () => {
  assert.equal(nextUpdatableAt(2000, 1000), 1000)
})
