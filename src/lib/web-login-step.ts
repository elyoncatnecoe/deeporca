/**
 * 网页账号模式的「先确保已登录」这一步。
 *
 * 单独抽出来的原因是它出过事故：`loginWebChat()` 内部要走
 * native.webApiLogin / native.webChatShow / native.webApiCapture 三个真实异步，
 * 任何一个 reject 都会把整条发送链路打断。以前这段直接写在 `sendMessage()` 的准备
 * 阶段里，外面没有兜底，异常一冒出去 `busy` 就永远停在 true —— 发送键卡成「停止」，
 * 只能重启进程（二审 P1）。
 *
 * 现在它是个纯函数：不碰 store、不弹 toast，只把结果说清楚；
 * 异常**照原样往上抛**，由调用方的统一 try/finally 负责释放、catch 负责提示。
 */

export interface WebLoginDeps {
  /** 现有登录态可用吗（HTTP 模式）或者网页窗开着（DOM 遥控后备）。 */
  webChatReady: () => Promise<boolean>
  /** 走一次登录流程。可能 reject。 */
  loginWebChat: () => Promise<{ ok: boolean; message?: string }>
}

export type WebLoginOutcome =
  | { kind: 'ready'; justLoggedIn: boolean }
  | { kind: 'blocked'; message: string }

/** 默认文案：登录失败但对方没给原因时用它。 */
export const DEFAULT_LOGIN_HINT = '网页账号还没登录；请在弹出的窗口里登录一次'

/**
 * 确保网页账号可用。
 *
 * - 已经就绪 → `{ kind: 'ready', justLoggedIn: false }`，不会多弹一次登录；
 * - 刚登录成功 → `{ kind: 'ready', justLoggedIn: true }`；
 * - 登录返回 ok:false → `{ kind: 'blocked', message }`；
 * - 登录抛错 → **原样抛出**（不吞、不转成 blocked），交给调用方统一处理。
 */
export async function ensureWebChatLogin(deps: WebLoginDeps): Promise<WebLoginOutcome> {
  const ready = await deps.webChatReady()
  if (ready) return { kind: 'ready', justLoggedIn: false }

  const login = await deps.loginWebChat()
  if (!login.ok) return { kind: 'blocked', message: login.message ?? DEFAULT_LOGIN_HINT }
  return { kind: 'ready', justLoggedIn: true }
}
