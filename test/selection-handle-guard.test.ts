import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Android 文本选择 / 光标 的回归守卫。
 *
 * 这一整套踩过两次坑，而且都**只有真机才看得出来**：
 *   ① 曾用一个「全 no-op 的假 ActionMode」压掉系统浮动选择工具条，结果
 *      光标拖不动、手柄拖不动（假 mode 不遵守契约，且把所有类型都压了）；
 *   ② 压掉工具条后，手柄的 PopupWindow 又退回主题默认的浅色 9-patch，
 *      出现「白底 / 白闪」。
 *
 * 真正的行为验证只能在真机上做；这里用结构断言把「删掉就会复发」的关键点钉死，
 * 防止后续改主题 / 改 ActionMode / 改复制逻辑时把它们悄悄弄回去。
 */

const STYLES = readFileSync('android/app/src/main/res/values/styles.xml', 'utf8')
const WEBVIEW = readFileSync(
  'android/app/src/main/java/com/elyoncat/deepsea/DeepSeaWebView.java',
  'utf8',
)
const SUPPRESSOR = readFileSync(
  'android/app/src/main/java/com/elyoncat/deepsea/SelectionMenuSuppressor.java',
  'utf8',
)
const WEBCHAT = readFileSync(
  'android/app/src/main/java/com/elyoncat/deepsea/WebChatActivity.java',
  'utf8',
)
const MARKDOWN = readFileSync('src/components/Markdown.tsx', 'utf8')

test('只压 TYPE_FLOATING，光标/插入手柄不能被一起压掉', () => {
  assert.match(
    WEBVIEW,
    /ActionMode\.TYPE_FLOATING/,
    'DeepSeaWebView.startActionMode 必须只接管 TYPE_FLOATING；全类型都压会让光标拖不动（历史 bug）',
  )
  assert.match(
    WEBCHAT,
    /onWindowStartingActionMode[\s\S]*?ActionMode\.TYPE_FLOATING/,
    '网页版也要只压 TYPE_FLOATING',
  )
})

test('空 ActionMode 必须遵守契约：给真实 Menu + finish 回调 onDestroy', () => {
  assert.doesNotMatch(
    SUPPRESSOR,
    /getMenu\(\)\s*\{\s*return\s+null/,
    'getMenu() 不能返回 null —— Chromium 会 NPE / 卡死选择会话（历史 bug）',
  )
  assert.match(
    SUPPRESSOR,
    /return\s+menu/,
    'NoOpActionMode.getMenu() 必须返回一个真实的 Menu（PopupMenu(...).getMenu()）',
  )
  assert.match(
    SUPPRESSOR,
    /callback\.onDestroyActionMode\s*\(\s*this\s*\)/,
    'finish() 必须回调 onDestroyActionMode，让 Chromium 正常收尾并保留选区',
  )
  assert.match(SUPPRESSOR, /setType\s*\(\s*ActionMode\.TYPE_FLOATING\s*\)/, '要声明成 TYPE_FLOATING')
})

test('手柄 PopupWindow 的默认背景必须被钉成透明（否则白底/白闪）', () => {
  assert.ok(
    existsSync('android/app/src/main/res/drawable/ds_transparent.xml'),
    'ds_transparent.xml 不存在了 —— 手柄背景会退回浅色 9-patch',
  )
  // AppTheme 与 AppTheme.NoActionBar 两处都要有 popupBackground 兜底。
  const hits = STYLES.split('android:popupBackground').length - 1
  assert.ok(hits >= 2, `styles.xml 里 android:popupBackground 只出现 ${hits} 次，两个主题都要钉透明`)
  assert.match(
    STYLES,
    /name="android:popupBackground">\s*@drawable\/ds_transparent/,
    'popupBackground 必须指向透明 drawable',
  )
  // DsHandleWindow 那一层也要透明。
  const handleWindow = /name="DsHandleWindow"[\s\S]*?<\/style>/.exec(STYLES)
  assert.ok(handleWindow !== null, '找不到 DsHandleWindow 样式')
  assert.match(
    handleWindow[0],
    /@drawable\/ds_transparent/,
    'DsHandleWindow 的 popupBackground 必须是透明 drawable',
  )
})

test('复制代码块不能再靠临时 textarea 抢焦点（会闪输入框/弹键盘）', () => {
  assert.doesNotMatch(
    MARKDOWN,
    /createElement\(\s*['"]textarea['"]\s*\)/,
    'Markdown.tsx 里又出现了临时 textarea —— 安卓上 select() 会闪输入框、弹键盘',
  )
  assert.match(MARKDOWN, /writeClipboardText/, '复制应统一走 platform.writeClipboardText（安卓走原生剪贴板）')
})
