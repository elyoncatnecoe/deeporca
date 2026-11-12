import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 登录 / 采集的 **IPC 集成测试**。
 *
 * 为什么不是真 Electron：
 *   本机沙箱里 Chromium 的 mojo 命名管道被拒绝，Electron 起不来，实测报
 *   `FATAL:mojo\public\cpp\platform\platform_channel.cc:89 Check failed: 拒绝访问 (0x5)`。
 *   因此这里用**等价方案**：一个真实的「channel → handler 注册表 + 路由」总线，
 *   `ipcMain.handle` 真的注册、`invoke` 真的按 channel 派发、抛异常真的变成 rejection
 *   （含与 Electron 一致的 `Error invoking remote method '<channel>': ...` 包装）。
 *
 * 被测对象是生产实现：
 *   - `registerWebLoginIpc`（main.ts 里实际调用的注册函数）；
 *   - `captureSessionWith` + `createSessionStore`（真实采集与持久化逻辑）。
 * 只有「总线」和「BrowserWindow」是替身。**这不是端到端测试**。
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})

const {
  SessionRemoveError,
  captureSessionWith,
  createSessionStore,
} = await import('../electron/web-session.ts')
const { registerWebLoginIpc } = await import('../electron/web-login-ipc.ts')
const { loginFailureToast } = await import('../src/lib/web-chat.ts')

const SAFE = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`SEALED(${plain})`, 'utf8'),
  decryptString: (buffer: Buffer) => {
    const match = /^SEALED\(([\s\S]*)\)$/.exec(buffer.toString('utf8'))
    if (match === null) throw new Error('not sealed')
    return match[1]
  },
}

const OLD_SESSION = { token: 'token-old-account', userAgent: 'UA/old', savedAt: 1000 }

/** 等价 IPC 总线：真实注册表 + 按 channel 派发 + Electron 风格的 rejection 包装。 */
function createIpcBus() {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()
  return {
    ipcMain: {
      handle(channel: string, listener: Handler): void {
        if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
        handlers.set(channel, listener)
      },
    },
    has: (channel: string): boolean => handlers.has(channel),
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`No handler registered for '${channel}'`)
      try {
        return await handler({ sender: { id: 1 } }, ...args)
      } catch (error) {
        // Electron 的 ipcRenderer.invoke 就是这种包装形态。
        const name = error instanceof Error ? error.name : 'Error'
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Error invoking remote method '${channel}': ${name}: ${message}`)
      }
    },
  }
}

function tempFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-ipc-'))
  return { file: join(dir, 'deepseek-web-session.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 可分别控制「写失败」与「删失败」的文件层。 */
function failingFs(state: { failWrites: boolean; failUnlink: boolean }) {
  const err = (code: string): NodeJS.ErrnoException => {
    const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException
    error.code = code
    return error
  }
  return {
    readFile: () => {
      throw err('ENOENT')
    },
    writeFile: () => {
      if (state.failWrites) throw err('EACCES')
    },
    rename: () => {
      if (state.failWrites) throw err('EACCES')
    },
    unlink: () => {
      if (state.failUnlink) throw err('EPERM')
    },
    mkdirp: () => undefined,
  }
}

const executeNewToken = async (script: string): Promise<unknown> => {
  if (script.includes('userToken')) return 'token-new-account'
  return 'UA/new'
}

function setup(state: { failWrites: boolean; failUnlink: boolean }) {
  const { file, cleanup } = tempFile()
  const store = createSessionStore({ safe: SAFE, file: () => file, fs: failingFs(state) })
  const bus = createIpcBus()
  let tick = 0
  registerWebLoginIpc(bus.ipcMain, {
    loginTimeoutMs: 100,
    ensureWindow: async () => ({ kind: 'webchat' }),
    liveWindow: () => ({ kind: 'webchat' }),
    showAndFocus: () => undefined,
    hideWindow: () => undefined,
    capture: () => captureSessionWith(executeNewToken, store),
    verify: async () => ({ ok: true }),
    forget: () => store.forget(),
    persistFailureText: (result) => `写入失败：${result.message}`,
    sleep: async () => undefined,
    // 每次读表前进 10ms：保证首轮一定在 deadline 内，不会一次都不跑。
    now: () => (tick += 10),
  })
  return { bus, store, file, cleanup }
}

test('I1 handler 真实注册：两个 channel 都在注册表里', () => {
  const { bus, cleanup } = setup({ failWrites: false, failUnlink: false })
  try {
    assert.equal(bus.has('webapi:login'), true)
    assert.equal(bus.has('webapi:capture'), true)
  } finally {
    cleanup()
  }
})

test('I2 双重清理失败：invoke("webapi:login") 确实被 reject', async () => {
  const state = { failWrites: false, failUnlink: false }
  const { bus, store, cleanup } = setup(state)
  try {
    assert.deepEqual(store.save(OLD_SESSION), { ok: true })
    state.failWrites = true
    state.failUnlink = true

    await assert.rejects(
      () => bus.invoke('webapi:login'),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /Error invoking remote method 'webapi:login'/, '必须是 IPC rejection 形态')
        assert.match(message, /旧登录态清理失败/, '异常内容必须带用户可见短语')
        return true
      },
    )
  } finally {
    cleanup()
  }
})

test('I3 前端 .catch() 能收到错误并生成指定提示', async () => {
  const state = { failWrites: false, failUnlink: false }
  const { bus, store, cleanup } = setup(state)
  try {
    store.save(OLD_SESSION)
    state.failWrites = true
    state.failUnlink = true

    let caught: unknown = null
    try {
      await bus.invoke('webapi:login')
    } catch (error) {
      caught = error
    }
    assert.ok(caught !== null, 'rejection 必须能被 .catch 捕获')

    const toast = loginFailureToast(caught)
    assert.match(toast, /^旧登录态清理失败/, 'UI 提示必须以指定短语开头')
    assert.doesNotMatch(toast, /Error invoking remote method/, '必须剥掉 IPC 包装')
    assert.doesNotMatch(toast, /已连接|已退出|已清除/, '不得误报成功')
  } finally {
    cleanup()
  }
})

test('I4 失败后旧会话缓存没有被清空', async () => {
  const state = { failWrites: false, failUnlink: false }
  const { bus, store, cleanup } = setup(state)
  try {
    store.save(OLD_SESSION)
    state.failWrites = true
    state.failUnlink = true

    await assert.rejects(() => bus.invoke('webapi:login'))
    assert.equal(store.peek()?.token, OLD_SESSION.token, '旧会话缓存必须保留')
  } finally {
    cleanup()
  }
})

test('I5 webapi:capture 同样以 rejection 传回', async () => {
  const state = { failWrites: false, failUnlink: false }
  const { bus, store, cleanup } = setup(state)
  try {
    store.save(OLD_SESSION)
    state.failWrites = true
    state.failUnlink = true

    await assert.rejects(
      () => bus.invoke('webapi:capture'),
      /Error invoking remote method 'webapi:capture': .*旧登录态清理失败/s,
    )
  } finally {
    cleanup()
  }
})

test('I6 非双重失败（写入失败但旧会话已清）仍返回结构化失败，不误伤成 rejection', async () => {
  const state = { failWrites: true, failUnlink: false }
  const { bus, store, cleanup } = setup(state)
  try {
    store.save(OLD_SESSION)

    const response = await bus.invoke('webapi:login') as { ok: boolean; error?: string }
    assert.equal(response.ok, false)
    assert.match(response.error ?? '', /写入失败/)
  } finally {
    cleanup()
  }
})

test('I7 SessionRemoveError 的类型不被总线吞掉（仍可识别）', async () => {
  const { file, cleanup } = tempFile()
  try {
    const state = { failWrites: false, failUnlink: false }
    const store = createSessionStore({ safe: SAFE, file: () => file, fs: failingFs(state) })
    store.save(OLD_SESSION)
    state.failWrites = true
    state.failUnlink = true

    await assert.rejects(
      () => captureSessionWith(executeNewToken, store),
      (error: unknown) => error instanceof SessionRemoveError,
    )
  } finally {
    cleanup()
  }
})
