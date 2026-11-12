/**
 * 网页登录态（token）的持久化逻辑。
 *
 * 从 deepseek-api.ts 抽出来的原因和 secure-store 一样：那边直接 import electron，
 * node 单测里跑不起来；而「写失败要回滚内存」「换账号失败要让旧会话失效」
 * 「旧版明文迁移失败不能假装成功」这几条必须能被自动化测试守住。
 *
 * 这里不 import electron：safeStorage 的能力与文件路径都由调用方注入。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SafeStorageLike } from './secure-store'

export interface WebSession {
  token: string
  userAgent: string
  savedAt: number
}

/**
 * 落盘形状。
 *
 * `sealed === true` 时 `token` 是 safeStorage 的密文（Base64）；缺省表示旧版
 * 明文格式，只为迁移而兼容读取。
 */
interface StoredSession {
  token: string
  userAgent: string
  savedAt: number
  sealed?: boolean
}

/**
 * 登录态持久化的失败原因。
 *
 * 单独建模而不是返回 boolean：调用方要据此决定「回滚内存 / 清掉旧文件 / 提示用户」，
 * 只给一个 false 的话这些都没法做，最后就变成「UI 显示登录成功、重启却是旧账号」。
 */
export type SessionPersistResult =
  | { ok: true }
  | { ok: false; reason: 'no-encryption' | 'write-failed'; message: string }

/** 需要提示给用户、但当前 IPC 返回值里没有合适字段的会话问题。 */
export interface WebSessionIssue {
  kind: 'save-failed' | 'migration-failed'
  message: string
}

export interface SessionStoreOptions {
  safe: SafeStorageLike
  /** 延迟取值：`app.getPath('userData')` 必须在 app ready 之后才可用。 */
  file: () => string
}

export interface SessionStore {
  load: () => WebSession | null
  save: (next: WebSession, options?: { invalidateStale?: boolean }) => SessionPersistResult
  forget: () => void
  takeIssue: () => WebSessionIssue | null
  /** 记一条待提示的问题（例如采集到会话但没存下来）。 */
  reportIssue: (issue: WebSessionIssue) => void
  /** 仅供测试观察当前内存态。 */
  peek: () => WebSession | null
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const { safe, file } = options
  let cached: WebSession | null = null
  let pendingIssue: WebSessionIssue | null = null

  /** 用系统密钥存储（Windows DPAPI / macOS Keychain）加密 token；不可用返回 null。 */
  const sealToken = (token: string): string | null => {
    if (!safe.isEncryptionAvailable()) return null
    try {
      return safe.encryptString(token).toString('base64')
    } catch {
      return null
    }
  }

  const unsealToken = (stored: StoredSession): string | null => {
    if (stored.sealed === true) {
      try {
        return safe.decryptString(Buffer.from(stored.token, 'base64'))
      } catch {
        // 解密失败多半是密钥暂时不可用（换用户 / 系统锁屏）。此时既不能当成
        // 「已登录」，也不能删文件 —— 删了就真找不回来了。
        return null
      }
    }
    // 旧版明文格式。
    return stored.token
  }

  /**
   * 把密文写盘。
   *
   * 先写 `.tmp` 再 rename：rename 在同一分区上是原子的，所以「旧的明文文件被替换」
   * 只会发生在**加密写入完整成功之后**。中途失败时原文件一个字节都不会变。
   */
  const writeSealed = (next: WebSession, sealed: string): void => {
    const target = file()
    mkdirSync(dirname(target), { recursive: true })
    const payload: StoredSession = {
      token: sealed,
      userAgent: next.userAgent,
      savedAt: next.savedAt,
      sealed: true,
    }
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, target)
  }

  /** 删掉盘上的登录态文件（删不掉就退一步截断）。 */
  const removeFile = (): void => {
    const target = file()
    try {
      unlinkSync(target)
      return
    } catch (error) {
      // 本来就没有文件是正常状态。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    }
    try {
      writeFileSync(target, '', 'utf8')
    } catch {
      console.warn('[web-session] 登录态文件既删不掉也写不动，可能仍留在磁盘上')
    }
  }

  /**
   * 保存登录态，并把失败如实返回。
   *
   * 失败时**回滚内存**：绝不能让内存里显示「已登录」而磁盘上还是旧会话 ——
   * 那正是「重启后恢复旧账号 / 旧 token」的来源。
   *
   * `invalidateStale` 表示这次是**换账号**（新 token 与旧的不同）：一旦写失败，
   * 盘上那份旧会话必须失效，否则下次启动会把旧账号复活。迁移场景要传 false，
   * 因为那时盘上是用户唯一一份旧数据，只能保留、不能删。
   */
  const save = (
    next: WebSession,
    saveOptions: { invalidateStale?: boolean } = {},
  ): SessionPersistResult => {
    const previous = cached

    const fail = (reason: 'no-encryption' | 'write-failed', message: string): SessionPersistResult => {
      if (saveOptions.invalidateStale === true) {
        // 换账号失败：内存与磁盘一起回到「没有登录态」，避免旧账号被复活。
        removeFile()
        cached = null
      } else {
        cached = previous
      }
      return { ok: false, reason, message }
    }

    const sealed = sealToken(next.token)
    if (sealed === null) {
      return fail('no-encryption', '系统密钥存储不可用，网页登录态无法安全保存')
    }
    try {
      writeSealed(next, sealed)
    } catch (error) {
      return fail('write-failed', `网页登录态写入失败（${describeError(error)}）`)
    }
    cached = next
    return { ok: true }
  }

  const load = (): WebSession | null => {
    if (cached !== null) return cached

    let parsed: StoredSession
    try {
      parsed = JSON.parse(readFileSync(file(), 'utf8')) as StoredSession
    } catch {
      // 没有存档 / 存档损坏：登录态本身可以重建（重新登录即可），不像 API Key 那样
      // 存在「一份还能恢复的密文」，所以这里当成没有登录态是安全的。
      return null
    }

    const token = unsealToken(parsed)
    if (typeof token !== 'string' || token === '') return null

    const session: WebSession = {
      token,
      userAgent: typeof parsed.userAgent === 'string' && parsed.userAgent !== ''
        ? parsed.userAgent
        : 'Mozilla/5.0',
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
    }

    if (parsed.sealed === true) {
      cached = session
      return session
    }

    /*
     * 旧版明文登录态：先加密写回，**写成功才算迁移完成**。
     *
     * 迁移失败时：
     *   - 不把明文会话装进内存（不静默继续用不符合预期的存储状态）；
     *   - 不删盘上的旧文件（那是用户唯一一份，删了就真没了）；
     *   - 记一条待提示的问题，让自检/登录时能明确告诉用户「需要重新登录一次」。
     */
    const result = save(session, { invalidateStale: false })
    if (result.ok) return session
    pendingIssue = {
      kind: 'migration-failed',
      message: `${result.message}，请重新登录一次以升级存储格式`,
    }
    console.warn('[web-session] 旧版明文登录态迁移失败，已保留原文件：', result.message)
    return null
  }

  const forget = (): void => {
    cached = null
    removeFile()
  }

  const takeIssue = (): WebSessionIssue | null => {
    const issue = pendingIssue
    pendingIssue = null
    return issue
  }

  const reportIssue = (issue: WebSessionIssue): void => {
    pendingIssue = issue
  }

  return { load, save, forget, takeIssue, reportIssue, peek: () => cached }
}
