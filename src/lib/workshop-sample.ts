import orcaHtml from './samples/orca.html?raw'
import orcaJs from './samples/orca.js?raw'
import { DEFAULT_WORKSPACE, listFiles } from './db'
import { writeWorkspaceFile } from './workspace'

/**
 * 工坊的预置范例：一只纸雕虎鲸。
 *
 * 新用户第一次进工坊看到空白编辑器没什么说服力，所以这里塞一个真的能玩的
 * 东西进去——它同时也是「成品长什么样」的默认参照。
 *
 * 两个文件会被工坊的打包器合成一个页面：
 *   index.html 里的 <script src="./app.js"> 由 bundleWorkspaceHtml 内联。
 *
 * 只种一次：写一个 .seeded 占位文件，之后用户删掉范例也不会再塞回来。
 */

const SEED_FLAG = '.seeded'
const SEED_ENTRY = 'index.html'
const SEED_SCRIPT = 'app.js'

export function sampleFiles(): Array<{ path: string; content: string }> {
  return [
    { path: SEED_ENTRY, content: orcaHtml },
    { path: SEED_SCRIPT, content: orcaJs },
  ]
}

async function markSeeded(workspaceId: string): Promise<void> {
  await writeWorkspaceFile(SEED_FLAG, '', workspaceId)
}

/**
 * 工坊是空的就写入范例。已经有文件（或已经种过）就什么都不做。
 * @returns 是否真的写入了。
 */
export async function seedWorkspaceIfEmpty(workspaceId = DEFAULT_WORKSPACE): Promise<boolean> {
  try {
    const files = await listFiles(workspaceId)
    // 已经种过，或者用户本来就有自己的东西：不打扰。
    if (files.some((file) => file.path === SEED_FLAG)) return false
    if (files.length > 0) {
      await markSeeded(workspaceId)
      return false
    }
    for (const file of sampleFiles()) {
      await writeWorkspaceFile(file.path, file.content, workspaceId)
    }
    await markSeeded(workspaceId)
    return true
  } catch (error) {
    // 种范例失败绝不能挡住工坊打开。
    console.warn('[workshop] seed skipped', error)
    return false
  }
}

/** 用户主动点「恢复范例」时调用：不管现状，直接覆盖写入。 */
export async function restoreSample(workspaceId = DEFAULT_WORKSPACE): Promise<void> {
  for (const file of sampleFiles()) {
    await writeWorkspaceFile(file.path, file.content, workspaceId)
  }
  await markSeeded(workspaceId)
}

/** 让「恢复范例」只在真的写过之后才可用（列表里不该出现 .seeded）。 */
export function visibleFiles(files: readonly { path: string }[]): string[] {
  return files.filter((file) => !file.path.startsWith('.')).map((file) => file.path)
}