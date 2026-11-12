/**
 * 网页登录 / 采集的 IPC handler 注册。
 *
 * 从 main.ts 里抽出来的唯一原因：main.ts 直接 `import { app, ipcMain } from 'electron'`，
 * 在 node 测试里 import 不进来，而这两条 handler 的**失败语义**（双重清理失败必须
 * 抛成 rejection，不能变成正常返回）恰恰是最需要被集成测试盯住的地方。
 *
 * 这里不 import electron：调用方把 `ipcMain.handle` 和实际依赖注入进来。
 * 测试就可以用一个真实的「注册表 + channel 路由」总线，跑真正的 handler。
 */
import type { CapturedSession, SessionPersistResult } from './web-session'

/** 只用到 `handle`：注册 invoke 型通道。 */
export interface IpcRegistrar {
  handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void
}

export interface WebLoginIpcDeps {
  /** 登录等待上限（扫码 / 人机校验都需要时间）。 */
  loginTimeoutMs: number
  ensureWindow: () => Promise<unknown | null>
  liveWindow: () => unknown | null
  showAndFocus: (win: unknown) => void
  hideWindow: (win: unknown) => void
  capture: (win: unknown) => Promise<CapturedSession | null>
  verify: () => Promise<{ ok: boolean; reason?: string }>
  forget: () => void
  persistFailureText: (result: Extract<SessionPersistResult, { ok: false }>) => string
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/**
 * 注册 `webapi:login` 与 `webapi:capture`。
 *
 * **关键约束**：两条 handler 都不 catch `capture()`。
 * `save()` 在「新会话写不进 + 旧会话清不掉」时抛 `SessionRemoveError`，
 * 这个异常必须原样冒出去变成 IPC rejection —— 一旦在这里转成 `{ ok: false }`
 * 的正常返回，调用方很容易只判 `ok` 后当成普通失败处理，界面就会误报「已清除」。
 */
export function registerWebLoginIpc(ipc: IpcRegistrar, deps: WebLoginIpcDeps): void {
  ipc.handle('webapi:login', async () => {
    const win = await deps.ensureWindow()
    if (win === null) return { ok: false, error: 'no-window' }
    deps.showAndFocus(win)

    const deadline = deps.now() + deps.loginTimeoutMs
    while (deps.now() < deadline) {
      // 故意不 catch：见上面的说明。
      const captured = await deps.capture(win)
      if (captured !== null) {
        if (!captured.persist.ok) {
          return { ok: false, error: deps.persistFailureText(captured.persist) }
        }
        // 验证 token 真的能用，避免存下一个过期的登录态。
        const verified = await deps.verify()
        if (verified.ok) {
          deps.hideWindow(win)
          return { ok: true }
        }
        // 网络问题不能说明 token 无效：别把刚采集到的登录态删了。
        if (verified.reason !== undefined && /连不上|网络|SSL|TLS/i.test(verified.reason)) {
          return { ok: false, error: verified.reason }
        }
        deps.forget()
      }
      await deps.sleep(1200)
    }
    return { ok: false, error: '登录超时了；请重试一次' }
  })

  ipc.handle('webapi:capture', async () => {
    const win = deps.liveWindow()
    if (win === null) return { ok: false, error: 'no-window' }
    // 同样不 catch。
    const captured = await deps.capture(win)
    if (captured === null) return { ok: false, error: '还没登录：窗口里没有 userToken' }
    if (!captured.persist.ok) {
      return { ok: false, error: deps.persistFailureText(captured.persist) }
    }
    return { ok: true }
  })
}
