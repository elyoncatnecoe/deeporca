import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 内容安全策略（BUG-REVIEW P0-3）。
 *
 * 桌面端主窗口带着 `window.deepsea` 桥（读 Key、读写文件、跑 mcpStdioRequest），
 * 一旦被 XSS 拿到就等于本机 RCE。这里把能加载的东西收紧到「自家产物」：
 *   - script 只认打包产物：没有 inline、没有 eval；
 *   - style 允许 inline（React 的 style 属性、皮肤注入都靠它）；
 *   - connect 放开 https/http：供应商地址是用户自己填的，还可能是本机网关；
 *   - img 放开 data:/blob:：附件预览、头像都是这两种；
 *   - frame 放开 blob:/data:：沙箱预览用 blob: URL 加载（srcdoc 的 about:srcdoc
 *     不在 frame-src 的匹配范围里，实测会被拦掉，所以不能靠 srcDoc）。
 *
 * 只在 build 时注入：开发模式（vite dev）下 @vitejs/plugin-react 会往页面里塞
 * 一段 inline 的 react-refresh 预置脚本，'self' 的 script-src 会把它拦掉。
 * 开发服务器只监听 127.0.0.1，本来就不对外。
 */
const CSP = [
  "default-src 'self'",
  // wasm-unsafe-eval：导入 rikkahub 的 .db 要用 sql.js（WASM），Chromium 编译
  // WASM 需要这个权限，否则打包版会被 CSP 直接拦掉（dev 模式不注入 CSP，看不出来）。
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https: http: ws: wss:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'self' data: blob:",
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'deepsea-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const meta = `    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n`
      return html.replace('</head>', `${meta}  </head>`)
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin()],
  build: {
    // 降到 es2019：Android WebView 的版本取决于系统，老机器可能只到 Chromium 80 左右。
    // 注意 target 只影响**语法降级**，不会 polyfill 内置方法——像 Array.prototype.at
    // （ES2022）、findLast、Object.hasOwn 这类在老内核上依然会抛
    // "xxx is not a function"，所以代码里要主动避开（见 src/lib/body.ts 的注释）。
    target: 'es2019',
    outDir: 'dist',
    chunkSizeWarningLimit: 2500,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
})