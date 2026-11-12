import fs from 'node:fs'

/**
 * className ↔ CSS 对账用的底层工具。
 *
 * 单独抽出来是为了能被**真正测**：注释剥离、CRLF、重复表达式的行号、
 * 模板串的前后缀，这些都需要拿具体输入跑一遍才能证明没坏。
 * 之前这些都塞在 test/css-class-audit.test.ts 里，只能靠「跑整个文件」间接验证。
 */

/* ------------------------------------------------------------------ */
/* 扫描：注释区间与字符串区间                                           */
/* ------------------------------------------------------------------ */

export interface CodeScan {
  /** [start, end) 注释区间（含注释标记本身） */
  comments: Array<[number, number]>
  /** [start, end) 字符串 / 正则字面量区间（含引号） */
  strings: Array<[number, number]>
}

/** 这些符号后面出现的 `/` 更可能是正则开头，而不是除号。 */
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'])

/**
 * 扫一遍源码，记下注释与字符串的区间。
 *
 * 为什么需要它：直接对源码跑正则，会把注释里的示例（`// className="foo"`）
 * 和字符串里的 HTML（`'<div className="bar">'`）当成真的 JSX 属性。
 */
export function scanCode(text: string): CodeScan {
  const comments: Array<[number, number]> = []
  const strings: Array<[number, number]> = []
  let i = 0
  let prevSignificant = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      const start = i
      while (i < text.length && text[i] !== '\n') i += 1
      comments.push([start, i])
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const start = i
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i = Math.min(i + 2, text.length)
      comments.push([start, i])
      continue
    }
    if (ch === "'" || ch === '"') {
      const start = i
      const quote = ch
      i += 1
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1
        i += 1
      }
      i = Math.min(i + 1, text.length)
      strings.push([start, i])
      prevSignificant = quote
      continue
    }
    if (ch === '`') {
      const start = i
      i += 1
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === '`') {
          i += 1
          break
        }
        i += 1
      }
      strings.push([start, i])
      prevSignificant = '`'
      continue
    }
    if (ch === '/' && REGEX_PREV.has(prevSignificant)) {
      const start = i
      i += 1
      let inClass = false
      while (i < text.length) {
        const c = text[i]
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '\n') break
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) {
          i += 1
          break
        }
        i += 1
      }
      strings.push([start, i])
      prevSignificant = '/'
      continue
    }
    if (!/\s/.test(ch)) prevSignificant = ch
    i += 1
  }
  return { comments, strings }
}

/**
 * 去掉注释，**保持长度不变**（注释字符换成空格，换行原样保留）。
 *
 * 保持长度是为了让「在剥完注释的文本上算出的偏移」还能对回原始行号。
 * 按 `\r?\n` 处理，CRLF 检出下不会像老写法那样把整行注释漏掉。
 */
export function stripComments(text: string): string {
  const { comments } = scanCode(text)
  if (comments.length === 0) return text
  const chars = text.split('')
  for (const [start, end] of comments) {
    for (let i = start; i < end; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '
    }
  }
  return chars.join('')
}

/** 把扫描结果变成「从某个位置可以直接跳到区间末尾」的查表。 */
export interface SkipTable {
  /** 下标 = 位置，值 = 该位置所在字符串/注释的结束位置（不在区间内为 0）。 */
  end: Int32Array
  /** 下标 = 位置，1 表示在字符串/注释内。 */
  inside: Uint8Array
}

export function buildSkipTable(scan: CodeScan, length: number): SkipTable {
  const end = new Int32Array(length + 1)
  const inside = new Uint8Array(length + 1)
  for (const [start, stop] of [...scan.comments, ...scan.strings]) {
    end[start] = stop
    for (let i = start; i < stop && i < length; i += 1) inside[i] = 1
  }
  return { end, inside }
}

/* ------------------------------------------------------------------ */
/* 提取 className 表达式                                               */
/* ------------------------------------------------------------------ */

export interface ClassNameExpression {
  /** 表达式原文，例如 `"newchat-item"` 或 `{`…`}` */
  raw: string
  /** 在源码中的起始偏移（`className` 的 c） */
  index: number
  /** 1 起的行号 */
  line: number
}

/** 每个换行符的位置，用来把偏移换算成行号（二分）。 */
function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function lineOf(starts: number[], index: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (starts[mid] <= index) low = mid
    else high = mid - 1
  }
  return low + 1
}

/**
 * 找出所有 `className=` 的属性表达式。
 *
 * 注释里、字符串里的 `className=` 会被跳过；行号按**每一处匹配自己的偏移**算，
 * 所以同一个文件里出现两次完全相同的表达式也不会都指到第一处（审查意见 P2-4）。
 */
export function extractClassNameExpressions(text: string): ClassNameExpression[] {
  const skip = buildSkipTable(scanCode(text), text.length)
  const starts = lineStartsOf(text)
  const found: ClassNameExpression[] = []
  const re = /className\s*=\s*/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const attrIndex = match.index
    if (skip.inside[attrIndex] === 1) continue
    let i = attrIndex + match[0].length
    const head = text[i]
    if (head === '"' || head === "'") {
      const close = skip.end[i] > 0 ? skip.end[i] : text.indexOf(head, i + 1) + 1
      if (close <= 0) continue
      found.push({ raw: text.slice(i, close), index: attrIndex, line: lineOf(starts, attrIndex) })
      re.lastIndex = close
      continue
    }
    if (head !== '{') continue
    const close = matchBrace(text, i, skip)
    if (close === -1) continue
    found.push({ raw: text.slice(i, close + 1), index: attrIndex, line: lineOf(starts, attrIndex) })
    re.lastIndex = close + 1
  }
  return found
}

function matchBrace(text: string, open: number, skip: SkipTable): number {
  let depth = 0
  let i = open
  while (i < text.length) {
    const jump = skip.end[i]
    if (jump > 0) {
      i = jump
      continue
    }
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/* ------------------------------------------------------------------ */
/* 把一个表达式拆成「静态类名 / 动态前缀 / 动态后缀 / 无法解析」          */
/* ------------------------------------------------------------------ */

export interface TokenScan {
  /** 完全静态、可以直接去 CSS 里找的类名 */
  static: string[]
  /** 模板串里紧贴 `${…}` 前面的片段，例如 `tier-${level}` 的 `tier-` */
  prefixes: string[]
  /** 模板串里紧贴 `${…}` 后面的片段，例如 `tier-${level}-active` 的 `-active` */
  suffixes: string[]
  /** 有动态片段但既不是前缀也不是后缀 —— 静态分析到此为止，需要人工看 */
  unresolved: boolean
}

const CLASS_TOKEN = /^-?[A-Za-z_][A-Za-z0-9_-]*$/

function isClassToken(token: string): boolean {
  return CLASS_TOKEN.test(token)
}

function pushPlain(text: string, out: TokenScan): void {
  for (const piece of text.split(/\s+/)) {
    if (piece === '' || !isClassToken(piece)) continue
    out.static.push(piece)
  }
}

function parseTemplate(text: string, start: number, end: number): { segments: string[]; exprs: string[] } {
  const segments: string[] = []
  const exprs: string[] = []
  let current = ''
  let i = start + 1
  while (i < end - 1) {
    const ch = text[i]
    if (ch === '\\') {
      current += text[i + 1] ?? ''
      i += 2
      continue
    }
    if (ch === '$' && text[i + 1] === '{') {
      segments.push(current)
      current = ''
      let depth = 1
      let j = i + 2
      while (j < end - 1) {
        if (text[j] === '{') depth += 1
        else if (text[j] === '}') {
          depth -= 1
          if (depth === 0) break
        }
        j += 1
      }
      exprs.push(text.slice(i + 2, j))
      i = j + 1
      continue
    }
    current += ch
    i += 1
  }
  segments.push(current)
  return { segments, exprs }
}

function visitTemplate(segments: string[], exprs: string[], out: TokenScan): void {
  const before = { static: out.static.length, prefixes: out.prefixes.length, suffixes: out.suffixes.length }
  let innerUnresolved = false
  for (const expr of exprs) {
    const inner = scanClassNames(expr)
    out.static.push(...inner.static)
    out.prefixes.push(...inner.prefixes)
    out.suffixes.push(...inner.suffixes)
    if (inner.unresolved) innerUnresolved = true
  }
  if (segments.length === 1) {
    pushPlain(segments[0] ?? '', out)
    return
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? ''
    const tokens = segment.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const isFirst = index === 0
    const isLast = index === segments.length - 1
    const gluedRight = !/\s$/.test(segment)
    const gluedLeft = !/^\s/.test(segment)
    if (isFirst && gluedRight) {
      const prefix = tokens.pop()
      if (prefix !== undefined && isClassToken(prefix)) out.prefixes.push(prefix)
      pushPlain(tokens.join(' '), out)
      continue
    }
    if (isLast && gluedLeft) {
      const suffix = tokens.shift()
      if (suffix !== undefined && isClassToken(suffix)) out.suffixes.push(suffix)
      pushPlain(tokens.join(' '), out)
      continue
    }
    if (!isFirst && !isLast) {
      // 夹在两个插值之间的片段，静态分析判断不了它和谁拼在一起。
      out.unresolved = true
      continue
    }
    pushPlain(segment, out)
  }
  /*
   * 整条类名都由变量拼出来（`${name}`、`${a}${b}`）时，静态侧什么都没学到 ——
   * 这种必须报出来，不能因为「没解析出类名」就当成「没有类名」悄悄放过。
   */
  const learned = out.static.length > before.static
    || out.prefixes.length > before.prefixes
    || out.suffixes.length > before.suffixes
  if (!learned) {
    out.unresolved = true
    return
  }
  /*
   * 插值里是动态值（`theme-${tone.id}`、`tier-${level}`）时，只要它**贴着**一个
   * 已解析的前缀 / 后缀，就由前缀/后缀检查兜住 —— 那正是 prefix/suffix 机制存在的意义，
   * 不重复报 unresolved。反过来，`item ${cls}` 这种插值是独立一段的，仍然要报。
   */
  const anchored = out.prefixes.length > before.prefixes || out.suffixes.length > before.suffixes
  if (innerUnresolved && !anchored) out.unresolved = true
}

const KEYWORDS = new Set(['typeof', 'instanceof', 'new', 'void', 'delete', 'in', 'of', 'true', 'false', 'null', 'undefined', 'return'])

const COMPARISONS = ['===', '!==', '==', '!=', '<=', '>=', '<', '>']

/**
 * 把表达式里的字符串 / 模板 / 正则整体换成占位符，剩下「骨架」。
 * 用来回答一个问题：除了已经识别出来的字面量，还有没有别的值在拼类名？
 */
function skeletonOf(text: string, skip: SkipTable): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const end = skip.end[i]
    if (end > 0 && (text[i] === "'" || text[i] === '"' || text[i] === '`' || text[i] === '/')) {
      // 占位符里不能有字母，否则会被下面的标识符正则当成变量名。
      out += '«»'
      i = end
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

/**
 * 骨架里还有没有「可能产出类名」的标识符 / 成员访问 / 函数调用。
 *
 * 明确放过的三类（它们产出的是布尔值或比较结果，不是类名）：
 *   - 三元条件：`cond ? … : …` 里的 `cond`；
 *   - 比较运算的两侧：`mode === 'group'` 里的 `mode`；
 *   - 逻辑非的操作数：`!open && …` 里的 `open`。
 *
 * 其余一律算残留 —— 包括 `buttonClass`、`getButtonClass()`、`styles.active`。
 * 这正是二审指出的漏报：以前这些表达式因为「没提取到字符串」被当成通过。
 */
function hasDynamicResidue(skeleton: string): boolean {
  const identRe = /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g
  let match: RegExpExecArray | null
  while ((match = identRe.exec(skeleton)) !== null) {
    const chain = match[0]
    const first = chain.split('.')[0].trim()
    if (KEYWORDS.has(first)) continue

    const before = skeleton.slice(0, match.index).trimEnd()
    const after = skeleton.slice(match.index + chain.length).trimStart()

    // 可选链 `a?.b` 不是三元
    const isOptionalChain = after.startsWith('?.')
    if (!isOptionalChain && after.startsWith('?')) continue
    if (COMPARISONS.some((op) => after.startsWith(op))) continue
    if (COMPARISONS.some((op) => before.endsWith(op))) continue
    if (before.endsWith('!')) continue
    // `cond && 'x'` / `cond || 'x'` 里的 cond 是布尔守卫，不是类名
    if (after.startsWith('&&') || after.startsWith('||')) continue

    return true
  }
  return false
}

/**
 * 扫一个 className 表达式，拆出可校验的部分。
 *
 * 支持：字符串、三元 / 数组 / 函数调用里的字符串、模板串（前缀与后缀）、
 * 以及模板插值里再套的字符串。
 * 判断不了的情况一律置 `unresolved`，**不静默跳过**。
 */
export function scanClassNames(expression: string): TokenScan {
  const out: TokenScan = { static: [], prefixes: [], suffixes: [], unresolved: false }
  /*
   * 先摘掉比较运算符右侧的字面量。
   *
   * `className={`newchat-item ${mode === 'group' ? 'is-on' : ''}`}` 里的 'group'
   * 是**比较值**，不是类名；不摘掉就会把 'group' 当成「用了但没样式」误报。
   * 只摘紧跟 ===/!==/==/!= 的那一个字面量，三元里的真类名不受影响。
   */
  const cleaned = expression.replace(
    /(===|!==|==|!=)\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g,
    '$1',
  )
  const skip = buildSkipTable(scanCode(cleaned), cleaned.length)
  let i = 0
  while (i < cleaned.length) {
    const ch = cleaned[i]
    if (ch === "'" || ch === '"') {
      const end = skip.end[i] > 0 ? skip.end[i] : cleaned.indexOf(ch, i + 1) + 1
      if (end <= 0) break
      pushPlain(cleaned.slice(i + 1, end - 1), out)
      i = end
      continue
    }
    if (ch === '`') {
      const end = skip.end[i] > 0 ? skip.end[i] : cleaned.length
      const { segments, exprs } = parseTemplate(cleaned, i, end)
      visitTemplate(segments, exprs, out)
      i = end
      continue
    }
    i += 1
  }

  /*
   * 字面量之外还有没有别的东西在拼类名。
   *
   * `className={buttonClass}` / `className={getButtonClass()}` 这种一个字符串都提不出来的，
   * 以前会「什么都没扫到 = 没问题」地悄悄放过；`condition ? styles.active : 'normal'`
   * 这种混着静态分支的，也要在检查 'normal' 的同时把动态那半边报出来。
   */
  if (hasDynamicResidue(skeletonOf(cleaned, skip))) out.unresolved = true

  return {
    static: [...new Set(out.static)],
    prefixes: [...new Set(out.prefixes)],
    suffixes: [...new Set(out.suffixes)],
    unresolved: out.unresolved,
  }
}

/* ------------------------------------------------------------------ */
/* CSS 侧：收集已定义的类名                                             */
/* ------------------------------------------------------------------ */

/** 把 src 下所有 .css 的**选择器**里的类名收集起来（声明块里的内容不算）。 */
export function collectDefinedClasses(cssFiles: string[]): Set<string> {
  const defined = new Set<string>()
  for (const file of cssFiles) {
    const text = stripComments(fs.readFileSync(file, 'utf8'))
    // 每个 '{' 之前的那段文本就是选择器（@media/@supports 之类的 at-rule 里没有点，天然跳过）。
    const ruleRe = /([^{}]*)\{/g
    let match: RegExpExecArray | null
    while ((match = ruleRe.exec(text)) !== null) {
      const classRe = /\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g
      let cls: RegExpExecArray | null
      while ((cls = classRe.exec(match[1])) !== null) defined.add(cls[1])
    }
  }
  return defined
}
