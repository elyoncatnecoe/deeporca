/**
 * 水族馆进度存档的窄接口。
 *
 * 投喂数 / 体型 / 装饰 / 伙伴 / 皮肤 / 动作速度这些进度，是 3D 引擎自己写进
 * localStorage 的（见 `src/orca/persistence.ts`）。引擎是从参考项目整份移植来的
 * 独立模块，不该为了备份再动它的存储层。
 *
 * 所以这里只做一件极窄的事：**知道键名**，把整块 JSON 原样读出 / 写回。
 * 字段结构归引擎的 persistence.ts 管，这里刻意不解析 —— 否则同一个 schema
 * 要维护两份，改一边忘另一边就是静默丢数据。
 *
 * 照片**不在**备份范围内：8 张拍立得是 dataURL，能把备份撑大三倍。
 */
export const GAME_SAVE_KEY = 'orca-aquarium-shell:save:v1'

/** 读引擎存档；没有 / 坏了 / 不是对象都返回 null（备份里就不写这一项）。 */
export function readGameSave(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(GAME_SAVE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 写回引擎存档。localStorage 不可用（私密模式 / 沙箱）时静默跳过。 */
export function writeGameSave(save: Record<string, unknown>): void {
  try {
    localStorage.setItem(GAME_SAVE_KEY, JSON.stringify(save))
  } catch {
    // 存不进去不能让整个备份导入失败 —— 其它数据已经进库了。
  }
}
