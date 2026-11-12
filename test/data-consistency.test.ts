import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clampNumber, isKnownProtocol, resolveProtocol } from '../src/lib/normalize.ts'
import { headerLines, parseHeaderLines } from '../src/lib/headers.ts'

/**
 * C 批（数据一致性）回归测试。
 *
 * 覆盖 BUG-REVIEW 里这几条：
 *   - P1-12 网页账号供应商每次冷启动被改写成 openai；
 *   - P1-14 temperature=0 被 `|| 默认值` 吞掉；
 *   - P1-15 「一行一项」文本域加不出第二行 / 请求头敲第一个字符就消失；
 *   - P1-30 删对话/清空对话不清全文索引；
 *   - P1-1/2/3 跨会话污染与并发双击（源码结构断言，原因见文件末尾说明）。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8')

test('P1-12：deepseek-web 是认识的协议，不会被判成脏数据', () => {
  assert.equal(isKnownProtocol('deepseek-web'), true, '不认它的话，网页账号供应商每次冷启动都会被改写成 openai')
  assert.equal(isKnownProtocol('openai'), true)
  assert.equal(isKnownProtocol('anthropic'), true)
  assert.equal(isKnownProtocol('google'), true)
  assert.equal(isKnownProtocol('whatever'), false)
  assert.equal(isKnownProtocol(undefined), false)
  assert.equal(isKnownProtocol(42), false)
})

test('P1-12：settings.ts 用的是共享判定，而不是自己另抄一份清单', () => {
  const settings = read('src/lib/settings.ts')
  assert.match(settings, /resolveProtocol\(item\.protocol, models\)/, '归一化供应商时必须走共享判定')
  assert.equal(
    /const PROTOCOLS: readonly ProviderProtocol\[\] = \['openai', 'anthropic', 'google'\]/.test(settings),
    false,
    '别再在 settings.ts 里抄协议清单 —— 就是它漏掉 deepseek-web 才出的这次事故',
  )
})

test('P1-12：被老版本改坏的网页账号供应商会被认回来', () => {
  // 这就是用户库里真实的样子：名字是「网页账号（免 Key）」，协议却被写成了 openai。
  assert.equal(resolveProtocol('openai', ['deepseek-chat-web']), 'deepseek-web', '模型只有网页模型，就该还原成网页账号')
  assert.equal(resolveProtocol(undefined, ['deepseek-chat-web']), 'deepseek-web')
  // 正常的供应商不能被误伤。
  assert.equal(resolveProtocol('openai', ['deepseek-chat', 'deepseek-reasoner']), 'openai')
  assert.equal(resolveProtocol('anthropic', ['claude-sonnet-4']), 'anthropic')
  assert.equal(resolveProtocol('google', ['gemini-2.5-pro']), 'google')
  // 真不认识的协议仍然回落 openai。
  assert.equal(resolveProtocol('whatever', ['gpt-4o']), 'openai')
})

test('P1-14：temperature=0 不会被悄悄改成 0.7', () => {
  assert.equal(clampNumber(0, 0, 1.5, 0.7), 0)
  assert.equal(clampNumber('0', 0, 1.5, 0.7), 0)
  assert.equal(clampNumber(0.3, 0, 1.5, 0.7), 0.3)
})

test('P1-14：缺失/NaN 仍然回落默认值，越界仍然夹紧', () => {
  assert.equal(clampNumber(Number.NaN, 0, 1.5, 0.7), 0.7)
  assert.equal(clampNumber(undefined, 0, 1.5, 0.7), 0.7)
  assert.equal(clampNumber(9, 0, 1.5, 0.7), 1.5)
  assert.equal(clampNumber(-3, 0, 1.5, 0.7), 0)
})

test('P1-14：memoryTokenBudget=0 走下限而不是回落默认值', () => {
  assert.equal(clampNumber(0, 200, 16000, 800), 200, '0 应该被夹到下限 200，而不是被 || 吞成 800')
  assert.equal(clampNumber(Number.NaN, 200, 16000, 800), 800)
})

test('P1-14：settings.ts 里不再有 `Number(x) || 默认值` 这种吞 0 的写法', () => {
  const settings = read('src/lib/settings.ts')
  assert.equal(/Number\(settings\.[A-Za-z]+\) \|\|/.test(settings), false, '这种写法会把合法的 0 吞掉')
  assert.match(settings, /clampNumber\(settings\.temperature/, 'temperature 必须走 clampNumber')
  assert.match(settings, /clampNumber\(settings\.memoryTokenBudget/, 'memoryTokenBudget 必须走 clampNumber')
})

test('P1-15：请求头解析 —— 冒号没打完的行不生效，但原文能完整回显', () => {
  // 用户刚敲到 "Author"，这时不该有任何请求头生效。
  assert.deepEqual(parseHeaderLines('Author'), {})
  // 补上冒号与值之后才生效。
  assert.deepEqual(parseHeaderLines('Authorization: Bearer abc'), { Authorization: 'Bearer abc' })
  // 多行、空行、带空格的 key 都要认。
  assert.deepEqual(
    parseHeaderLines('X-Title: DeepSea\n\n HTTP-Referer : https://e.com \n坏的'),
    { 'X-Title': 'DeepSea', 'HTTP-Referer': 'https://e.com' },
  )
})

test('P1-15：请求头来回转换不丢内容', () => {
  const headers = { Authorization: 'Bearer abc', 'X-Title': 'DeepSea' }
  assert.deepEqual(parseHeaderLines(headerLines(headers)), headers)
  assert.deepEqual(parseHeaderLines(headerLines({})), {})
})

test('P1-15：三个页面都用 ListTextarea，不再有自己拼 value 的裸 textarea', () => {
  const expected = new Map([
    ['src/components/Providers.tsx', 2],
    ['src/components/Mcp.tsx', 2],
    ['src/components/Assistants.tsx', 1],
  ])
  for (const [file, count] of expected) {
    const source = read(file)
    const used = (source.match(/<ListTextarea/g) ?? []).length
    assert.equal(used, count, `${file} 应该有 ${count} 个 ListTextarea，实际 ${used} 个`)
    // 自由文本的 textarea（人设之类）不受影响，只盯「把数组 join 回去当 value」这种列表形态。
    assert.equal(
      /<textarea[\s\S]{0,300}?value=\{[^}]*\.join\(/.test(source),
      false,
      `${file} 里还有把数组 join 回去当 value 的 textarea —— 行尾回车会被立刻吞掉（BUG-REVIEW P1-15）`,
    )
  }
})

test('P1-15：ListTextarea 自己存草稿，只有切换编辑对象时才用外部值重置', () => {
  const ui = read('src/components/ui.tsx')
  assert.match(ui, /export function ListTextarea/, '共享组件应该在 ui.tsx')
  assert.match(ui, /const \[text, setText\] = useState\(props\.value\)/, '要有本地草稿')
  assert.match(ui, /lastKey\.current === props\.resetKey/, '只在切换对象时重置，否则每次按键都会被写回覆盖')
})

test('P1-30：删对话与清空对话都会清全文索引', () => {
  const db = read('src/lib/db.ts')
  const remove = db.slice(db.indexOf('export async function deleteConversation'), db.indexOf('export async function listMessages'))
  assert.match(remove, /'search'/, 'deleteConversation 的事务里必须带上 search 存储')
  assert.match(remove, /index\('by-conversation'\)/, '要按对话 id 把索引条目删掉')
  const clear = db.slice(db.indexOf('export async function clearConversations'), db.indexOf('export async function addUsage'))
  assert.match(clear, /clear\('search'\)/, '清空对话时全文索引也要清')
})

test('P1-30：开机重建索引时顺手清掉孤儿条目（老数据也能修）', () => {
  const db = read('src/lib/db.ts')
  const rebuild = db.slice(db.indexOf('export async function rebuildSearchIndex'), db.indexOf('export async function listMemories'))
  assert.match(rebuild, /orphans/, '要找出「消息已经删了、索引还留着」的条目')
  assert.match(rebuild, /cleanup\.store\.delete/, '并且真的删掉')
})

test('P1-1：appendMessage 只往「自己那段对话」里塞消息', () => {
  const store = read('src/lib/store.ts')
  const append = store.slice(store.indexOf('async appendMessage(message)'), store.indexOf('async updateMessage('))
  assert.match(append, /state\.activeId === message\.conversationId/, '生成中切走时，旧对话的回复不能进新对话的列表')
})

test('P1-1：摘要/标题按本轮对话 id 落库，不跟着 activeId 走', () => {
  const store = read('src/lib/store.ts')
  const bump = store.slice(store.indexOf('async bumpConversation(patch, conversationId)'), store.indexOf('startLive(conversationId)'))
  assert.match(bump, /conversationId \?\? get\(\)\.activeId/, '显式给了对话 id 就必须用它')
  const engine = read('src/lib/engine.ts')
  const calls = engine.match(/bumpConversation\(\{/g) ?? []
  const withId = engine.match(/bumpConversation\(\{[\s\S]*?\}, conversationId\)/g) ?? []
  assert.ok(calls.length > 0, 'engine 里应该有 bumpConversation 调用')
  assert.equal(withId.length, calls.length, `每一处 bumpConversation 都要带上本轮 conversationId（${withId.length}/${calls.length}）`)
})

test('P1-2：openConversation 有请求代数守卫', () => {
  const store = read('src/lib/store.ts')
  const open = store.slice(store.indexOf('async openConversation(id)'), store.indexOf('async removeConversation('))
  assert.match(open, /openSeq \+= 1/, '每次打开都要推代数')
  assert.match(open, /seq !== openSeq/, '先发后到的结果要作废')
})

test('P1-3：重生成/编辑重发在动库之前就占住 busy', () => {
  const engine = read('src/lib/engine.ts')
  for (const [name, endMarker] of [
    ['export async function regenerateAtMessage', 'export async function editAndResend'],
    ['export async function editAndResend', 'export default'],
  ] as const) {
    const start = engine.indexOf(name)
    const end = engine.indexOf(endMarker, start + 1)
    const body = engine.slice(start, end === -1 ? undefined : end)
    const busyAt = body.indexOf('busy = true')
    const firstAwait = body.indexOf('await ')
    assert.ok(busyAt > 0, `${name} 里应该有 busy = true`)
    assert.ok(busyAt < firstAwait, `${name} 必须先把 busy 占住再 await，否则双击会并发起两轮`)
  }
})

test('P1-1：实时气泡与占位气泡只画给自己那段对话', () => {
  const chat = read('src/components/Chat.tsx')
  assert.match(chat, /live\.conversationId === activeId/, '上一段的半截回复不能跑到当前对话里')
  assert.match(chat, /sendingId === activeId/, '「正在使用工具」的占位也不该跟过去')
})

test('P1-19：往上翻之后不再被拽回底部', () => {
  const chat = read('src/components/Chat.tsx')
  assert.match(chat, /stickToBottom/, '要记住用户是不是贴着底部看')
  assert.match(chat, /distance < 80/, '离底部足够近才算「贴着底部」')
  const pinned = /useEffect\(\(\) => \{\s*const element = scrollRef\.current\s*if \(element === null\) return\s*if \(!stickToBottom\.current\) return/
  assert.match(chat.replace(/\r\n/g, '\n'), pinned, '流式滚动必须先判断要不要跟随')
})