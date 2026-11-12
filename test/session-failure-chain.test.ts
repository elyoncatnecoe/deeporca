import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * P1-2 的**调用链**测试（IPC rejection 语义）。
 *
 * 约定：`save()` 的「双重清理失败」抛 `SessionRemoveError`；主进程**不 catch**，
 * 让异常经 IPC rejection 传回渲染层，由前端 `.catch()` 显示「旧登录态清理失败」。
 *
 * 这里除了「React 渲染」这一跳，其余都是生产实现在跑：
 *   - `createSessionStore` / `captureSessionWith`（web-session.ts）
 *   - `loginFailureToast`（web-chat.ts，Settings 页与 engine 都调它）
 *
 * **这不是端到端测试**：没有启动 Electron、没有真实 IPC 通道、没有渲染 DOM。
 * Electron 的 rejection 包装（`Error invoking remote method ...`）在这里是**手工模拟**的。
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const {
  SessionRemoveError,
  captureSessionWith,
  createSessionStore,
} = await import('../electron/web-session.ts')
const { loginFailureToast, loginResultToast, mapLoginResponse } = await import('../src/lib/web-chat.ts')

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
const NEW_TOKEN = 'token-new-account'

function tempFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-chain-'))
  return { file: join(dir, 'deepseek-web-session.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 可切换失败的文件层：模拟「写不进 + 删不掉」的双重失败。 */
function failingFs(state: { fail: boolean }) {
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
      if (state.fail) throw err('EACCES')
    },
    rename: () => {
      if (state.fail) throw err('EACCES')
    },
    unlink: () => {
      if (state.fail) throw err('EPERM')
    },
    mkdirp: () => undefined,
  }
}

const executeNewToken = async (script: string): Promise<unknown> => {
  if (script.includes('userToken')) return NEW_TOKEN
  return 'UA/new'
}

test('C1 双重失败时 save() 抛 SessionRemoveError（不是返回 ok:false 对象）', () => {
  const { file, cleanup } = tempFile()
  try {
    const state = { fail: false }
    const store = createSessionStore({ safe: SAFE, file: () => file, fs: failingFs(state) })
    assert.deepEqual(store.save(OLD_SESSION), { ok: true })

    state.fail = true
    assert.throws(
      () => store.save({ token: NEW_TOKEN, userAgent: 'UA/new', savedAt: 2000 }, { invalidateStale: true }),
      (error: unknown) => {
        assert.ok(error instanceof SessionRemoveError)
        assert.match((error as Error).message, /^旧登录态清理失败：/, '消息必须以用户可见短语开头')
        assert.match((error as Error).message, /未能清除/)
        return true
      },
    )
  } finally {
    cleanup()
  }
})

test('C2 采集链路把异常原样传上来（captureSessionWith 不吞），旧缓存不清空', async () => {
  const { file, cleanup } = tempFile()
  try {
    const state = { fail: false }
    const store = createSessionStore({ safe: SAFE, file: () => file, fs: failingFs(state) })
    store.save(OLD_SESSION)

    state.fail = true
    await assert.rejects(() => captureSessionWith(executeNewToken, store), SessionRemoveError)
    assert.equal(store.peek()?.token, OLD_SESSION.token, '失败后旧会话缓存不能被清空')
  } finally {
    cleanup()
  }
})

test('C3 主进程不 catch：登录/采集交给 registerWebLoginIpc，且该模块不吞异常', () => {
  const main = readFileSync(join(root, 'electron/main.ts'), 'utf8')
  assert.match(main, /registerWebLoginIpc\(/, 'main.ts 应把两条 handler 交给可测模块注册')
  assert.doesNotMatch(main, /toLoginFailure/, '不得再引入「异常转返回对象」的转换函数')

  const ipc = readFileSync(join(root, 'electron/web-login-ipc.ts'), 'utf8')
  assert.doesNotMatch(ipc, /try\s*\{[^}]*deps\.capture/s, 'capture 不能被 try/catch 包住')
  assert.match(ipc, /await deps\.capture\(win\)/, '应直接 await，让异常冒成 rejection')
})

test('C5 其它异常不被吞：原样交给用户', () => {
  assert.equal(loginFailureToast(new Error('窗口打不开了')), '窗口打不开了')
  assert.equal(loginFailureToast(''), '登录流程出错')
})

test('C6 成功路径不回归：结构化结果仍走 loginResultToast', () => {
  assert.equal(loginResultToast({ ok: true }), '网页账号已连接，以后不用再登录')
  assert.equal(loginResultToast(mapLoginResponse({ ok: false, error: '超时了' })), '超时了')
})

test('C8 UI 接线：Settings 与 engine 都接住 rejection', () => {
  /*
   * 这是整条链上**唯一无法在 node 里执行**的一跳（React 渲染）。
   * 只做结构断言，报告里标注为「未执行渲染」，不算端到端验证。
   */
  const settings = readFileSync(join(root, 'src/components/Settings.tsx'), 'utf8')
  assert.match(settings, /\.catch\(/, 'Settings 必须捕获 rejection')
  assert.match(settings, /loginFailureToast\(error\)/, '失败提示必须走统一函数')

  const engine = readFileSync(join(root, 'src/lib/engine.ts'), 'utf8')
  assert.match(engine, /loginFailureToast\(error\)/, '发消息前的登录失败也必须提示')
})
