import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * B 批（安全）的结构性回归测试。
 *
 * 这几条守的都是「一旦退化就等于没有」的防线：
 *   - P0-1 备份只清 apiKey，headers 里的密钥照进文件；
 *   - P0-3 主窗口能被导航走 / IPC 不验来源 / 页面没有 CSP；
 *   - P0-4「运行代码」又跑回同源 Worker；
 *   - P1-21/22 mcp-stdio 的 stdin 错误与 id 配对。
 *
 * 用源码断言而不是跑一遍：这些是主进程与安全策略，node 里起不来 Electron，
 * 但「代码长什么样」正好能说清这些约束。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8')

/** 去掉注释：注释里会提到「以前用的是 new Worker(...)」这类字眼，不能当成代码。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

const main = read('electron/main.ts')
const preload = read('electron/preload.ts')
const stdio = read('electron/mcp-stdio.ts')
const backup = read('src/lib/backup.ts')
const codeRun = read('src/components/CodeRunModal.tsx')
const sandboxLib = read('src/lib/sandbox.ts')
const workshop = read('src/components/Workshop.tsx')
const viteConfig = read('vite.config.ts')
const sandboxHtml = read('public/sandbox.html')

test('P0-1：备份会把供应商与 MCP 的请求头一起脱敏', () => {
  const strip = backup.slice(backup.indexOf('export function stripSecrets'), backup.indexOf('export async function buildBackup'))
  assert.match(strip, /redactHeaders\(provider\.headers\)/, 'providers[].headers 必须脱敏')
  assert.match(strip, /redactHeaders\(server\.headers\)/, 'mcpServers[].headers 必须脱敏')
  // 导入侧也要丢掉占位符，否则 <redacted> 会被当成真请求头。
  assert.match(backup, /dropRedactedHeaders\(record\.headers\)/)
})

test('P0-1：生图/语音 Key 与 headers 也要脱敏，且不能明文进 IndexedDB', () => {
  const strip = backup.slice(backup.indexOf('export function stripSecrets'), backup.indexOf('export async function buildBackup'))
  assert.match(strip, /'imageApi'/, '生图 API 的 apiKey 没清')
  assert.match(strip, /'speechApi'/, '语音 API 的 apiKey 没清')
  assert.match(strip, /extraHeaders/, '媒体 API 的自定义请求头没脱敏')
  const settings = read('src/lib/settings.ts')
  assert.match(settings, /MEDIA_IMAGE_KEY/, '生图 Key 没有安全存储槽位')
  assert.match(settings, /MEDIA_SPEECH_KEY/, '语音 Key 没有安全存储槽位')
  assert.match(settings, /strippedImageApi/, 'persistSettings 没剥掉生图 Key')
  assert.match(settings, /strippedSpeechApi/, 'persistSettings 没剥掉语音 Key')
})

test('P0-3：主窗口有导航拦截（will-navigate / will-redirect / webview）', () => {
  const create = main.slice(main.indexOf('async function createWindow'), main.indexOf('app.setAppUserModelId'))
  assert.match(create, /webContents\.on\('will-navigate'/, '没有 will-navigate，一条 markdown 链接就能把 App 导航走')
  assert.match(create, /webContents\.on\('will-redirect'/)
  assert.match(create, /webContents\.on\('will-attach-webview'/)
  assert.match(create, /openExternal\(url\)/, '外部链接应该交给系统浏览器')
})

test('P0-3：所有 IPC 都走来源校验包装器', () => {
  assert.match(main, /function isTrustedSender/)
  assert.match(main, /frame\.parent !== null/, '子框架一律不认')
  assert.match(main, /function trustedHandle/)
  assert.match(main, /function trustedOn/)
  // 注册处只允许用包装器：出现裸 ipcMain.handle/on 就说明有人绕过了校验。
  const registrations = main.match(/ipcMain\.(handle|on)\(/g) ?? []
  assert.equal(registrations.length, 2, `裸 ipcMain.handle/on 只应出现在两个包装器内部，实际 ${registrations.length} 处`)
  assert.ok((main.match(/trustedHandle\('/g) ?? []).length >= 15, '业务 handler 都要用 trustedHandle 注册')
  assert.match(main, /trustedOn\('app:version'/)
})

test('P0-3：preload 没有把 ipcRenderer 整个交出去', () => {
  assert.equal(/exposeInMainWorld\([^)]*ipcRenderer/.test(preload), false, '不能把 ipcRenderer 直接暴露给页面')
  assert.match(preload, /contextBridge\.exposeInMainWorld\('deepsea'/)
})

test('P0-3：构建产物带 CSP，且脚本只认自家产物', () => {
  assert.match(viteConfig, /Content-Security-Policy/)
  // wasm-unsafe-eval 是给 sql.js（导入 rikkahub 的 .db）用的：它只放行 WASM 编译，
  // 不放行 JS 的 eval / inline 脚本。除此之外 script-src 仍然只认自家产物。
  assert.match(viteConfig, /"script-src 'self' 'wasm-unsafe-eval'"/, 'script-src 只能是 self + wasm-unsafe-eval')
  assert.equal(/script-src[^"]*'unsafe-eval'/.test(viteConfig), false, 'script-src 不允许真正的 unsafe-eval')
  assert.match(viteConfig, /"object-src 'none'"/)
  assert.match(viteConfig, /"base-uri 'none'"/)
  assert.match(viteConfig, /frame-src[^"]*blob:/, '沙箱预览用 blob/sandbox 页，frame-src 要放行')
  assert.equal(/script-src[^"]*unsafe-inline/.test(viteConfig), false, 'script-src 不允许 unsafe-inline')
})

test('P0-4：运行代码不再用同源 Worker，改跑在不透明源 iframe', () => {
  assert.equal(/new Worker\(/.test(stripComments(codeRun)), false, 'Worker 继承同源，能读 IndexedDB，等于把库交出去')
  assert.match(codeRun, /sandbox="allow-scripts"/)
  assert.equal(/sandbox="[^"]*allow-same-origin/.test(codeRun), false, '一旦给了 allow-same-origin 就不是隔离环境了')
  // 沙箱页地址统一收在 src/lib/sandbox.ts；这里守的是「必须从独立文件加载」。
  assert.match(sandboxLib, /sandbox\.html/, '沙箱页要从独立文件加载（srcDoc/blob/data 都会继承父页面 CSP）')
  assert.match(codeRun, /from '\.\.\/lib\/sandbox'/)
})

test('P0-4：工坊预览也走沙箱页，不许退回 srcDoc', () => {
  // srcDoc / blob: / data: 加载的文档会继承父文档的 CSP，
  // 父页面的 script-src 'self' 会把预览里的 inline 脚本全部拦掉 ——
  // 页面能显示（CSS 动画照跑），但一个事件都没绑上，表现就是「整页点不动」。
  assert.equal(/srcDoc=/.test(stripComments(workshop)), false, '工坊预览不能用 srcDoc')
  assert.match(workshop, /from '\.\.\/lib\/sandbox'/)
  assert.match(workshop, /postSandboxHtml\(/, 'HTML 要 postMessage 给沙箱页执行')
  assert.equal(/sandbox="[^"]*allow-same-origin/.test(workshop), false, '预览同样不能给 allow-same-origin')
})

test('P0-4：沙箱页自己也收紧了 CSP', () => {
  assert.match(sandboxHtml, /Content-Security-Policy/)
  assert.match(sandboxHtml, /default-src 'none'/)
  assert.match(sandboxHtml, /event\.source !== window\.parent/, '只接受父窗口的指令')
  assert.match(sandboxHtml, /deepseaRunJs/)
  assert.match(sandboxHtml, /deepseaRunHtml/)
})

test('P1-21：stdin 的错误有监听，写入走统一出口', () => {
  assert.match(stdio, /child\.stdin\.on\('error'/, '没有监听的话，子进程先死会让主进程抛未捕获异常')
  assert.match(stdio, /function writeLine\(/)
  assert.equal(/child\.stdin\.write\(/.test(stdio), false, '写入一律走 writeLine，别各处裸 write')
})

test('P1-22：请求 id 由主进程重新发号，退出时不误删新会话', () => {
  assert.match(stdio, /nextId: number/)
  assert.match(stdio, /const wireId = session\.nextId/)
  assert.match(stdio, /if \(sessions\.get\(key\) === session\) sessions\.delete\(key\)/, '旧进程晚退出时不能把新会话从表里抹掉')
})

test('工坊/运行代码：沙箱允许远程脚本，并支持 ES module 写法', () => {
  // 用户反馈「工坊对 three.js 支持有问题」：以前 sandbox 的 CSP 只允许 inline 脚本，
  // 从 CDN 引的库一律被拦；而 import 写法塞进 new Function 还会直接语法错误。
  assert.match(sandboxHtml, /script-src[^"]*https:/, 'CDN 上的库（three.js）要能加载')
  assert.match(sandboxHtml, /script-src[^"]*blob:/, '模块代码要能包成 blob 加载')
  assert.match(sandboxHtml, /function looksLikeModule/, '要有 import/export 的判据')
  assert.match(sandboxHtml, /script\.type = 'module'/, '模块写法要用 <script type="module"> 跑')
  assert.match(codeRun, /RUN_TIMEOUT_MODULE_MS/, '模块要联网拉依赖，超时不能还是 4 秒')
  // 隔离性不能被这次放宽破坏：仍然不给 allow-same-origin。
  assert.equal(/sandbox="[^"]*allow-same-origin/.test(codeRun), false)
  assert.equal(/sandbox="[^"]*allow-same-origin/.test(workshop), false)
})