import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 结构性回归测试：守住「不会永久卡死」的几条不变量。
 *
 * 这些不是纯粹的实现细节 —— 它们对应的都是用户能直接感知的事故：
 *   - P0-2：busy 泄漏后发送键永远停在「停止」，只能重启；
 *   - P1-4：MCP 请求没有超时/取消，一台服务器挂住就整轮卡死；
 *   - P1-5：网页账号「停止」不生效，最长要等 180 秒；
 *   - P1-6：启动失败永久停在开屏画面。
 *
 * 之所以用源码断言而不是跑一遍：engine/store 依赖 IndexedDB 与 Capacitor，
 * 在 node 里跑不起来；而这几条不变量恰好都能在源码结构上说清楚。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

/**
 * 去掉行注释与块注释，避免注释里的字眼被当成代码。
 *
 * 按 /\r?\n/ 切行，不是 split('\n')：Windows 检出（core.autocrlf=true）拿到的是 CRLF，
 * 行尾的 \r 会让 `.*$` 匹配不上（\r 在 JS 正则里算行终止符，$ 又只认字符串末尾），
 * 于是整行注释原样留下 —— 注释里解释规矩的那些字眼就会被当成真的代码。
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

const engine = read('src/lib/engine.ts')
const webChat = read('src/lib/web-chat.ts')
const mcp = read('src/lib/mcp.ts')
const store = read('src/lib/store.ts')

test('P0-2 / T-08：五个入口都是「先 beginTurn 占位、再做 await」', () => {
  const code = stripComments(engine)
  const entries = [
    'export async function sendMessage',
    'export async function sendGroupMessage',
    'export async function continueTurn',
    'export async function regenerateAtMessage',
    'export async function editAndResend',
  ]
  for (const name of entries) {
    const start = code.indexOf(name)
    assert.ok(start > 0, `找不到 ${name}`)
    const body = code.slice(start, start + 2600)
    const claim = body.indexOf('beginTurn()')
    const guard = body.indexOf('if (turn === null)')
    const firstAwait = body.indexOf('await ')
    assert.ok(claim > 0, `${name} 必须用 beginTurn() 占住「正在发送」`)
    assert.ok(guard > claim, `${name} 占位失败（已有一轮在跑）时必须直接退出`)
    assert.ok(firstAwait === -1 || claim < firstAwait, `${name} 必须先占住 busy 再 await，否则双击能开出两轮`)
  }
})

test('P0-2 / T-08：beginTurn 与 endTurn 成对出现，busy / activeAbort 只在 turnGate 里改', () => {
  const code = stripComments(engine)
  const begins = (code.match(/= beginTurn\(\)/g) ?? []).length
  const ends = (code.match(/endTurn\(turn\)/g) ?? []).length
  assert.ok(begins >= 5, `五个入口都要占位，实际只有 ${begins} 处`)
  // 早退分支不再各自补 endTurn（准备阶段已并入主 try），所以两边应当一样多。
  assert.equal(ends, begins, `endTurn（${ends}）必须和 beginTurn（${begins}）一样多`)
  /*
   * 核心不变量：engine 里不许再直接碰 busy / activeAbort。
   * 它们搬进了 src/lib/turn-gate.ts —— 那里才有归属判断，也才能写行为测试。
   * 散在 engine 里的 `busy = false` 就是「旧轮收尾把新轮状态清掉」的来源。
   */
  assert.doesNotMatch(code, /^\s*activeAbort = /m, 'activeAbort 只许在 turn-gate.ts 里改')
  assert.doesNotMatch(code, /^\s*busy = /m, 'busy 只许在 turn-gate.ts 里改')

  const gate = stripComments(read('src/lib/turn-gate.ts'))
  assert.match(gate, /begin\(\): Turn \| null \{/, '占位逻辑在 turnGate.begin 里')
  assert.match(gate, /if \(activeAbort !== turn\.abort\) return false/, '归属判断在 turnGate.end 里')
})

test('P0-2：每一处置位都要有对应的复位', () => {
  const raised = (engine.match(/\bbusy = true\b/g) ?? []).length
  const cleared = (engine.match(/\bbusy = false\b/g) ?? []).length
  assert.ok(cleared >= raised, `busy = false 只有 ${cleared} 处，少于 busy = true 的 ${raised} 处`)
})

test('P0-2：「停止」在没有请求在跑时也能强制复位', () => {
  assert.match(engine, /function resetSendingState\(\)/)
  assert.match(engine, /if \(turnGate\.isBusy\(\)\) resetSendingState\(\)/)
  assert.match(engine, /turnGate\.abortCurrent\(\)/, '停止优先走「中止当前这一轮」')
})

test('P1-4：本轮对话的 signal 一路传到 MCP 工具调用', () => {
  // 第 5 个参数是「这个调用的参数被输出上限截断了，不能执行」（B6）。
  // 这条只守「signal 与工坊项目有没有传」，所以允许后面再跟参数。
  assert.match(engine, /runTool\(call, conversationId, signal, workspaceId(?:\s*,[^)]*)?\)/, 'engine 调 runTool 时要传本轮 signal 和工坊项目')
  assert.match(engine, /callToolByName\(call\.function\.name, args, signal\)/, 'runTool 要把 signal 交给 MCP')
  assert.match(mcp, /const MCP_CALL_TIMEOUT_MS = \d+/, 'MCP 调用必须有超时')
  assert.match(mcp, /linkAbort\(signal, timeoutMs\)/, 'HTTP 请求要同时接超时与取消')
  assert.match(mcp, /raceAbort\(bridge\.mcpStdioRequest/, 'stdio 的 IPC 往返也要能被取消')
})

test('P1-5：网页账号的两条路都接了 abort', () => {
  const listeners = (webChat.match(/addEventListener\('abort'/g) ?? []).length
  assert.ok(listeners >= 2, `sendViaHttp 与 sendViaAndroidHttp 各要挂一个 abort 监听，实际 ${listeners} 处`)
  assert.ok((webChat.match(/webApiAbort/g) ?? []).length >= 2, '停止时要通知原生把连接掐掉')
})

test('P1-6：启动失败也要放开界面，并给出原因', () => {
  assert.match(store, /bootError/, 'store 要记住启动失败的原因')
  assert.match(store, /failBoot\(message\)/, '要有「彻底失败」的出口')
  const bootBody = store.slice(store.indexOf('async boot()'), store.indexOf('failBoot(message)'))
  assert.match(bootBody, /ready: true,/, 'boot 里必须把 ready 置真（否则永久停在开屏画面）')
  assert.match(bootBody, /bootError,/, '开机时要带上失败原因')
})
