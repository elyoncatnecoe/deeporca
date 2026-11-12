/**
 * 网页账号模式的「先确保已登录」这一步。
 *
 * 单独抽出来的原因是它出过两次事故：
 *   1. `loginWebChat()` 内部要走 native.webApiLogin / webChatShow / webApiCapture
 *      三个真实异步，任何一个 reject 都会把整条发送链路打断；以前这段直接写在
 *      `sendMessage()` 的准备阶段里，外面没有兜底，异常一冒出去 `busy` 就永远停在
 *      true —— 发送键卡成「停止」，只能重启进程（二审 P1）。
 *   2. 用户在这两步等待期间点了停止，返回后仍然继续建会话、落库、发请求
 *      （三审 P1）。所以这里必须**每个 await 之后都复查 signal**。
 *
 * 现在它是纯函数：不碰 store、不弹 toast，只把结果说清楚；
 * 异常照原样往上抛，由调用方的统一 try/finally 负责释放、catch 负责提示。
 *
 * 注意：本批次**不要求**底层原生登录窗口/IPC 能瞬间中断 —— 即使 `loginWebChat()`
 * 内部无法取消，这里也保证它返回之后不会再继续任何已取消的发送流程。
 */

export interface WebLoginDeps {
  /** 这一轮的取消信号。等待期间被 abort 就不再继续。 */
  signal?: AbortSignal
  /** 现有登录态可用吗（HTTP 模式）或者网页窗开着（DOM 遥控后备）。 */
  webChatReady: () => Promise<boolean>
  /** 走一次登录流程。可能 reject。 */
  loginWebChat: () => Promise<{ ok: boolean; message?: string }>
}

export type WebLoginOutcome =
  | { kind: 'ready'; justLoggedIn: boolean }
  | { kind: 'blocked'; message: string }
  /** 等待期间被停止：不是失败，不该弹任何错误提示。 */
  | { kind: 'cancelled' }

/** 默认文案：登录失败但对方没给原因时用它。 */
export const DEFAULT_LOGIN_HINT = '网页账号还没登录；请在弹出的窗口里登录一次'

/**
 * 确保网页账号可用。
 *
 * - 已经就绪 → `{ kind: 'ready', justLoggedIn: false }`，不会多弹一次登录；
 * - 刚登录成功 → `{ kind: 'ready', justLoggedIn: true }`；
 * - 登录返回 ok:false → `{ kind: 'blocked', message }`；
 * - 登录抛错 → **原样抛出**（不吞、不转成 blocked）；
 * - 等待期间被取消 → `{ kind: 'cancelled' }`，且在取消之后**不会**再发起登录。
 */
export async function ensureWebChatLogin(deps: WebLoginDeps): Promise<WebLoginOutcome> {
  /*
   * 用函数读而不是直接比较：TS 会按第一次判断把 `deps.signal.aborted` 收窄成 false，
   * 后面再比较就报「没有重叠」。而实际运行时它会在 await 期间被置位。
   */
  const aborted = (): boolean => deps.signal?.aborted === true

  const ready = await deps.webChatReady()
  // 等 webChatReady 的这段时间用户可能已经按了停止 —— 那就别再去弹登录窗。
  if (aborted()) return { kind: 'cancelled' }
  if (ready) return { kind: 'ready', justLoggedIn: false }

  const login = await deps.loginWebChat()
  // 登录窗口关掉 / 登录成功回来时，这一轮可能已经被取消了。
  if (aborted()) return { kind: 'cancelled' }
  if (!login.ok) return { kind: 'blocked', message: login.message ?? DEFAULT_LOGIN_HINT }
  return { kind: 'ready', justLoggedIn: true }
}
