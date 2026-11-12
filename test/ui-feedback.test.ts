import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * UI 反馈修复的回归测试（分支 fix/ui-feedback-1）。
 *
 * 对应真机上报的四个问题：
 *   ① 历史对话「全部助手」点开白屏 —— 裸 <select> 在 Android WebView 上弹系统窗口；
 *   ② 历史抽屉的「+」绕过单聊/群聊选择 —— 群聊功能看起来「还是老的」；
 *   ③ 快捷指令面板写死「虎鲸动作」—— 不跟随当前助手名；
 *   ④ 发送后输入框暂留 —— 清空发生在整轮生成结束之后，而不是消息落库那一刻。
 *
 * 写法沿用 test/sending-state.test.ts：engine / store 依赖 IndexedDB 与 Capacitor，
 * node 里跑不起来，所以用「剥掉注释后的源码结构」断言。这不是端到端测试。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

/** 去掉行注释与块注释，避免注释里的字眼被当成代码。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

const history = read('src/components/HistoryDrawer.tsx')
const chat = read('src/components/Chat.tsx')
const quick = read('src/components/QuickCommands.tsx')
const store = read('src/lib/store.ts')
const app = read('src/App.tsx')
const engine = read('src/lib/engine.ts')
const styles = read('src/styles.css')

/* ------------------------------------------------------------------ */
/* ① 原生 select 白屏                                                   */
/* ------------------------------------------------------------------ */

test('① 历史筛选不再用原生 <select>，改用自绘 Select', () => {
  const code = stripComments(history)
  assert.doesNotMatch(code, /<select\b/, '原生 select 在 Android WebView 上会弹系统窗口（白屏）')
  assert.doesNotMatch(code, /<option\b/, '原生 option 同样属于系统弹层')
  assert.match(history, /import \{[^}]*\bSelect\b[^}]*\} from '\.\/ui'/, '应复用 ui.tsx 的自绘 Select')
  assert.match(code, /<Select\b/, '筛选器必须用自绘组件')
})

test('① 整个组件树里都不再出现原生 <select>（新规矩：表单组件要跟深色主题走）', () => {
  const dir = path.join(root, 'src', 'components')
  const offenders: string[] = []
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx$/.test(entry.name)) continue
      if (/<select\b/.test(stripComments(fs.readFileSync(full, 'utf8')))) {
        offenders.push(path.relative(root, full))
      }
    }
  }
  walk(dir)
  assert.deepEqual(offenders, [], `这些组件还在用原生 select：${offenders.join(', ')}`)
})

test('① 新增的筛选容器有对应样式（不留裸 DOM）', () => {
  assert.match(styles, /\.drawer-filter\s*\{/, '.drawer-filter 必须有样式，否则又是「加了组件没加样式」')
})

/* ------------------------------------------------------------------ */
/* ② 新建对话入口统一                                                   */
/* ------------------------------------------------------------------ */

test('② 历史抽屉的「+」打开统一的新建对话弹层，而不是直接建会话', () => {
  const code = stripComments(history)
  assert.match(code, /setNewChatOpen\(true\)/, '抽屉里的「+」要打开单聊/群聊选择')
  assert.doesNotMatch(code, /void actions\.createConversation\(\)/, '不能再直接 createConversation 绕过群聊选择')
})

test('② 弹层状态提升到 store，Chat 与抽屉共用同一份', () => {
  assert.match(store, /newChatOpen: boolean/, 'store 要有 newChatOpen')
  assert.match(store, /setNewChatOpen: \(open: boolean\) => void/, 'store 要有对应动作')
  assert.match(store, /setNewChatOpen\(newChatOpen\)/, '动作要真的写状态')
  assert.match(store, /newChatOpen: false,/, '初始值必须显式给（否则 undefined 会让弹层行为怪）')

  const chatCode = stripComments(chat)
  assert.match(chatCode, /actions\.setNewChatOpen\(true\)/, 'Chat 顶部的「+」也走同一个动作')
  assert.doesNotMatch(chatCode, /useState\(false\)[\s\S]{0,40}newChatOpen/, 'Chat 不该再持有本地 newChatOpen 状态')
})

test('② 弹层挂在 App 层渲染，历史页也能用', () => {
  assert.match(app, /import \{ NewChatSheet \}/, 'App 要引入弹层')
  assert.match(app, /<NewChatSheet\b/, 'App 要渲染弹层')
  assert.match(app, /newChatOpen/, 'App 要订阅这个状态')
})

/* ------------------------------------------------------------------ */
/* ③ 快捷指令文案：动作组固定「虎鲸动作」，工具组用泛称「助手」           */
/* ------------------------------------------------------------------ */

test('③ 动作组固定叫「虎鲸动作」，不跟随助手名', () => {
  const code = stripComments(quick)
  // 这一组是身体动画，只有虎鲸本体有 —— 所以它就该写死，不能跟着助手名变。
  assert.match(code, /<span>虎鲸动作<\/span>/, '动作组标题必须固定为「虎鲸动作」')
  assert.match(code, /aria-label="虎鲸动作"/, '无障碍标签同样固定')
  assert.doesNotMatch(quick, /assistantName/, '不该为了改这个标题引入助手名参数/判定')
})

test('③ 常用指令用泛称「助手」，不写死某个名字', () => {
  const code = stripComments(quick)
  assert.match(code, /label: '让助手写网页'/, '工具指令应写成「让助手写网页」')
  assert.match(code, /label: '让助手记住当前记忆'/, '工具指令应写成「让助手记住当前记忆」')
  assert.doesNotMatch(code, /让虎鲸写网页|让虎鲸记住/, '工具指令里不该再出现具体名字')
})

test('③ Chat 不再向快捷指令面板传助手名', () => {
  const code = stripComments(chat)
  assert.doesNotMatch(code, /<QuickCommands[^>]*assistantName/, '传了也用不上，属于多余耦合')
})

/* ------------------------------------------------------------------ */
/* ④ 输入框在「消息落库」那一刻清空                                      */
/* ------------------------------------------------------------------ */

test('④ engine 提供 onAccepted 回调，并在用户消息落库处触发', () => {
  assert.match(engine, /onAccepted\?: \(\) => void/, 'sendMessage / sendGroupMessage 要接受 onAccepted')
  const calls = (engine.match(/options\.onAccepted\?\.\(\)/g) ?? []).length
  assert.ok(calls >= 2, `单聊与群聊两条路径都要触发，实际 ${calls} 处`)
})

test('④ 触发点在「落库之后、生成之前」——这是「暂留」的根因', () => {
  const body = engine.slice(engine.indexOf('export async function sendMessage'), engine.indexOf('export async function sendGroupMessage'))
  const accepted = body.indexOf('accepted = true')
  const notify = body.indexOf('options.onAccepted?.()')
  const generate = body.indexOf('await runAssistantTurn')

  assert.ok(accepted >= 0 && notify >= 0 && generate >= 0, '三个锚点都要能找到')
  assert.ok(accepted < notify, 'onAccepted 必须在 accepted = true 之后')
  assert.ok(notify < generate, 'onAccepted 必须在开始生成之前 —— 否则输入框还是会暂留到回复结束')
})

test('④ Chat 不再在 await 之后无条件清空输入框', () => {
  const code = stripComments(chat)
  assert.doesNotMatch(
    code,
    /if \(accepted\) \{\s*setInput\(''\)/,
    '不能在 sendMessage 返回后才清空（那时整轮回复已经生成完了）',
  )
  assert.match(code, /clearComposerIfUnchanged/, '应改由 onAccepted 触发清空')
  assert.match(code, /onAccepted: clearComposerIfUnchanged/, '两条发送路径都要挂上回调')
})

test('④ 清空前确认输入框没被用户改过（不误删新输入）', () => {
  const code = stripComments(chat)
  assert.match(code, /inputRef\.current\.value\.trim\(\) === text/, '只有内容还是刚才那段时才清空')
})
