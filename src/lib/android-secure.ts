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
 * 三种结果必须分开处理：
 *   1. 插件成功返回**有效值** → 直接用；
 *   2. 插件成功返回 `null`/空 → 才允许去检查并迁移旧版 localStorage 明文；
 *   3. 插件**抛异常**（`UserNotAuthenticatedException` 等）→ 立即返回失败状态，
 *      **绝不进入迁移流程**。
 *
 * 第 3 条是红线：读失败说明 Keystore 里可能还有一份有效凭证，只是这次读不出来。
 * 这时候去读 localStorage、再 `pluginSet` 一次，等于用一份旧明文覆盖掉那份凭证；
 * 更糟的是删掉旧明文之后，两边都没了。
 */
export async function androidSecureGet(deps: AndroidSecureDeps): Promise<AndroidSecureReadResult> {
  let pluginValue: string | null
  try {
    pluginValue = await deps.pluginGet()
  } catch (error) {
    // 读失败：不碰 legacyGet / pluginSet / legacyRemove，如实上报。
    // 注意这里**不返回 available**：那会被上层当成「用户还没配置」。
    return { value: null, status: classifyPluginError(error) }
  }

  if (typeof pluginValue === 'string' && pluginValue !== '') {
    return { value: pluginValue, status: 'available' }
  }

  // 走到这里说明插件**明确成功且没有值**，这时才允许检查旧版明文。
  const legacy = deps.legacyGet()
  if (legacy === null || legacy === '') {
    // 确实没有旧值：这才是真的「尚未配置」。
    return { value: null, status: 'available' }
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
