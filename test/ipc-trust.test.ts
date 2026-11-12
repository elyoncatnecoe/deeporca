import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isAllowedMainWindowNavigation, isTrustedIpcSenderUrl } from '../electron/trust.ts'

/**
 * IPC / 导航信任边界（任务 3B）。
 *
 * **这是逻辑级测试，不是 Electron 运行时验证。**
 * URL 判断是纯函数，可以直接断言；但「非可信 frame 真的拿不到 IPC」取决于
 * Electron 的 event.senderFrame 行为，node 里无法模拟。那部分由两条补充手段守：
 *   1. 对 main.ts 的结构断言（frame.parent 守卫仍然在、没有 about:* 白名单）；
 *   2. 真机手动验收（见 docs/BATCH1-MANUAL-TEST-PLAN.md 的 IPC 部分）。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const main = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8')

test('3B-1 合法主窗口 URL 通过', () => {
  assert.equal(isTrustedIpcSenderUrl('app://deepsea/index.html'), true)
  assert.equal(isTrustedIpcSenderUrl('app://deepsea/'), true)
  assert.equal(isTrustedIpcSenderUrl('app://deepsea'), true)
})

test('3B-2 非可信外部网站拒绝', () => {
  assert.equal(isTrustedIpcSenderUrl('https://evil.example/'), false)
  assert.equal(isTrustedIpcSenderUrl('http://chat.deepseek.com/'), false, '外部站点一律不认')
  assert.equal(isTrustedIpcSenderUrl('https://deepsea.evil.com/'), false, '名字像也不行')
})

test('3B-3 about:blank 拒绝（这正是批次 1 收紧的那条）', () => {
  assert.equal(isTrustedIpcSenderUrl('about:blank'), false)
})

test('3B-4 about:srcdoc 拒绝', () => {
  assert.equal(isTrustedIpcSenderUrl('about:srcdoc'), false)
})

test('3B-5 其它可疑协议拒绝', () => {
  assert.equal(isTrustedIpcSenderUrl('javascript:alert(1)'), false)
  assert.equal(isTrustedIpcSenderUrl('data:text/html,<script>x</script>'), false)
  assert.equal(isTrustedIpcSenderUrl('file:///C:/Windows/System32/calc.exe'), false)
  assert.equal(isTrustedIpcSenderUrl('app://deepsea/../../../etc/passwd'), true,
    'URL 层只看来源；路径越界由 app-protocol-path 拒绝（见 3A）')
})

test('3B-6 伪造 / 异常 URL 拒绝', () => {
  assert.equal(isTrustedIpcSenderUrl(''), false)
  assert.equal(isTrustedIpcSenderUrl('not a url'), false)
  assert.equal(isTrustedIpcSenderUrl('   '), false)
  assert.equal(isTrustedIpcSenderUrl('app://'), false)
})

test('3B-7 开发地址：只认配置的那个 origin', () => {
  const dev = 'http://localhost:5173'
  assert.equal(isTrustedIpcSenderUrl('http://localhost:5173/index.html', dev), true)
  assert.equal(isTrustedIpcSenderUrl('http://localhost:5174/index.html', dev), false, '端口不同就是不同 origin')
  assert.equal(isTrustedIpcSenderUrl('http://localhost:5173/index.html', ''), false, '没配置 devUrl 时不应放行')
  assert.equal(isTrustedIpcSenderUrl('http://localhost:5173/index.html', undefined), false)
})

test('3B-8 导航白名单同样不放行 about:*', () => {
  assert.equal(isAllowedMainWindowNavigation('app://deepsea/index.html'), true)
  assert.equal(isAllowedMainWindowNavigation('about:blank'), false)
  assert.equal(isAllowedMainWindowNavigation('about:srcdoc'), false)
  assert.equal(isAllowedMainWindowNavigation('https://evil.example/'), false)
})

test('3B-9 结构断言：main.ts 仍保留 frame 级守卫', () => {
  assert.match(main, /frame\.parent !== null/, '子框架必须仍然被挡掉')
  assert.match(main, /isTrustedIpcSenderUrl\(frame\.url/, 'IPC 来源判断必须走抽出来的函数')
  assert.match(main, /function isTrustedSender/, '包装器入口还在')
})

test('3B-10 结构断言：不存在 about:* 白名单后门', () => {
  assert.equal(/raw === 'about:blank'/.test(main), false, '不能再用 about:blank 白名单')
  assert.equal(/=== 'about:srcdoc'/.test(main), false, '不能再用 about:srcdoc 白名单')
})

test('3B-11 结构断言：导航与 IPC 用的是两个函数（不能合并回去）', () => {
  const navigateCalls = main.match(/isAllowedMainWindowNavigation\(/g) ?? []
  assert.ok(navigateCalls.length >= 2, 'will-navigate / will-redirect 都要用导航白名单')
  assert.match(main, /isTrustedIpcSenderUrl/, 'IPC 侧用自己的判断')
})

/* ------------------------------------------------------------------ */
/* 修复 4：导航白名单必须把 DEEPSEA_DEV_URL 传下去                       */
/* ------------------------------------------------------------------ */

test('3B-12 导航白名单接收并使用 devUrl：开发地址放行，其它不放宽', () => {
  const dev = 'http://localhost:5173'

  // 开发环境：合法 localhost 不能被误拦
  assert.equal(isAllowedMainWindowNavigation('http://localhost:5173/index.html', dev), true)
  assert.equal(isAllowedMainWindowNavigation('http://localhost:5173/', dev), true)

  // 边界：同主机不同端口是不同 origin
  assert.equal(isAllowedMainWindowNavigation('http://localhost:5174/', dev), false)
  assert.equal(isAllowedMainWindowNavigation('https://localhost:5173/', dev), false)

  // 生产环境地址在开发模式下依然放行
  assert.equal(isAllowedMainWindowNavigation('app://deepsea/index.html', dev), true)

  // devUrl 不能把外部站点也放进来
  assert.equal(isAllowedMainWindowNavigation('https://evil.example/', dev), false)
  assert.equal(isAllowedMainWindowNavigation('about:blank', dev), false)

  // 没有配置 devUrl 时，localhost 不应被放行（生产行为不能被开发配置污染）
  assert.equal(isAllowedMainWindowNavigation('http://localhost:5173/', undefined), false)
  assert.equal(isAllowedMainWindowNavigation('http://localhost:5173/', ''), false)
})

test('3B-13 结构断言：main.ts 调导航白名单时传了 DEEPSEA_DEV_URL', () => {
  const calls = main.match(/isAllowedMainWindowNavigation\([^)]*\)/g) ?? []
  assert.ok(calls.length >= 2, '至少 will-navigate / will-redirect 两处')
  for (const call of calls) {
    assert.match(call, /DEEPSEA_DEV_URL/, `调用漏传 devUrl：${call}`)
  }
})
