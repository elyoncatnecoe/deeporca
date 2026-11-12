import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isTruncatedFinish } from '../src/lib/budget.ts'

/**
 * 工具循环与截断续跑的回归测试（修复 B3 / B6 / B8）。
 *
 * 为什么用源码文本断言：engine.ts 一路 import 到 IndexedDB / Capacitor，
 * 在 node 里跑不起来；而这一类 bug 恰恰是「某一行没写」—— 完成一轮就退出的
 * break、没人读的 finishReason、只给 4 轮的循环上限。文本断言能锁住「有没有」，
 * 真行为断言由 request-body / stream-protocols / tool-args-truncation 覆盖。
 * 沿用 test/workshop-projects.test.ts 的写法。
 */

const ENGINE = readFileSync('src/lib/engine.ts', 'utf8')
const DEEPSEEK = readFileSync('src/lib/deepseek.ts', 'utf8')
const PROMPT = readFileSync('src/lib/prompt.ts', 'utf8')
// 协议层的两条纪律（budget_tokens < max_tokens、开推理不发 temperature）只能从
// protocols.ts 的源码里断言 —— 它 import 了 types 但没有任何 DOM/IDB 依赖，
// 这里仍然用文本断言，理由同上：这条线最容易「某一行没写」。
const PROTOCOLS = readFileSync('src/lib/protocols.ts', 'utf8')

test('撞顶判定：三种协议的写法都算截断，正常收尾不算', () => {
  for (const reason of ['length', 'max_tokens', 'MAX_TOKENS']) {
    assert.ok(isTruncatedFinish(reason), reason + ' 应判成截断')
  }
  for (const reason of ['stop', 'tool_use', 'tool_calls', 'end_turn', 'aborted', 'content_filter']) {
    assert.equal(isTruncatedFinish(reason), false, reason + ' 不是截断')
  }
})

test('引擎必须真的读 finishReason（RC-3：截断过去完全隐形）', () => {
  assert.ok(ENGINE.includes('isTruncatedFinish(result.finishReason)'), 'engine 没有消费本轮的 finishReason')
  assert.ok(ENGINE.includes('result.truncatedToolCallIds'), 'engine 没有处理半截参数的工具调用')
  // 截断要落到消息上，回看时才知道这条是断的（界面那句「已到输出上限」用的就是它）。
  assert.ok(/truncated:\s*true/.test(ENGINE), '被截断的助手消息没有打 truncated 标记')
  // 也要说给用户听 —— 静默停在半路是最难排查的。
  assert.ok(ENGINE.includes('已到输出上限'), '截断没有可见提示')
})

test('截断后先用翻倍上限原地重试一次，而且不碰历史', () => {
  assert.ok(ENGINE.includes('retryCap(outputCap)'), '没有用 budget.ts 的翻倍上限')
  assert.ok(ENGINE.includes('maxTokensOverride: limit'), '重试没有把覆盖上限传给 streamChat')
  assert.ok(ENGINE.includes('result.toolCalls.length === 0 && lengthRetries < 2'), '重试没有「只救两次」的硬上限，会空转')
  // 重试用的是同一个请求：不能在两次之间把截断的那条塞进 history。
  const retry = ENGINE.slice(ENGINE.indexOf('const bigger = retryCap'), ENGINE.indexOf('const parsed = extractBodyDirectives'))
  assert.ok(!retry.includes('history = [...history'), '原地重试改了历史')
  assert.ok(!retry.includes('appendMessage'), '原地重试把截断的回复落了库')
})

test('工具循环上限 4 -> 10，撞上限要吭声（旧值刚好被 index.html+style.css+script.js+收尾吃满）', () => {
  assert.ok(/const MAX_TOOL_ITERATIONS = 10/.test(ENGINE), '循环上限没抬到 10')
  assert.ok(ENGINE.includes('while (iteration < MAX_TOOL_ITERATIONS)'), '循环还在用别的上限')
  assert.ok(!ENGINE.includes('while (iteration < 4)'), '还留着 4 轮的旧上限')
  assert.ok(ENGINE.includes('iteration >= MAX_TOOL_ITERATIONS'), '撞上限时没有提示')
})

test('上限一律由 budget.ts 算，三处 body 构造都不许再裸传 settings.maxTokens（RC-1）', () => {
  assert.ok(DEEPSEEK.includes('resolveOutputCap(settings, provider)'), '没有用预算模块算上限')
  const region = DEEPSEEK.slice(DEEPSEEK.indexOf('const buildBody'), DEEPSEEK.indexOf('const send'))
  assert.ok(!region.includes('maxTokens: settings.maxTokens'), '还在把正文预算直接当输出上限发出去')
  // 分工：deepseek.ts 只递数字（正文预算 + 思考预留、强度 → 预算），
  // 「budget_tokens 严格小于 max_tokens」「开推理不发 temperature」这些**协议纪律**在 protocols.ts。
  // 纪律留在协议层是因为它各家不同、也最容易被调用方记错（lead 在 13:36 的裁定）。
  assert.ok(region.includes('thinkingBudget: anthropicThinkingBudget(settings)'), 'Anthropic 没收到思考预算')
  assert.ok(region.includes('thinkingBudget: googleThinkingBudget(settings)'), 'Gemini 没收到思考预算')
  assert.ok(region.includes('tools,'), '工坊工具没递给 body 构造器')
})

test('协议纪律收在 protocols.ts：Anthropic 的 budget < max_tokens、开推理不发温度（B4）', () => {
  const anthropic = PROTOCOLS.slice(PROTOCOLS.indexOf('export function buildAnthropicBody'), PROTOCOLS.indexOf('/** 解析 Anthropic 的一个 SSE data 负载。 */'))
  assert.ok(anthropic.includes('maxTokens - 1024'), 'budget_tokens 与 max_tokens 的大小关系没收紧')
  assert.ok(anthropic.includes('thinkingBudget === undefined ? { temperature'), '开着推理还在发 temperature（必 400）')
  assert.ok(anthropic.includes('ANTHROPIC_AUTO_MAX_TOKENS'), 'max_tokens 必填却没有「自动」时的兜底')
  // Google 的 tools：P1-11 —— 签名里没有 tools 时四个工坊工具静默消失。
  const google = PROTOCOLS.slice(PROTOCOLS.indexOf('export function buildGoogleBody'))
  assert.ok(google.includes('functionDeclarations'), 'Gemini 没有把工具翻成 functionDeclarations')
  assert.ok(google.includes("mode: 'AUTO'"), '少了 toolConfig 的调用模式')
  assert.ok(google.includes('budget >= limit'), 'maxOutputTokens 与 thinkingBudget 的大小关系没收紧')
})

test('工坊提示词要有工具纪律：要产出页面就必须真的调用 write_file（B8 另一半）', () => {
  assert.ok(PROMPT.includes('必须先真的调用 write_file'), '工坊提示词没有写工具纪律')
  assert.ok(PROMPT.includes('一次 write_file 只写'), '没有约束「一次调用一个完整文件」')
})

test('媒体工具必须在工坊文件 else 之前分流，并拿到本轮附件与 AbortSignal', () => {
  const mediaPos = ENGINE.indexOf('isMediaToolName(call.function.name)')
  const fileElsePos = ENGINE.indexOf('// 文件工具：把 args.project')
  assert.ok(mediaPos > 0, 'engine 没有媒体工具分支')
  assert.ok(fileElsePos > mediaPos, '媒体工具分支落在了文件工具 else 后面，会被误当成项目文件操作')
  assert.ok(ENGINE.includes('mediaToolDefinitions(settings)'), '媒体工具定义没有注入 tools')
  assert.ok(ENGINE.includes('referenceImages'), '图生图没有拿到本轮用户附件')
  assert.ok(ENGINE.includes('runMediaTool(call.function.name, call.function.arguments'), '没有调用 runMediaTool')
})

test('思考全文不再每轮回灌（RC-6）：只有带 tool_calls 的那条，或供应商明确开启', () => {
  assert.ok(PROMPT.includes('if (hasTools || includeReasoning) request.reasoning_content'), 'reasoning_content 还在无条件回灌')
  assert.ok(!/\n\s*request\.reasoning_content = message\.reasoning\n/.test(PROMPT), '又变回每条都带思考全文')
  assert.ok(PROMPT.includes('includeHistoryReasoning'), '没有供应商级开关')
  // 上下文预算也要用「实际发出去的上限」，不然思考预留没算进去。
  assert.ok(PROMPT.includes('resolveOutputCap(settings, provider)'), '历史预算还在用 settings.maxTokens')
  assert.ok(PROMPT.includes('settings.contextBudget - outputAllowance'), '历史预算没有减去有效上限')
})
