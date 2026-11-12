import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * MCP stdio 传输。
 *
 * 渲染进程没有 spawn 权限，所以本地 MCP 服务器由主进程代跑：
 * 每行一个 JSON-RPC（MCP 的 stdio 规范），按 id 配对请求与响应。
 *
 * 进程按「命令 + 参数」共享 —— 同一份配置只起一个子进程，多次调用复用。
 */

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface Session {
  key: string
  child: ChildProcessWithoutNullStreams
  pending: Map<string, Pending>
  buffer: string
  stderr: string
  exited: boolean
  /**
   * 我们自己发号的 JSON-RPC id。
   *
   * 以前直接用渲染层传下来的 id 当键：`callMcpTool` 用的是 `Date.now() % 1e6`，
   * 同一毫秒发两个请求就撞号 —— 后来的把前一个的 pending 覆盖掉，前一个只能等到
   * 超时，响应还会投给错的那个（BUG-REVIEW P1-22）。现在每条请求在主进程这边
   * 重新发一个单调递增的 id，撞号不可能发生。
   */
  nextId: number
}

const sessions = new Map<string, Session>()

function sessionKey(command: string, args: string[]): string {
  return `${command}\u0000${args.join('\u0000')}`
}

function failAll(session: Session, reason: string): void {
  for (const [id, pending] of session.pending) {
    clearTimeout(pending.timer)
    pending.reject(new Error(reason))
    session.pending.delete(id)
  }
}

/**
 * 往子进程 stdin 写一行。
 *
 * 子进程先死、我们再往里写会异步抛 EPIPE；没有监听的话它就是主进程的
 * 未捕获异常（Electron 会弹一个红叉对话框，BUG-REVIEW P1-21）。
 * 这里统一收口：能写就写，写不了就返回 false，由调用方给一句人话。
 */
function writeLine(session: Session, payload: string): boolean {
  const stdin = session.child.stdin
  if (session.exited || stdin.destroyed || !stdin.writable) return false
  try {
    stdin.write(payload)
    return true
  } catch {
    return false
  }
}

function handleLine(session: Session, line: string): void {
  const text = line.trim()
  if (text === '') return
  let message: JsonRpcMessage
  try {
    message = JSON.parse(text) as JsonRpcMessage
  } catch {
    // 服务器可能往 stdout 打非 JSON 的日志，忽略就好。
    return
  }
  const id = message.id === undefined ? null : String(message.id)
  if (id === null) return // 通知，没有响应可配
  const pending = session.pending.get(id)
  if (pending === undefined) return
  session.pending.delete(id)
  clearTimeout(pending.timer)
  if (message.error !== undefined) {
    pending.reject(new Error(message.error.message ?? `JSON-RPC 错误 ${message.error.code ?? ''}`.trim()))
  } else {
    pending.resolve(message.result)
  }
}

function ensureSession(command: string, args: string[]): Session {
  const key = sessionKey(command, args)
  const existing = sessions.get(key)
  if (existing !== undefined && !existing.exited) return existing

  // 只有 Windows 的 .cmd/.bat 脚本必须经过 shell 才能起；
  // 其余一律直接 spawn —— 用 shell 会把参数拼成命令行，
  // 路径里带空格（"C:\Program Files\..."）会被从空格处截断。
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)

  // shell 模式下参数是自己拼进命令行的，必须逐个加引号，否则带空格的路径会被截断。
  const spawnArgs = needsShell
    ? args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    : args

  const child = spawn(command, spawnArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(needsShell ? { shell: true } : {}),
    windowsHide: true,
  })

  const session: Session = { key, child, pending: new Map(), buffer: '', stderr: '', exited: false, nextId: 1 }
  sessions.set(key, session)

  // stdin 的写入错误必须有人接：子进程先死后写会异步抛 EPIPE。
  child.stdin.on('error', (error) => {
    session.stderr = `${session.stderr}\nstdin: ${error.message}`.slice(-2000)
  })

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    session.buffer += chunk
    while (true) {
      const index = session.buffer.indexOf('\n')
      if (index === -1) break
      const line = session.buffer.slice(0, index)
      session.buffer = session.buffer.slice(index + 1)
      handleLine(session, line)
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    // 只留最后一段，用来在启动失败时给用户看。
    session.stderr = (session.stderr + chunk).slice(-2000)
  })

  child.on('error', (error) => {
    session.exited = true
    failAll(session, `启动失败：${error.message}`)
  })

  child.on('exit', (code) => {
    session.exited = true
    const tail = session.stderr.trim()
    failAll(session, `进程已退出（${code ?? '?'}）${tail !== '' ? `：${tail.slice(-300)}` : ''}`)
    // 只有表里还是「我」时才删。旧进程晚一步退出时，表里可能已经换成了
    // 新起的那个同名会话；无条件 delete 会把新会话从表里抹掉 —— 之后谁也
    // 关不掉那个子进程，越积越多（BUG-REVIEW P1-22）。
    if (sessions.get(key) === session) sessions.delete(key)
  })

  return session
}

/** 一个请求 —— 主进程负责起进程、发消息、等响应、超时。 */
export async function requestStdio(
  command: string,
  args: string[],
  request: { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> },
  timeoutMs: number,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (command.trim() === '') return { ok: false, error: '命令为空' }
  let session: Session
  try {
    session = ensureSession(command, args)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  // 主进程重新发号：调用方传的 id 只用于它自己的上下文，不能当配对键（会撞号）。
  const wireId = session.nextId
  session.nextId += 1
  const id = String(wireId)
  const payload = { ...request, id: wireId }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.pending.delete(id)
      resolve({ ok: false, error: `等待超过 ${Math.round(timeoutMs / 1000)} 秒没有响应` })
    }, timeoutMs)

    session.pending.set(id, {
      resolve: (value) => resolve({ ok: true, result: value }),
      reject: (error) => resolve({ ok: false, error: error.message }),
      timer,
    })

    if (!writeLine(session, `${JSON.stringify(payload)}\n`)) {
      clearTimeout(timer)
      session.pending.delete(id)
      resolve({ ok: false, error: session.exited ? '这个进程已经退出了' : '写不进这个进程的输入（可能已经关闭）' })
    }
  })
}

/** 结束某个命令对应的子进程。 */
export function closeStdio(command: string, args: string[]): void {
  const key = sessionKey(command, args)
  const session = sessions.get(key)
  if (session === undefined) return
  sessions.delete(key)
  try {
    session.child.kill()
  } catch {
    // 已经退出的进程 kill 会抛，忽略。
  }
}

/** 应用退出前统一清理，避免留下孤儿进程。 */
export function closeAllStdio(): void {
  for (const key of [...sessions.keys()]) {
    const session = sessions.get(key)
    if (session === undefined) continue
    try {
      session.child.kill()
    } catch {
      // ignore
    }
  }
  sessions.clear()
}
/**
 * 发一条通知：写进 stdin 就完事，不注册 pending、不等响应。
 *
 * MCP 的通知（比如 notifications/initialized）服务器不会回，
 * 如果复用 requestStdio 会一直挂到超时。
 */
export function notifyStdio(
  command: string,
  args: string[],
  message: { jsonrpc: '2.0'; method: string; params?: Record<string, unknown> },
): void {
  if (command.trim() === '') return
  try {
    const session = ensureSession(command, args)
    writeLine(session, `${JSON.stringify(message)}\n`)
  } catch {
    // 通知失败不该影响主流程。
  }
}
