import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 「模型目录」与「分享 / 导出」的回归测试（源码结构断言）。
 *
 * 为什么用结构断言而不是渲染测试：Chat / Providers 依赖 zustand + IndexedDB +
 * Capacitor，在 node 里跑不起来；而这两轮改动的关键恰恰是「谁给选择器供数据」
 * 和「导出弹层有没有偷偷塞进图片格式」这类结构问题，用源码断言反而更稳。
 * 真机行为由 scripts/probe-model-catalog.mjs 与 scripts/probe-export-select.mjs 覆盖。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8')

test('模型选择器吃「模型目录」，不再拿内置表兜底', () => {
  const chat = read('src/components/Chat.tsx')
  assert.match(chat, /providerModels\(settings\)/, '聊天页模型选项必须来自当前供应商的模型目录')
  assert.match(chat, /目录外 ID，仍可直接发送/, '当前模型不在目录里时也要留一行，否则用户看不到自己在用什么')
  assert.equal(
    /modelOptions = settings\.model !== '' && !MODEL_IDS\.includes/.test(chat),
    false,
    '内置模型表兜底已按 DSH 语义去掉：目录为空就一个模型都不显示',
  )
})

test('多选：三键 + 确定后带着选中的消息打开导出弹层', () => {
  const chat = read('src/components/Chat.tsx')
  assert.match(chat, /className="selection-bar"/)
  assert.match(chat, /aria-label="取消多选"/)
  assert.match(chat, /aria-label=\{allSelected \? '全不选' : '全选'\}/)
  assert.match(chat, /aria-label="确定"/)
  assert.match(chat, /preselectIds=\{exportIds \?\? undefined\}/)
  assert.match(chat, /message\.role !== 'tool'/, '工具消息不参与全选（也不导出）')
  // 长按已经被自绘的文本选择条占用（SelectionCopyBar），多选只能走按钮入口。
  assert.equal(/onContextMenu|onLongPress/.test(chat), false, '别给气泡加长按多选，会和 SelectionCopyBar 抢手势')
})

test('导出格式弹层：默认导出思维过程，且没有图片格式', () => {
  const dialog = read('src/components/ExportDialog.tsx')
  assert.match(dialog, /title="导出格式"/)
  assert.match(dialog, /const \[includeReasoning, setIncludeReasoning\] = useState\(true\)/, '「导出思维过程」默认开')
  // 注释里会提到「图片 / PNG」解释为什么不做，判断前先把注释去掉。
  const code = dialog.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(code.includes('PNG'), false, '用户明确不需要图片导出')
  assert.equal(/导出为图片/.test(code), false)
  assert.match(dialog, /preselectIds/, '多选模式要能把选中的消息带进来')
})

test('样式契约：多选条 / 勾选圈 / 模型目录 / 导出卡片都有规则', () => {
  const css = read('src/styles.css')
  for (const selector of [
    '.selection-bar',
    '.selection-bar-btn',
    '.bubble-select',
    '.model-catalog',
    '.model-catalog-row',
    '.model-picker-search',
    '.export-format-card',
    '.export-format-hint',
  ]) {
    assert.ok(css.includes(selector), `styles.css 缺少 ${selector}`)
  }
  assert.match(css, /\.chat-scroll\[data-selecting='true'\]/, '多选时左侧要让出勾选圈的通道，否则会被滚动容器裁掉')
})

test('供应商页：模型目录组件接管了原来的「一行一个」文本域', () => {
  const providers = read('src/components/Providers.tsx')
  assert.match(providers, /<ModelCatalog/)
  const settings = read('src/lib/settings.ts')
  assert.match(settings, /normalizeModelMeta/, 'modelMeta 必须过归一化，脏数据不能带进运行时')
})

test('设置页的模型下拉也按目录走，不再回落到内置表', () => {
  const settings = read('src/components/Settings.tsx')
  assert.match(settings, /return provider\?\.models \?\? \[\]/, '目录为空就是空，别再回落到内置四个')
  assert.equal(/return MODELS\b/.test(settings), false)
  assert.match(settings, /currentProviderMeta/, '目录带回来的显示名/上下文要显示出来')
})

test('气泡动作条只留图标，其余动作进「⋯」菜单', () => {
  const chat = read('src/components/Chat.tsx')
  // 以前是「多选 复制 分享 编辑 重新生成 分叉 删除」七个文字按钮，窄屏会被压成一字一行。
  assert.equal(/>多选</.test(chat), false, '动作条里不该再有文字「多选」按钮')
  assert.equal(/>重新生成</.test(chat), false, '动作条里不该再有文字「重新生成」按钮')
  assert.match(chat, /className="bubble-act"/, '动作条按钮是图标样式 .bubble-act')
  assert.match(chat, /aria-label="复制"/, '复制按钮在')
  assert.match(chat, /aria-label="更多"/, '⋯ 入口')
  assert.match(chat, /className="bubble-menu"/, '⋯ 菜单容器')
})

test('分享是唯一入口：进去先多选，且预选「从第一条到这一条」', () => {
  const chat = read('src/components/Chat.tsx')
  assert.match(chat, /const shareFromMessage = \(id: string\)/, '分享入口收敛到一个函数')
  assert.match(chat, /\.slice\(0, index < 0 \? messages\.length : index \+ 1\)/, '预选到这一条为止')
  assert.match(chat, /onShare=\{shareFromMessage\}/)
})

test('界面色调挂到 .app 上，和海底主题解绑', () => {
  const app = read('src/App.tsx')
  assert.match(app, /data-tone=\{appTone\}/, '.app 要带上 data-tone')
  // 海底主题已经搬到「布置」屏，不能再从 App.tsx 往 .app 上挂。
  assert.doesNotMatch(app, /data-theme=/, '.app 不该再有 data-theme')
  const css = read('src/styles.css')
  assert.match(css, /\.app\[data-tone='iceberg'\]/, '雾霭色调的变量块')
  assert.match(css, /\.app\[data-tone='tropical'\]/, '暖阳色调的变量块')
  assert.match(css, /--bubble-user-from/, '用户气泡颜色要走变量')
})