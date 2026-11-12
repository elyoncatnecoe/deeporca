import { linkAbort, raceAbort } from './abort'
import type { McpServerConfig, ProviderProtocol } from './types'

/**
 * MCP 客户端。只实现我们真正需要的那部分协议：
 * initialize → tools/list → tools/call。
 *
 * 传输有三种：
 * - Streamable HTTP（2025 规范，一次 POST 一个 JSON-RPC，响应可能是 JSON 或 SSE 流）；
 * - SSE（旧规范，先 GET 一个事件流拿 endpoint，再 POST 到该 endpoint）；
 * - stdio（本地子进程，一行一个 JSON-RPC；由 Electron 主进程代跑）。
 * 对外形状一样，所以 UI 和工具注册都不用关心服务器用哪种。
 */

export type McpTransport = 'streamable_http' | 'sse' | 'stdio'

export interface McpToolDef {
  name: string
  description: string
  /** JSON Schema，已把 $ref 内联展开。 */
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  /** 拼好的文本结果。 */
  text: string
  isError: boolean
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'deepsea', version: '1.0.0' }

/* ------------------------------------------------------ 超时与取消 */

/** 建立会话（initialize + tools/list）最多等多久。 */
const MCP_CONNECT_TIMEOUT_MS = 30_000
/** 单次工具调用最多等多久。挂住的服务器不该让整轮对话永远转圈。 */
const MCP_CALL_TIMEOUT_MS = 120_000
/** initialized 通知这类「发了就不管」的请求，最多等这么久。 */
const MCP_NOTIFY_TIMEOUT_MS = 15_000

/** linkAbort / raceAbort 在 ./abort 里（web-chat.ts 也要用同一份）。 */


function timeoutMessage(what: string, timeoutMs: number): string {
  return `${what}：服务器 ${Math.round(timeoutMs / 1000)} 秒没有响应，这次先放弃（可以再试一次，或检查服务器是否还活着）`
}

function serverLabel(config: McpServerConfig): string {
  return config.name.trim() !== '' ? config.name : config.url.trim() !== '' ? config.url : config.command
}

/* ------------------------------------------------- codeface: $ref 内联 */

const SCHEMA_KEYWORDS = new Set([
  'items', 'prefixItems', 'additionalItems', 'unevaluatedItems', 'contains',
  'additionalProperties', 'unevaluatedProperties', 'propertyNames',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'contentSchema',
])
const SCHEMA_MAP_KEYWORDS = new Set([
  'properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions',
])

function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined
  const tokens = ref.slice(1).split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
  let current: unknown = root
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[token]
    } else {
      return undefined
    }
    if (current === undefined) return undefined
  }
  return current
}

/**
 * 把 JSON Schema 里的文档内 $ref 展开掉。
 *
 * 为什么必须做：部分 provider（典型是 Gemini）不接受 $ref，一旦请求里出现悬空引用
 * 整个请求会被拒；另外我们生成 tool 定义时也只需要扁平结构。
 */
export function inlineSchemaRefs(schema: unknown, root?: unknown, resolving: Set<string> = new Set()): unknown {
  const base = root ?? schema
  if (Array.isArray(schema)) return schema.map((item) => inlineSchemaRefs(item, base, resolving))
  if (typeof schema !== 'object' || schema === null) return schema

  const obj = schema as Record<string, unknown>
  const ref = typeof obj.$ref === 'string' ? obj.$ref : null
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref') continue
    if (SCHEMA_KEYWORDS.has(key)) {
      rest[key] = Array.isArray(value)
        ? value.map((item) => inlineSchemaRefs(item, base, resolving))
        : inlineSchemaRefs(value, base, resolving)
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === 'object' && value !== null) {
      const mapped: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        mapped[k] = inlineSchemaRefs(v, base, resolving)
      }
      rest[key] = mapped
    } else {
      rest[key] = value
    }
  }
  if (ref === null) return rest

  const target = resolvePointer(base, ref)
  if (typeof target !== 'object' || target === null) {
    // 解析不出来的引用退化成「不限制」，别让请求因为一个指针失效就挂掉。
    return rest
  }
  if (resolving.has(ref)) {
    // 循环引用：回到自身的地方只保留类型，避免无限展开。
    const shallow: Record<string, unknown> = {}
    if ('type' in (target as Record<string, unknown>)) shallow.type = (target as Record<string, unknown>).type
    return { ...shallow, ...rest }
  }
  const expanded = inlineSchemaRefs(target, base, new Set([...resolving, ref]))
  return { ...(expanded as Record<string, unknown>), ...rest }
}

/* ------------------------------------------------------------ 传输实现 */

export interface McpSession {
  config: McpServerConfig
  tools: McpToolDef[]
  /** streamable http 的会话 id，后续请求要带上；stdio 恒为 null。 */
  sessionId: string | null
}

/**
 * 这个工具要不要先问用户。
 * 先看工具级覆盖，没有再落到服务器默认策略。
 */
export function needsApproval(config: McpServerConfig, toolName: string): boolean {
  const override = config.toolPolicies?.[toolName]
  if (override !== undefined) return override === 'always'
  return (config.defaultPolicy ?? 'always') === 'always'
}

/** 判定这个工具属于哪类操作，用来在确认弹窗里给出更直观的提示。 */
export function toolRiskHint(toolName: string, description: string): string {
  const text = `${toolName} ${description}`.toLowerCase()
  if (/delete|remove|drop|unlink|destroy|truncate|clear/.test(text)) return '可能删除数据'
  if (/write|create|update|edit|insert|append|save|mkdir|move|rename|patch/.test(text)) return '可能修改数据'
  if (/execute|run|shell|exec|spawn|command|script|eval/.test(text)) return '会在你的设备上执行命令'
  if (/send|post|upload|publish|push|webhook|email/.test(text)) return '会把数据发到外部'
  if (/read|get|list|search|query|fetch|find|describe|inspect/.test(text)) return '只读取信息'
  return ''
}

function headerPairs(headers: Record<string, string>): Record<string, string> {
  return { ...headers }
}

async function readSseJsonRpc(response: Response, wantId: number): Promise<JsonRpcResponse | null> {
  const body = response.body
  if (body === null) return null
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer)
        if (match === null) break
        const raw = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
        if (data === '') continue
        try {
          const parsed = JSON.parse(data) as JsonRpcResponse
          if (parsed.id === wantId || (parsed.result !== undefined && parsed.id === undefined)) return parsed
          if (parsed.error !== undefined) return parsed
        } catch {
          // 单个事件解析失败就跳过，不要中断整条流。
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  return null
}

/**
 * 发一个 JSON-RPC 请求。streamable http 下响应可能是 JSON 也可能是一条 SSE；
 * 两种都读得出来。
 */
async function postJsonRpc(
  config: McpServerConfig,
  request: JsonRpcRequest,
  sessionId: string | null,
  signal?: AbortSignal,
  timeoutMs: number = MCP_CALL_TIMEOUT_MS,
): Promise<{ response: Response; rpc: JsonRpcResponse | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...headerPairs(config.headers),
  }
  if (sessionId !== null) headers['Mcp-Session-Id'] = sessionId

  const link = linkAbort(signal, timeoutMs)
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: link.signal,
    })

    const contentType = response.headers.get('content-type') ?? ''
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`MCP 服务器返回 ${response.status}${detail !== '' ? `：${detail.slice(0, 200)}` : ''}`)
    }
    if (contentType.includes('text/event-stream')) {
      // 读流也在 try 里：服务器把头发回来之后就装死，同样要能超时。
      const rpc = await readSseJsonRpc(response, request.id)
      return { response, rpc }
    }
    const text = await response.text()
    if (text.trim() === '') return { response, rpc: null }
    try {
      return { response, rpc: JSON.parse(text) as JsonRpcResponse }
    } catch {
      return { response, rpc: null }
    }
  } catch (error) {
    // 超时和用户取消都表现为 AbortError，要分开说，别让用户以为是服务器坏了。
    if (link.timedOut()) throw new Error(timeoutMessage(`连不上 ${serverLabel(config)}`, timeoutMs))
    if (signal?.aborted === true) throw new Error('已停止')
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    link.dispose()
  }
}

function unwrap(rpc: JsonRpcResponse | null, what: string): unknown {
  if (rpc === null) throw new Error(`${what}：服务器没有返回内容`)
  if (rpc.error !== undefined) {
    throw new Error(`${what} 失败：${rpc.error.message ?? rpc.error.code ?? '未知错误'}`)
  }
  return rpc.result
}

/* ------------------------------------------------------------ stdio 传输 */

/**
 * stdio 走 Electron 主进程：渲染进程没有 spawn 权限。
 * 这里只做一次 IPC 往返，主进程负责维护子进程与 JSON-RPC 的 id 配对。
 */
async function stdioRequest(
  config: McpServerConfig,
  request: JsonRpcRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JsonRpcResponse> {
  const bridge = typeof window === 'undefined' ? undefined : window.deepsea
  if (bridge?.mcpStdioRequest === undefined) {
    throw new Error('当前环境不支持本地进程服务器（stdio 只在桌面版可用）')
  }
  // 主进程自己也有超时，但用户按「停止」时这边必须立刻松手，不能一直等它。
  const outcome = await raceAbort(bridge.mcpStdioRequest(config.command, config.args, request, timeoutMs), signal)
  if (!outcome.ok) throw new Error(outcome.error)
  return { jsonrpc: '2.0', id: request.id, result: outcome.result }
}

/* ------------------------------------------------------------ 对外接口 */

/**
 * 发一条通知（没有 id、服务器不回）。
 *
 * 和「请求」必须分开：请求会注册一个等待响应的 pending，通知不会有人回，
 * 走请求路径会一直挂到超时。
 */
async function sendNotification(
  config: McpServerConfig,
  method: string,
  sessionId: string | null,
): Promise<void> {
  if (config.transport === 'stdio') {
    const bridge = typeof window === 'undefined' ? undefined : window.deepsea
    if (bridge?.mcpStdioNotify === undefined) return
    // 主进程里写进 stdin 就算送达，不注册 pending。
    await bridge.mcpStdioNotify(config.command, config.args, { jsonrpc: '2.0', method }).catch(() => undefined)
    return
  }
  // 网络传输：POST 出去即可，响应内容不重要。但也不能无限等：挂住的服务器
  // 会把这个「后台通知」拖到天荒地老，顺手给个短超时。
  const link = linkAbort(undefined, MCP_NOTIFY_TIMEOUT_MS)
  try {
    await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId !== null ? { 'Mcp-Session-Id': sessionId } : {}),
        ...config.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      signal: link.signal,
    })
  } catch {
    // 通知丢了就丢了，不影响会话主流程。
  } finally {
    link.dispose()
  }
}

/** 建立会话：initialize → notifications/initialized → tools/list。 */
export async function connectMcpServer(config: McpServerConfig, signal?: AbortSignal): Promise<McpSession> {
  const isStdio = config.transport === 'stdio'
  if (isStdio) {
    if (config.command.trim() === '') throw new Error('还没填要启动的命令')
  } else if (config.url.trim() === '') {
    throw new Error('还没填服务器地址')
  }

  let id = 1
  const nextId = (): number => {
    id += 1
    return id
  }

  // 统一的请求入口：stdio 与网络两条路在下面分流。
  const send = async (request: JsonRpcRequest, sessionId: string | null): Promise<{ rpc: JsonRpcResponse | null; sessionId: string | null }> => {
    if (isStdio) return { rpc: await stdioRequest(config, request, MCP_CONNECT_TIMEOUT_MS, signal), sessionId: null }
    const result = await postJsonRpc(config, request, sessionId, signal, MCP_CONNECT_TIMEOUT_MS)
    return { rpc: result.rpc, sessionId: result.response.headers.get('mcp-session-id') }
  }

  const initResult = await send({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  }, null)
  unwrap(initResult.rpc, '初始化')
  const sessionId = initResult.sessionId

  // 规范要求 initialize 之后发一条 initialized 通知。
  // 通知没有 id、服务器也不会回，所以**不能**走请求路径 ——
  // stdio 下走请求路径会一直等到超时，会话就这么卡住了。
  await sendNotification(config, 'notifications/initialized', sessionId)

  const listResult = await send({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/list',
    params: {},
  }, sessionId)
  const listed = unwrap(listResult.rpc, '获取工具列表') as {
    tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>
  }

  const tools: McpToolDef[] = (listed.tools ?? [])
    .filter((tool): tool is { name: string; description?: string; inputSchema?: unknown } => typeof tool.name === 'string' && tool.name !== '')
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      // 这里就把 $ref 展开掉，后面生成请求体时不用再管。
      inputSchema: (inlineSchemaRefs(tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>) ?? {},
    }))

  return { config, tools, sessionId }
}

/** 调用一个工具，把返回的 content 拍平成文本。 */
export async function callMcpTool(
  session: McpSession,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpCallResult> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: Date.now() % 1_000_000,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  }
  const rpc = session.config.transport === 'stdio'
    ? await stdioRequest(session.config, request, MCP_CALL_TIMEOUT_MS, signal)
    : (await postJsonRpc(session.config, request, session.sessionId, signal, MCP_CALL_TIMEOUT_MS)).rpc

  const result = unwrap(rpc, `调用 ${toolName}`) as {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>
    isError?: boolean
  }

  const parts: string[] = []
  for (const item of result.content ?? []) {
    if (typeof item.text === 'string') parts.push(item.text)
    else if (item.type === 'image' && typeof item.data === 'string') parts.push(`[图片 ${item.mimeType ?? ''}]`.trim())
    else parts.push(JSON.stringify(item))
  }
  const text = parts.join('\n').trim()
  return { text: text === '' ? '（工具没有返回内容）' : text, isError: result.isError === true }
}

/** 关掉一个 stdio 会话（结束时必须叫，否则子进程会一直挂着）。 */
export async function closeMcpStdio(config: McpServerConfig): Promise<void> {
  const bridge = typeof window === 'undefined' ? undefined : window.deepsea
  if (config.transport !== 'stdio' || bridge?.mcpStdioClose === undefined) return
  await bridge.mcpStdioClose(config.command, config.args).catch(() => undefined)
}

/** 转成我们内部工具定义的样子（OpenAI function 形状）。 */
export function toFunctionTool(serverName: string, tool: McpToolDef): Record<string, unknown> {
  // 工具名要带服务器前缀：不同服务器可能有同名工具，混在一起会串。
  const safeServer = serverName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return {
    type: 'function',
    function: {
      name: `mcp__${safeServer}__${tool.name}`,
      description: `[MCP:${serverName}] ${tool.description}`.slice(0, 1024),
      parameters: tool.inputSchema,
    },
  }
}