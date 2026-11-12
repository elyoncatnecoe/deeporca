/**
 * 沙箱页的地址。
 *
 * 为什么不能直接用 `srcDoc` / `blob:` / `data:` 加载要运行的 HTML：
 * 这三种「本地 scheme」文档都会**继承父文档的 CSP**（已实测：srcdoc、blob:、
 * data: 三者的 inline 脚本都被父页面的 `script-src 'self'` 拦掉）。父页面加
 * CSP 就是为了防 XSS，不能为了预览去开 `'unsafe-inline'` 的口子。
 *
 * 只有「真的按 URL 取一份文档」才有自己的 CSP、不继承父页面 —— 所以统一用
 * `public/sandbox.html`：它以 `sandbox="allow-scripts"`（不给 allow-same-origin）
 * 挂进来，是不透明源，读不到 App 的 IndexedDB / localStorage / Cookie，也摸不到
 * 父页面；父页面把 HTML 用 postMessage 送进去，它在自己的 CSP 下执行。
 */
export function sandboxUrl(): string {
  try {
    return new URL('./sandbox.html', window.location.href).toString()
  } catch {
    return './sandbox.html'
  }
}

/** 送一段完整 HTML 给沙箱页执行（沙箱页收到后 document.write 进自己）。 */
export function postSandboxHtml(frame: HTMLIFrameElement | null, html: string): void {
  if (frame === null) return
  try {
    frame.contentWindow?.postMessage({ deepseaRunHtml: html }, '*')
  } catch {
    /* 沙箱还没就绪就下一次再说 */
  }
}
