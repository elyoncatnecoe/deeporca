import { callMcpTool, closeMcpStdio, connectMcpServer, needsApproval, toFunctionTool, toolRiskHint, type McpSession } from './mcp'
import type { McpServerConfig } from './types'

/**
 * MCP 连接注册表。
 *
 * 连上的服务器会缓存工具列表；断线的标记为不可用但保留配置，
 * 不会因为某台服务器挂了就让整轮对话失败。
 */

export interface McpState {
  config: McpServerConfig
  session: McpSession | null
  error: string | null
  connecting: boolean
}

const states = new Map<string, McpState>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribeMcp(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function listMcpStates(): McpState[] {
  return [...states.values()]
}

export function getMcpState(id: string): McpState | undefined {
  return states.get(id)
}

/** 连（或重连）一台服务器。失败只记录错误，不抛。 */
export async function connectServer(config: McpServerConfig): Promise<McpState> {
  const existing = states.get(config.id)
  if (existing?.connecting === true) return existing

  const state: McpState = { config, session: existing?.session ?? null, error: null, connecting: true }
  states.set(config.id, state)
  notify()

  try {
    const session = await connectMcpServer(config)
    const next: McpState = { config, session, error: null, connecting: false }
    states.set(config.id, next)
    notify()
    return next
  } catch (error) {
    const next: McpState = {
      config,
      session: null,
      error: error instanceof Error ? error.message : String(error),
      connecting: false,
    }
    states.set(config.id, next)
    notify()
    return next
  }
}

export function disconnectServer(id: string): void {
  const state = states.get(id)
  // stdio 的子进程挂在主进程上，断开时要显式关掉，否则会留成一个孤儿进程。
  if (state !== undefined && state.config.transport === 'stdio') {
    void closeMcpStdio(state.config)
  }
  states.delete(id)
  notify()
}

/** 这个配置填够了连它所需的信息没有。stdio 看命令，网络看地址。 */
function isConfigured(config: McpServerConfig): boolean {
  if (config.transport === 'stdio') return config.command.trim() !== ''
  return config.url.trim() !== ''
}

/** 按当前配置同步：新增的连接，删掉的断开。 */
export async function reconcileServers(configs: readonly McpServerConfig[]): Promise<void> {
  const enabled = configs.filter((config) => config.enabled && isConfigured(config))
  const wanted = new Set(enabled.map((config) => config.id))

  for (const id of [...states.keys()]) {
    if (!wanted.has(id)) disconnectServer(id)
  }
  await Promise.all(enabled.map(async (config) => {
    const current = states.get(config.id)
    // 目标变了就重连，否则沿用已有会话。stdio 的目标是命令 + 参数。
    const sameTarget = current?.session !== null
      && current?.config.transport === config.transport
      && current?.config.url === config.url
      && current?.config.command === config.command
      && JSON.stringify(current?.config.args) === JSON.stringify(config.args)
      && JSON.stringify(current?.config.headers) === JSON.stringify(config.headers)
    if (sameTarget) {
      states.set(config.id, { ...current, config })
      return
    }
    await connectServer(config)
  }))
  notify()
}

/**
 * 等到「正在连接」的服务器都有了结果。
 *
 * 开机的 reconcile 是后台跑的，用户可能马上发消息；不等的话这一轮就看不到 MCP 工具。
 * 只等一小会儿，连不上也照常往下走（不能因为一台服务器慢就把对话卡住）。
 */
export async function waitForReady(timeoutMs = 4000): Promise<void> {
  const connecting = (): boolean => [...states.values()].some((state) => state.connecting)
  if (!connecting()) return
  const deadline = Date.now() + timeoutMs
  while (connecting() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
}

/** 所有已连服务器里可用的工具，转成 OpenAI function 定义。 */
export function availableTools(): Array<{ serverId: string; serverName: string; toolName: string; definition: Record<string, unknown> }> {
  const out: Array<{ serverId: string; serverName: string; toolName: string; definition: Record<string, unknown> }> = []
  for (const state of states.values()) {
    if (state.session === null) continue
    for (const tool of state.session.tools) {
      out.push({
        serverId: state.config.id,
        serverName: state.config.name !== '' ? state.config.name : state.config.id,
        toolName: tool.name,
        definition: toFunctionTool(state.config.name !== '' ? state.config.name : state.config.id, tool),
      })
    }
  }
  return out
}

/** 这个工具名是不是 MCP 的（带 mcp__ 前缀）。 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__')
}

/* --------------------------------------------------------------- 审批 */

export interface ApprovalRequest {
  /** 唯一 id，UI 用它来应答。 */
  id: string
  serverId: string
  serverName: string
  toolName: string
  /** 完整工具名（mcp__server__tool），用于「总是允许」时记策略。 */
  fullName: string
  args: Record<string, unknown>
  /** 人类可读的风险提示，可能为空。 */
  risk: string
  description: string
}

export type ApprovalDecision = 'allow' | 'allow_always' | 'deny'

interface PendingApproval {
  request: ApprovalRequest
  resolve: (decision: ApprovalDecision) => void
  timer: number
}

const pendingApprovals = new Map<string, PendingApproval>()
let approvalSeq = 0

export function subscribeApprovals(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function listPendingApprovals(): ApprovalRequest[] {
  return [...pendingApprovals.values()].map((item) => item.request)
}

/** 用户在弹窗里点了某个按钮。 */
export function resolveApproval(id: string, decision: ApprovalDecision): void {
  const pending = pendingApprovals.get(id)
  if (pending === undefined) return
  window.clearTimeout(pending.timer)
  pendingApprovals.delete(id)
  pending.resolve(decision)
  notify()
}

/** 等用户确认。超时按拒绝处理 —— 宁可少做一次操作，也不要挂住整轮对话。 */
function requestApproval(
  request: Omit<ApprovalRequest, 'id'>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  const id = `apv_${(approvalSeq += 1)}`
  // 用户已经按了「停止」：没必要再弹一个没人会点的窗。
  if (signal?.aborted === true) return Promise.resolve('deny')
  return new Promise<ApprovalDecision>((resolve) => {
    let done = false
    let timer: number | undefined
    const finish = (decision: ApprovalDecision): void => {
      if (done) return
      done = true
      if (timer !== undefined) window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      pendingApprovals.delete(id)
      resolve(decision)
    }
    const onAbort = (): void => {
      finish('deny')
      notify()
    }
    timer = window.setTimeout(() => {
      finish('deny')
      notify()
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    pendingApprovals.set(id, { request: { ...request, id }, resolve: finish, timer })
    notify()
  })
}

/** 「总是允许」时要把策略写回配置。 */
let policyWriter: ((serverId: string, toolName: string) => void) | null = null

export function setPolicyWriter(writer: ((serverId: string, toolName: string) => void) | null): void {
  policyWriter = writer
}

/** 审批等待时长。太短会在用户还在读的时候超时。 */
const APPROVAL_TIMEOUT_MS = 120_000

function findStateByFullName(name: string): { state: McpState; toolName: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  if (match === null) return null
  const [, serverKey, toolName] = match as unknown as [string, string, string]
  const state = [...states.values()].find((item) => {
    const display = item.config.name !== '' ? item.config.name : item.config.id
    return display.replace(/[^a-zA-Z0-9_-]/g, '_') === serverKey
  })
  if (state === undefined) return null
  return { state, toolName }
}

/**
 * 调用一个 MCP 工具。name 形如 mcp__<server>__tool。
 * 需要确认的工具会先挂起，等用户在界面上点。
 * signal 来自本轮对话：用户按「停止」时，连同「等确认」和「等服务器」一起松手。
 */
export async function callToolByName(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const resolved = findStateByFullName(name)
  if (resolved === null) return `MCP 服务器不在线：${name}`
  const { state, toolName } = resolved
  if (state.session === null) {
    return `MCP 服务器未连接：${state.config.name}${state.error !== null ? `（${state.error}）` : ''}`
  }

  // 先问用户。
  if (needsApproval(state.config, toolName)) {
    const tool = state.session.tools.find((item) => item.name === toolName)
    const decision = await requestApproval({
      serverId: state.config.id,
      serverName: state.config.name,
      toolName,
      fullName: name,
      args,
      risk: toolRiskHint(toolName, tool?.description ?? ''),
      description: tool?.description ?? '',
    }, APPROVAL_TIMEOUT_MS, signal)

    if (decision === 'deny') {
      return `用户拒绝了这个操作（${toolName}），没有执行。如果不需要就别再尝试调用它。`
    }
    if (decision === 'allow_always') {
      policyWriter?.(state.config.id, toolName)
    }
  }

  try {
    const result = await callMcpTool(state.session, toolName, args, signal)
    return result.isError ? `工具报错：${result.text}` : result.text
  } catch (error) {
    return `调用 ${toolName} 失败：${error instanceof Error ? error.message : String(error)}`
  }
}