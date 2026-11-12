/**
 * DeepSeek 网页接口的 SSE 解析。
 *
 * 回复是 SSE：`event: ready`，然后是若干 `data:` 帧（对回复对象的 JSON patch），
 * `event: close` 结束一轮，里面带着状态（INCOMPLETE 表示说了一半，页面会要求续写）。
 *
 * 文本有两种到达方式：
 *   {"v":{"response":{...fragments:[{type:"RESPONSE",content:"…"}]}}}   整段
 *   {"p":"response/fragments/-1/content","o":"APPEND","v":"…"}          追加
 * THINKING 类 fragment 是思考过程。
 *
 * 之前那版只看 `response.ok` 就往下走、并且把任何字符串都当正文，所以
 * 「内容不返回」——状态帧（"FINISHED"）会被当成文字，而真正的帧结构没人解。
 *
 * 实现参考 volcanicll/magpie-deepseek-web-auth 的 src/stream.mjs（MIT），
 * 去掉其中的工具调用/DSML 处理，只保留文本与思考。
 */

export interface ReplyPatchReader {
  text: string
  reasoning: string
  messageId: number | null
  status: string | null
  usage: number | null
  apply(frame: unknown): void
}

/** 这些 fragment 类型算思考过程，不进正文。 */
const REASONING_KINDS = new Set([
  'THINK',
  'THINKING',
  'REASONING',
  'SEARCH',
  'TOOL_SEARCH',
  'TOOL_OPEN',
  'TOOL_FIND',
])

const TEXT_KINDS = new Set(['RESPONSE', 'TEMPLATE_RESPONSE'])

export class PatchReader implements ReplyPatchReader {
  text = ''
  reasoning = ''
  messageId: number | null = null
  status: string | null = null
  usage: number | null = null
  /** fragment -1 属于哪一类（裸字符串追加就落在它里面）。 */
  private lastKind = 'RESPONSE'

  /** 处理一帧。 */
  apply(frame: unknown): void {
    if (frame === null || typeof frame !== 'object') return
    const record = frame as Record<string, unknown>

    // 带路径的 patch 先处理：它的值经常也是字符串（status → "FINISHED"），
    // 不能当成正文。
    if (typeof record.p === 'string') {
      this.patch(record.p, record.o, record.v)
      return
    }
    if (typeof record.v === 'string') {
      // 裸字符串是往「当前正在写的 fragment」追加。
      this.append(this.lastKind, record.v)
      return
    }
    if (record.v !== null && typeof record.v === 'object') this.tree(record.v)
  }

  private tree(value: unknown): void {
    const record = value as Record<string, unknown>
    const response = (record.response ?? (record.v as Record<string, unknown> | undefined)?.response) as
      | Record<string, unknown>
      | undefined
    if (response !== undefined && typeof response === 'object') {
      if (typeof response.message_id === 'number') this.messageId = response.message_id
      if (typeof response.status === 'string') this.status = response.status
      if (typeof response.accumulated_token_usage === 'number') this.usage = response.accumulated_token_usage
      this.fragments(response.fragments)
    }
    // patch 自己的值也可能是 response 的某个部分。
    for (const [key, v] of Object.entries(record)) {
      if (key === 'response') continue
      if (key === 'status' && typeof v === 'string') this.status = v
      if (key === 'message_id' && typeof v === 'number') this.messageId = v
    }
  }

  private fragments(list: unknown): void {
    if (!Array.isArray(list)) return
    for (const fragment of list) {
      if (fragment === null || typeof fragment !== 'object') continue
      const item = fragment as Record<string, unknown>
      if (typeof item.type === 'string') this.lastKind = item.type
      if (typeof item.content === 'string') this.append(item.type, item.content)
    }
  }

  private patch(path: string, op: unknown, value: unknown): void {
    if (/^response\/status$/.test(path) && typeof value === 'string') this.status = value
    if (/^response\/message_id$/.test(path) && typeof value === 'number') this.messageId = value
    if (/accumulated_token_usage/.test(path) && typeof value === 'number') this.usage = value
    // 整段 fragment 追加会把「最后一个 fragment」推走（expert 模型就这样开头）。
    if (/^response\/fragments$/.test(path) && Array.isArray(value)) {
      this.fragments(value)
      return
    }
    if (
      /^response\/fragments\/-1\//.test(path)
      && typeof value === 'string'
      && (op === 'APPEND' || op === 'SET' || op === undefined)
    ) {
      this.append(this.lastKind, value)
    }
    if (op === 'BATCH' && Array.isArray(value)) {
      for (const item of value) this.apply(item)
    }
    const asRecord = value as Record<string, unknown> | null
    if (asRecord !== null && typeof asRecord === 'object' && Array.isArray(asRecord.fragments)) {
      this.fragments(asRecord.fragments)
    }
  }

  private append(type: unknown, content: string): void {
    if (content === '') return
    const kind = String(type ?? '').toUpperCase()
    if (REASONING_KINDS.has(kind)) {
      this.reasoning += content
      return
    }
    if (TEXT_KINDS.has(kind) || kind === '') {
      this.text += content
    }
  }
}

export interface SseFrame {
  event: string
  data: unknown
}

/**
 * 把 fetch 的 body 读成 SSE 帧，保留每帧的 event 名。
 *
 * 帧之间以空行分隔；`event:` 行给名字，`data:` 行可以有多行、拼起来是 JSON。
 */
export async function* iterSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  const pending: string[] = []
  const reader = body.getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line === '') {
          if (pending.length > 0) {
            const data = pending.join('\n')
            pending.length = 0
            if (data.trim() !== '[DONE]') {
              try {
                yield { event, data: JSON.parse(data) as unknown }
              } catch {
                /* 不是 JSON 的帧跳过 */
              }
            }
          }
          event = 'message'
          index = buffer.indexOf('\n')
          continue
        }
        if (line.startsWith(':')) {
          index = buffer.indexOf('\n')
          continue
        }
        const colon = line.indexOf(':')
        if (colon === -1) {
          index = buffer.indexOf('\n')
          continue
        }
        const field = line.slice(0, colon)
        let fieldValue = line.slice(colon + 1)
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1)
        if (field === 'event') event = fieldValue === '' ? 'message' : fieldValue
        else if (field === 'data') pending.push(fieldValue)
        index = buffer.indexOf('\n')
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 流已结束 */
    }
  }

  if (pending.length > 0) {
    try {
      yield { event, data: JSON.parse(pending.join('\n')) as unknown }
    } catch {
      /* 结尾的半帧忽略 */
    }
  }
}