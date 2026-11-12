import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * className ↔ CSS 守卫。
 *
 * 起因是两次真实事故，都是同一个毛病：组件里加了 class，样式表里没加规则。
 *   ① 历史抽屉筛选器 `className="drawer-filter"` —— 无规则，裸 <select> 在 Android
 *      WebView 上弹系统窗口，整页白屏；
 *   ② 记忆页「覆盖导入」`className="danger-button"` —— 无规则，退回浏览器默认按钮，
 *      字号/字重/内边距和旁边的「添加导入」对不上，肉眼一看就不是一套。
 *
 * 所以这里做一次全量对账：src 下所有 .tsx/.ts 里 className 用到的类名，
 * 必须在 src 下某个 .css 的**选择器**里出现过。缺一条就失败，报错里直接给文件名 + 行号。
 *
 * 已知的、故意不写样式的「纯钩子」类放进 ALLOWED_WITHOUT_STYLE，每条都要写原因；
 * 白名单里的类如果已经没人用了，同样失败（免得它一直挂着）。
 *
 * 这是静态检查，不是渲染测试。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const srcDir = path.join(root, 'src')

/* ------------------------------------------------------------------ */
/* 白名单：确实不需要样式的类                                           */
/* ------------------------------------------------------------------ */

const ALLOWED_WITHOUT_STYLE: Record<string, string> = {
  // 各页面最外层容器：布局全部由 .screen 负责，这些类只是页面级语义钩子（DevTools 里好定位）。
  'memory-screen': '纯语义钩子，样式由 .screen 提供',
  'settings-screen': '纯语义钩子，样式由 .screen 提供',
  'appearance-screen': '纯语义钩子，样式由 .screen 提供',
  'assistants-screen': '纯语义钩子，样式由 .screen 提供',
  'calendar-screen': '纯语义钩子，样式由 .screen 提供',
  'workshop-screen': '纯语义钩子，样式由 .screen 提供',
  // 宽高与字号由行内 style 给，圆角与裁切由 .avatar 给。
  'avatar-emoji': '视觉属性走行内 style，这个类只用来区分「emoji 头像」',
  // 流式气泡：外观沿用 .bubble-assistant，这个类只作为「正在生成」的标记。
  'bubble-live': '流式标记，外观沿用 .bubble-assistant',
  // 样式来自后代选择器 .drawer-row-main small，类本身只是钩子。
  'drawer-row-who': '样式来自 .drawer-row-main small',
  // 外观来自 .text-button，这个类只用来定位「视觉模型开关」那个按钮。
  'model-catalog-vision': '样式来自 .text-button',
  // 工作区名就是工具卡片正文里的一行字，没有独立外观。
  'tool-project': '跟随工具卡片正文，无独立样式',
}

/**
 * CSS 不是以 .css 文件形式存在的源。
 * src/orca/ui/styles.ts 把整张样式表写进字符串、运行时注入 <style>，
 * 所以它的选择器也要算进「已定义」。
 */
const EXTRA_CSS_SOURCES = ['src/orca/ui/styles.ts']

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function walk(dir: string, extensions: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, extensions, out)
      continue
    }
    if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full)
  }
  return out
}

/** 把 src 下所有 .css 的**选择器**里的类名收集起来（声明块里的内容不算）。 */
function collectDefinedClasses(cssFiles: string[]): Set<string> {
  const defined = new Set<string>()
  for (const file of cssFiles) {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    // 每个 '{' 之前的那段文本就是选择器（@media/@supports 之类的 at-rule 里没有点，天然跳过）。
    const ruleRe = /([^{}]*)\{/g
    let match: RegExpExecArray | null
    while ((match = ruleRe.exec(text)) !== null) {
      const selector = match[1]
      const classRe = /\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g
      let cls: RegExpExecArray | null
      while ((cls = classRe.exec(selector)) !== null) defined.add(cls[1])
    }
  }
  return defined
}

/** 取出源码里每个 className= 后面的表达式（字符串字面量 / {…} 表达式，括号配平）。 */
function classNameExpressions(code: string): string[] {
  const found: string[] = []
  const re = /className\s*=\s*/g
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) {
    let i = match.index + match[0].length
    const head = code[i]
    if (head === '"' || head === "'") {
      const end = code.indexOf(head, i + 1)
      if (end === -1) break
      found.push(code.slice(i, end + 1))
      re.lastIndex = end + 1
      continue
    }
    if (head !== '{') continue
    let depth = 0
    let j = i
    for (; j < code.length; j++) {
      const ch = code[j]
      if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) break
      } else if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch
        j++
        while (j < code.length && code[j] !== quote) {
          if (code[j] === '\\') j++
          j++
        }
      }
    }
    found.push(code.slice(i, j + 1))
    re.lastIndex = j + 1
  }
  return found
}

const LITERAL_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g

/** 从一个 className 表达式里拆出所有类名 token。 */
function classTokens(expression: string): string[] {
  // className={mode === 'group' && 'newchat-group'} 里的 'group' 是比较值，不是类名。
  const withoutComparisons = expression.replace(
    /(===|!==|==|!=)\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g,
    '$1',
  )
  const tokens: string[] = []
  const literals = withoutComparisons.match(LITERAL_RE) ?? []
  for (const raw of literals) {
    const body = raw
      .slice(1, -1)
      // 模板插值里是表达式，不可能是类名
      .replace(/\$\{[^{}]*\}/g, ' ')
    for (const piece of body.split(/\s+/)) {
      if (piece === '') continue
      // 只认纯粹的类名：带 / . : # = 的是路径、URL 或别的东西
      if (!/^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(piece)) continue
      tokens.push(piece)
    }
  }
  return tokens
}

/** 扫一遍源码，返回 class → 出现位置列表。 */
function collectUsedClasses(files: string[]): Map<string, string[]> {
  const used = new Map<string, string[]>()
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8')
    const relative = path.relative(root, file).replace(/\\/g, '/')
    for (const expression of classNameExpressions(code)) {
      const offset = code.indexOf(expression)
      const line = code.slice(0, offset === -1 ? 0 : offset).split('\n').length
      for (const token of classTokens(expression)) {
        const where = used.get(token) ?? []
        where.push(`${relative}:${line}`)
        used.set(token, where)
      }
    }
  }
  return used
}

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

const cssFiles = [...walk(srcDir, ['.css']), ...EXTRA_CSS_SOURCES.map((file) => path.join(root, file))]
const sourceFiles = walk(srcDir, ['.tsx', '.ts']).filter((file) => !file.endsWith('.d.ts'))
const defined = collectDefinedClasses(cssFiles)
const used = collectUsedClasses(sourceFiles)

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

test('扫描到的东西不是空的（防止 walk 写错后这条守卫变成永远通过）', () => {
  assert.ok(cssFiles.length >= 5, `只找到 ${cssFiles.length} 个 CSS 文件，路径可能写错了`)
  assert.ok(sourceFiles.length >= 20, `只找到 ${sourceFiles.length} 个源码文件，路径可能写错了`)
  assert.ok(defined.size >= 100, `只解析出 ${defined.size} 个类名，选择器提取可能失效了`)
  assert.ok(used.size >= 100, `只找到 ${used.size} 个被使用的类名，className 提取可能失效了`)
})

test('源码里用到的每个 className 都在 CSS 里有对应规则', () => {
  const missing: string[] = []
  for (const [token, places] of used) {
    if (defined.has(token)) continue
    // `tier-${level}` 这种拼接出来的类名，只保留前缀；要求前缀下至少有一条真规则。
    if (token.endsWith('-')) {
      if ([...defined].some((name) => name.startsWith(token))) continue
      missing.push(`  ${token}*  ←  ${[...new Set(places)].join(', ')}（动态前缀下没有任何规则）`)
      continue
    }
    if (Object.hasOwn(ALLOWED_WITHOUT_STYLE, token)) continue
    missing.push(`  ${token}  ←  ${[...new Set(places)].join(', ')}`)
  }
  assert.deepEqual(
    missing.sort(),
    [],
    `以下类名写了但没有任何 CSS 规则（要么补样式，要么加进 ALLOWED_WITHOUT_STYLE 并写明原因）：\n${missing.join('\n')}`,
  )
})

test('白名单里没有已经失效的条目', () => {
  const stale = Object.keys(ALLOWED_WITHOUT_STYLE).filter((token) => !used.has(token))
  assert.deepEqual(stale, [], `白名单里这些类已经没人用了，删掉：${stale.join(', ')}`)
})

/* ------------------------------------------------------------------ */
/* 两条具体的回归                                                        */
/* ------------------------------------------------------------------ */

test('记忆页「覆盖导入」按钮和「添加导入」是同一套字体', () => {
  const styles = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf8')
  const block = /\.danger-button\s*\{([^}]*)\}/.exec(styles)
  assert.ok(block, '.danger-button 必须有独立规则，否则会退回浏览器默认按钮')
  const body = block[1]
  assert.match(body, /font-size:\s*12px/, '字号要和 .primary-button 一致（12px）')
  assert.match(body, /font-weight:\s*650/, '字重要和 .primary-button 一致（650）')
  assert.match(body, /border-radius:\s*11px/, '圆角要和 .primary-button 一致（11px）')
  assert.match(body, /padding:\s*8px 14px/, '内边距要和 .primary-button 一致')
})

test('群聊参数区和助手列表之间有分隔', () => {
  const groupchat = fs.readFileSync(path.join(srcDir, 'components', 'styles-groupchat.css'), 'utf8')
  const block = /\.newchat-group\s*\{([^}]*)\}/.exec(groupchat)
  assert.ok(block, '.newchat-group 必须有规则，否则几组群聊设置会直接贴在一起')
  assert.match(block[1], /border-top:/, '用一条上分隔线把「选人」和「群聊参数」分开')
})
