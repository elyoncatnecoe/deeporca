import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isCompleteToolArguments } from '../src/lib/budget.ts'

/**
 * 半截工具参数不许执行（修复 B6）。
 *
 * 现场：流被输出上限切断时，arguments 常常只剩半截 ——「写到一半的 index.html」。
 * 这种东西一旦真被执行，等于用品残内容覆盖工坊里原本好好的文件，比不写糟糕得多；
 * 而且模型看到「已写入」，下一轮就照着这个假事实继续说。
 * 现在定稿时校验一次 JSON，解析不了的只回一句「参数被截断，请重新调用」。
 */

const DEEPSEEK = readFileSync('src/lib/deepseek.ts', 'utf8')
const ENGINE = readFileSync('src/lib/engine.ts', 'utf8')
const WORKSPACE = readFileSync('src/lib/workspace.ts', 'utf8')
const PROTOCOLS = readFileSync('src/lib/protocols.ts', 'utf8')

test('参数完整性判定：合法 JSON / 空串过，半截与垃圾不过', () => {
  assert.equal(isCompleteToolArguments('{"path":"index.html","content":"<h1>hi</h1>"}'), true)
  assert.equal(isCompleteToolArguments('{}'), true, '空参数是合法的 JSON（会不会执行由工具自己判）')
  assert.equal(isCompleteToolArguments(''), true, '空串按 {} 处理')
  assert.equal(isCompleteToolArguments(undefined), false, '压根没收到参数不算完整')
  assert.equal(isCompleteToolArguments('{"path":"index.html","content":"<h1>'), false, '半截 JSON 必须判不完整')
  assert.equal(isCompleteToolArguments('{"content": '), false)
  assert.equal(isCompleteToolArguments('not json at all'), false)
  // 只接受对象/数组以外的 JSON 标量也是「不完整」吗？—— 不：能解析就交给工具自己判，
  // 这里只挡「解析不了」这一种，别把判定扩大成 schema 校验。
  assert.equal(isCompleteToolArguments('"just a string"'), true)
})

test('定稿时校验参数，半截的标出来但不发给 onToolCall', () => {
  assert.ok(DEEPSEEK.includes('isCompleteToolArguments(args)'), 'finalizeTools 没有校验参数')
  assert.ok(DEEPSEEK.includes('truncatedToolCallIds'), 'StreamResult 没有把截断的调用交给上层')
  // 截断的那条要留在 calls 里（tool_calls 与 tool 结果必须配对），但不能被当成一次真调用推给上层。
  const finalize = DEEPSEEK.slice(DEEPSEEK.indexOf('function finalizeTools'), DEEPSEEK.indexOf('/** One non-streaming'))
  assert.ok(finalize.includes('truncatedIds.push(call.id)'), '没有记录截断的调用 id')
  assert.ok(
    finalize.indexOf('truncatedIds.push') < finalize.indexOf('handlers?.onToolCall'),
    '半截参数还是会以 onToolCall 推给上层',
  )
})

test('引擎对半截参数只回说明，一次 executeTool 都不进', () => {
  assert.ok(ENGINE.includes('if (argsTruncated)'), 'runTool 没有截断闸门')
  assert.ok(ENGINE.includes('result.truncatedToolCallIds.indexOf(call.id) !== -1'), '引擎没把判定传给 runTool')
  const gate = ENGINE.slice(ENGINE.indexOf('async function runTool'), ENGINE.indexOf('/**\n * 重新生成某条助手消息'))
  assert.ok(
    gate.indexOf('if (argsTruncated)') < gate.indexOf('executeTool(call.function.name'),
    'executeTool 排在闸门之前，半截参数可能被执行',
  )
  assert.ok(gate.includes('没有执行'), '没有告诉模型这次没执行')
  assert.ok(gate.includes('请重新调用'), '没有让模型重新发起调用')
  // 另一半现场：Anthropic 以前在 content_block_start 就发 arguments:'{}'，
  // 于是每个 write_file 都带着空参真的跑进 workspace.ts，抛「content 必须是字符串」。
  // 这条要等 pending-b §2 落到 protocols.ts（那个文件现在由 task-1 持有）。
})

test('工坊层自己的兜底还在：参数解析不了就在写入之前抛，不碰文件', () => {
  const parse = WORKSPACE.slice(WORKSPACE.indexOf('function parseArgs'), WORKSPACE.indexOf('export async function executeTool'))
  assert.ok(parse.includes('throw new Error'), 'parseArgs 不合法时没有抛错')
  assert.ok(parse.includes('工具参数不是合法 JSON'))
  // executeTool 第一行就解析，写入在后面：顺序倒了就等于「非法参数已经落盘才报错」。
  const exec = WORKSPACE.slice(WORKSPACE.indexOf('export async function executeTool'))
  assert.ok(exec.indexOf('parseArgs(rawArgs)') >= 0, 'executeTool 没有解析参数')
  assert.ok(
    exec.indexOf('parseArgs(rawArgs)') < exec.indexOf('await writeWorkspaceFile'),
    '解析要排在写入之前，否则非法参数已经落盘了',
  )
  assert.ok(WORKSPACE.includes("typeof args.content !== 'string'"), 'content 类型没校验（空参 write_file 的来源）')
})

test('Anthropic 不许在 content_block_start 就交出可执行参数', { skip: '等 _tmp/pending-b.md §2 落到 protocols.ts（task-1 完成后由我应用）' }, () => {
  // 现场：那一行发的是 arguments: JSON.stringify(block.input ?? {})，此刻 input 恒为空对象，
  // 于是每个 write_file 都带 '{}' 真的跑进 executeTool，抛「content 必须是字符串」。
  const start = PROTOCOLS.slice(PROTOCOLS.indexOf("case 'content_block_start'"))
  assert.ok(!start.includes('arguments: JSON.stringify(block.input'), '又回到「开块即空参」')
})
