/**
 * 「Key: Value」文本与请求头对象之间的互转。
 *
 * 单独放一个纯模块，是为了能被测试直接 import —— ui.tsx 里带着 React，
 * 在 node 里跑测试没必要把整个组件树拖进来。
 */

/** 把「Key: Value」逐行解析成请求头；冒号没打完的行先不生效，但原文不会被吞掉。 */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key !== '') headers[key] = value
  }
  return headers
}

/** 把请求头拼回「一行一个」的文本。 */
export function headerLines(headers: Record<string, string>): string {
  return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\n')
}