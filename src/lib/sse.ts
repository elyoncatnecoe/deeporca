/**
 * SSE（text/event-stream）解析，按 WHATWG 规范实现：
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 *
 * 为什么单独抽出来：deepseek.ts 和 media-api.ts 以前各自手写
 * `/\r?\n\r?\n/` 切分 + `filter(line => line.startsWith('data:'))`，有三个规范上的漏洞：
 *   1. 只认 `\n` / `\r\n`，CR-only 换行一个事件都切不出来；
 *   2. 只取 `data:`，带 `event: error` 且 data 是纯文本的错误帧会被静默丢掉 ——
 *      表现是「请求一直挂着，直到超时」，日志里什么都没有；
 *   3. 多行 `data:` 用 trimStart 逐行处理，严格说规范只该去掉一个前导空格。
 * 现在两处共用这一个解码器，行为与规范一致（参考 deepseek-ai/chat-demo 的
 * src/services/api/sse.ts，MIT）。
 *
 * 注意：解码器故意**不做** UTF-8 字节解码。传输层（net.ts）交给我们的已经是
 * 解码后的字符串，这里只负责「文本 → 事件」。若将来要接字节流，外层包一层
 * TextDecoder({stream:true}) 即可。
 */

export type SseEvent = {
  /** `event` 字段，缺省为 `message` */
  event: string
  /** 多行 `data` 以 `\n` 连接 */
  data: string
  /** 最近一次 `id` 字段 */
  lastEventId: string
}

/** 按 CRLF / LF / CR 切行；顺序很重要（CRLF 要在 CR 之前）。 */
const LINE_BREAK = /\r\n|\r|\n/g

export class SseDecoder {
  private buffer = ''
  private data = ''
  private hasData = false
  private eventType = ''
  private lastEventId = ''

  /**
   * 还没有切出完整行的原始文本（半行）。
   *
   * 注意：它**不等于**「还有没派发的事件」。`data: X\n` 这种收尾，行已经被
   * push() 吃掉了，buffer 为空、事件却还压在 hasData 里 —— 所以收尾判断
   * 一律用 flush()，别拿这个值当开关（曾经就是这么做，把最后一帧弄丢了）。
   */
  get pending(): string {
    return this.buffer
  }

  /** 输入一段已解码的文本，返回其中完整的事件。 */
  push(text: string): SseEvent[] {
    this.buffer += text
    const events: SseEvent[] = []
    let lineStart = 0
    LINE_BREAK.lastIndex = 0
    for (let match = LINE_BREAK.exec(this.buffer); match !== null; match = LINE_BREAK.exec(this.buffer)) {
      // 结尾的 CR 可能是 CRLF 的前半，等下一段再判断（否则会把 \r\n 拆成两个换行）。
      if (match[0] === '\r' && LINE_BREAK.lastIndex === this.buffer.length) {
        break
      }
      const event = this.processLine(this.buffer.slice(lineStart, match.index))
      if (event !== null) {
        events.push(event)
      }
      lineStart = LINE_BREAK.lastIndex
    }
    this.buffer = this.buffer.slice(lineStart)
    return events
  }

  /**
   * 流结束收尾：把「没有以空行结尾」的最后一段也派发出去。
   *
   * 这是刻意的偏离规范（规范说 EOF 处未完成的事件直接丢弃）：很多网关最后一段
   * 就是不跟空行，丢掉往往正是最后一段正文或 usage —— deepseek.ts 的 T-10 和
   * media-api.ts 的 T-12 都在补这一刀，这里统一成方法，别再各自手写。
   *
   * 判据必须同时看两处状态：buffer 里可能是半行没切，也可能已经被 push() 吃完
   * （`data: X\n` 只跟一个换行就 EOF），事件却还压在 hasData 里没派发。只看
   * buffer 会把后一种当成「无事可做」直接返回 —— 那就是最后一帧被吞的根因。
   */
  flush(): SseEvent[] {
    if (this.buffer === '' && !this.hasData) {
      return []
    }
    return this.push('\n\n')
  }

  /** 清空全部状态，复用同一个实例处理下一段流。 */
  reset(): void {
    this.buffer = ''
    this.data = ''
    this.hasData = false
    this.eventType = ''
    this.lastEventId = ''
  }

  private processLine(line: string): SseEvent | null {
    if (line === '') {
      return this.dispatch()
    }
    // 以冒号开头的行是注释（服务端常用来保活，如 `: keep-alive`），忽略。
    if (line.startsWith(':')) {
      return null
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // 规范：值前最多去掉一个空格。
    if (value.startsWith(' ')) {
      value = value.slice(1)
    }
    switch (field) {
      case 'data':
        this.data = this.hasData ? `${this.data}\n${value}` : value
        this.hasData = true
        break
      case 'event':
        this.eventType = value
        break
      case 'id':
        // 含 NUL 的 id 按规范忽略。
        if (!value.includes('\0')) {
          this.lastEventId = value
        }
        break
      default:
        // retry 只对 EventSource 自动重连有意义，这里不处理；未知字段按规范忽略。
        break
    }
    return null
  }

  private dispatch(): SseEvent | null {
    const event: SseEvent | null = this.hasData
      ? { event: this.eventType || 'message', data: this.data, lastEventId: this.lastEventId }
      : null
    this.data = ''
    this.hasData = false
    this.eventType = ''
    return event
  }
}
