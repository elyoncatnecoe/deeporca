import { DEFAULT_WORKSPACE, deleteFile, getFile, listFiles, putFile } from './db'
import type { WorkspaceFile } from './types'

/** 单个文件的字符上限（不是字节）。 */
export const MAX_FILE_CHARS = 240_000

/**
 * executeTool 的调用方（引擎）在每次调用前塞进来的「项目名」。
 *
 * 为什么不直接给 executeTool 加参数：它的三参签名被历史回归测试锁着，
 * 又不能让 workspace.ts 反过来 import store 去查项目名 —— 那一层不该知道 store。
 * 引擎一轮里工具是顺序执行的，这个旁路不会有并发问题。
 */
let toolWorkspaceName = ''
export function setToolWorkspaceName(name: string): void {
  toolWorkspaceName = name
}

export interface ToolExecution {
  result: string
  changed: boolean
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'List every workshop project with its id and name. Call this before targeting a specific project.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_project',
      description: 'Create a NEW empty workshop project and return its id. Use it when the user wants a new app/page so the new code does not mix into an existing project.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'New project name, e.g. 个人主页' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List every file in one workshop project.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Optional: target project id or name (see list_projects). Omit to use the conversation\'s current project.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one workshop file by its relative path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path, such as index.html' },
          project: { type: 'string', description: 'Optional: target project id or name (see list_projects).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace one workshop file with the complete content. Use mode="append" to add to the end of an existing file (for writing a large file in several parts).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path, such as index.html or src/app.js' },
          content: { type: 'string', description: 'Complete UTF-8 file content' },
          mode: {
            type: 'string',
            enum: ['overwrite', 'append'],
            description: 'overwrite (default) replaces the whole file; append adds content to the end.',
          },
          project: { type: 'string', description: 'Optional: target project id or name (see list_projects). Omit to use the conversation\'s current project.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete one workshop file. Only use when the user asked for it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          project: { type: 'string', description: 'Optional: target project id or name (see list_projects).' },
        },
        required: ['path'],
      },
    },
  },
] as const

function cleanPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('path 必须是字符串')
  const path = raw.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  if (path === '' || path.length > 160) throw new Error('路径为空或过长')
  if (path.split('/').some((part) => part === '..' || part === '')) throw new Error('路径不合法')
  if (!/^[a-zA-Z0-9._\-\/]+$/.test(path)) throw new Error('路径只能包含字母、数字、点、下划线、横线和斜杠')
  return path
}

function fileId(path: string, workspaceId: string): string {
  return `ws:${workspaceId}:${path}`
}

export async function readWorkspaceFile(
  path: string,
  workspaceId = DEFAULT_WORKSPACE,
): Promise<WorkspaceFile | undefined> {
  return getFile(cleanPath(path), workspaceId)
}

export async function writeWorkspaceFile(
  path: string,
  content: string,
  workspaceId = DEFAULT_WORKSPACE,
): Promise<WorkspaceFile> {
  const safePath = cleanPath(path)
  // 240_000 是字符数不是字节：老文案按 KB 写会误导，改成人能核对的字符数。
  if (content.length > MAX_FILE_CHARS) throw new Error('文件太大（上限 240000 字符）')
  const now = Date.now()
  const existing = await getFile(safePath, workspaceId)
  const file: WorkspaceFile = {
    id: existing?.id ?? fileId(safePath, workspaceId),
    workspaceId,
    path: safePath,
    content,
    updatedAt: now,
  }
  await putFile(file)
  return file
}

export async function deleteWorkspaceFile(path: string, workspaceId = DEFAULT_WORKSPACE): Promise<void> {
  const safePath = cleanPath(path)
  const existing = await getFile(safePath, workspaceId)
  if (existing) await deleteFile(existing.id)
}

/**
 * 重命名（其实是改路径，因为 path 就是文件在项目里的唯一标识）。
 *
 * 做法是「写新路径 + 删旧记录」：id 由 path 派生，不能原地改。
 * 目标路径已存在时直接报错，不覆盖 —— 改名手滑不该吃掉别人的文件。
 */
export async function renameWorkspaceFile(
  oldPath: string,
  newPath: string,
  workspaceId = DEFAULT_WORKSPACE,
): Promise<WorkspaceFile> {
  const from = cleanPath(oldPath)
  const to = cleanPath(newPath)
  const source = await getFile(from, workspaceId)
  if (source === undefined) throw new Error(`文件不存在：${from}`)
  if (from === to) return source
  if ((await getFile(to, workspaceId)) !== undefined) throw new Error(`同名文件已存在：${to}`)
  const next: WorkspaceFile = {
    id: fileId(to, workspaceId),
    workspaceId,
    path: to,
    content: source.content,
    updatedAt: Date.now(),
  }
  await putFile(next)
  await deleteFile(source.id)
  return next
}

/** 把一个文件挪到另一个项目；目标项目已有同名文件时报错，不覆盖。 */
export async function moveWorkspaceFile(
  path: string,
  fromWorkspace: string,
  toWorkspace: string,
): Promise<WorkspaceFile> {
  const safePath = cleanPath(path)
  if (fromWorkspace === toWorkspace) throw new Error('目标项目和当前项目相同')
  const source = await getFile(safePath, fromWorkspace)
  if (source === undefined) throw new Error(`文件不存在：${safePath}`)
  if ((await getFile(safePath, toWorkspace)) !== undefined) {
    throw new Error(`目标项目里已有同名文件：${safePath}`)
  }
  const next: WorkspaceFile = {
    id: fileId(safePath, toWorkspace),
    workspaceId: toWorkspace,
    path: safePath,
    content: source.content,
    updatedAt: Date.now(),
  }
  await putFile(next)
  await deleteFile(source.id)
  return next
}

/**
 * 复制一份文件副本（不删源）。
 *
 * 和重命名的区别就在这里：改名是「写新 + 删旧」，备份必须留着原件。
 * 目标路径要过 cleanPath（只放行 ASCII），重名直接拒绝，别悄悄覆盖。
 */
export async function copyWorkspaceFile(
  sourcePath: string,
  destPath: string,
  workspaceId = DEFAULT_WORKSPACE,
): Promise<WorkspaceFile> {
  const from = cleanPath(sourcePath)
  const to = cleanPath(destPath)
  const source = await getFile(from, workspaceId)
  if (source === undefined) throw new Error(`文件不存在：${from}`)
  if ((await getFile(to, workspaceId)) !== undefined) throw new Error(`同名文件已存在：${to}`)
  const copy: WorkspaceFile = {
    id: fileId(to, workspaceId),
    workspaceId,
    path: to,
    content: source.content,
    updatedAt: Date.now(),
  }
  await putFile(copy)
  return copy
}

/**
 * 把整个项目的文件复制进另一个项目（整项目副本用）。
 *
 * 这里故意不走 cleanPath / writeWorkspaceFile：老项目里历史上可能存着非 ASCII
 * 路径，重校验会把它们全判非法、副本就缺文件了。直接按 fileId 重算主键写库。
 */
export async function duplicateWorkspaceFiles(fromId: string, toId: string): Promise<void> {
  const files = await listFiles(fromId)
  const now = Date.now()
  for (const file of files) {
    await putFile({
      ...file,
      id: `ws:${toId}:${file.path}`,
      workspaceId: toId,
      updatedAt: now,
    })
  }
}

export async function listWorkspaceFiles(workspaceId = DEFAULT_WORKSPACE): Promise<WorkspaceFile[]> {
  return listFiles(workspaceId)
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new Error('工具参数不是合法 JSON')
  }
}

export async function executeTool(
  name: string,
  rawArgs: string,
  workspaceId = DEFAULT_WORKSPACE,
): Promise<ToolExecution> {
  const args = parseArgs(rawArgs)
  if (name === 'list_files') {
    const files = await listWorkspaceFiles(workspaceId)
    // 表头带上项目名（引擎在调用前用 setToolWorkspaceName 喂进来），模型才知道列的是哪个项目。
    const header = `项目「${toolWorkspaceName || workspaceId}」的文件：`
    if (files.length === 0) return { result: `${header}\n（空）`, changed: false }
    return {
      result: `${header}\n${files.map((file) => `- ${file.path} (${file.content.length} chars)`).join('\n')}`,
      changed: false,
    }
  }
  if (name === 'read_file') {
    const path = cleanPath(args.path)
    const file = await getFile(path, workspaceId)
    if (file === undefined) return { result: `文件不存在：${path}`, changed: false }
    return { result: file.content, changed: false }
  }
  if (name === 'write_file') {
    if (typeof args.content !== 'string') throw new Error('content 必须是字符串')
    const append = args.mode === 'append'
    if (append) {
      /*
       * 追加模式：给「一个大文件分几次写」用的。
       *
       * 为什么需要它：单次生成的输出上限（正文 + 思考共用 max_tokens）经常不够
       * 写完一个几千行的 HTML/JS，模型只能被截断；有了 append，模型可以分 2-3 次
       * 调用把同一个文件写完整，不必跟输出上限硬碰。
       */
      const existing = await getFile(cleanPath(args.path), workspaceId)
      const base = existing?.content ?? ''
      const file = await writeWorkspaceFile(String(args.path), `${base}${args.content}`, workspaceId)
      return { result: `已追加到 ${file.path}（现在 ${file.content.length} 字符）`, changed: true }
    }
    const file = await writeWorkspaceFile(String(args.path), args.content, workspaceId)
    return { result: `已写入 ${file.path}（${file.content.length} 字符）`, changed: true }
  }
  if (name === 'delete_file') {
    const path = cleanPath(args.path)
    await deleteWorkspaceFile(path, workspaceId)
    return { result: `已删除 ${path}`, changed: true }
  }
  return { result: `未知工具：${name}`, changed: false }
}

function resolveAsset(reference: string, byPath: Map<string, string>): string | undefined {
  const cleaned = reference.trim().replace(/^\.?\//, '').split('?')[0]?.split('#')[0] ?? ''
  return byPath.get(cleaned) ?? byPath.get(cleaned.toLowerCase())
}

const PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data: blob: https: http:",
  "style-src 'unsafe-inline' https: http:",
  /*
   * 工坊里的页面经常要引 CDN 库（three.js 是典型），模块写法还要 blob:；
   * 'unsafe-eval' 给那些内部用 new Function 的库留条路。
   * 预览跑在 sandbox="allow-scripts"（不给 allow-same-origin）的 iframe 里，
   * 是不透明源，读不到 App 的存储，所以放开这些不会碰到用户数据。
   */
  "script-src 'unsafe-inline' 'unsafe-eval' https: http: blob:",
  "font-src data: https: http:",
  "connect-src https: http:",
  "media-src data: blob: https: http:",
  "worker-src blob: https: http:",
].join('; ')

/**
 * 预览页也要关掉「点击高亮」。
 *
 * Android WebView 的默认 tap highlight 是系统色 #33b5e5 的 20% 透明：
 * 用户看到的就是「点一下冒出一大片半透明浅蓝色蒙版」。它是**按文档**生效的 ——
 * 主界面 body 上那条 -webkit-tap-highlight-color: transparent 管不到 iframe 里的
 * 另一份文档，所以预览页必须自己带一条重置。只影响点击反馈，不改页面排版与配色。
 */
const PREVIEW_TAP_RESET = '<style data-deepsea-tap-reset>html,body,*{-webkit-tap-highlight-color:transparent}</style>'

export function injectPreviewCsp(html: string): string {
  const hasCsp = /http-equiv=["']Content-Security-Policy["']/i.test(html.slice(0, 4000))
  const head = hasCsp
    ? PREVIEW_TAP_RESET
    : `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">\n${PREVIEW_TAP_RESET}`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (headTag) => `${headTag}\n${head}`)
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
}

export function bundleWorkspaceHtml(files: readonly WorkspaceFile[]): { html: string; entry: string | null } {
  const byPath = new Map(files.map((file) => [file.path, file.content]))
  const lower = new Map(files.map((file) => [file.path.toLowerCase(), file.content]))
  const find = (path: string): string | undefined => byPath.get(path) ?? lower.get(path.toLowerCase())

  let entry = files.find((file) => file.path.toLowerCase() === 'index.html')?.path
  if (entry === undefined) {
    entry = files.find((file) => file.path.toLowerCase().endsWith('.html'))?.path
  }
  if (entry === undefined) {
    return {
      entry: null,
      html: injectPreviewCsp(
        `<!doctype html><html><head><meta charset="utf-8"><style>
          html,body{height:100%;margin:0;background:#04141d;color:#a9d9e3;font:15px system-ui,sans-serif}
          body{display:grid;place-items:center;text-align:center;padding:32px}
          strong{color:#7fe3d4;display:block;margin-bottom:8px;font-size:18px}
        </style></head><body><div><strong>工坊还是空的</strong>让深鲸写一个页面，或新建一个 index.html。</div></body></html>`,
      ),
    }
  }
  const source = find(entry) ?? ''
  let html = source.replace(
    /<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi,
    (match, href: string) => {
      const css = resolveAsset(href, byPath)
      return css === undefined ? match : `<style data-inlined="${href}">\n${css}\n</style>`
    },
  )
  html = html.replace(
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    (match, before: string, src: string, after: string) => {
      const js = resolveAsset(src, byPath)
      return js === undefined ? match : `<script${before}${after}>\n${js}\n</script>`
    },
  )
  return { html: injectPreviewCsp(html), entry }
}

export async function previewHtml(workspaceId = DEFAULT_WORKSPACE): Promise<{ html: string; entry: string | null }> {
  const files = await listWorkspaceFiles(workspaceId)
  return bundleWorkspaceHtml(files)
}
