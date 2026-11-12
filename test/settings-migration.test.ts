import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { DEFAULT_SETTINGS, type Settings } from '../src/lib/types.ts'

/**
 * 设置迁移回归测试：主题拆成「海底场景」+「界面色调」，orcaName 并进助手。
 *
 * 为什么这里要装一个 resolve 钩子：settings.ts 连带 import 了 db / platform
 * （IndexedDB、Capacitor），它内部是 bundler 风格的无扩展名 import（`'./db'`），
 * Node 的 ESM 解析器不认，直接 import 会 ERR_MODULE_NOT_FOUND。
 * 给「相对路径且没写扩展名」的 specifier 补一个 .ts，就能在 node 里跑到真正的
 * sanitize —— 而不是把迁移规则抄一份进测试（抄的那份永远不会发现真正的回归）。
 */
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

/**
 * 老库里的对象在类型上已经不是 Settings 了（theme / orcaName 已删），
 * 测试从这个口子把老格式喂进去。
 */
function sanitizeRaw(raw: Record<string, unknown>): Settings {
  return sanitize(raw as unknown as Partial<Settings>)
}

const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)

test('老格式（只有 theme + orcaName）：两个新字段都继承老主题，名字搬到第一个助手', () => {
  const settings = sanitizeRaw({ theme: 'iceberg', orcaName: '小蓝' })
  assert.equal(settings.aquariumTheme, 'iceberg', '海底场景主题继承老 theme')
  assert.equal(settings.appTone, 'iceberg', '界面色调也继承老 theme —— 升级前后看起来要一样')
  assert.equal(settings.assistants[0]?.name, '小蓝', '老名字要挪到第一优先级助手上')
  assert.equal(has(settings, 'orcaName'), false, '存回去的必须是新格式：不能再有 orcaName')
  assert.equal(has(settings, 'theme'), false, '存回去的必须是新格式：不能再有 theme')
})

test('新格式：两个主题字段各自独立，互不覆盖', () => {
  const settings = sanitizeRaw({ aquariumTheme: 'tropical', appTone: 'iceberg' })
  assert.equal(settings.aquariumTheme, 'tropical')
  assert.equal(settings.appTone, 'iceberg')
  assert.equal(has(settings, 'theme'), false, '新格式里不该凭空冒出老键')
  assert.equal(has(settings, 'orcaName'), false)
})

test('非法主题值退回 deep，两个字段各自校验、互不连累', () => {
  assert.equal(sanitizeRaw({ aquariumTheme: 'nope' }).aquariumTheme, 'deep')
  assert.equal(sanitizeRaw({ appTone: 'nope' }).appTone, 'deep')
  const mixed = sanitizeRaw({ aquariumTheme: 'nope', appTone: 'tropical' })
  assert.equal(mixed.aquariumTheme, 'deep', '脏的那一个退回 deep')
  assert.equal(mixed.appTone, 'tropical', '另一个合法值不能被顺手改掉')
})

test('老 theme 本身是脏值时，两个字段都退回 deep', () => {
  const settings = sanitizeRaw({ theme: 'neon' })
  assert.equal(settings.aquariumTheme, 'deep')
  assert.equal(settings.appTone, 'deep')
})

test('老 orcaName 等于默认值「深鲸」时不算用户起的名字，助手名不被改写', () => {
  const settings = sanitizeRaw({ theme: 'deep', orcaName: '深鲸' })
  assert.equal(settings.assistants[0]?.name, 'DeepOrca', '默认值不该被当成脏名字再写回去')
  assert.equal(has(settings, 'orcaName'), false)
})

test('第一个助手已经有用户起的名字时，老 orcaName 不覆盖它', () => {
  const base = DEFAULT_SETTINGS.assistants[0]
  const settings = sanitizeRaw({ theme: 'deep', orcaName: '小蓝', assistants: [{ ...base, name: '阿鲸' }] })
  assert.equal(settings.assistants[0]?.name, '阿鲸', '助手页改好的名字优先')
})

test('第一个助手还没有名字（规范化成「未命名」）时，老 orcaName 照样搬过去', () => {
  const base = DEFAULT_SETTINGS.assistants[0]
  const settings = sanitizeRaw({ orcaName: '小蓝', assistants: [{ ...base, name: '' }] })
  assert.equal(settings.assistants[0]?.name, '小蓝')
})

test('默认设置就是新格式：两个主题字段都是 deep，没有老键', () => {
  assert.equal(DEFAULT_SETTINGS.aquariumTheme, 'deep')
  assert.equal(DEFAULT_SETTINGS.appTone, 'deep')
  assert.equal(has(DEFAULT_SETTINGS, 'theme'), false)
  assert.equal(has(DEFAULT_SETTINGS, 'orcaName'), false)
})

test('老数据没有 imageApi / speechApi：补默认值且默认关闭', () => {
  const settings = sanitizeRaw({})
  assert.equal(settings.imageApi.enabled, false)
  assert.equal(settings.imageApi.protocol, 'openrouter')
  assert.equal(settings.imageApi.baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(settings.imageApi.timeoutMs, 300000)
  assert.equal(settings.speechApi.enabled, false)
  assert.equal(settings.speechApi.protocol, 'openrouter')
  assert.equal(settings.speechApi.voice, 'alloy')
  assert.equal(settings.speechApi.timeoutMs, 180000)
})

test('半截 imageApi / speechApi 对象要补默认值，不能把 timeout/headers 变成 undefined', () => {
  const settings = sanitizeRaw({
    imageApi: { enabled: true, model: 'bytedance-seed/seedream-4.5' },
    speechApi: { enabled: true, model: 'openai/gpt-4o-audio-preview', speed: 1.5 },
  })
  assert.equal(settings.imageApi.enabled, true)
  assert.equal(settings.imageApi.model, 'bytedance-seed/seedream-4.5')
  assert.equal(settings.imageApi.timeoutMs, 300000)
  assert.deepEqual(settings.imageApi.extraHeaders, {})
  assert.equal(settings.speechApi.speed, 1.5)
  assert.equal(settings.speechApi.format, 'mp3')
  assert.equal(settings.speechApi.timeoutMs, 180000)
})

test('非法媒体协议 / 格式 / 超时值回落默认，不把脏值带进请求', () => {
  const settings = sanitizeRaw({
    imageApi: { protocol: 'nope', timeoutMs: -1 },
    speechApi: { protocol: 'nope', format: 'ogg', speed: 999 },
  })
  assert.equal(settings.imageApi.protocol, 'openrouter')
  assert.equal(settings.imageApi.timeoutMs, 300000)
  assert.equal(settings.speechApi.protocol, 'openrouter')
  assert.equal(settings.speechApi.format, 'mp3')
  assert.equal(settings.speechApi.speed, 4)
})

test('新增媒体协议（Gemini / MiniMax / 阿里百炼 / ElevenLabs）能通过 sanitize', () => {
  const settings = sanitizeRaw({
    imageApi: { protocol: 'gemini', model: 'imagen-3.0-generate-002' },
    speechApi: { protocol: 'minimax', model: 'speech-2.6-turbo' },
  })
  assert.equal(settings.imageApi.protocol, 'gemini')
  assert.equal(settings.speechApi.protocol, 'minimax')
  const aliyun = sanitizeRaw({ imageApi: { protocol: 'aliyun' }, speechApi: { protocol: 'elevenlabs' } })
  assert.equal(aliyun.imageApi.protocol, 'aliyun')
  assert.equal(aliyun.speechApi.protocol, 'elevenlabs')
})

/*
 * 外观自定义（自定义强调色 / 气泡色 / 对话底图）。
 *
 * 这几个字段最终会被写进 .app 的内联 CSS 变量，或者整份塞进 IndexedDB，
 * 所以「脏值当成没有自定义」比「尽量修一修」更安全 —— 下面锁住这条口径。
 */

test('外观自定义：颜色只认 #rrggbb，脏值退回「没有自定义」', () => {
  assert.equal(sanitizeRaw({ customAccent: '#B06BFF' }).customAccent, '#b06bff', '统一小写')
  assert.equal(sanitizeRaw({ customAccent: '#abc' }).customAccent, '#aabbcc', '三位简写展开成六位（<input type="color"> 只吃六位）')
  assert.equal(sanitizeRaw({ customAccent: 'red' }).customAccent, null)
  assert.equal(sanitizeRaw({ customAccent: '#12345' }).customAccent, null)
  assert.equal(sanitizeRaw({ customAccent: '#fff; background: url(x)' }).customAccent, null, '不能把任意 CSS 放进内联变量')
  assert.equal(sanitizeRaw({ customBubble: 42 }).customBubble, null, '非字符串当没给')
})

test('外观自定义：默认是「跟随预设」，不是布尔式的默认开', () => {
  const settings = sanitizeRaw({})
  assert.equal(settings.customAccent, null)
  assert.equal(settings.customBubble, null)
  assert.equal(settings.chatBackdrop, null)
  assert.equal(settings.chatBackdropOpacity, 0.7)
})

test('外观自定义：底图不透明度夹到 0~1，超大 / 非 dataURL 的底图直接丢掉', () => {
  assert.equal(sanitizeRaw({ chatBackdropOpacity: 3 }).chatBackdropOpacity, 1)
  assert.equal(sanitizeRaw({ chatBackdropOpacity: -2 }).chatBackdropOpacity, 0)
  assert.equal(sanitizeRaw({ chatBackdropOpacity: 'nope' }).chatBackdropOpacity, 0.7)
  const ok = `data:image/jpeg;base64,${'A'.repeat(2000)}`
  assert.equal(sanitizeRaw({ chatBackdrop: ok }).chatBackdrop, ok)
  const huge = `data:image/jpeg;base64,${'A'.repeat(2_100_000)}`
  assert.equal(sanitizeRaw({ chatBackdrop: huge }).chatBackdrop, null, '超过体积上限的底图不能落库')
  assert.equal(sanitizeRaw({ chatBackdrop: 'https://example.com/a.jpg' }).chatBackdrop, null, '只认 dataURL，避免外链图片')
})

