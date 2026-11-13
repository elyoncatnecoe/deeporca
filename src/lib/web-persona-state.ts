/**
 * 网页账号「人设只拼一次」的去重状态机。
 *
 * 为什么单独抽出来：网页账号有两条链路，各存一份「这一版人设已经拼进去过」的标记 ——
 *   · HTTP 直发：Electron 的 `thread.persona`、Android 的 `WebThread.persona`（落盘）；
 *   · DOM 遥控：注入脚本里 localStorage 的 `CTX_KEY`（见 web-relay.ts）。
 * 两条链路的规则必须一致，否则会出现很难查的状态：关掉助手再打开同一个助手，
 * 去重以为 A 已经注入过，于是**再也不注入**。
 *
 * 规则（两端必须逐条对应）：
 *   1. 空人设 = 助手被关掉了：这一轮不注入，并且**把缓存清空**。
 *      不清的话，「开 A → 关 → 再开 A」第三步会被判定成「A 已经拼过」而跳过。
 *   2. 非空且与缓存不同：注入；缓存等这条消息**真的发成功**之后才记
 *      （调用方负责，见 deepseek-api.ts 的 `needPersona` 落点）。
 *   3. 非空且与缓存相同：不注入。
 *
 * 注意：清缓存只是让「下次要重新注入」，**不会**、也无法撤回已经发进网页会话里的
 * 旧消息。网页线程的 sid / mid / 历史一律不动。
 */
export interface PersonaDecision {
  /** 这一轮要不要把人设拼进 prompt。 */
  inject: boolean
  /** 发成功之后应该记下的缓存值；空串表示「缓存要清掉」。 */
  cache: string
}

export function decidePersona(cached: string, incoming: string): PersonaDecision {
  const persona = incoming.trim()
  // 空人设：不注入，同时把缓存清空（第 1 条）。
  if (persona === '') return { inject: false, cache: '' }
  return { inject: persona !== cached, cache: persona }
}
