/**
 * `app://` 协议路径解析（纯函数）。
 *
 * 从 main.ts 抽出来是为了能单测：这里守的是「任何编码形式都不能越出 dist 目录」，
 * 而这种防线一旦退化就等于没有 —— 必须每条变体都有回归测试。
 */
import { isAbsolute, join, normalize, relative, sep } from 'node:path'

export const APP_PROTOCOL_HOST = 'deepsea'

export type AppPathResolution =
  | { ok: true; target: string }
  | { ok: false; reason: 'malformed' | 'host' | 'decode' | 'escape' }

/**
 * 把 `app://deepsea/...` 映射到磁盘路径。
 *
 * 关键点（顺序不能变）：
 *   1. 先 URL 解析 —— 解析器会折叠字面的 `..` 和 `%2e%2e`；
 *   2. 再 decodeURIComponent —— 这一步之后才可能出现真实 `..`
 *      （`%2e%2e%2f` 里的 `..` 在解析阶段不是一个完整 segment，所以不会被折叠）；
 *   3. 最后用 `relative()` 判断包含关系 —— **不能用 `startsWith`**，那只是字符串
 *      前缀，`dist-other` 能通过对 `dist` 的判断。
 */
export function resolveAppPath(root: string, requestUrl: string): AppPathResolution {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (url.protocol !== 'app:') return { ok: false, reason: 'host' }
  if (url.hostname !== APP_PROTOCOL_HOST) return { ok: false, reason: 'host' }

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
  } catch {
    // 孤立的 `%` 会抛 URIError。放过去会让整个请求静默失败，这里明确拒绝。
    return { ok: false, reason: 'decode' }
  }

  let target = normalize(join(root, pathname))
  // `join` 会把尾斜杠保留下来（`.../assets/`）。返回规范路径，避免调用方拿它
  // 做字符串比较时多出一个分隔符。
  if (target.length > root.length && target.endsWith(sep)) target = target.slice(0, -1)

  const rel = relative(root, target)
  // rel === '' 表示 target 就是 root 本身（不是文件）；
  // '..' / '../x' 表示越界；isAbsolute(rel) 覆盖跨盘符的情况。
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: 'escape' }
  }
  return { ok: true, target }
}
