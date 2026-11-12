/**
 * 凭证 blob 的读/写闸门。
 *
 * 为什么需要这一层：安全存储只有「一个槽位」（一串 JSON），而它同时承载
 * 「用户改主题」「用户改 Key」两种完全不同的写入意图。如果只按「blob 变了就写」
 * 判断，那么**读失败**时会得到一个空 blob，于是「改个主题」就会顺手把用户原有
 * 的凭证删掉 —— 这正是本状态机要堵的洞。
 *
 * 规则（对应 read-error 的四条禁令）：
 *   1. 读失败时绝不写、绝不删、绝不迁移；
 *   2. 读失败 + 本次 blob 为空（只改了普通设置）→ 静默跳过；
 *   3. 读失败 + 本次 blob 非空（用户想写新 Key）→ 明确报错，不覆盖；
 *   4. 任何失败路径都不改动 knownBlob，下次启动仍按「未知」处理。
 */
import { SecureStorageError } from './android-secure'
import {
  SECURE_READ_ERROR_MESSAGE,
  SECURE_UNAVAILABLE_MESSAGE,
  type SecureStorageStatus,
} from './secure-types'
import { secureRead, secureRemove, secureSet } from './platform'

/** 空凭证集合的序列化形式。`''` 与 `'{}'` 视为同一种「没有 Key」。 */
const EMPTY_BLOB = '{}'

export type PersistOutcome = 'written' | 'removed' | 'skipped'

export interface SecureBackend {
  read: () => Promise<{ value: string | null; status: SecureStorageStatus }>
  write: (value: string) => Promise<void>
  remove: () => Promise<void>
}

export interface CredentialVault {
  getStatus: () => SecureStorageStatus
  /** 读回原始 blob；没有就是 `''`。读失败时返回 `''` 但状态为 read-error。 */
  load: () => Promise<string>
  /** 写回 blob。read-error 下永不触碰原密文。 */
  persist: (blob: string) => Promise<PersistOutcome>
}

/** 把 `null` / `''` 归一成空 blob，避免「空 vs 空」被判成变更。 */
function normalize(blob: string | null): string {
  return blob === null || blob === '' ? EMPTY_BLOB : blob
}

export function createCredentialVault(backend: SecureBackend): CredentialVault {
  let status: SecureStorageStatus = 'available'
  /** 已知的盘上内容；`null` 表示「不知道」（读失败/不可用）。 */
  let knownBlob: string | null = null

  return {
    getStatus: () => status,

    async load(): Promise<string> {
      const result = await backend.read()
      status = result.status
      if (status !== 'available') {
        // 读失败或不可用：我们不知道盘上是什么，绝不把它记成「空」。
        knownBlob = null
        return ''
      }
      const blob = normalize(result.value)
      knownBlob = blob
      return result.value ?? ''
    },

    async persist(blob: string): Promise<PersistOutcome> {
      const next = normalize(blob)
      const empty = next === EMPTY_BLOB

      if (status === 'read-error') {
        // 无法确认原凭证状态。空的写入说明只是改了普通设置 → 静默跳过；
        // 非空说明用户想写新 Key → 拒绝并让上层提示，绝不覆盖可能还能恢复的密文。
        if (empty) return 'skipped'
        throw new SecureStorageError(SECURE_READ_ERROR_MESSAGE)
      }

      if (status === 'unavailable') {
        // 不可用时写一定失败。空写入无需删除（也没有能安全删除的东西）。
        if (empty) return 'skipped'
        throw new SecureStorageError(SECURE_UNAVAILABLE_MESSAGE)
      }

      if (knownBlob !== null && next === knownBlob) return 'skipped'

      if (empty) {
        await backend.remove()
        knownBlob = next
        return 'removed'
      }
      await backend.write(blob)
      knownBlob = next
      return 'written'
    },
  }
}

/** 生产环境的后端：直接走 platform 的真实安全存储。 */
export const platformSecureBackend: SecureBackend = {
  read: () => secureRead(),
  write: (value) => secureSet(value),
  remove: () => secureRemove(),
}

let vault: CredentialVault = createCredentialVault(platformSecureBackend)

/** settings 每次操作都取当前 vault（测试会替换它）。 */
export function getCredentialVault(): CredentialVault {
  return vault
}

/**
 * 仅供测试注入后端。
 *
 * 名字带下划线是刻意的：生产代码不应调用它。真正需要换后端的地方只有
 * 单测（node 里没有 Electron / Capacitor / localStorage）。
 */
export function __setCredentialVaultForTest(next: CredentialVault): void {
  vault = next
}

/** 测试用：恢复成生产后端。 */
export function __resetCredentialVaultForTest(): void {
  vault = createCredentialVault(platformSecureBackend)
}
