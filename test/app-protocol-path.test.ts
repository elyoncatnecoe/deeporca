import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { resolveAppPath } from '../electron/app-protocol-path.ts'

/**
 * `app://` 协议路径校验（任务 3A）。
 *
 * 这一层守的是「任何编码形式都不能越出 dist 目录」。测试直接打 resolveAppPath ——
 * 它是 registerAppProtocol 的全部判断逻辑，main.ts 只负责把结果变成 HTTP 响应。
 *
 * 注意：这是**纯函数逻辑测试**。`%2f` 是否原样到达 Electron 的 protocol.handle
 * 属于 Chromium 行为，需真机验证（见 docs/BATCH1-MANUAL-TEST-PLAN.md）。
 */

const ROOT = path.resolve(tmpdir(), 'deepsea-dist-root')
const inside = (target: string): boolean => {
  const rel = path.relative(ROOT, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

test('3A-1 合法路径继续通过', () => {
  const index = resolveAppPath(ROOT, 'app://deepsea/index.html')
  assert.equal(index.ok, true)
  if (index.ok) assert.equal(index.target, path.join(ROOT, 'index.html'))

  const asset = resolveAppPath(ROOT, 'app://deepsea/assets/app.js')
  assert.equal(asset.ok, true)
  if (asset.ok) {
    assert.equal(asset.target, path.join(ROOT, 'assets', 'app.js'))
    assert.equal(inside(asset.target), true)
  }
})

test('3A-2 根路径映射到 index.html（不是目录本身）', () => {
  const result = resolveAppPath(ROOT, 'app://deepsea/')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.target, path.join(ROOT, 'index.html'))
    assert.equal(result.target.endsWith('index.html'), true)
  }
})

test('3A-3 编码穿越 %2e%2e%2f 必须拒绝', () => {
  const result = resolveAppPath(ROOT, 'app://deepsea/%2e%2e%2fdist-other/secret.txt')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'escape')
})

test('3A-4 混合编码穿越（分隔符编码 + 普通路径段）必须拒绝', () => {
  const variants = [
    'app://deepsea/assets%2f..%2f..%2fsecret.txt',
    'app://deepsea/assets/..%2f..%2fsecret.txt',
    'app://deepsea/..%2fdist-other/secret.txt',
    'app://deepsea/a%2f%2e%2e%2f%2e%2e%2fsecret.txt',
  ]
  for (const url of variants) {
    const result = resolveAppPath(ROOT, url)
    assert.equal(result.ok, false, `${url} 必须被拒绝`)
    if (!result.ok) assert.equal(result.reason, 'escape', `${url} 的拒绝原因应是 escape`)
  }
})

test('3A-5 双重编码：只解一次，解出来的 %2e 是文件名而不是穿越', () => {
  // %252e%252e%252f → 一次 decode → "%2e%2e%2f"（字面量），不是 ".."
  const result = resolveAppPath(ROOT, 'app://deepsea/%252e%252e%252fsecret.txt')
  assert.equal(result.ok, true, '单次解码后不含 ..，应视为普通文件名')
  if (result.ok) assert.equal(inside(result.target), true, '无论如何必须留在 root 内')
})

test('3A-6 字面 .. 会被 URL 解析器折叠，结果仍在 root 内', () => {
  // 解析器把 /a/../../secret.txt 折成 /secret.txt，因此不会越界。
  const result = resolveAppPath(ROOT, 'app://deepsea/a/../../secret.txt')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(inside(result.target), true)
    assert.equal(result.target, path.join(ROOT, 'secret.txt'))
  }
})

test('3A-7 非法百分号编码必须拒绝（不能让请求静默失败）', () => {
  for (const url of ['app://deepsea/100%', 'app://deepsea/%E0%A4%A']) {
    const result = resolveAppPath(ROOT, url)
    assert.equal(result.ok, false, `${url} 应被拒绝`)
    if (!result.ok) assert.equal(result.reason, 'decode')
  }
})

test('3A-8 错误 host / 错误协议必须拒绝', () => {
  const wrongHost = resolveAppPath(ROOT, 'app://evil/index.html')
  assert.equal(wrongHost.ok, false)
  if (!wrongHost.ok) assert.equal(wrongHost.reason, 'host')

  const wrongScheme = resolveAppPath(ROOT, 'https://deepsea/index.html')
  assert.equal(wrongScheme.ok, false)
  if (!wrongScheme.ok) assert.equal(wrongScheme.reason, 'host')

  const lookalike = resolveAppPath(ROOT, 'app://deepsea.evil.com/index.html')
  assert.equal(lookalike.ok, false, '后缀相同的域名不能算自己人')
})

test('3A-9 畸形 URL 必须拒绝', () => {
  const result = resolveAppPath(ROOT, 'not a url')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'malformed')
})

test('3A-10 目录与文件的边界：路径层只判包含，文件判定在 main.ts', () => {
  // 带尾斜杠的目录请求：路径层允许（还在 root 内），是否可读由 main.ts 的
  // statSync().isFile() 决定 —— 目录会被当 404，不会 EISDIR 崩掉。
  const dir = resolveAppPath(ROOT, 'app://deepsea/assets/')
  assert.equal(dir.ok, true)
  if (dir.ok) {
    assert.equal(dir.target, path.join(ROOT, 'assets'))
    assert.equal(inside(dir.target), true)
  }

  // root 自身（relative 为空）这一条在 URL 层到不了：WHATWG 规范把 `.`、`%2e`
  // 都算单点段，解析阶段就折成 `/`（于是映射到 index.html，是合法情况）。
  // 所以这里只断言防护仍然存在 —— 万一将来换了解析器/改了映射规则，它还能兜住。
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron/app-protocol-path.ts'),
    'utf8',
  )
  assert.match(source, /rel === ''/, 'root 自身的防护要保留（防御性）')

  const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron/main.ts'), 'utf8')
  assert.match(main, /isFile\(\)/, 'main.ts 必须有 isFile() 判定，否则目录会 EISDIR')
})
