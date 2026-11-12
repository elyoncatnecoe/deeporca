import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildWebChatContext } from '../src/lib/web-context.ts'
import { DEFAULT_SETTINGS, ORCA_PERSONA, type MemoryEntry, type Settings } from '../src/lib/types.ts'

/**
 * 回归测试：网页账号模式注入的「稳定块」。
 *
 * 踩过的坑：上层把整个 system prompt（人设 + 身体读数 + 时间 + 最近对话回顾 +
 * 滚动摘要）当成「人设」传下去。网页那边靠「和上次拼进去的是不是同一段文字」
 * 决定要不要重拼，而身体/时间/摘要每轮都在变，于是判据几乎每轮命中——用户看到
 * 自己每发一句，网页里就多一段「【以下是你的设定…】」。
 *
 * 修法：只拼稳定块（人设 + 常驻记忆），每轮都变的东西一律不进这个字符串。
 */

const ENGINE = readFileSync('src/lib/engine.ts', 'utf8')
const DS = readFileSync('src/lib/deepseek.ts', 'utf8')
const API = readFileSync('electron/deepseek-api.ts', 'utf8')
const JAVA = readFileSync('android/app/src/main/java/com/elyoncat/deepsea/WebApiClient.java', 'utf8')
const SOURCE = readFileSync('src/lib/web-context.ts', 'utf8')

const CHARACTER_ID = 'asst_orca'

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

function memory(text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem_' + text,
    text,
    type: 'profile',
    tags: [],
    importance: 2,
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    ...patch,
  }
}

function context(overrides: {
  persona?: string
  name?: string
  memories?: MemoryEntry[]
  settings?: Settings
} = {}): string {
  return buildWebChatContext({
    settings: overrides.settings ?? settings(),
    persona: overrides.persona ?? ORCA_PERSONA,
    name: overrides.name ?? '深鲸',
    characterId: CHARACTER_ID,
    memories: overrides.memories ?? [],
  })
}

test('稳定块带人设和常驻记忆', () => {
  const text = context({ memories: [memory('用户在做一只鲸鱼客户端')] })
  assert.ok(text.startsWith('【以下是你的设定，请在整段对话里保持】'), '缺少设定头')
  assert.ok(text.includes('你是「深鲸」'), '没有带人设')
  assert.ok(text.includes('- 用户在做一只鲸鱼客户端'), '没有带常驻记忆')
})

test('稳定块不含每轮都在变的东西（时间/身体/回顾/摘要）', () => {
  const text = context({ memories: [memory('用户叫小明')] })
  for (const marker of ['<time>', '<body>', '<recent_chats>', '<earlier_in_this_conversation>']) {
    assert.ok(!text.includes(marker), `稳定块里不该出现 ${marker}`)
  }
  // 也不该借道 prompt.ts 的整段 system prompt：身体/时间那几个构造函数在这里用不到。
  for (const name of ['bodyMind', 'timeBlock', 'recapBlock', 'digestBlock']) {
    assert.ok(!SOURCE.includes(name), `web-context.ts 不该碰 ${name}`)
  }
})

test('同样的输入拼出同样的字符串（否则去重判据失效）', () => {
  const a = context({ memories: [memory('用户喜欢简洁的回答')] })
  const b = context({ memories: [memory('用户喜欢简洁的回答')] })
  assert.equal(a, b)
})

test('人设或记忆真的变了，稳定块才跟着变', () => {
  const base = context()
  assert.notEqual(base, context({ persona: '你是一只猫。' }))
  assert.notEqual(base, context({ memories: [memory('用户叫小明')] }))
})

test('人设为空时退回内置身份，并带上助手名字', () => {
  const text = context({ persona: '', name: '小蓝' })
  assert.ok(text.includes('你是「小蓝」'), '空人设没有退回内置身份')
})

test('engine 只把 persona / 名字 / 记忆交给稳定块', () => {
  const start = ENGINE.indexOf('const webContext')
  assert.ok(start !== -1, 'engine 里没有 webContext')
  const end = ENGINE.indexOf('let iteration', start)
  assert.ok(end > start, '没找到 webContext 之后的位置')
  const body = ENGINE.slice(start, end)
  assert.ok(body.includes('buildWebChatContext'), 'engine 没用稳定块构造器')
  for (const banned of ['bodyMind', 'recap', 'digest', 'timeReminder']) {
    assert.ok(!body.includes(banned), `engine 的稳定块里不该出现 ${banned}`)
  }
})

test('渲染层把稳定块交给网页账号', () => {
  assert.ok(ENGINE.includes('webContext,'), 'engine 没有把 webContext 传给 streamChat')
  assert.ok(DS.includes('systemPrompt: options.webContext'), 'deepseek 没有把稳定块传下去')
  assert.ok(!DS.includes('webChatSystemText'), 'deepseek 还在从整段 system 里取人设')
})

test('走不走网页账号以「这段对话实际用的模型」为准', () => {
  // 用全局设置判断会漏掉「对话快照是网页模型、全局已切回 API」的情况，
  // 那时 webContext 会是空的，网页线程一条人设都拿不到。
  assert.ok(ENGINE.includes('const webMode = isWebChatProvider(settings)'), 'webMode 没按生效设置判断')
  assert.ok(!ENGINE.includes('isWebChatProvider(options.settings)'), 'webMode/webContext 还在用全局设置')
  assert.ok(ENGINE.includes('const webContext = webMode'), 'webContext 没跟着 webMode')
})

test('桌面端按「和上次是否一样」决定重拼，不再只认首轮', () => {
  assert.ok(API.includes('needPersona'), '主进程没有 needPersona 判据')
  assert.ok(API.includes('persona !== thread.persona'), '没有比较上次拼进去的人设')
  assert.ok(API.includes('thread.persona = persona'), '没有记住这次拼进去的人设')
})

test('Android 侧同样是「变了才重拼」，并把稳定块存盘', () => {
  assert.ok(JAVA.includes('!persona.equals(thread.persona)'), 'Java 没有比较上次的人设')
  assert.ok(JAVA.includes('thread.persona = persona'), 'Java 没有记住这次的人设')
  assert.ok(JAVA.includes('item.put("persona"'), 'Java 没有把人设存进 SharedPreferences')
})

test('改写历史时给网页模型补一句「以这条为准」', () => {
  // 网页会话只能追加：编辑重发/重新生成时，网页那边旧消息还在。
  assert.ok(DS.includes('REWRITE_NOTES'), 'deepseek 没有改写说明')
  assert.ok(DS.includes('我改写了前面那条消息'), '缺少编辑重发的说明')
  assert.ok(DS.includes('请重新回答这条消息'), '缺少重新生成的说明')
  assert.ok(ENGINE.includes("rewrite: 'edit'"), '编辑重发没有标记 rewrite')
  assert.ok(ENGINE.includes("rewrite: 'regenerate'"), '重新生成没有标记 rewrite')
  assert.ok(
    ENGINE.includes('webRewrite: webMode ? options.rewrite : undefined'),
    '没有把 rewrite 传给网页层',
  )
})

test('网页线程映射在建会话时就落盘（失败/被杀也不会丢）', () => {
  // 映射丢了 → 下一轮重新建会话 → 同一段对话又被灌一遍设定。
  const javaStart = JAVA.indexOf('thread.sid = createSession(token)')
  assert.ok(javaStart !== -1, '没找到 Android 建会话的位置')
  assert.ok(JAVA.slice(javaStart, javaStart + 600).includes('saveThreads()'), 'Android 建完会话没立刻保存')

  const apiStart = API.indexOf('sid: await createSession(signal)')
  assert.ok(apiStart !== -1, '没找到 Electron 建会话的位置')
  assert.ok(API.slice(apiStart, apiStart + 400).includes('saveThreads()'), 'Electron 建完会话没立刻保存')
})
