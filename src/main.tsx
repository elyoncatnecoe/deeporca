// 必须排在所有业务模块之前：老 WebView 缺少 ES2022 内置方法，
// 依赖库（marked / react-dom）在渲染路径里会直接用它们。
// ESM 的 import 会被提升，所以这里放第一行就能保证先执行。
import './lib/polyfills'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import 'highlight.js/styles/github-dark.css'

/**
 * 启动期错误兜底。
 *
 * 之前遇到过「对话页和设置页一片黑」但没有任何报错线索的情况：JS 抛在
 * 渲染途中，React 整棵树都没挂上去，用户只看到背景色，开发者也拿不到信息。
 *
 * 这里做两件事：
 *   1. 全局捕获未处理异常，把它们写到页面上（而不是只进控制台——
 *      手机上根本看不到控制台）；
 *   2. React 渲染失败时，至少让用户看到一句人话，而不是纯黑。
 */
function showFatal(message: string): void {
  const root = document.getElementById('root')
  if (root === null) return
  // 已经有内容就不覆盖：这类错误多半发生在某个子页面，不该把整页干掉。
  if (root.childElementCount > 0) {
    console.error('[deepsea] fatal (page kept):', message)
    return
  }
  root.innerHTML = ''
  const box = document.createElement('div')
  box.setAttribute('data-deepsea-fatal', '')
  box.style.cssText = [
    'position:fixed', 'inset:0', 'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center', 'gap:12px', 'padding:24px',
    'background:#04141d', 'color:#e8f7f9', 'font:14px/1.6 system-ui,sans-serif',
    'text-align:center', 'z-index:99999', 'overflow:auto',
  ].join(';')
  const title = document.createElement('strong')
  title.textContent = '界面没能加载出来'
  const detail = document.createElement('pre')
  detail.textContent = message
  detail.style.cssText = 'max-width:100%;white-space:pre-wrap;color:#93b7c0;font-size:12px;text-align:left'
  box.append(title, detail)
  root.appendChild(box)
}

window.addEventListener('error', (event) => {
  const message = event.error instanceof Error
    ? `${event.error.message}\n${event.error.stack ?? ''}`
    : String(event.message)
  showFatal(message)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  showFatal(reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason))
})

const root = document.getElementById('root')
if (root === null) throw new Error('missing #root')

try {
  createRoot(root).render(<App />)
} catch (error) {
  showFatal(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
}
