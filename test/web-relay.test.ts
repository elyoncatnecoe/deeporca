import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 中继脚本的两条硬约束，用测试钉住：
 *   1. 必须能被序列化成一段可独立执行的字符串（注入网页时靠这个）；
 *   2. 序列化后的代码里不能出现 import / require / 模块级引用，
 *      否则在 chat.deepseek.com 页面里会直接 ReferenceError。
 *
 * 另外校验 Android 那份生成物跟源文件同步，避免两边漂移。
 */

const SOURCE = readFileSync('src/lib/web-relay.ts', 'utf8')

test('relayBootstrap 不 import 任何东西', () => {
  const start = SOURCE.indexOf('function relayBootstrap(): void {')
  assert.ok(start > 0, '找不到 relayBootstrap')
  const body = SOURCE.slice(start)
  assert.ok(!/^\s*import\s/m.test(body), 'relayBootstrap 里出现了 import')
  assert.ok(!/\brequire\(/.test(body), 'relayBootstrap 里出现了 require')
})

test('relayBootstrap 只引用函数体内的变量（不碰模块级常量）', () => {
  const start = SOURCE.indexOf('function relayBootstrap(): void {')
  const body = SOURCE.slice(start)
  // 这两个是模块级的东西（函数本身和导出的类型），函数体里不该出现。
  for (const name of ['webRelayScript', 'RelayState']) {
    assert.ok(!body.includes(name), `relayBootstrap 引用了模块级标识符 ${name}`)
  }
  // 反向确认：选择器表是函数体内的局部变量，必须在这里定义。
  assert.ok(body.includes('var ANSWER_SELECTORS'), 'ANSWER_SELECTORS 应在函数体内定义')
})

test('生成的中继脚本能被 new Function 解析', async () => {
  // 用 esbuild 转译同一段函数，模拟 Android 生成器的做法。
  const { transformSync } = await import('esbuild')
  const start = SOURCE.indexOf('function relayBootstrap(): void {')
  const braceStart = SOURCE.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = braceStart; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  const body = SOURCE.slice(start, end)
  const js = transformSync(body, { loader: 'ts', target: 'es2019', format: 'esm' })
    .code.trim()
    .replace(/^export\s+/gm, '')
  const source = ';(function(){' + js + ';relayBootstrap();})();'
  assert.doesNotThrow(() => new Function(source))
})

test('Android 的 RelayScript.java 由源文件生成（不是手写）', () => {
  const java = readFileSync('android/app/src/main/java/com/elyoncat/deepsea/RelayScript.java', 'utf8')
  assert.ok(java.includes('__deepseaRelay'), 'Java 副本里没有中继脚本')
  // 生成器会在文件头写明来源；手改过的文件通常会把这句删掉或改掉。
  assert.ok(java.includes('build-relay-java.mjs'), 'Java 副本缺少生成说明')
  assert.ok(java.includes('src/lib/web-relay.ts'), 'Java 副本没有指向源文件')
})