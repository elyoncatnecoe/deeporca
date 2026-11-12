import wasmBrowserUrl from 'sql.js/dist/sql-wasm-browser.wasm?url'
import { parseRikkaRows, type RikkaConversationRow, type RikkaNodeRow } from './rikkahub'
import type { ParsedImport } from './types'

/**
 * SQLite 读取层（只在浏览器/Electron 渲染层跑）。
 *
 * 为什么单独一层：sql.js 是 WASM，加载方式依赖打包器（wasm 要走 Vite 的 ?url 资源），
 * 而纯映射逻辑（rikkahub.ts）要能被 node 脚本直接拿来验证。两者分开，测试不用拖进 WASM。
 *
 * wasm 用 `?url` 导入而不是写死 '/sql-wasm.wasm'：本项目 vite base 是 './'（打包后从
 * file:// 或 assets 相对路径加载），绝对路径 '/' 在安装版里会 404；?url 由打包器给出
 * 正确的相对/哈希地址。
 */

type SqlValue = number | string | Uint8Array | null

interface QueryResult {
  columns: string[]
  values: SqlValue[][]
}

interface SqlDatabaseLike {
  exec: (sql: string) => QueryResult[]
  close: () => void
}

interface SqlStaticLike {
  Database: new (data?: Uint8Array) => SqlDatabaseLike
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasTable(database: SqlDatabaseLike, name: string): boolean {
  const result = database.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`)
  return result.length > 0 && (result[0]?.values.length ?? 0) > 0
}

function selectConversations(database: SqlDatabaseLike): RikkaConversationRow[] {
  const result = database.exec('SELECT id, title, create_at, update_at FROM ConversationEntity')
  const rows = result[0]?.values ?? []
  return rows.map((row) => ({
    id: String(row[0] ?? ''),
    title: row[1] === null || row[1] === undefined ? null : String(row[1]),
    create_at: typeof row[2] === 'number' ? row[2] : null,
    update_at: typeof row[3] === 'number' ? row[3] : null,
  })).filter((row) => row.id !== '')
}

function selectNodes(database: SqlDatabaseLike): RikkaNodeRow[] {
  const result = database.exec(
    'SELECT id, conversation_id, node_index, messages, select_index FROM message_node ORDER BY conversation_id, node_index',
  )
  const rows = result[0]?.values ?? []
  return rows.map((row) => ({
    id: String(row[0] ?? ''),
    conversation_id: String(row[1] ?? ''),
    node_index: typeof row[2] === 'number' ? row[2] : null,
    messages: row[3] === null || row[3] === undefined ? null : String(row[3]),
    select_index: typeof row[4] === 'number' ? row[4] : null,
  })).filter((row) => row.conversation_id !== '')
}

export async function parseRikkahub(bytes: Uint8Array): Promise<ParsedImport> {
  let SQL: SqlStaticLike
  try {
    // 动态 import：sql.js 的 JS + WASM 加起来上兆，只有真的选到 .db 时才加载，
    // 不让普通 JSON/ZIP 导入（甚至只是打开记忆页）去背这份体积。
    const mod = await import('sql.js')
    const initSqlJs = (mod.default ?? mod) as unknown as (config?: { locateFile?: (file: string) => string }) => Promise<SqlStaticLike>
    SQL = await initSqlJs({ locateFile: () => wasmBrowserUrl })
  } catch (error) {
    throw new Error(`加载 SQLite 解析器失败（WASM 没准备好）：${describeError(error)}`)
  }

  let database: SqlDatabaseLike
  try {
    database = new SQL.Database(bytes)
  } catch (error) {
    throw new Error(`这个文件不是有效的 SQLite 数据库：${describeError(error)}`)
  }

  try {
    if (!hasTable(database, 'ConversationEntity') || !hasTable(database, 'message_node')) {
      throw new Error('这个 .db 里找不到 rikkahub 的会话表（ConversationEntity / message_node）')
    }
    return parseRikkaRows(selectConversations(database), selectNodes(database))
  } catch (error) {
    throw new Error(`读取 rikkahub 数据库失败：${describeError(error)}`)
  } finally {
    database.close()
  }
}
