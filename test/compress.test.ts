import test from "node:test"
import assert from "node:assert/strict"
import {
  COMPRESS_KEEP_RATIO,
  COMPRESS_TRIGGER_RATIO,
  resolveCutIndex,
  shouldCompress,
} from "../src/lib/compress-plan.ts"
import { estimateTokens } from "../src/lib/tokens.ts"
import type { ChatMessage } from "../src/lib/types.ts"

/**
 * 压缩决策的纯逻辑回归。
 *
 * compress.ts 本体带 IndexedDB 与模型调用（很难在 node 里剥开），
 * 所以「什么时候压 / 保留哪一段」抽到 compress-plan.ts，由这里守住。
 */

let seq = 0
function msg(content: string, reasoning = ""): ChatMessage {
  seq += 1
  return { id: `m${seq}`, conversationId: "c1", role: "user", content, reasoning, createdAt: seq }
}

test("触发线是严格大于 预算×0.7", () => {
  const budget = 1000
  assert.equal(shouldCompress(budget * COMPRESS_TRIGGER_RATIO, budget), false, "刚好 70% 不该压")
  assert.equal(shouldCompress(budget * COMPRESS_TRIGGER_RATIO + 1, budget), true)
  assert.equal(shouldCompress(10, budget), false)
})

test("手动压缩（force）永远视为满足", () => {
  assert.equal(shouldCompress(0, 1000, true), true)
  assert.equal(shouldCompress(9999, 1000, true), true)
})

test("预算非法时不压", () => {
  assert.equal(shouldCompress(100, 0), false)
  assert.equal(shouldCompress(100, Number.NaN), false)
})

test("保留条数优先：保留最近 N 条，前面的才折", () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg(`第${i}条`))
  assert.equal(resolveCutIndex(messages, 32000, 4), 6)
  assert.equal(resolveCutIndex(messages, 32000, 8), 2)
})

test("保留条数超过总条数时全部保留（切点 0）", () => {
  const messages = Array.from({ length: 3 }, (_, i) => msg(`第${i}条`))
  assert.equal(resolveCutIndex(messages, 32000, 30), 0)
})

test("按预算 30% 推保留窗口：保留段的成本不超过预算，再多一条就超", () => {
  const budget = 1000
  const keepBudget = Math.floor(budget * COMPRESS_KEEP_RATIO)
  // 每条约 40 字符 → 大约 10~12 token + 8 开销
  const messages = Array.from({ length: 40 }, (_, i) => msg(`消息内容比较长一点的样例文本-${i}`))
  const cut = resolveCutIndex(messages, budget)
  assert.ok(cut > 0, "40 条短消息应当需要压缩，切点应大于 0")
  const kept = messages.slice(cut)
  const keptCost = kept.reduce(
    (total, message) => total + estimateTokens(message.content) + estimateTokens(message.reasoning ?? "") + 8,
    0,
  )
  assert.ok(keptCost <= keepBudget, `保留段 ${keptCost} 应 ≤ 预算 ${keepBudget}`)
  // 再加回一条必然超预算（说明切点在边界上）
  const oneMore = messages[cut - 1]
  assert.ok(oneMore !== undefined, "切点应大于 0")
  const withOneMore =
    keptCost + estimateTokens(oneMore.content) + estimateTokens(oneMore.reasoning ?? "") + 8
  assert.ok(withOneMore > keepBudget, `多保留一条应超出预算（${withOneMore} > ${keepBudget}）`)
})

test("空对话切点为 0", () => {
  assert.equal(resolveCutIndex([], 32000), 0)
})
