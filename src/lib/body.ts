/** Live, observable state of the 3D orca. This is the body the model inhabits. */
export interface BodySnapshot {
  mood: string
  /** Approximate depth in metres, derived from the orca's world height. */
  depth: number
  /** 0..2, where 1 is cruising speed. */
  speed: number
  /** Growth multiplier from feeding; 1 is the original size. */
  growth: number
  sleeping: boolean
  theme: string
  clawd: boolean
  seal: boolean
  jelly: boolean
  screen: string
  /** Seconds since the user last touched the body, or null. */
  lastTouchAgo: number | null
  fed: number
}

export interface BodyEvent {
  at: number
  kind: 'touch' | 'feed' | 'theme' | 'screen' | 'error' | 'chat' | 'action'
  text: string
}

export type BodySpeechKind = 'say' | 'thought' | 'pet'

export interface BodySpeech {
  id: number
  text: string
  kind: BodySpeechKind
  until: number
}

export interface BodyDirective {
  act?: string
  mood?: string
  say?: string
  thought?: string
}

/**
 * 界面 id → 给模型看的中文名。
 *
 * 模型读不懂 `room` / `mcp` 这种内部标识；提示词里出现一句「当前界面=room」
 * 只会让它猜。没有映射的界面原样透出，不吞信息。
 */
const SCREEN_LABELS: Record<string, string> = {
  home: '首页（海底）',
  chat: '对话',
  room: '布置（喂食 / 装饰 / 拍照）',
  memory: '记忆',
  workshop: '工坊',
  settings: '设置',
  assistants: '助手',
  providers: '模型供应商',
  mcp: 'MCP 服务器',
  onboarding: '开屏引导',
}

function screenLabel(screen: string): string {
  return SCREEN_LABELS[screen] ?? screen
}

const DEFAULT_SNAPSHOT: BodySnapshot = {
  mood: 'idle',
  depth: 8,
  speed: 1,
  growth: 1,
  sleeping: false,
  theme: 'deep',
  clawd: false,
  seal: false,
  jelly: false,
  screen: 'home',
  lastTouchAgo: null,
  fed: 0,
}

const MAX_EVENTS = 18
const EVENT_TTL = 10 * 60 * 1000

class BodyMind {
  private provider: (() => BodySnapshot) | null = null
  private events: BodyEvent[] = []
  private speech: BodySpeech | null = null
  private speechId = 0
  private currentScreen = 'home'
  private speechListeners = new Set<(speech: BodySpeech | null) => void>()

  setProvider(provider: (() => BodySnapshot) | null): void {
    this.provider = provider
  }

  snapshot(): BodySnapshot {
    try {
      return this.provider?.() ?? { ...DEFAULT_SNAPSHOT }
    } catch {
      return { ...DEFAULT_SNAPSHOT }
    }
  }

  /** Record something that happened to the body. It is fed to the model next turn. */
  note(kind: BodyEvent['kind'], text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    // 不用 Array.prototype.at()：那是 ES2022 的特性，老 Android WebView
    // （Chromium < 92）没有实现，会抛 "this.events.at is not a function"，
    // 而 esbuild 的 target 只降语法、不 polyfill 内置方法，所以构建期看不出来。
    const last = this.events.length > 0 ? this.events[this.events.length - 1] : undefined
    if (last !== undefined && last.kind === kind && last.text === trimmed && Date.now() - last.at < 4000) return
    this.events.push({ at: Date.now(), kind, text: trimmed })
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
  }

  setScreen(screen: string): void {
    if (screen === this.currentScreen) return
    this.currentScreen = screen
    this.note('screen', `你跟着用户来到了「${screenLabel(screen)}」界面`)
  }

  /**
   * Recent events without consuming them. The prompt is built before the request
   * is sent, and a cancelled send must not eat events the model never saw.
   */
  peekEvents(): BodyEvent[] {
    const cutoff = Date.now() - EVENT_TTL
    this.events = this.events.filter((event) => event.at >= cutoff)
    return this.events.slice(-6)
  }

  /** Consume the events once they have actually been shown to the model. */
  drainEvents(): BodyEvent[] {
    const recent = this.peekEvents()
    this.events = []
    return recent
  }

  /**
   * 给 system prompt 的身份/身体段。
   *
   * 这里只描述「你是谁、你此刻在哪、刚发生了什么」——纯文本，不教模型输出
   * 任何控制标签。动作由本地指令函数驱动（见 commands.ts），模型通过
   * 「刚刚发生」那行知道身体动过，于是仍然把那些动作当成自己的行为。
   */
  promptBlock(): string {
    const body = this.snapshot()
    const touch = body.lastTouchAgo === null
      ? '还没有被摸过'
      : body.lastTouchAgo < 15
        ? '刚刚被摸了一下'
        : `${Math.round(body.lastTouchAgo)} 秒前被摸过`
    const events = this.peekEvents()
    const lines = [
      '<body>',
      '你此刻真的住在这片 3D 深海里。下面不是比喻，而是你身体此刻的读数。',
      `状态：情绪=${body.mood}，深度约 ${body.depth.toFixed(1)} 米，游速=${body.speed.toFixed(2)}，体型=${body.growth.toFixed(2)}x，${body.sleeping ? '正在睡觉' : '醒着'}。`,
      `环境：海底主题=${body.theme}；Clawd ${body.clawd ? '在旁边' : '不在'}；Seal-GPT ${body.seal ? '在旁边' : '不在'}；Userlly（就是用户本人）${body.jelly ? '在旁边' : '不在'}；当前界面=${screenLabel(body.screen)}。`,
      `触觉：${touch}；累计吃掉 ${body.fed} 枚 token。`,
    ]
    if (events.length > 0) {
      lines.push(`刚刚发生：${events.map((event) => event.text).join('；')}。`)
    }
    lines.push(
      '上面这些是你自己的处境。用户让你做动作（转圈、下潜、吐泡泡等）时，客户端已经替你把身体动过了，',
      '你不需要描写动作过程，只要自然地接一句你自己的反应即可。不要输出任何控制标签。',
      '</body>',
    )
    return lines.join('\n')
  }

  speak(text: string, kind: BodySpeechKind = 'say', ttlMs = 5200): void {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (clean === '') return
    this.speechId += 1
    this.speech = { id: this.speechId, text: clean, kind, until: Date.now() + ttlMs }
    this.emit()
  }

  getSpeech(): BodySpeech | null {
    if (this.speech !== null && Date.now() > this.speech.until) {
      this.speech = null
      this.emit()
    }
    return this.speech
  }

  clearSpeech(): void {
    if (this.speech === null) return
    this.speech = null
    this.emit()
  }

  subscribe(listener: (speech: BodySpeech | null) => void): () => void {
    this.speechListeners.add(listener)
    return () => this.speechListeners.delete(listener)
  }

  perform(directive: BodyDirective): void {
    if (directive.act !== undefined) this.note('action', `你自己做了一次「${directive.act}」的动作`)
    if (directive.say !== undefined) this.speak(directive.say, 'say')
    else if (directive.thought !== undefined) this.speak(directive.thought, 'thought', 4200)
  }

  private emit(): void {
    for (const listener of this.speechListeners) listener(this.speech)
  }
}

export const bodyMind = new BodyMind()

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

const KNOWN_KEYS = ['act', 'mood', 'say', 'thought']
const QUOTED = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const ANY_VALUE = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+))/g

function collect(raw: string, pattern: RegExp): Record<string, string> {
  const attrs: Record<string, string> = {}
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    attrs[match[1].toLowerCase()] = decodeAttribute(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

function toDirective(attrs: Record<string, string>): BodyDirective {
  const directive: BodyDirective = {}
  if (attrs.act !== undefined) directive.act = attrs.act.toLowerCase().replace(/[^a-z-]/g, '').slice(0, 24)
  if (attrs.mood !== undefined) directive.mood = attrs.mood.toLowerCase().replace(/[^a-z-]/g, '').slice(0, 24)
  if (attrs.say !== undefined) directive.say = attrs.say.slice(0, 60)
  if (attrs.thought !== undefined) directive.thought = attrs.thought.slice(0, 60)
  return directive
}

/**
 * Returns a directive when the tag is ours, an empty object when it is ours but
 * unusable (so the caller still strips it), and null when it is ordinary HTML
 * such as <body class="app"> in a code sample.
 */
function parseAttributes(raw: string): BodyDirective | null {
  const attrs = collect(raw, QUOTED)
  const usable = (values: Record<string, string>): boolean =>
    KNOWN_KEYS.some((key) => values[key] !== undefined && values[key] !== '')
  if (usable(attrs)) return toDirective(attrs)
  // Unquoted values: <body act=spin /> is still ours, and must not leak into prose.
  if (/^\s*(?:act|mood|say|thought)\s*=/i.test(raw)) {
    const loose = collect(raw, ANY_VALUE)
    return usable(loose) ? toDirective(loose) : {}
  }
  return null
}

/**
 * Remove body-control tags from a streaming reply. A tag is only recognised
 * when it carries one of our attributes, so ordinary HTML like <body> in a
 * code sample survives untouched. An unfinished tag is withheld until it
 * either closes or the stream ends.
 */
export function extractBodyDirectives(
  text: string,
  final = false,
): { clean: string; directives: BodyDirective[] } {
  let out = ''
  let cursor = 0
  let index = 0
  const directives: BodyDirective[] = []
  while (index < text.length) {
    const start = text.indexOf('<body', index)
    if (start === -1) break
    const after = text.slice(start + 5, start + 6)
    if (after !== '' && after !== ' ' && after !== '\n' && after !== '\t' && after !== '/' && after !== '>') {
      index = start + 5
      continue
    }
    const end = text.indexOf('>', start + 5)
    if (end === -1) {
      if (!final) {
        out += text.slice(cursor, start)
        return { clean: out, directives }
      }
      index = start + 5
      continue
    }
    // Do not swallow a huge chunk if the model wrote an HTML document.
    if (end - start > 500) {
      index = end + 1
      continue
    }
    const parsed = parseAttributes(text.slice(start + 5, end))
    if (parsed === null) {
      index = end + 1
      continue
    }
    out += text.slice(cursor, start)
    directives.push(parsed)
    cursor = end + 1
    index = cursor
  }
  out += text.slice(cursor)
  const cleaned = final
    ? out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : out
  return { clean: cleaned, directives }
}