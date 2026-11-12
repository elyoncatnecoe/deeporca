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
 * 于是整行注释原样留下 —— 注释里解释规矩的那句「…三个 await 留在 try 外面…」
 * 就会被当成真的 await，这条守卫在 CRLF 机器上必然误报。
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

test('P0-2：busy 一旦置位，到 try 之间不许有 await', () => {
  const lines = engine.split('\n')
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (/^\s*busy = true\s*$/.test(line)) starts.push(index)
  })
  assert.ok(starts.length >= 3, `发送/重生成/编辑重发三处都该有 busy = true，实际 ${starts.length} 处`)

  for (const start of starts) {
    let tryLine = -1
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^\s*try \{\s*$/.test(lines[index] ?? '')) {
        tryLine = index
        break
      }
    }
    assert.ok(tryLine > start, `第 ${start + 1} 行的 busy = true 之后必须紧跟 try {`)
    // 注释里出现「await」是在解释这条规矩本身，先剥掉注释再判断。
    const between = stripComments(lines.slice(start + 1, tryLine).join('\n'))
    assert.equal(
      /\bawait\b/.test(between),
      false,
      `第 ${start + 1} 行 busy = true 与 try 之间出现 await：异常会直接 reject，busy 永久泄漏\n${between}`,
    )
  }
})

test('P0-2：每一处置位都要有对应的复位', () => {
  const raised = (engine.match(/\bbusy = true\b/g) ?? []).length
  const cleared = (engine.match(/\bbusy = false\b/g) ?? []).length
  assert.ok(cleared >= raised, `busy = false 只有 ${cleared} 处，少于 busy = true 的 ${raised} 处`)
})

test('P0-2：「停止」在没有请求在跑时也能强制复位', () => {
  assert.match(engine, /function resetSendingState\(\)/)
  assert.match(engine, /if \(busy\) resetSendingState\(\)/)
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