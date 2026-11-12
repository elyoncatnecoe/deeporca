import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 工坊第 4 轮修复的回归测试：超长粘贴卡死 / 项目隔离 / 副本备份 / 对话重绑。
 *
 * 这些模块一路 import 到 IndexedDB 与 Capacitor，在 node 里跑不起来，
 * 所以按 test/workshop-projects.test.ts 的写法锁源码里的关键落点（纯文本断言）。
 */

const WORKSHOP = readFileSync('src/components/Workshop.tsx', 'utf8')
const WORKSPACE = readFileSync('src/lib/workspace.ts', 'utf8')
const STORE = readFileSync('src/lib/store.ts', 'utf8')
const ENGINE = readFileSync('src/lib/engine.ts', 'utf8')
const PROMPT = readFileSync('src/lib/prompt.ts', 'utf8')
const TYPES = readFileSync('src/lib/types.ts', 'utf8')
const CHAT = readFileSync('src/components/Chat.tsx', 'utf8')

test('P0 超长粘贴：粘贴闸门与大文档动态降配都在编辑器里', () => {
  assert.ok(WORKSHOP.includes('MAX_FILE_CHARS'), '没有引入文件字符上限常量')
  assert.ok(WORKSHOP.includes('EditorView.domEventHandlers'), '没有粘贴/输入闸门')
  assert.ok(WORKSHOP.includes('paste:'), '粘贴事件没被拦')
  assert.ok(WORKSHOP.includes('BIG_DOC_CHARS'), '没有大文档阈值')
  assert.ok(WORKSHOP.includes('EditorView.lineWrapping'), '大文档没关掉换行')
  assert.ok(WORKSHOP.includes('bracketMatching()'), '大文档没关掉括号匹配')
  assert.ok(WORKSHOP.includes('syntaxHighlighting('), '大文档没关掉语法高亮')
})

test('P0 超长粘贴：编辑器非受控，逐键不再抬全文、不再整树重渲染', () => {
  assert.ok(WORKSHOP.includes('const contentRef = useRef'), '没有用 ref 存当前文档')
  assert.ok(!WORKSHOP.includes('setContent(next)'), '逐键还在 setContent(全文)')
  assert.ok(!WORKSHOP.includes('insert: props.value'), '还留着 [props.value] 全文回灌 effect')
  // 全文只在落盘那一刻取一次
  assert.ok(WORKSHOP.includes('.state.doc.toString()'), '没有在落盘时读编辑器全文')
  // 撤销/重做可用性变化才更新，别每次挪光标都抬升整树
  assert.ok(WORKSHOP.includes('historyAvailRef.current'), '可用性没有做前后比较')
})

test('P0 超长粘贴：上限校验前移到保存期，dirty 不会永远卡住', () => {
  assert.ok(WORKSHOP.includes('if (text.length > MAX_FILE_CHARS)'), '防抖保存没有长度校验')
  assert.ok(WORKSHOP.includes('if (content.length > MAX_FILE_CHARS)'), 'flushSave 没有长度校验')
})

test('P2 文案：上限是 240000 字符，不是 240KB', () => {
  assert.ok(WORKSPACE.includes('240000 字符'), '报错文案没改成 240000 字符')
  assert.ok(!WORKSPACE.includes('240KB'), '误导性的 KB 文案没删干净')
  assert.ok(WORKSPACE.includes('export const MAX_FILE_CHARS = 240_000'), '上限常量没导出')
})

test('P0 项目隔离：TOOL_DEFINITIONS 里有 create_project / list_projects', () => {
  assert.ok(WORKSPACE.includes("name: 'list_projects'"), '缺 list_projects 工具')
  assert.ok(WORKSPACE.includes("name: 'create_project'"), '缺 create_project 工具')
})

test('P0 项目隔离：write_file 等文件工具有可选 project 参数', () => {
  const defs = WORKSPACE.slice(WORKSPACE.indexOf('export const TOOL_DEFINITIONS'), WORKSPACE.indexOf('function cleanPath'))
  const write = defs.slice(defs.indexOf("name: 'write_file'"), defs.indexOf("name: 'delete_file'"))
  assert.ok(write.includes('project:'), 'write_file 没有 project 参数')
  assert.ok(defs.includes("name: 'read_file'"), 'read_file 工具丢了')
  assert.ok(defs.includes("name: 'list_files'"), 'list_files 工具丢了')
  assert.ok(defs.includes("name: 'delete_file'"), 'delete_file 工具丢了')
})

test('P0 项目隔离：list_files 结果带项目名表头', () => {
  assert.ok(WORKSPACE.includes('setToolWorkspaceName'), '没有把项目名交给工坊层的机制')
  assert.ok(WORKSPACE.includes('项目「'), 'list_files 结果没有项目表头')
})

test('P0 项目隔离：prompt 教模型先建项目、用 project 指定目标', () => {
  assert.ok(PROMPT.includes('list_projects'), '提示词没提 list_projects')
  assert.ok(PROMPT.includes('create_project'), '提示词没提 create_project')
  assert.ok(PROMPT.includes('project 参数'), '提示词没提 project 参数')
  assert.ok(PROMPT.includes('别把新代码覆盖进老项目'), '提示词没写「新应用先建项目」的规则')
})

test('P0 项目隔离：engine 在 executeTool 前拦截项目级工具并解析 project', () => {
  assert.ok(ENGINE.includes("'list_projects'"), 'engine 没拦 list_projects')
  assert.ok(ENGINE.includes("'create_project'"), 'engine 没拦 create_project')
  assert.ok(ENGINE.includes('createWorkspace('), 'create_project 没复用 createWorkspace')
  assert.ok(ENGINE.includes('项目不存在'), 'project 指错时没报错')
  assert.ok(ENGINE.includes('setActiveWorkspace('), '写入后没把界面切到目标项目')
  assert.ok(ENGINE.includes('refreshWorkspace(targetWorkspaceId)'), '没按目标项目刷新')
  assert.ok(ENGINE.includes('setToolWorkspaceName('), '没把项目名喂给 list_files')
})

test('P0 项目隔离：工具卡与工具调用行显示项目名', () => {
  assert.ok(TYPES.includes('workspaceName?: string'), 'ChatMessage 没有 workspaceName 字段')
  assert.ok(ENGINE.includes('workspaceName'), 'engine 没回填项目名')
  assert.ok(CHAT.includes('message.workspaceName'), '工具卡/调用行没渲染项目名')
})

test('P1 副本备份：workspace / store 都有复制实现，工坊有入口', () => {
  assert.ok(WORKSPACE.includes('export async function copyWorkspaceFile'), '缺 copyWorkspaceFile')
  assert.ok(WORKSPACE.includes('export async function duplicateWorkspaceFiles'), '缺 duplicateWorkspaceFiles')
  assert.ok(WORKSPACE.includes('await putFile(copy)'), '副本没写新记录')
  assert.ok(WORKSPACE.includes('await deleteFile(source.id)'), '改名/移动仍要删旧记录（回归保护）')
  assert.ok(STORE.includes('duplicateWorkspace:'), 'store 没有 duplicateWorkspace action')
  assert.ok(STORE.includes('copyWorkspaceFile:'), 'store 没有 copyWorkspaceFile action')
  assert.ok(WORKSHOP.includes('复制项目'), '工坊没有复制项目按钮')
  assert.ok(WORKSHOP.includes('复制文件副本'), '工坊没有复制文件副本按钮')
  assert.ok(WORKSHOP.includes('路径只能用英文/数字/点/横线/下划线'), '副本路径没提示 ASCII 限制')
})

test('P1 对话可重绑到项目：store 有 setConversationWorkspace，工坊有入口', () => {
  assert.ok(STORE.includes('setConversationWorkspace:'), 'store 没有重绑 action')
  assert.ok(STORE.includes('async setConversationWorkspace(workspaceId)'), '重绑实现没落库')
  assert.ok(STORE.includes('await putConversation(next)'), '重绑没有持久化')
  assert.ok(WORKSHOP.includes('当前对话写入'), '工坊没有提示当前对话写入目标')
  assert.ok(WORKSHOP.includes('setConversationWorkspace'), '工坊没接上重绑 action')
  assert.ok(WORKSHOP.includes('切换上面的项目只改界面'), '没提示「切 UI 不等于切写入目标」')
})
