import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildMemoryExportPrompt } from '../src/lib/persona-export.ts'
import { DEFAULT_SETTINGS, type MemoryEntry, type Settings } from '../src/lib/types.ts'

/**
 * 回归测试：纸雕右键菜单 + 首次切网页模式的风险提醒。
 *
 * 两条硬约束：
 *   1. mountPet 会被 toString() 注入到 chat.deepseek.com，所以函数体里不能 import、
 *      不能引用模块级常量；菜单要复制的文本必须由 options 回调带进来。
 *   2. 风险提醒必须在「真的切换模型」之前；取消不能把模型切过去。
 */

const MOUNT = readFileSync('src/components/pet/mountPet.ts', 'utf8')
const WEB_MODE = readFileSync('src/lib/web-mode.ts', 'utf8')
const CHAT = readFileSync('src/components/Chat.tsx', 'utf8')
const CSS = readFileSync('src/components/pet/pet.css', 'utf8')

function settings(): Settings {
  return { ...DEFAULT_SETTINGS }
}

function memory(text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem_' + text,
    text,
    type: 'profile',
    tags: [],
    importance: 2,
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    ...patch,
  }
}

test('mountPet 仍然可以被 toString() 注入（文件里没有 import）', () => {
  assert.ok(!/^\s*import\s/m.test(MOUNT), 'mountPet.ts 里出现了 import，注入后会直接报错')
})

test('右键菜单挂在 shadow root 上，fixed 定位并做视口内收敛', () => {
  assert.ok(MOUNT.includes('orca-context-menu'), '缺少菜单节点')
  assert.ok(MOUNT.includes('shadow.appendChild(box)'), '菜单没有挂到 shadow root')
  assert.ok(MOUNT.includes('getBoundingClientRect()'), '菜单没有量尺寸做视口收敛')
  assert.ok(CSS.includes('.orca-context-menu'), 'pet.css 缺少菜单样式')
  assert.ok(CSS.includes('position: fixed'), '菜单应为 fixed 定位')
  assert.ok(CSS.includes('pointer-events: auto'), '菜单要自己接收点击（宿主是 pointer-events:none）')
})

test('两个菜单项由 options 回调提供（注入脚本拿不到 store）', () => {
  assert.ok(MOUNT.includes('onCopyPersonaPrompt'), '缺少人格提示词回调')
  assert.ok(MOUNT.includes('onCopyMemoryExportMarkdown'), '缺少记忆导出回调')
  assert.ok(WEB_MODE.includes('personaPrompt'), 'web-mode 没把人格文本带进 config')
  assert.ok(WEB_MODE.includes('memoryExportPrompt'), 'web-mode 没把导出文本带进 config')
  assert.ok(WEB_MODE.includes('onCopyPersonaPrompt: function'), '注入脚本没接人格回调')
  assert.ok(WEB_MODE.includes('onCopyMemoryExportMarkdown: function'), '注入脚本没接导出回调')
  assert.ok(
    WEB_MODE.includes('buildWebChatContextForSettings(settings, memories)'),
    '人格文本没按当前设置生成',
  )
})

test('复制失败要有兜底（textarea 必须放 body，shadow 里的选区复制不到）', () => {
  assert.ok(MOUNT.includes('navigator.clipboard.writeText'), '没有走剪贴板 API')
  assert.ok(MOUNT.includes("document.execCommand('copy')"), '没有 execCommand 兜底')
  assert.ok(MOUNT.includes('document.body.appendChild(area)'), '兜底 textarea 没挂到 body')
})

test('手机没有右键：触摸长按也要能弹菜单', () => {
  assert.ok(MOUNT.includes('LONG_PRESS_MS'), '缺少长按阈值')
  assert.ok(MOUNT.includes("event.pointerType === 'touch'"), '没有识别触摸指针')
  assert.ok(MOUNT.includes('longPressFired'), '长按后没有抑制「戳虎鲸」的动作')
})

test('菜单能关掉，dispose 时清理干净', () => {
  assert.ok(MOUNT.includes("event.key === 'Escape'"), 'Esc 不能关菜单')
  assert.ok(MOUNT.includes('onMenuOutside'), '点外部不能关菜单')
  assert.ok(
    MOUNT.includes("document.addEventListener('pointerdown', onMenuOutside, true)"),
    '外部点击监听没挂',
  )
  assert.ok(
    MOUNT.includes("document.removeEventListener('pointerdown', onMenuOutside, true)"),
    'dispose 没摘掉外部点击监听',
  )
  assert.ok(MOUNT.includes('menuEl.parentNode.removeChild(menuEl)'), 'dispose 没移除菜单节点')
})

test('记忆导出命令带人设和常驻记忆，没有记忆时不带空小节', () => {
  const withMemory = buildMemoryExportPrompt(settings(), [memory('用户叫小明')])
  assert.ok(withMemory.includes('## 助手人设'), '缺少人设小节')
  assert.ok(withMemory.includes('你是「深鲸」'), '人设正文没带上')
  assert.ok(withMemory.includes('## 记忆条目'), '缺少记忆小节')
  assert.ok(withMemory.includes('- 用户叫小明'), '记忆条目没带上')

  const empty = buildMemoryExportPrompt(settings(), [])
  assert.ok(empty.includes('## 助手人设'), '空记忆时人设也该在')
  assert.ok(!empty.includes('## 记忆条目'), '空记忆时不该出现空小节')
})

test('风险提醒在切换模型之前，取消就不切', () => {
  const start = CHAT.indexOf('async function chooseModel')
  assert.ok(start !== -1, '没找到 chooseModel')
  const end = CHAT.indexOf('function onModelKeyDown', start)
  assert.ok(end > start, '没找到 chooseModel 的结尾')
  const body = CHAT.slice(start, end)
  const risk = body.indexOf('confirmWebChatRisk')
  const apply = body.indexOf('setSettings({ model: id })')
  assert.ok(risk !== -1, 'chooseModel 没弹风险提醒')
  assert.ok(apply !== -1, 'chooseModel 没有设置模型')
  assert.ok(risk < apply, '必须先弹提醒、确认后才切模型')
  assert.ok(body.includes('if (!(await confirmWebChatRisk()))'), '取消后没有提前返回')
  assert.ok(
    CHAT.includes("const WEB_CHAT_RISK_KEY = 'deepsea_webchat_risk_warned'"),
    '缺少一次性标记',
  )
  assert.ok(
    !CHAT.includes('不支持记忆同步'),
    '风险文案里还写着「不支持记忆同步」（不准确：人设和常驻记忆会注入）',
  )
})
