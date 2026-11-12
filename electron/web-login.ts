/**
 * 登录 / 采集失败时的响应构造。
 *
 * 单独抽一个文件，是为了让「异常 → 明确的失败响应」这一步既能被主进程复用，
 * 又能在 node 里跑真实调用链测试（main.ts 直接 import electron，测不了）。
 */
import { SessionRemoveError } from './web-session'

/**
 * 双重失败时的固定提示前缀。
 *
 * 前端会把这个字符串原样显示给用户，所以措辞要能独立成句、不能只写「失败」。
 */
export const STALE_SESSION_CLEANUP_FAILED = '旧登录态清理失败'

export interface LoginFailureResponse {
  ok: false
  error: string
}

/**
 * 把登录 / 采集过程中抛出的异常转成明确的失败响应。
 *
 * 只处理 `SessionRemoveError`（新会话没写进去 + 旧会话清不掉）：
 * 这种情况**绝不能**被当成普通失败悄悄吞掉 —— 用户会以为已经换了账号，
 * 实际重启后又回到旧账号。其余异常原样抛回，由 IPC 变成 rejection，
 * 避免这里把未知错误也翻译成一句模糊的话。
 */
export function toLoginFailure(error: unknown): LoginFailureResponse {
  if (error instanceof SessionRemoveError) {
    return { ok: false, error: `${STALE_SESSION_CLEANUP_FAILED}：${error.message}` }
  }
  throw error
}
