import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 回归测试：中继脚本里两个踩过的坑。
 *
 * 1. 「一直显示正在思考」——以前用「停止按钮消失」判断回复结束，
 *    但思考阶段本来就没有停止按钮，于是正文一出来就误判结束；
 *    某些版本又一直挂着停止按钮，导致永远不结束。现在改成「正文稳定 N 次」。
 * 2. 「思考混进正文 / 思考链看不到」——思考块和正文是同级节点，
 *    按序号取会把思考算进正文。现在按「是否落在思考容器里」区分。
 */

const SOURCE = readFileSync('src/lib/web-relay.ts', 'utf8')

test('结束判定不依赖停止按钮，改用正文稳定计数', () => {
  assert.ok(SOURCE.includes('stableTicks'), '缺少稳定计数')
  assert.ok(SOURCE.includes('STABLE_TICKS'), '缺少稳定阈值')
  assert.ok(
    !/aria-label\*="stop"/.test(SOURCE),
    '不应再用停止按钮判断结束（思考阶段没有这个按钮）',
  )
})

test('正文读取会排除思考容器', () => {
  assert.ok(SOURCE.includes('insideReasoning'), '缺少 insideReasoning 判定')
  // readLatest 里必须调用它，否则思考会混进正文。
  const start = SOURCE.indexOf('function readLatest')
  const end = SOURCE.indexOf('function insideReasoning')
  const body = SOURCE.slice(start, end)
  assert.ok(body.includes('insideReasoning'), 'readLatest 没有排除思考块')
})

test('思考块按 baselineReasoning 之后取，不串上一轮', () => {
  assert.ok(SOURCE.includes('baselineReasoning'), '缺少思考块基线')
  const start = SOURCE.indexOf('function readReasoning')
  const body = SOURCE.slice(start, start + 900)
  assert.ok(body.includes('j = baselineReasoning'), 'readReasoning 没有从基线开始')
})

test('设定去重标记要跨页面重载（存 localStorage，不是闭包变量）', () => {
  // 踩过的坑：标记只活在闭包里，App 一退出（WebView 重建 → 页面重载 → 脚本重新注入）
  // 就丢，同一段网页对话又被灌一遍人设。
  assert.ok(SOURCE.includes('__deepseaCtxSent'), '缺少 localStorage 标记键')
  assert.ok(SOURCE.includes('window.localStorage.getItem(CTX_KEY)'), '没有从 localStorage 读标记')
  assert.ok(SOURCE.includes('window.localStorage.setItem(CTX_KEY'), '没有往 localStorage 写标记')
  assert.ok(!SOURCE.includes('contextSent'), '仍在用只在内存里的 contextSent 标记')
})

test('send 里按「已拼过没」和「是不是空对话」决定拼不拼设定', () => {
  const start = SOURCE.indexOf('var payload = text')
  assert.ok(start !== -1, '没找到 send 里的 payload 组装')
  const body = SOURCE.slice(start, start + 900)
  assert.ok(body.includes('readSentContext()'), '没有比对已拼过的设定')
  assert.ok(body.includes('conversationIsEmpty()'), '没有判断是不是新对话')
  assert.ok(body.includes('writeSentContext'), '拼完没有记下标记')
})

test('setContext 只记文本，不再无条件重置标记', () => {
  const start = SOURCE.indexOf('setContext: function')
  const body = SOURCE.slice(start, start + 500)
  assert.ok(body.includes('ctxPrefix = text'), 'setContext 没有记下文本')
  assert.ok(
    !body.includes('contextSent = false'),
    'setContext 还在重置标记，上层每轮同步一次设定就会让人设被重复灌入',
  )
})

test('发送后会主动清空输入框（不能只靠网页自己清）', () => {
  // 踩过的坑：用原生 setter 写进去的值没进 React 状态，网页自己「清空」时
  // 清的是它以为的空值，用户刚发出去的话就留在输入框里了。
  assert.ok(SOURCE.includes('function clearInput'), '缺少 clearInput')
  const start = SOURCE.indexOf('function send')
  const body = SOURCE.slice(start, start + 2000)
  assert.ok(body.includes('clearInput'), 'send 里没有清空输入框')
})

test('写入编辑器优先用 execCommand，保证 React 收到输入', () => {
  assert.ok(
    SOURCE.includes("execCommand('insertText'"),
    'contenteditable 应优先走 execCommand insertText',
  )
})