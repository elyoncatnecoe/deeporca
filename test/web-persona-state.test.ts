import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decidePersona } from '../src/lib/web-persona-state.ts'

/**
 * 网页账号「人设只拼一次」的去重状态机，以及两条链路的失效接线。
 *
 * 二审抓到的状态转换 bug：
 *   1. 开启助手，人设 A 已注入 → 线程缓存 A。
 *   2. 关闭助手，空人设阻止注入，但缓存**没清**，仍是 A。
 *   3. 重新开启助手，人设还是 A。
 *   4. 去重认为「A 已经拼过」→ 跳过 → 网页那边永远用关掉之前的旧设定。
 *
 * 修法：空人设时把缓存清掉（不是删线程/会话/历史），并保证两端都清。
 * 前 5 条是行为测试（直接跑状态机）；后 4 条是接线断言 ——
 * Electron 主进程与 Android 都是原生代码，node 里跑不起来，只能守「有没有接上」。
 */

const ELECTRON_API = readFileSync('electron/deepseek-api.ts', 'utf8')
const ELECTRON_MAIN = readFileSync('electron/main.ts', 'utf8')
const JAVA_API = readFileSync('android/app/src/main/java/com/elyoncat/deepsea/WebApiClient.java', 'utf8')
const JAVA_PLUGIN = readFileSync('android/app/src/main/java/com/elyoncat/deepsea/DeepSeaWebChatPlugin.java', 'utf8')
const RELAY = readFileSync('src/lib/web-relay.ts', 'utf8')
const RELAY_JAVA = readFileSync('android/app/src/main/java/com/elyoncat/deepsea/RelayScript.java', 'utf8')

/** 模拟一次「发送成功」：只有成功之后才把 cache 记下来。 */
function send(cached: string, persona: string): { injected: boolean; cached: string } {
  const decision = decidePersona(cached, persona)
  return { injected: decision.inject, cached: decision.inject ? decision.cache : cached }
}

/* ------------------------------------------------------------------ 行为 */

test('状态转换：开 A → 关 → 再开 A，必须重新注入 A', () => {
  let cached = ''

  // 1. 开启助手，人设 A：注入，成功后缓存 A。
  let step = send(cached, '你是「深鲸」，一只虎鲸。')
  assert.equal(step.injected, true, '第一轮就该注入')
  cached = step.cached
  assert.equal(cached, '你是「深鲸」，一只虎鲸。')

  // 2. 关闭助手：推下来的是空人设。不注入，但**缓存必须清空**。
  const cleared = decidePersona(cached, '')
  assert.equal(cleared.inject, false, '关掉助手时不该注入')
  assert.equal(cleared.cache, '', '关掉助手时缓存没清 —— 再打开同一个助手就会被永久跳过')
  cached = cleared.cache

  // 3. 重新开启助手，人设与关闭前一模一样：必须重新注入。
  step = send(cached, '你是「深鲸」，一只虎鲸。')
  assert.equal(step.injected, true, '重新开启后没有重新注入 —— 这就是二审抓到的问题')
  cached = step.cached

  // 4. 再发一条，人设没变：不重复注入。
  step = send(cached, '你是「深鲸」，一只虎鲸。')
  assert.equal(step.injected, false, '同一版人设不该每条消息都灌一遍')
  assert.equal(step.cached, cached)
})

test('改人设会重新注入，改回原样也会（因为缓存是最后一次真的发出去的那版）', () => {
  let step = send('', 'A')
  assert.equal(step.injected, true)
  step = send(step.cached, 'B')
  assert.equal(step.injected, true, '换人设没重新注入')
  step = send(step.cached, 'A')
  assert.equal(step.injected, true, '改回 A 也该重新注入（缓存此刻是 B）')
})

test('空人设是幂等的：连着来几次都不会注入，缓存一直是空', () => {
  const first = decidePersona('A', '')
  const second = decidePersona(first.cache, '')
  assert.deepEqual(first, { inject: false, cache: '' })
  assert.deepEqual(second, { inject: false, cache: '' })
})

test('只有空白字符的人设按空处理（清缓存），不能当成「有设定」', () => {
  assert.deepEqual(decidePersona('A', '   \n\t '), { inject: false, cache: '' })
})

test('人设前后空白不影响判重（否则同一个人设会因为首尾空格被反复注入）', () => {
  assert.deepEqual(decidePersona('A', '  A  '), { inject: false, cache: 'A' })
})

/* ------------------------------------------------------------------ 接线 */

test('Electron：发消息时用同一套规则，且空人设在发送路径上就把标记清掉', () => {
  assert.ok(ELECTRON_API.includes("from '../src/lib/web-persona-state'"), 'deepseek-api 没用共享的状态机')
  assert.ok(ELECTRON_API.includes('decidePersona(thread.persona, persona)'), 'needPersona 还是自己算的')
  assert.ok(ELECTRON_API.includes('thread.persona = decision.cache'), '成功后没记 decision.cache')
  // 空人设必须在这一轮就清（不能只靠 setContext 那条 IPC）
  assert.ok(
    ELECTRON_API.includes("if (persona === '' && thread.persona !== decision.cache)"),
    '发送路径上没清空人设的标记 —— 只靠 setContext 的话，网页窗关着时漏清',
  )
  assert.ok(ELECTRON_API.includes('export function clearPersonaCache()'), '缺少清缓存的入口')
  // 只清 persona，不许把线程/会话一起删掉（切到下一个顶层声明为止，别把后面的代码算进来）
  const from = ELECTRON_API.indexOf('export function clearPersonaCache()')
  const rest = ELECTRON_API.slice(from + 10)
  const nextDecl = rest.search(/\nexport (async )?function |\nfunction /)
  const body = nextDecl === -1 ? rest : rest.slice(0, nextDecl)
  assert.ok(body.includes("thread.persona = ''"), '没有清 persona')
  assert.ok(!body.includes('threadMap.delete'), '清缓存把线程删了 —— 会话 id 和历史会一起丢')
})

test('Electron：空人设要在「网页窗没开就返回」之前清缓存', () => {
  const start = ELECTRON_MAIN.indexOf("trustedHandle('webchat:context'")
  assert.ok(start !== -1, '找不到 webchat:context 处理器')
  const end = ELECTRON_MAIN.indexOf('trustedHandle(', start + 10)
  const handler = ELECTRON_MAIN.slice(start, end === -1 ? undefined : end)
  const clearAt = handler.indexOf('clearPersonaCache()')
  const earlyReturn = handler.indexOf('if (win === null) return')
  assert.ok(clearAt !== -1, '空人设时没有清 HTTP 链路的缓存')
  assert.ok(earlyReturn !== -1, '找不到窗口未打开时的早退')
  assert.ok(clearAt < earlyReturn, '清缓存放在早退之后 —— 网页窗关着时根本执行不到')
})

test('Android：WebApiClient 有同样的清缓存入口，且只清 persona', () => {
  assert.ok(JAVA_API.includes('static void clearPersonaCache()'), 'WebApiClient 缺少 clearPersonaCache')
  const start = JAVA_API.indexOf('static void clearPersonaCache()')
  const body = JAVA_API.slice(start, start + 600)
  assert.ok(body.includes('thread.persona = ""'), '没有清 persona')
  assert.ok(!body.includes('THREADS.remove'), '清缓存把线程删了')
  assert.ok(body.includes('saveThreads()'), '清完没有落盘 —— 重启后旧缓存还在')
})

test('Android：发送路径上也清空人设的标记（不只靠插件那条 IPC）', () => {
  assert.ok(
    JAVA_API.includes('if (persona.isEmpty() && !thread.persona.isEmpty())'),
    'WebApiClient 发送时没清空人设的标记',
  )
  const start = JAVA_API.indexOf('if (persona.isEmpty() && !thread.persona.isEmpty())')
  const body = JAVA_API.slice(start, start + 260)
  assert.ok(body.includes('thread.persona = ""'), '没清 persona')
  assert.ok(body.includes('saveThreads()'), '清完没落盘')
})

test('Android：插件收到空人设时调用它', () => {
  const start = JAVA_PLUGIN.indexOf('public void setContext(PluginCall call)')
  const body = JAVA_PLUGIN.slice(start, start + 700)
  assert.ok(body.includes('WebApiClient.clearPersonaCache()'), '插件没有清 HTTP 链路的缓存')
  assert.ok(body.includes('text.isEmpty()'), '没有按空人设判断')
})

test('DOM 遥控链路：空设定时也清「这一版已经拼过」的标记（含生成的 Java 副本）', () => {
  const setContext = RELAY.slice(RELAY.indexOf('setContext: function'), RELAY.indexOf('refresh: function'))
  assert.ok(setContext.includes("if (text === '') writeSentContext('')"), 'setContext 空文本没清标记')
  const sendBody = RELAY.slice(RELAY.indexOf('var payload = text'), RELAY.indexOf('baseline = answerNodes()'))
  assert.ok(sendBody.includes("writeSentContext('')"), 'send 的空人设分支没清标记')

  // RelayScript.java 是从 web-relay.ts 生成的：不重新生成，Android 就拿不到这段。
  const count = (RELAY_JAVA.match(/writeSentContext/g) ?? []).length
  assert.ok(count >= 4, `生成的 RelayScript.java 里 writeSentContext 只有 ${count} 处，像是没重新生成`)
})
