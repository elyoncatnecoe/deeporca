import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, type Provider, type Settings } from '../src/lib/types.ts'
import { REASONING_RESERVE, resolveOutputCap, retryCap } from '../src/lib/budget.ts'
import { buildAnthropicBody, buildGoogleBody, buildOpenAiBody } from '../src/lib/protocols.ts'

/**
 * 请求体回归测试（修复 B）。
 *
 * 为什么以前这个 bug 能一路跑到线上：仓里**没有任何**请求体测试。
 * 现场是「做 html 时工坊没被调用 + 思考截断」，根因却是 max_tokens 只给了 4096，
 * 而推理模型的思考与正文共用这一个额度 —— 思考吃光，正文与 tool_calls 双双为空。
 * 这里锁三件事：预算怎么算（budget.ts）、三个协议各自收到什么数（纯构造器）、
 * Anthropic/Google 那几个「必 400 / 工具静默消失」的形状约束。
 *
 * 断言全部打在**纯构造器**上（buildOpenAiBody / buildAnthropicBody / buildGoogleBody），
 * 这样「数字由预算模块算、形状由协议层拼」两边各自改动都不会让测试说谎。
 */

// B4/B5 的形状约束要落到 protocols.ts，而那个文件现在由 task-1 持有（见 _tmp/pending-b.md §2）。
// 落地前这几条必然是红的，所以先标 skip；应用 pending-b 时把开关改成 false。
const PENDING_PROTOCOLS = '等 _tmp/pending-b.md §2 落到 protocols.ts（task-1 完成后由我应用）'

function settings(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

function providerWith(model: string, meta?: Partial<NonNullable<Provider['modelMeta']>[string]>): Provider {
  const base = DEFAULT_SETTINGS.providers[0] as Provider
  return { ...base, models: [model], modelMeta: meta === undefined ? undefined : { [model]: meta } }
}

const USER = { role: 'user' as const, content: '做个 3D 场景' }

/* ------------------------------------------------------------------ 预算 */

test('正文预算 + 思考预留：maxTokens 是正文那一半，不是发出去的上限', () => {
  const s = settings({ maxTokens: 8192, thinkingEffort: 'high' })
  const cap = resolveOutputCap(s, providerWith('deepseek-v4-pro'))
  assert.equal(cap.body, 8192)
  assert.equal(cap.reserve, 8192, 'high 档预留 8192')
  assert.equal(cap.cap, 16384, '发出去的 max_tokens = 8192 + 8192')
  assert.ok(cap.cap !== null && cap.cap > cap.reserve, '正文不能被思考挤光')
})

test('四档思考强度的预留', () => {
  assert.equal(REASONING_RESERVE.off, 0)
  assert.equal(REASONING_RESERVE.low, 4096)
  assert.equal(REASONING_RESERVE.high, 8192)
  assert.equal(REASONING_RESERVE.max, 16384)
  for (const effort of ['off', 'low', 'high', 'max'] as const) {
    const cap = resolveOutputCap(settings({ maxTokens: 8192, thinkingEffort: effort }), providerWith('m'))
    assert.equal(cap.cap, 8192 + REASONING_RESERVE[effort], `${effort} 档`)
  }
})

test('模型目录声明了输出上限就按它收顶，但绝不低于正文预算', () => {
  // modelMeta 按 settings.model 索引：模型名对不上就等于没有目录信息（手填的模型名就是这样）。
  const s = settings({ model: 'm', maxTokens: 8192, thinkingEffort: 'high' })
  // 目录说这模型最多输出 12000：16384 会被砍到 12000。
  assert.equal(resolveOutputCap(s, providerWith('m', { maxTokens: 12000 })).cap, 12000)
  // 目录说得更大：不抬过「正文 + 预留」，省得一次回复把账单和等待时间拉飞。
  assert.equal(resolveOutputCap(s, providerWith('m', { maxTokens: 65536 })).cap, 16384)
  // 目录填了个比正文预算还小的脏数：用户要的正文优先，不能被目录砍成 4000。
  assert.equal(resolveOutputCap(s, providerWith('m', { maxTokens: 4000 })).cap, 8192)
  // 目录里没有这个模型的条目：不收顶。
  assert.equal(resolveOutputCap(s, providerWith('other')).cap, 16384)
})

test('maxTokens = 0 是「自动」：不发这个字段，而不是发 0', () => {
  const cap = resolveOutputCap(settings({ model: 'm', maxTokens: 0, thinkingEffort: 'high' }), providerWith('m'))
  assert.equal(cap.body, 0)
  assert.equal(cap.cap, null, 'null = 干脆不发 max_tokens（对齐上游「留空表示无限制」）')
})

test('撞顶重试的上限：翻倍，贴着模型上限时不翻', () => {
  const s = settings({ model: 'm', maxTokens: 8192, thinkingEffort: 'high' })
  const big = resolveOutputCap(s, providerWith('m', { maxTokens: 65536 }))
  assert.equal(retryCap(big), 32768)
  // 已经贴着目录上限：再翻只会让中转站回一个 400，不值得重试。
  const stuck = resolveOutputCap(s, providerWith('m', { maxTokens: 16384 }))
  assert.equal(stuck.cap, 16384)
  assert.equal(retryCap(stuck), null)
  // 自动模式本来就没发上限，翻倍无从翻起。
  assert.equal(retryCap(resolveOutputCap(settings({ model: 'm', maxTokens: 0 }), providerWith('m'))), null)
})

/* -------------------------------------------------------------- 请求体形状 */

test('OpenAI 兼容：max_tokens 用预算算出来的数，工具照旧带 tool_choice', () => {
  const body = buildOpenAiBody({
    model: 'deepseek-v4-pro',
    messages: [USER],
    temperature: 0.7,
    maxTokens: 16384,
    tools: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object', properties: {} } } }],
    stream: true,
    includeUsage: true,
    thinking: { type: 'enabled' },
    reasoningEffort: 'high',
  })
  assert.equal(body.max_tokens, 16384)
  assert.equal(body.reasoning_effort, 'high')
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal((body.tools as unknown[]).length, 1, '工具必须进请求体，否则工坊根本不可用')
  assert.equal(body.tool_choice, 'auto')
})

test('OpenAI 兼容：没有工具时不要发空的 tools 数组', () => {
  const body = buildOpenAiBody({ model: 'm', messages: [USER], temperature: 0.7, maxTokens: 1024, tools: [], stream: true })
  assert.equal(body.tools, undefined)
  assert.equal(body.tool_choice, undefined)
})

test('Anthropic：budget_tokens 必须严格小于 max_tokens，开思考时不发 temperature', { skip: PENDING_PROTOCOLS }, () => {
  // 现场：budget 4096 与 max_tokens 4096 一起发 + 恒带 temperature 0.7
  //  —— Anthropic 两个都要求改，于是接 Anthropic 中转的用户「每次必 400」，
  //  而 400 退避只会剥 stream_options / thinking / reasoning_effort / reasoning_content，修不好这个搭配。
  const body = buildAnthropicBody({
    model: 'claude-x',
    messages: [USER],
    temperature: 0.7,
    maxTokens: 4096,
    thinkingBudget: 4096,
    stream: true,
  })
  const thinking = body.thinking as { budget_tokens: number }
  assert.ok(thinking.budget_tokens < (body.max_tokens as number), 'max_tokens 必须大于 budget_tokens')
  assert.equal(body.temperature, undefined, '开推理时不能带 temperature')
})

test('Anthropic：思考关着时 temperature 照发（别顺手改掉正常路径）', { skip: PENDING_PROTOCOLS }, () => {
  const body = buildAnthropicBody({ model: 'claude-x', messages: [USER], temperature: 0.7, maxTokens: 4096, stream: false })
  assert.equal(body.temperature, 0.7)
  assert.equal(body.thinking, undefined)
})

test('Google：工坊工具必须翻成 functionDeclarations（回归 P1-11）', { skip: PENDING_PROTOCOLS }, () => {
  // 现场：buildGoogleBody 的签名里没有 tools，Gemini 下四个工坊工具静默消失 ——
  // 症状和「模型不想调用工具」一模一样，而且日志里没有任何错误。
  const body = buildGoogleBody({
    messages: [USER],
    temperature: 0.7,
    maxTokens: 16384,
    thinkingBudget: 4096,
    tools: [{ type: 'function', function: { name: 'write_file', description: '写文件', parameters: { type: 'object', properties: {} } } }],
  })
  const tools = body.tools as Array<{ functionDeclarations?: Array<{ name: string }> }>
  assert.equal(tools[0]?.functionDeclarations?.[0]?.name, 'write_file')
  const config = body.generationConfig as Record<string, unknown>
  assert.ok((config.maxOutputTokens as number) > (config.thinkingConfig as { thinkingBudget: number }).thinkingBudget)
})

test('正文预算填 0：三个协议都不发上限字段（Anthropic 除外，它必填）', { skip: PENDING_PROTOCOLS }, () => {
  const openai = buildOpenAiBody({ model: 'm', messages: [USER], temperature: 0.7, maxTokens: undefined as never, stream: true })
  assert.equal(openai.max_tokens, undefined, '不发这个字段 = 交给模型自己定')
  const google = buildGoogleBody({ messages: [USER], temperature: 0.7, maxTokens: undefined as never })
  const config = google.generationConfig as Record<string, unknown>
  assert.equal(config.maxOutputTokens, undefined)
})
