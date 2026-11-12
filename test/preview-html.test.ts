import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// workspace.ts 一路 import 到 db / IndexedDB，内部是无扩展名的 bundler 写法；
// node 的 ESM 解析器不认，给它补上 .ts 才能真跑（同 test/model-vision.test.ts）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})

const { bundleWorkspaceHtml, injectPreviewCsp } = await import('../src/lib/workspace.ts')

/**
 * 工坊预览的 HTML 组装：CSP、资源内联，以及「点击高亮」重置。
 *
 * 2026-11-03 的真机反馈：「工坊里点一下出现一大片半透明浅蓝色蒙版」。
 * 根因是 Android WebView 的默认 tap highlight（系统色 #33b5e5 20% 透明），
 * 而它按文档生效 —— 主界面 body 上那条规则管不到 iframe 里的预览文档。
 * 所以预览页必须自己带一条重置；这里把它锁住，免得以后重构 CSP 时被顺手删掉。
 */

const file = (path: string, content: string, workspaceId = 'default') => ({
  id: `ws:${workspaceId}:${path}`,
  workspaceId,
  path,
  content,
  updatedAt: 0,
})

test('预览 HTML 一定带 tap-highlight 重置（有 CSP meta 的页面也要带）', () => {
  const plain = injectPreviewCsp('<html><head><title>x</title></head><body>hi</body></html>')
  assert.match(plain, /data-deepsea-tap-reset/)
  assert.match(plain, /-webkit-tap-highlight-color:transparent/)

  const withCsp = injectPreviewCsp(
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src none"></head><body>hi</body></html>',
  )
  assert.match(withCsp, /data-deepsea-tap-reset/, '页面自带 CSP 时不能把重置一起跳过')
  assert.equal((withCsp.match(/http-equiv="Content-Security-Policy"/g) ?? []).length, 1, '不能重复注入 CSP')
})

test('没有 head 的片段也能组装出完整文档并带重置', () => {
  const html = injectPreviewCsp('<div>裸片段</div>')
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /data-deepsea-tap-reset/)
  assert.match(html, /<div>裸片段<\/div>/)
})

test('bundleWorkspaceHtml：内联 CSS/JS，且入口 HTML 也拿到 tap 重置', () => {
  const result = bundleWorkspaceHtml([
    file('index.html', '<html><head><link rel="stylesheet" href="style.css"></head><body><script src="app.js"></script></body></html>'),
    file('style.css', 'body{color:red}'),
    file('app.js', 'console.log(1)'),
  ])
  assert.equal(result.entry, 'index.html')
  assert.match(result.html, /<style data-inlined="style.css">/)
  assert.match(result.html, /console\.log\(1\)/)
  assert.match(result.html, /data-deepsea-tap-reset/)
})

test('bundleWorkspaceHtml：空工坊给的是引导页，也带重置', () => {
  const result = bundleWorkspaceHtml([])
  assert.equal(result.entry, null)
  assert.match(result.html, /工坊还是空的/)
  assert.match(result.html, /data-deepsea-tap-reset/)
})

