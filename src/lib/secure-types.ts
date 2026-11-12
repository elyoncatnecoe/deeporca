/**
 * 安全存储的状态契约。
 *
 * 为什么单独抽一个文件：这个三态值同时被 platform（读）、settings（判断能不能写）、
 * store（提示用户）和测试用到，散在各处就会出现「一边认为是没配置、一边认为是读失败」
 * 的分歧 —— 而那正好是最危险的一类分歧（会把用户已有的 Key 覆盖掉）。
 */

/**
 * - `available`：安全存储正常可用，读取成功（包括「确实没有存过 Key」）。
 * - `unavailable`：平台明确报告安全存储不可用（例如 Electron 的 safeStorage 后端缺失、
 *   Capacitor 插件没注册）。此时**不可能**安全写入。
 * - `read-error`：读取过程发生异常，**无法确认**原有凭证状态。此时必须假定「可能有一份
 *   还能恢复的密文」，任何写/删都可能把它毁掉。
 */
export type SecureStorageStatus = 'available' | 'unavailable' | 'read-error'

/**
 * read-error 时给用户看的原文。
 *
 * 注意措辞里刻意写成「Key」而不是「API Key」：Chat 的 notice 栏对包含 `API Key`
 * 的文案会追加一个「去填 Key」的链接（Chat.tsx:1278），那正好是「触发重新输入 Key
 * 的流程」，与本状态的要求相反。
 */
export const SECURE_READ_ERROR_MESSAGE = '安全存储读取失败，请勿重新输入Key，建议重启应用'

/** 安全存储不可用（写入被拒）时给用户看的原文。 */
export const SECURE_UNAVAILABLE_MESSAGE = '系统安全存储不可用，无法安全保存 API Key'
