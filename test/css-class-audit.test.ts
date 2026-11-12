import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDefinedClasses, extractClassNameExpressions, scanClassNames } from './css-audit-lib.ts'

/**
 * className ↔ CSS 守卫。
 *
 * 起因是两次真实事故，都是同一个毛病：组件里加了 class，样式表里没加规则。
 *   ① 历史抽屉筛选器 `className="drawer-filter"` —— 无规则，裸 <select> 在 Android
 *      WebView 上弹系统窗口，整页白屏；
 *   ② 记忆页「覆盖导入」`className="danger-button"` —— 无规则，退回浏览器默认按钮，
 *      字号/字重/内边距和旁边的「添加导入」对不上。
 *
 * 所以这里做一次全量对账：src 下所有 .tsx/.ts 里 className 用到的类名，
 * 必须在 src 下某个 .css 的**选择器**里出现过。
 *
 * 覆盖范围（审查意见 P2 第 1、2 条）：
 *   - 静态类名：直接查；
 *   - 模板串的前缀 / 后缀：`tier-${level}` 查前缀，`tier-${level}-active` 连后缀一起查；
 *   - 判断不了的动态片段：**不静默跳过**，收集起来在失败信息里给出文件、行号和原文。
 *
 * 解析细节（注释 / 字符串 / 行号）在 test/css-audit-lib.ts，另有 test/css-audit-lib.test.ts
 * 用具体输入逐条验证。
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
/* 收集                                                                */
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

interface Usage {
  token: string
  file: string
  line: number
  kind: 'static' | 'prefix' | 'suffix'
}

const cssFiles = [...walk(srcDir, ['.css']), ...EXTRA_CSS_SOURCES.map((file) => path.join(root, file))]
const sourceFiles = walk(srcDir, ['.tsx', '.ts']).filter((file) => !file.endsWith('.d.ts'))
const defined = collectDefinedClasses(cssFiles)

const usages: Usage[] = []
const unresolved: Array<{ file: string; line: number; raw: string }> = []

for (const file of sourceFiles) {
  const code = fs.readFileSync(file, 'utf8')
  const relative = path.relative(root, file).replace(/\\/g, '/')
  for (const expression of extractClassNameExpressions(code)) {
    const scan = scanClassNames(expression.raw)
    for (const token of scan.static) usages.push({ token, file: relative, line: expression.line, kind: 'static' })
    for (const token of scan.prefixes) usages.push({ token, file: relative, line: expression.line, kind: 'prefix' })
    for (const token of scan.suffixes) usages.push({ token, file: relative, line: expression.line, kind: 'suffix' })
    if (scan.unresolved) unresolved.push({ file: relative, line: expression.line, raw: expression.raw })
  }
}

const usedTokens = new Set(usages.map((item) => item.token))

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

test('扫描到的东西不是空的（防止 walk 写错后这条守卫变成永远通过）', () => {
  assert.ok(cssFiles.length >= 5, `只找到 ${cssFiles.length} 个 CSS 文件，路径可能写错了`)
  assert.ok(sourceFiles.length >= 20, `只找到 ${sourceFiles.length} 个源码文件，路径可能写错了`)
  assert.ok(defined.size >= 100, `只解析出 ${defined.size} 个类名，选择器提取可能失效了`)
  assert.ok(usedTokens.size >= 100, `只找到 ${usedTokens.size} 个被使用的类名，className 提取可能失效了`)
})

test('源码里用到的每个静态 className 都在 CSS 里有对应规则', () => {
  const missing: string[] = []
  for (const usage of usages) {
    if (usage.kind !== 'static') continue
    if (defined.has(usage.token)) continue
    if (Object.hasOwn(ALLOWED_WITHOUT_STYLE, usage.token)) continue
    missing.push(`  ${usage.token}  ←  ${usage.file}:${usage.line}`)
  }
  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    `以下类名写了但没有任何 CSS 规则（要么补样式，要么加进 ALLOWED_WITHOUT_STYLE 并写明原因）：\n${missing.join('\n')}`,
  )
})

test('模板串里的动态前缀 / 后缀也能对上具体规则', () => {
  const names = [...defined]
  const problems: string[] = []
  for (const usage of usages) {
    if (usage.kind === 'static') continue
    const hit = usage.kind === 'prefix'
      ? names.some((name) => name.startsWith(usage.token))
      : names.some((name) => name.endsWith(usage.token))
    if (!hit) {
      const what = usage.kind === 'prefix' ? '前缀' : '后缀'
      problems.push(`  ${usage.token}*  ←  ${usage.file}:${usage.line}（这个${what}下没有任何规则）`)
    }
  }
  assert.deepEqual(
    [...new Set(problems)].sort(),
    [],
    `模板串拼出来的类名找不到对应规则：\n${problems.join('\n')}`,
  )
})

test('判断不了的动态表达式不会被静默跳过', () => {
  /*
   * 这一条是审查意见 P2 第 2 条：`${a}-${b}` 这种中间片段没法归约成前缀或后缀，
   * 静态分析到此为止。它**不允许**被塞进白名单糊过去，也不允许安静地消失 ——
   * 一旦出现，就必须带着文件、行号和原文报出来，由人来判断。
   */
  assert.deepEqual(
    unresolved.map((item) => `${item.file}:${item.line}  ${item.raw.replace(/\s+/g, ' ').slice(0, 120)}`),
    [],
    '这些 className 静态分析判断不了，请人工确认它们拼出来的类名在 CSS 里存在',
  )
})

test('白名单里没有已经失效的条目', () => {
  const stale = Object.keys(ALLOWED_WITHOUT_STYLE).filter((token) => !usedTokens.has(token))
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
