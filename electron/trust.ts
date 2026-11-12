/**
 * IPC / 导航的信任判断（纯函数）。
 *
 * 拆成两个函数是刻意的：以前导航白名单和 IPC 来源校验共用一个函数，里面无条件
 * 放行 `about:blank` / `about:srcdoc`，于是「主窗口不许导航走」这条保护被自己
 * 开了个口子。现在导航和 IPC 各用各的，`about:*` 一律不认。
 */

/** 我们自己的页面。 */
export function isTrustedIpcSenderUrl(raw: string, devUrl?: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol === 'app:') return url.hostname === 'deepsea'
    if (devUrl !== undefined && devUrl !== '') return url.origin === new URL(devUrl).origin
    return false
  } catch {
    return false
  }
}

/**
 * 主窗口允许停留在哪个地址。
 *
 * 与 IPC 判断同源，但**独立存在**：将来要给导航加例外时，不会顺手放宽 IPC。
 */
export function isAllowedMainWindowNavigation(raw: string, devUrl?: string): boolean {
  return isTrustedIpcSenderUrl(raw, devUrl)
}
