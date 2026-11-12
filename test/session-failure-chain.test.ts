import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * P1-2 的**调用链**测试：save() 双重失败 → 抛 SessionRemoveError → IPC 层转成
 * 明确失败响应 → 渲染层映射 → UI 文案。
 *
 * 这里刻意不用「孤立 mock + 字符串断言」：
 *   - `createSessionStore` 是生产实现，只替换了文件层（造 EPERM/EACCES）；
 *   - `captureSessionWith` 是生产实现（`webapi:login` 真正调用的那个）；
 *   - `toLoginFailure` 是 `main.ts` 真正调用的转换函数；
 *   - `mapLoginResponse` / `loginResultToast` 是渲染层真正调用的映射函数。
 * 即：除了「React 组件没渲染」这一跳，其余每一跳都是真实代码在跑。
 *
 * **这不是端到端测试**：没有启动 Electron、没有真实 IPC、没有渲染 DOM。
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
const { STALE_SESSION_CLEANUP_FAILED, toLoginFailure } = await import('../electron/web-login.ts')
const { loginResultToast, mapLoginResponse } = await import('../src/lib/web-chat.ts')

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

/** 模拟网页窗里执行脚本：返回新账号的 token。 */
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
      SessionRemoveError,
    )
  } finally {
    cleanup()
  }
})

test('C2 采集链路把异常原样传上来（captureSessionWith 不吞）', async () => {
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

test('C3 IPC 层：异常被转成明确失败响应，绝不会是成功', () => {
  const error = new SessionRemoveError('网页登录态写入失败（EACCES: simulated）；且本地旧登录态文件未能清除')
  const response = toLoginFailure(error)

  assert.equal(response.ok, false, 'IPC 响应必须是失败')
  assert.match(response.error, new RegExp(STALE_SESSION_CLEANUP_FAILED), '必须点明「旧登录态清理失败」')
  assert.doesNotMatch(response.error, /已清除|已连接|成功/, '不得出现误导性成功措辞')
})

test('C4 非 SessionRemoveError 不被这里吞掉（保持原有语义，不扩大范围）', () => {
  const other = new Error('some other failure')
  assert.throws(() => toLoginFailure(other), /some other failure/)
})

test('C5 前端映射：失败原因一路变成 UI 文案', () => {
  const response = toLoginFailure(new SessionRemoveError('网页登录态写入失败；且本地旧登录态文件未能清除'))
  const login = mapLoginResponse(response)
  const toast = loginResultToast(login)

  assert.equal(login.ok, false)
  assert.match(login.message ?? '', new RegExp(STALE_SESSION_CLEANUP_FAILED))
  assert.match(toast, new RegExp(STALE_SESSION_CLEANUP_FAILED), 'UI 文案必须包含指定提示')
  assert.doesNotMatch(toast, /已连接|已清除/, '不能显示成功提示')
})

test('C7 UI 接线：Settings 页确实把结果交给 loginResultToast，并捕获 rejection', () => {
  /*
   * 这是整条链上**唯一无法在 node 里执行**的一跳（React 组件渲染）。
   * 所以这里只做结构断言，并在报告里如实标注为「未执行渲染」，
   * 不把它算作端到端验证。
   */
  const settings = readFileSync(join(root, 'src/components/Settings.tsx'), 'utf8')
  assert.match(settings, /showToast\(loginResultToast\(result\)\)/, 'UI 必须用统一文案函数显示结果')
  assert.match(settings, /\.catch\(/, 'UI 必须捕获 IPC rejection，不能静默丢弃')
  assert.doesNotMatch(settings, /result\.ok \? '网页账号已连接/, '不能残留旧的「成功就报已连接」内联文案')
})

test('C6 完整链路：save → capture → IPC 响应 → UI 文案（一次跑通）', async () => {
  const { file, cleanup } = tempFile()
  try {
    const state = { fail: false }
    const store = createSessionStore({ safe: SAFE, file: () => file, fs: failingFs(state) })
    store.save(OLD_SESSION)

    state.fail = true

    // ① 采集（生产实现）→ ② save 抛异常
    let thrown: unknown = null
    try {
      await captureSessionWith(executeNewToken, store)
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof SessionRemoveError, '采集链路必须抛出 SessionRemoveError')

    // ③ IPC handler（生产实现）把它变成失败响应
    const response = toLoginFailure(thrown)
    assert.equal(response.ok, false)

    // ④ 渲染层（生产实现）映射成 UI 文案
    const toast = loginResultToast(mapLoginResponse(response))
    assert.match(toast, /旧登录态清理失败/, 'UI 必须显示「旧登录态清理失败」')

    // ⑤ 失败后的状态：旧会话缓存没被清空，也没有任何「成功」痕迹
    assert.equal(store.peek()?.token, OLD_SESSION.token, '旧会话缓存必须保留')
    assert.doesNotMatch(toast, /已连接|已退出|已清除/, '不得误报成功')
  } finally {
    cleanup()
  }
})
