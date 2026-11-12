import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 工坊刷新的回归测试（修复 B7 / RC-5）。
 *
 * 现场：write_file 明明成功了（文件已落 IndexedDB），界面却一点动静都没有 ——
 * 因为引擎写的是**这段对话绑定的项目**（conversation.workspaceId），
 * 而刷新与预览读的都是**当前打开的项目**（settings.activeWorkspaceId）。
 * 对话绑 A 项目、工坊停在 B 项目时，用户读到的就是「工坊根本没被调用」。
 *
 * engine.ts / store.ts 一路 import 到 IndexedDB 与 Capacitor，在 node 里跑不起来，
 * 所以这里锁「刷新按哪个 id」这条线（沿用 test/workshop-projects.test.ts 的写法）。
 */

const STORE = readFileSync('src/lib/store.ts', 'utf8')
const ENGINE = readFileSync('src/lib/engine.ts', 'utf8')
const WORKSHOP = readFileSync('src/components/Workshop.tsx', 'utf8')

test('refreshWorkspace 接受显式项目 id，缺省仍跟着当前项目', () => {
  assert.ok(
    STORE.includes('refreshWorkspace: (workspaceId?: string) => Promise<void>'),
    'store 的 refreshWorkspace 还没有可选 id',
  )
  const impl = STORE.slice(STORE.indexOf('async refreshWorkspace(workspaceId)'))
  const body = impl.slice(0, impl.indexOf('async setActiveWorkspace'))
  // 缺省 = 当前项目（工坊自己的刷新入口都还在这么调，不能改坏）。
  assert.ok(body.includes('const target = workspaceId || active'), '缺省没有回落到 activeWorkspaceId')
  assert.ok(body.includes('const all = await listFiles(target)'), '列文件用的不是解析出来的项目 id')
  assert.ok(body.includes('seedWorkspaceIfEmpty(target)'), '范例种子没按目标项目走')
})

test('显式带 id 且与当前项目不同时，把工坊切过去（这就是「看不见那次写入」的正解）', () => {
  const impl = STORE.slice(STORE.indexOf('async refreshWorkspace(workspaceId)'))
  const body = impl.slice(0, impl.indexOf('async setActiveWorkspace'))
  assert.ok(body.includes('if (workspaceId !== undefined && target !== active)'), '切换判据丢了')
  assert.ok(body.includes("setSettings({ activeWorkspaceId: target })"), '没有把当前项目切过去')
})

test('引擎刷新用的是这段对话绑定的项目，而不是当前打开的那个', () => {
  // 写入目标：对话优先，老对话回落当前项目。
  assert.ok(
    ENGINE.includes('const workspaceId = conversation?.workspaceId || settings.activeWorkspaceId || DEFAULT_WORKSPACE'),
    'engine 没有解析本轮该写哪个项目',
  )
  assert.ok(ENGINE.includes('refreshWorkspace(workspaceId)'), 'engine 还在按「当前打开的项目」刷新')
  assert.ok(!ENGINE.includes('actions.refreshWorkspace()\n    }'), 'engine 里还留着无参刷新')
  // 切了项目就要在提示里说清楚是哪个项目，否则用户只会看到一句没头没尾的「工坊已更新」。
  assert.ok(ENGINE.includes('这段对话写在'), '提示里没有带项目名')
  const region = ENGINE.slice(ENGINE.indexOf('const shownWorkspace'), ENGINE.indexOf('/**\n * 重新生成某条助手消息'))
  assert.ok(region.includes('workspaces.find((item) => item.id === workspaceId)?.name'), '没有取项目名')
  assert.ok(region.includes('shownWorkspace !== workspaceId'), '没区分「切了项目」与「本来就在这个项目」')
})

test('工坊面板自己的刷新入口照旧无参（它读的就是当前项目，切过去之后自然同步）', () => {
  assert.ok(WORKSHOP.includes('actions.refreshWorkspace()'), '工坊界面的刷新调用被动过')
  assert.ok(WORKSHOP.includes('previewHtml(activeWorkspaceId)'), '预览还是按当前项目解析（回归保护）')
})
