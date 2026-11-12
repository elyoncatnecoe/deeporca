import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 批次 2（取消语义收口）的回归测试：T-04 ~ T-09。
 *
 * 这一批改的全是「点了停止之后会发生什么」：
 *   T-04 停止落在 tool_calls 流式中途 → 下一轮请求 400，用户下一条发不出去；
 *   T-05 写入层没有 abort 守卫 → 停止后仍然写库、仍然落媒体；
 *   T-06 break 之后的收尾没包守卫 → 停止后仍然记账（摘要/记忆/压缩/用量）；
 *   T-07 媒体生成的取消没打通 → isMediaAbort 零调用；
 *   T-08 全局状态没有归属判断 → 旧轮收尾把新轮状态清掉，新轮停不下来；
 *   T-09 本地指令 / 离线回复不进取消 → 停止后照样补一条回复。
 *
 * 写法沿用 test/ui-feedback.test.ts：engine 依赖 IndexedDB 与 Capacitor，
 * node 里跑不起来，所以断言「剥掉注释后的源码结构」。这不是端到端测试。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

/** 去掉注释（CRLF 也要能剥，见 test/sending-state.test.ts 的说明）。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

const engine = read('src/lib/engine.ts')
const engineCode = stripComments(engine)
const mediaTools = read('src/lib/media-tools.ts')
const mediaApi = read('src/lib/media-api.ts')

/* ------------------------------------------------------------------ */
/* T-04：停止时不许把半截 tool_calls 写进消息                            */
/* ------------------------------------------------------------------ */

test('T-04：停止的那一轮把 toolCalls 丢掉（半截 tool_calls 会让下一轮 400）', () => {
  assert.match(
    engineCode,
    /const usableToolCalls = result\.aborted \|\| result\.toolCalls\.length === 0\s*\?\s*undefined\s*:\s*result\.toolCalls/,
    'tool_calls 必须按 result.aborted 清空：只有名字、没有配对的 role:tool 响应，服务端直接 400',
  )
  assert.match(engineCode, /toolCalls: usableToolCalls,/, 'assistant 消息要写清空后的结果')
  assert.doesNotMatch(
    engineCode,
    /toolCalls: result\.toolCalls\.length > 0 \? result\.toolCalls : undefined/,
    '旧的「只要有就写」写法必须消失',
  )
  assert.match(engineCode, /usableToolCalls !== undefined/, 'workspaceName 标签也要跟着一起丢掉')
})

/* ------------------------------------------------------------------ */
/* T-05：写入层补 abort 守卫                                            */
/* ------------------------------------------------------------------ */

test('T-05：工具循环里停止后要给未执行的调用补一条 tool 消息（保持配对）', () => {
  const loop = engineCode.slice(engineCode.indexOf('for (const call of result.toolCalls)'))
  assert.match(loop, /if \(signal\.aborted\) \{/, '工具循环开头要有 abort 判断')
  assert.match(loop, /role: 'tool',/, '停止后仍要落一条 role:tool，否则配对断了又变成 T-04')
  assert.match(loop, /已停止，这个工具没有执行/, '占位文案要说明是停止而不是失败')
  assert.match(loop, /await useAppStore\.getState\(\)\.actions\.appendMessage\(skipped\)/, '占位消息必须落库，下一轮是从库里重建请求的')
})

test('T-05：新一轮循环开始前先看 signal', () => {
  assert.match(
    engineCode,
    /while \(iteration < MAX_TOOL_ITERATIONS\) \{\s*if \(signal\.aborted\) break/,
    '停止之后不要再发起下一轮请求',
  )
})

test('T-05：停止后不写媒体字节', () => {
  assert.match(engineCode, /if \(mediaDrafts\.length > 0 && !signal\.aborted\)/, '媒体落库条件要带 abort 守卫')
})

/* ------------------------------------------------------------------ */
/* T-06：break 之后的收尾也要包守卫                                      */
/* ------------------------------------------------------------------ */

test('T-06：停止后不再记账（摘要 / 记忆 / 压缩）', () => {
  const marker = engineCode.indexOf('if (signal.aborted) return { spoke: lastAssistantId !== null }')
  const bump = engineCode.indexOf('actions.bumpConversation({\n      summary: lastReply')
  assert.ok(marker > 0, '停止后要提前返回，跳过收尾')
  assert.ok(bump > marker, '这条提前返回必须排在 bumpConversation 之前')
  assert.match(engineCode, /if \(settings\.autoCompress\) void maybeCompress/, '压缩入口还在（只是被上面那句挡掉了）')
})

test('T-06：停止后不再写用量表', () => {
  assert.match(engineCode, /if \(!signal\.aborted\) \{\s*\n\s*if \(result\.usage\) \{/, 'addUsage 要包在 abort 守卫里')
})

test('T-06：void 出去的异步任务都有 catch', () => {
  assert.match(engineCode, /\}\)\.catch\(\(\) => undefined\)/, 'detectRepeatedMemories 这类 void promise 必须兜住，否则会变成 unhandled rejection')
})

/* ------------------------------------------------------------------ */
/* T-07：媒体生成的取消                                                 */
/* ------------------------------------------------------------------ */

test('T-07：生图 / 语音回来时先看 signal，取消了就不当成功', () => {
  const image = mediaTools.slice(mediaTools.indexOf('async function runGenerateImage'), mediaTools.indexOf('async function runSpeak'))
  const speak = mediaTools.slice(mediaTools.indexOf('async function runSpeak'))
  assert.match(image, /if \(context\.signal\?\.aborted === true\)/, '生图返回后要复查 signal')
  assert.match(image, /这次生图被取消/, '文案要说清是取消，不是失败')
  assert.match(speak, /if \(context\.signal\?\.aborted === true\)/, '语音返回后同样要复查')
  assert.match(speak, /这次语音生成被取消/, '语音也要有取消文案')
})

test('T-07：取消异常不再被当成普通失败文本', () => {
  const uses = (mediaTools.match(/isMediaAbort\(error\)/g) ?? []).length
  assert.ok(uses >= 2, `生图和语音的 catch 都要认 isMediaAbort，实际 ${uses} 处`)
  assert.match(mediaApi, /export function isMediaAbort\(error: unknown\): boolean/, 'isMediaAbort 必须仍然导出')
  assert.match(mediaTools, /isMediaAbort[^\n]*from '\.\/media-api/, 'media-tools 要把 isMediaAbort 导进来（以前全仓零调用）')
})

/* ------------------------------------------------------------------ */
/* T-09：本地指令 / 离线回复纳入取消                                     */
/* ------------------------------------------------------------------ */

test('T-09：本地指令与离线回复接收 signal，并在写回复前判断', () => {
  for (const name of ['async function runLocalCommand', 'async function runOfflineReply']) {
    const start = engineCode.indexOf(name)
    assert.ok(start > 0, `找不到 ${name}`)
    const body = engineCode.slice(start, start + 2600)
    assert.match(body, /signal: AbortSignal/, `${name} 要接收本轮 signal`)
    assert.match(body, /if \(signal\.aborted\) return true/, `${name} 停止后不要再补回复`)
  }
})

test('T-09：sendMessage 的准备阶段在主 try 里，异常由统一 finally 释放', () => {
  const start = engineCode.indexOf('export async function sendMessage')
  const end = engineCode.indexOf('export async function sendGroupMessage', start)
  const body = engineCode.slice(start, end === -1 ? undefined : end)
  const tryAt = body.indexOf('try {')
  const finallyAt = body.indexOf('} finally {')
  assert.ok(tryAt > 0 && finallyAt > tryAt, '主 try/finally 要能找到')
  /*
   * 准备阶段（本地指令 / 离线回复 / 网页账号登录）自己不管 busy，全部放在主 try 里；
   * 任何一步抛错都由同一个 finally 释放 —— 这是二审 P1 的修法：不再按分支补 endTurn，
   * 否则总有一条路会漏（上次漏的就是 `await loginWebChat()`）。
   */
  const prepare = body.slice(tryAt, finallyAt)
  for (const anchor of ['runLocalCommand(', 'runOfflineReply(', 'ensureWebChatLogin(']) {
    assert.ok(prepare.includes(anchor), `${anchor} 必须在主 try 里，否则它抛错时没人释放这一轮`)
  }
  assert.equal(
    (body.match(/endTurn\(turn\)/g) ?? []).length,
    1,
    '释放只留 finally 一处，准备阶段不许再有零散的 endTurn 补丁',
  )
})

test('T-09：本地路径不再自己抢 busy（会和 beginTurn 打架）', () => {
  for (const name of ['async function runLocalCommand', 'async function runOfflineReply']) {
    const start = engineCode.indexOf(name)
    const body = engineCode.slice(start, start + 2600)
    assert.doesNotMatch(body, /^\s*busy = true\s*$/m, `${name} 不该自己置位 busy，那会提前放掉调用方占的那一份`)
    assert.doesNotMatch(body, /^\s*busy = false\s*$/m, `${name} 不该自己复位 busy`)
  }
})

/* ------------------------------------------------------------------ */
/* T-15：33ms debounce timer 泄漏                                       */
/* ------------------------------------------------------------------ */

test('T-15：流式请求无论成功、抛错还是被 abort 都要收掉 debounce 定时器', () => {
  const at = engineCode.indexOf('.finally(() => {')
  assert.ok(at > 0, 'streamChat 的 promise 上要挂 finally：以前只有正常返回那条路会走到 flush()')
  const block = engineCode.slice(at, at + 900)
  assert.match(block, /window\.clearTimeout\(timer\)/, 'finally 里要清 timer')
  assert.match(block, /pendingFlush = false/, 'finally 里要复位 pendingFlush')
  assert.match(block, /bodyMind\.drainEvents\(\)/, '被跳过的身体事件也要清，别带进下一轮')
})

/* ------------------------------------------------------------------ */
/* 顺序约束：T-04 必须先于 T-05（否则守卫会制造新的孤儿 tool_calls）      */
/* ------------------------------------------------------------------ */

test('T-04 与 T-05 成对存在：先清空 toolCalls，再给未执行的调用补占位', () => {
  const t04 = engineCode.indexOf('const usableToolCalls')
  const t05 = engineCode.indexOf("content: '已停止，这个工具没有执行。'")
  assert.ok(t04 > 0 && t05 > 0, '两条补丁都要在')
  assert.ok(t04 < t05, 'T-04 的位置在消息构造处，T-05 在工具循环处，顺序必须是这样')
})
