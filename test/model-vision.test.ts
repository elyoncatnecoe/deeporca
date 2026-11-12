import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import {
  detectVisionByName,
  seesImages,
  visionOf,
  visionSourceLabel,
  type VisionProvider,
} from '../src/lib/capability.ts'
import { modelInfo, modelSeesImages } from '../src/lib/models.ts'
import { mergeCatalogModels } from '../src/lib/model-catalog.ts'
import { DEFAULT_SETTINGS, type Settings } from '../src/lib/types.ts'

/**
 * 「第三方模型无法识别图片」（2026-11-03）的回归锁。
 *
 * 这条链以前一点测试都没有：闸门是 BUILTIN_MODELS + 一条 /vision|vl/i，
 * 于是 gpt-4o / claude / gemini 全被判成瞎子，图片在附件阶段就被客户端丢掉。
 * 这里把四件事钉住：名字启发式认得出真实模型名、判定优先级（覆写 > 内置 > 名字 > 乐观）、
 * 元信息落库/合并不再吃掉手动开关、以及界面徽章和闸门共用同一个函数。
 */

/** settings.ts 连带 import 了 db / platform（IndexedDB、Capacitor），内部是 bundler
 *  风格的无扩展名 import，node 的 ESM 解析器不认。给它补上 .ts 才能跑到真正的 sanitize
 *  —— 抄一份规则进测试是没用的，抄的那份永远不会发现回归。 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})

const { sanitize } = await import('../src/lib/settings.ts')

/** 一个「中转站」供应商：openai 协议、没有手动覆写。 */
const relay: VisionProvider = { protocol: 'openai', modelMeta: {} }

/** 各家真正在用的多模态模型名。旧正则只认字面带 vl / vision 的那几个。 */
const REAL_VISION_IDS = [
  'gpt-4o',
  'gpt-4.1',
  'claude-3-5-sonnet-20241022',
  'glm-4v-plus',
  'kimi-latest',
  'MiniCPM-V',
  'gemini-2.5-flash',
  'qwen3-vl',
  'doubao-seed',
  'moonshot-v1-vision',
]

/** 明确不该被认成多模态的：纯文本、向量、老版本。 */
const TEXT_ONLY_IDS = [
  'deepseek-chat',
  'deepseek-reasoner',
  'gpt-3.5-turbo',
  'text-embedding-3-small',
  'llama-3.1-8b-instruct',
  'moonshot-v1-8k',
  'glm-4-plus',
  'qwen-turbo',
  '',
]

/* ------------------------------------------------------------ A1 名字启发式 */

test('A1 加宽后的名字启发式认得出真实的多模态模型名', () => {
  for (const id of REAL_VISION_IDS) {
    assert.equal(detectVisionByName(id), true, `${id} 应该被认出来`)
  }
})

test('A1 名字启发式不误伤纯文本和向量模型（多认可以，乱认不行）', () => {
  for (const id of TEXT_ONLY_IDS) {
    assert.equal(detectVisionByName(id), false, `${id} 不该被认成能看图`)
  }
})

/* --------------------------------------------------------------- A1 判定优先级 */

test('A1 第三方模型名走「名字」这一层，结论是会看图', () => {
  assert.deepEqual(visionOf(relay, 'gpt-4o'), { sees: true, source: 'name' })
  assert.deepEqual(visionOf(relay, 'claude-3-5-sonnet-20241022'), { sees: true, source: 'name' })
})

test('A1 一点依据都没有的自定义 id 乐观放行 —— 丢图是静默的，报错是响亮的', () => {
  assert.deepEqual(visionOf(relay, 'my-cool-model'), { sees: true, source: 'optimistic' })
  assert.deepEqual(visionOf(relay, 'accounts/foo/bar:generate'), { sees: true, source: 'optimistic' })
})

test('A1 手动覆写赢过内置表和名字启发式，false 也算话', () => {
  const provider: VisionProvider = {
    protocol: 'openai',
    modelMeta: { 'gpt-4o': { vision: false }, 'deepseek-flash': { vision: false } },
  }
  assert.deepEqual(visionOf(provider, 'gpt-4o'), { sees: false, source: 'override' })
  assert.deepEqual(visionOf(provider, 'deepseek-flash'), { sees: false, source: 'override' })
})

test('A1 内置表这一层赢过乐观默认（旧版那两个模型不该收到图）', () => {
  assert.deepEqual(visionOf(relay, 'deepseek-flash'), { sees: true, source: 'builtin' })
  assert.deepEqual(visionOf(relay, 'deepseek-reasoner'), { sees: false, source: 'builtin' })
  assert.deepEqual(visionOf(relay, 'deepseek-chat'), { sees: false, source: 'builtin' })
})

test('A1 deepseek-v4-pro 是内置的看图模型（README:163 对外承诺过，别再判成瞎子）', () => {
  assert.deepEqual(visionOf(relay, 'deepseek-v4-pro'), { sees: true, source: 'builtin' })
  assert.equal(modelInfo('deepseek-v4-pro').vision, true)
  assert.ok(modelInfo('deepseek-v4-pro').tags.includes('看图'))
})

test('A1 网页账号恒不能看图：它不走 HTTP，连手动覆写都翻不动', () => {
  const web: VisionProvider = {
    protocol: 'deepseek-web',
    modelMeta: { 'deepseek-chat-web': { vision: true }, 'gpt-4o': { vision: true } },
  }
  assert.equal(visionOf(web, 'deepseek-chat-web').sees, false)
  assert.equal(visionOf(web, 'gpt-4o').sees, false, '网页供应商压根发不出去图片')
  // 就算供应商是 openai 协议，那个 id 本身也不行。
  assert.deepEqual(visionOf(relay, 'deepseek-chat-web'), { sees: false, source: 'builtin' })
})

test('A1 旧的 modelSeesImages 壳还在，而且行为已经改走 capability', () => {
  assert.equal(modelSeesImages('deepseek-flash'), true)
  assert.equal(modelSeesImages('deepseek-chat-web'), false)
  assert.equal(modelSeesImages('deepseek-reasoner'), false)
  assert.equal(modelSeesImages('gpt-4o'), true, '旧壳不再自己写正则，第三方名字不该被判死')
  assert.equal(seesImages(relay, 'gpt-4o'), true)
})

/* ------------------------------------------ A7 徽章（读 modelInfo）与闸门同源 */

test('A7 设置页的徽章和附件闸门同一条规则，不许各说各话', () => {
  const ids = [...REAL_VISION_IDS, 'deepseek-flash', 'deepseek-v4-pro', 'deepseek-reasoner', 'deepseek-chat', 'deepseek-chat-web']
  for (const id of ids) {
    assert.equal(
      modelInfo(id).vision === true,
      visionOf(relay, id).sees,
      `${id} 的徽章（modelInfo）和闸门（visionOf）结论要一致`,
    )
  }
})

test('A7 判定依据的人话四种都有，界面不会撞到 undefined', () => {
  for (const source of ['override', 'builtin', 'name', 'optimistic'] as const) {
    assert.ok(visionSourceLabel(source) !== '', `${source} 要有对应的中文`)
  }
  assert.equal(visionSourceLabel('optimistic'), '未确认')
})

/* --------------------------------------------------- A3 元信息落库（sanitize） */

function rawProvider(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'provider_test',
    name: '测试供应商',
    protocol: 'openai',
    baseUrl: 'https://api.example.com',
    apiKey: '',
    models: ['mine'],
    headers: {},
    enabled: true,
    ...patch,
  }
}

function sanitizeRaw(raw: Record<string, unknown>): Settings {
  return sanitize(raw as unknown as Partial<Settings>)
}

test('A3 vision:false 必须能存住 —— 旧代码只认 === true，等于做不出「关掉看图」', () => {
  const settings = sanitizeRaw({
    providers: [rawProvider({ modelMeta: { mine: { name: '我的模型', vision: false } } })],
    model: 'mine',
  })
  const meta = settings.providers[0]?.modelMeta?.mine
  assert.equal(meta?.vision, false, 'false 被抹掉之后，三态开关的「关掉」这一档存不下来')
  assert.equal(meta?.name, '我的模型', '同一条里的别的字段照旧保留')
})

test('A3 vision:true 照旧保留，脏值（字符串 / 数字）仍然丢掉', () => {
  const settings = sanitizeRaw({
    providers: [rawProvider({ modelMeta: { mine: { vision: true }, other: { vision: 'yes', maxTokens: -3 } } })],
    model: 'mine',
  })
  const meta = settings.providers[0]?.modelMeta
  assert.equal(meta?.mine?.vision, true)
  assert.equal(meta?.other, undefined, '脏值不是布尔，不能当成用户的手动开关')
})

test('A3 正在用的模型就算不在目录里也保住元信息；无关的孤儿 id 照旧剪掉', () => {
  const settings = sanitizeRaw({
    providers: [rawProvider({ modelMeta: { hand: { vision: true, name: '手填的' }, ghost: { name: '没人用' } } })],
    model: 'hand',
  })
  const meta = settings.providers[0]?.modelMeta
  assert.equal(meta?.hand?.vision, true, '目录外手填的 id 正是最需要手动覆写的那个')
  assert.equal(meta?.hand?.name, '手填的')
  assert.equal(meta?.ghost, undefined, '既不在目录里也不是当前模型，还是要剪掉')
  assert.deepEqual(settings.providers[0]?.models, ['mine'], '不能顺手把 keepId 塞进 models：改写模型字段就是「自定义模型名存不住」那个坑')
})

test('A3 默认设置仍然自洽（deepseek 官方供应商那四个模型的元信息没被这条改动带歪）', () => {
  const settings = sanitizeRaw({ providers: [rawProvider({ models: ['deepseek-flash'], modelMeta: { 'deepseek-flash': { vision: true } } })], model: DEFAULT_SETTINGS.model })
  assert.equal(settings.providers[0]?.modelMeta?.['deepseek-flash']?.vision, true)
})

/* ------------------------------------------------------ A4 重新获取的目录合并 */

test('A4 重新「获取」要给已存在的 id 补上 vision —— 旧代码整条 continue，永远补不进来', () => {
  const merged = mergeCatalogModels(
    { models: ['mine'], modelMeta: { mine: { name: '用户自己起的名字' } } },
    [{ id: 'mine', name: '提供商起的名字', vision: true, contextWindow: 128000 }],
  )
  assert.deepEqual(merged.models, ['mine'], '不能因为合并就多出一份')
  assert.equal(merged.modelMeta?.mine?.vision, true, '缺的字段要补进来')
  assert.equal(merged.modelMeta?.mine?.contextWindow, 128000)
  assert.equal(merged.modelMeta?.mine?.name, '用户自己起的名字', '已有的键不覆盖：显示名可能是用户改过的')
})

test('A4 用户手动设过的 vision 绝不被一次重新获取翻回去（关掉的那档也一样）', () => {
  const forcedOn = mergeCatalogModels({ models: ['x'], modelMeta: { x: { vision: true } } }, [{ id: 'x', vision: false }])
  assert.equal(forcedOn.modelMeta?.x?.vision, true)
  const forcedOff = mergeCatalogModels({ models: ['x'], modelMeta: { x: { vision: false } } }, [{ id: 'x', vision: true }])
  assert.equal(forcedOff.modelMeta?.x?.vision, false, '「我不想给它发图」比提供商的声明更优先')
})

test('A4 目录里手填的 id 不会被一次拉取删掉（老规矩仍然成立），新 id 照旧追加', () => {
  const merged = mergeCatalogModels({ models: ['hand-typed'], modelMeta: undefined }, [{ id: 'new', vision: true }, { id: 'bare' }])
  assert.deepEqual(merged.models, ['hand-typed', 'new', 'bare'])
  assert.equal(merged.modelMeta?.new?.vision, true)
  assert.equal(merged.modelMeta?.bare, undefined, '什么元信息都没有的模型不留空条目')
})

/* ------------------------------------------------- 界面接线（源码文本断言） */

const CHAT = readFileSync('src/components/Chat.tsx', 'utf8')
const CATALOG = readFileSync('src/components/ModelCatalog.tsx', 'utf8')

/**
 * 只留代码行。源码注释里会引用被废掉的旧文案（正是为了说明为什么废），
 * 拿全文去 includes 旧串就永远红 —— 参考 test/es-compat.test.ts 的同款处理。
 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

const CHAT_CODE = codeOnly(CHAT)
const CATALOG_CODE = codeOnly(CATALOG)

test('A2 附件闸门不再丢图，提示用常驻 notice 而不是 2800ms 就消失的 toast', () => {
  assert.ok(!CHAT_CODE.includes('modelSeesImages'), 'Chat.tsx 还在用那个看不到 provider 的旧壳当闸门')
  assert.ok(!CHAT_CODE.includes("attachment.kind !== 'image'"), '还有一处把图片从附件里筛掉')
  assert.ok(!CHAT_CODE.includes('图片没有加入'), '旧的「图片没加入、切到 deepseek-flash 再试」闸门还在')
  assert.ok(CHAT_CODE.includes('visionOf(currentProvider(settings), settings.model)'), '闸门没改成读 capability')
  assert.ok(CHAT_CODE.includes('actions.setNotice('), '不能看图时用的是会自己消失的 toast')
  assert.ok(CHAT_CODE.includes('模型目录'), '提示里没说去哪儿把「看图」开关翻回来')
})

test('A2/A7 弹层徽章和模型目录那一行的三态开关都接在同一个 helper 上', () => {
  assert.ok(CHAT_CODE.includes('visionOf(provider, option.id)'), '聊天页的「看图」徽章没和闸门共用判定')
  assert.ok(CATALOG_CODE.includes('withVisionOverride'), '模型目录少了三态开关的写入函数')
  assert.ok(CATALOG_CODE.includes('visionOf(props.provider, id)'), '模型目录那一行看不到当前判定')
  assert.ok(CATALOG_CODE.includes('modelMeta'), '开关没有写回 provider.modelMeta')
})