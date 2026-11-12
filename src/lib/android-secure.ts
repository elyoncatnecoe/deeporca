/**
 * Android 安全存储（Keystore 插件 + 旧版 localStorage 明文迁移）的纯逻辑层。
 *
 * 从 platform.ts 抽出来的原因：platform.ts 直接依赖 Capacitor 的运行时
 * （`bridge()` / `Capacitor.getPlatform()`），在 node 单测里没法真实驱动；
 * 而「失败时不许降级写明文」「迁移失败要保留旧值」「读失败不许伪装成没配置」
 * 这三条规则必须能被自动化测试守住。
 *
 * platform.ts 只负责把真实依赖注入进来，判断逻辑全在这里。
 */
import type { SecureStorageStatus } from './secure-types'

/** 安全存储写入被拒。调用方必须提示用户，绝不能退回明文存储。 */
export class SecureStorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecureStorageError'
  }
}

export interface AndroidSecureDeps {
  /** 读 Keystore 插件。插件正常但没有值时应 resolve(null)。 */
  pluginGet: () => Promise<string | null>
  pluginSet: (value: string) => Promise<void>
  pluginRemove: () => Promise<void>
  /** 旧版降级路径留下的明文（localStorage）。没有返回 null。 */
  legacyGet: () => string | null
  legacyRemove: () => void
}

export interface AndroidSecureReadResult {
  value: string | null
  status: SecureStorageStatus
}

/**
 * 把插件异常归类。
 *
 * 「插件没注册 / 没实现」是**确定的不可用**；其它异常（Keystore 被锁、密钥暂时失效、
 * 解密失败）只能说明「这次读不出来」，不能断言凭证不存在。
 */
export function classifyPluginError(error: unknown): SecureStorageStatus {
  const message = error instanceof Error ? error.message : String(error)
  return /not implemented|not available|not registered|no such plugin/i.test(message)
    ? 'unavailable'
    : 'read-error'
}

/**
 * 读取凭证。
 *
 * 顺序：插件 → 旧版明文迁移。任何一步失败都**不会**返回「就是没配置」这个结论，
 * 除非插件明确正常且旧版也没有残留。
 */
export async function androidSecureGet(deps: AndroidSecureDeps): Promise<AndroidSecureReadResult> {
  let pluginStatus: SecureStorageStatus | null = null
  try {
    const value = await deps.pluginGet()
    if (typeof value === 'string' && value !== '') return { value, status: 'available' }
  } catch (error) {
    pluginStatus = classifyPluginError(error)
  }

  // 插件里没有值（或读失败）：看看旧版降级路径有没有留下明文。
  const legacy = deps.legacyGet()
  if (legacy === null || legacy === '') {
    // 没有任何旧值可救。插件读失败时如实报告失败，不谎称「尚未配置」。
    return { value: null, status: pluginStatus ?? 'available' }
  }

  // 有旧值：尝试搬进 Keystore。
  try {
    await deps.pluginSet(legacy)
  } catch {
    // 迁移失败：**保留旧值**（不删），否则用户唯一一份凭证就没了。
    // 状态报 unavailable —— 值能用，但后续写入一定失败，上层据此提示。
    return { value: legacy, status: 'unavailable' }
  }
  // 只有搬成功了才允许删旧值。
  deps.legacyRemove()
  return { value: legacy, status: 'available' }
}

/**
 * 写入凭证。
 *
 * 失败直接抛错 —— 绝不退回 localStorage 明文。调用方（store）会把
 * SecureStorageError 变成用户可见的提示。
 */
export async function androidSecureSet(deps: AndroidSecureDeps, value: string): Promise<void> {
  try {
    await deps.pluginSet(value)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new SecureStorageError(`系统安全存储不可用（${detail}）`)
  }
}

/**
 * 删除凭证。
 *
 * 删不掉就是**没删掉**：必须抛出去让上层如实提示，否则 UI 会显示「已清空」，
 * 而设备上的密文其实还在 —— 用户以为注销干净了，实际没有。
 *
 * 顺序也有讲究：只有插件删除成功之后，才允许清掉旧版明文残留。
 */
export async function androidSecureRemove(deps: AndroidSecureDeps): Promise<void> {
  try {
    await deps.pluginRemove()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new SecureStorageError(`系统安全存储删除失败（${detail}），凭证可能仍留在设备上`)
  }
  deps.legacyRemove()
}
