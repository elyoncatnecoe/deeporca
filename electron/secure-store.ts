/**
 * Electron 安全存储的纯逻辑层。
 *
 * 从 main.ts 抽出来的原因：main.ts 直接 `import { safeStorage } from 'electron'`，
 * 在 node 单测里根本 import 不进来；而「加密不可用时拒绝落盘」「解密失败不破坏
 * 原密文」「旧版 raw: 明文读到就升级」这三条规则必须能被自动化测试守住。
 *
 * 这里不 import electron：调用方把 `safeStorage` 的能力按 `SafeStorageLike`
 * 注入进来，测试传一个假的即可。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type SecureStorageStatus = 'available' | 'unavailable' | 'read-error'

/** safeStorage 里我们真正用到的那三个方法。 */
export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (plainText: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

/** 这台机器上没有可用的系统密钥存储（safeStorage 后端缺失）。 */
export class SecureStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecureStoreUnavailableError'
  }
}

/**
 * 凭证文件读不出来（权限、IO、JSON 损坏、结构不合法）。
 *
 * 与「没有存档」是**两种完全不同的事实**：前者说明盘上可能有一份还能恢复的
 * 密文，任何写入/删除都会把它毁掉；后者只是还没配过 Key。所以这里必须抛错，
 * 由上层映射成 `read-error`，绝不能统一转成 `{}`。
 */
export class SecureStoreReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'SecureStoreReadError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

export interface SecureReadResult {
  value: string | null
  status: SecureStorageStatus
  /** 读到的是旧版 `raw:` 明文，调用方应尽快用 encryptValue 覆盖写回。 */
  needsMigration: boolean
}

/** 凭证文件里我们用到的槽位名。 */
export const API_KEY_SLOT = 'apiKey'

const ENC_PREFIX = 'enc:'
const RAW_PREFIX = 'raw:'

/**
 * 加密一个值。
 *
 * 加密不可用时**抛错**，绝不降级成 Base64 明文 —— 那只是把「随手 cat 就拿到」
 * 换成「随手 base64 -d 就拿到」，等于没加密。抛错还保证调用方在写盘之前就失败，
 * 原有密文不会被这次写入覆盖。
 */
export function encryptValue(safe: SafeStorageLike, value: string): string {
  if (!safe.isEncryptionAvailable()) {
    throw new SecureStoreUnavailableError(
      '这台机器上没有可用的系统密钥存储（DPAPI / Keychain），为避免明文落盘，凭证没有保存',
    )
  }
  return `${ENC_PREFIX}${safe.encryptString(value).toString('base64')}`
}

/**
 * 解密一个存储值。
 *
 * 只做「能不能解出来」的判断，**不负责删除或改写**：解不开时返回 read-error，
 * 让上层提示用户，原密文原封不动地留在盘上（可能只是密钥暂时不可用）。
 */
export function decryptValue(
  safe: SafeStorageLike,
  stored: string,
): { value: string | null; status: SecureStorageStatus } {
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      return { value: safe.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')), status: 'available' }
    } catch {
      return { value: null, status: 'read-error' }
    }
  }
  // 旧版降级路径写下的 Base64「明文」：只为迁移而兼容读取。
  if (stored.startsWith(RAW_PREFIX)) {
    try {
      return { value: Buffer.from(stored.slice(RAW_PREFIX.length), 'base64').toString('utf8'), status: 'available' }
    } catch {
      return { value: null, status: 'read-error' }
    }
  }
  // 认不出的格式：不能当成「没配置」，否则会被一个空 blob 覆盖掉。
  return { value: null, status: 'read-error' }
}

/** 读凭证槽位，并把「没有存档」和「读失败」区分开。 */
export function readSecureEntry(safe: SafeStorageLike, store: Record<string, string>): SecureReadResult {
  const stored = store[API_KEY_SLOT]
  if (stored === undefined) {
    // 确实没有存档：能不能写入取决于加密后端在不在。
    return {
      value: null,
      status: safe.isEncryptionAvailable() ? 'available' : 'unavailable',
      needsMigration: false,
    }
  }
  const decoded = decryptValue(safe, stored)
  return {
    ...decoded,
    needsMigration: decoded.status === 'available' && stored.startsWith(RAW_PREFIX),
  }
}

/**
 * 读凭证文件。
 *
 * 三种情况必须分开（这是本文件最重要的一条约束）：
 *   1. 文件不存在 → 正常的空存储，返回 `{}`；
 *   2. 读到了、JSON 合法、结构也合法（对象 + 值都是字符串）→ 返回内容；
 *   3. 其它一切（无权限 / IO 错误 / JSON 损坏 / 结构不合法）→ **抛 SecureStoreReadError**。
 *
 * 第 3 种绝不能返回 `{}`：那等于告诉上层「用户没配过 Key」，于是一次普通的
 * 保存设置就会把盘上那份可能还能恢复的密文覆盖掉。
 */
export function readSecureStoreFile(file: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // 只有「确实不存在」才算正常的空存储。
    if (code === 'ENOENT') return {}
    throw new SecureStoreReadError(`凭证文件读取失败（${code ?? 'unknown'}）`, { cause: error })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SecureStoreReadError('凭证文件不是合法 JSON，已保留原文件等待处理', { cause: error })
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SecureStoreReadError('凭证文件结构不合法（应为对象），已保留原文件')
  }

  const store: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new SecureStoreReadError(`凭证文件字段 ${key} 不是字符串，已保留原文件`)
    }
    store[key] = value
  }
  return store
}

export function writeSecureStoreFile(file: string, store: Record<string, string>): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store), 'utf8')
}

/**
 * 读凭证（含旧版 `raw:` 明文的一次性升级）。
 *
 * 这是 `secure:get` 的完整实现，测试直接打这里 —— 避免测试里再抄一份
 * 「先加密再写」的顺序，抄的那份永远不会发现顺序被改错。
 */
export function readSecureValue(safe: SafeStorageLike, file: string): SecureReadResult {
  // 读不出来就抛（→ 上层 read-error），绝不在这里吞成空表。
  const store = readSecureStoreFile(file)
  const result = readSecureEntry(safe, store)
  if (result.needsMigration && result.value !== null) {
    try {
      store[API_KEY_SLOT] = encryptValue(safe, result.value)
      writeSecureStoreFile(file, store)
    } catch (error) {
      // 升级失败不静默：本次仍可用内存里的明文值，但必须留下痕迹，下次启动再试。
      console.warn('[secure-store] 旧版 raw: 凭证升级失败，本次仍可继续使用', error)
    }
  }
  return result
}

/**
 * 写凭证。
 *
 * **加密在写盘之前**：加密不可用时 `encryptValue` 直接抛错，函数在 `writeSecureStoreFile`
 * 之前就退出，所以原文件一个字节都不会变（这是「失败不得清空原凭证」的实现基础）。
 */
export function writeSecureValue(safe: SafeStorageLike, file: string, value: string): void {
  const store = readSecureStoreFile(file)
  store[API_KEY_SLOT] = encryptValue(safe, value)
  writeSecureStoreFile(file, store)
}

/** 删除凭证。 */
export function removeSecureValue(file: string): void {
  const store = readSecureStoreFile(file)
  delete store[API_KEY_SLOT]
  writeSecureStoreFile(file, store)
}
