import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { snippetExtension, suggestSnippetPath } from '../src/lib/snippet-path.ts'

/**
 * 回归测试：工坊项目 / 文件重命名 / 保存前确认 / 导出多选。
 *
 * 这一轮解决的是「垃圾文件」和「不能分项目」：
 *   1. 代码块不再直接写 snippet-<时间戳>，先问文件名和项目；
 *   2. 工坊可以重命名文件、可以按项目分开；
 *   3. 导出可以多选，不再只能整段导。
 */

const STORE = readFileSync('src/lib/store.ts', 'utf8')
const ENGINE = readFileSync('src/lib/engine.ts', 'utf8')
const SETTINGS = readFileSync('src/lib/settings.ts', 'utf8')
const WORKSPACE = readFileSync('src/lib/workspace.ts', 'utf8')
const WORKSHOP = readFileSync('src/components/Workshop.tsx', 'utf8')
const EXPORT = readFileSync('src/components/ExportDialog.tsx', 'utf8')
const SAVE = readFileSync('src/components/SaveToWorkshop.tsx', 'utf8')
const CHAT = readFileSync('src/components/Chat.tsx', 'utf8')
const DB = readFileSync('src/lib/db.ts', 'utf8')
const TYPES = readFileSync('src/lib/types.ts', 'utf8')

test('代码块语言映射到扩展名', () => {
  assert.equal(snippetExtension('html'), 'html')
  assert.equal(snippetExtension('xml'), 'html')
  assert.equal(snippetExtension('css'), 'css')
  assert.equal(snippetExtension('js'), 'js')
  assert.equal(snippetExtension('javascript'), 'js')
  assert.equal(snippetExtension('typescript'), 'js')
  assert.equal(snippetExtension('json'), 'json')
  assert.equal(snippetExtension('markdown'), 'md')
  assert.equal(snippetExtension('python'), 'py')
  assert.equal(snippetExtension(''), 'txt')
  assert.equal(snippetExtension('sql'), 'txt')
})

test('预填文件名会顺延编号，不撞已有文件', () => {
  assert.equal(suggestSnippetPath('html', []), 'snippet.html')
  assert.equal(suggestSnippetPath('html', ['snippet.html']), 'snippet-2.html')
  assert.equal(suggestSnippetPath('js', ['snippet.js', 'snippet-2.js']), 'snippet-3.js')
  // 别的扩展名互不影响
  assert.equal(suggestSnippetPath('css', ['snippet.html']), 'snippet.css')
})

test('保存代码块前先问文件名和项目，同名要确认覆盖', () => {
  assert.ok(SAVE.includes('readWorkspaceFile(name, workspaceId)'), '没有检查目标项目里的同名文件')
  assert.ok(SAVE.includes('confirmDialog({'), '同名文件没有先问用户')
  assert.ok(SAVE.includes('覆盖'), '没有覆盖确认文案')
  assert.ok(SAVE.includes('存到项目'), '面板里没有项目选择')
  assert.ok(CHAT.includes('setSnippetDraft({ code, lang })'), '聊天页没有走确认面板')
  assert.ok(!CHAT.includes('snippet-${Date.now()'), '聊天页还在直接生成 snippet-<时间戳>')
})

test('工坊文件可以重命名、可以移到别的项目', () => {
  assert.ok(WORKSPACE.includes('export async function renameWorkspaceFile'), '缺少重命名实现')
  assert.ok(WORKSPACE.includes('export async function moveWorkspaceFile'), '缺少移动到项目的实现')
  // 改名 = 写新路径 + 删旧记录；重名要拒绝，不能覆盖
  assert.ok(WORKSPACE.includes('同名文件已存在'), '重名时没有拒绝')
  assert.ok(WORKSPACE.includes('await deleteFile(source.id)'), '改名后没有删掉旧记录')
  assert.ok(STORE.includes('renameWorkspaceFile: (oldPath: string, newPath: string)'), 'store 没有暴露重命名')
  assert.ok(STORE.includes('moveWorkspaceFile: (path: string, targetWorkspaceId: string)'), 'store 没有暴露移动')
  assert.ok(WORKSHOP.includes('重命名'), '工坊界面没有重命名入口')
  assert.ok(WORKSHOP.includes('移动到…'), '工坊界面没有移动入口')
})

test('工坊可以分项目，文件按项目隔离', () => {
  assert.ok(TYPES.includes('export interface Workspace'), '缺少 Workspace 类型')
  assert.ok(TYPES.includes('workspaces: Workspace[]'), 'Settings 里没有项目列表')
  assert.ok(SETTINGS.includes('DEFAULT_WORKSPACE'), '设置归一化没有兜底默认项目')
  assert.ok(SETTINGS.includes('activeWorkspaceId'), '设置归一化没有校正当前项目')
  assert.ok(STORE.includes('setActiveWorkspace'), 'store 没有切换项目')
  assert.ok(STORE.includes('createWorkspace'), 'store 没有新建项目')
  assert.ok(STORE.includes('deleteWorkspace'), 'store 没有删除项目')
  assert.ok(DB.includes('deleteFilesByWorkspace'), '删除项目时没有清文件')
  // 所有工坊读写都要带上当前项目
  assert.ok(WORKSHOP.includes('previewHtml(activeWorkspaceId)'), '预览没按项目取文件')
  assert.ok(WORKSHOP.includes('writeWorkspaceFile(selected, content, activeWorkspaceId)'), '保存没写到当前项目')
  assert.ok(WORKSHOP.includes('deleteWorkspaceFile(selected, activeWorkspaceId)'), '删除没按项目走')
  assert.ok(WORKSHOP.includes('restoreSample(activeWorkspaceId)'), '恢复范例没按项目走')
})

test('对话绑定工坊项目，模型写文件落在对应项目里', () => {
  assert.ok(TYPES.includes('workspaceId?: string'), 'Conversation 没有项目字段')
  assert.ok(STORE.includes('workspaceId: settings.activeWorkspaceId || DEFAULT_WORKSPACE'), '新对话没有绑定项目')
  assert.ok(DB.includes('workspaceId: source.workspaceId'), '分叉没有继承项目')
  assert.ok(
    ENGINE.includes('const workspaceId = conversation?.workspaceId || settings.activeWorkspaceId || DEFAULT_WORKSPACE'),
    'engine 没有解析本轮项目',
  )
  assert.ok(
    ENGINE.includes('executeTool(call.function.name, call.function.arguments, workspaceId)'),
    '工具调用没有带项目',
  )
})

test('备份覆盖所有项目的文件', () => {
  const backup = readFileSync('src/lib/backup.ts', 'utf8')
  assert.ok(backup.includes('listAllFiles()'), '备份只导了默认项目（多项目会丢文件）')
  assert.ok(DB.includes('export async function listAllFiles'), 'db 没有「所有文件」查询')
})

test('导出可以多选：全选/全不选/只要提问/只要回答 + 预览', () => {
  assert.ok(EXPORT.includes('全选'), '缺少全选')
  assert.ok(EXPORT.includes('全不选'), '缺少全不选')
  assert.ok(EXPORT.includes('只要提问'), '缺少只要提问')
  assert.ok(EXPORT.includes('只要回答'), '缺少只要回答')
  assert.ok(EXPORT.includes('type="checkbox"'), '没有逐条复选框')
  assert.ok(EXPORT.includes('export-preview'), '没有预览区')
  assert.ok(EXPORT.includes('chosen.length === 0'), '没选任何消息时应该禁用导出')
})
