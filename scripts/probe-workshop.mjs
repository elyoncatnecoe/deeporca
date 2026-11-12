import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * 探针：工坊项目 / 文件重命名 / 导出多选。
 *
 * 用独立 user-data-dir 起一个「新装」的 App，从 onboarding 点进去，避免碰用户
 * 真实的对话和工坊数据。验证的是真 DOM 交互，不是源码断言。
 */

const PORT = 9387
const TMP = '_tmp/probe-workshop'
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// 独立 userData：起一个「新装」实例，不碰用户真实的对话和工坊。
env.DEEPSEA_USER_DATA = `${process.cwd()}/${TMP}/ud`

const child = spawn(
  'node_modules/electron/dist/electron.exe',
  ['.', `--remote-debugging-port=${PORT}`],
  { stdio: 'ignore', env },
)

let ws = null
let nextId = 1
const pending = new Map()

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.onopen = () => resolve(socket)
    socket.onerror = (error) => reject(error)
  })
}

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result?.value
}

async function waitFor(expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true
    await sleep(120)
  }
  throw new Error(`等待超时: ${expression}`)
}

function clickText(selector, text) {
  return `(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => (n.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) throw new Error('找不到按钮: ' + ${JSON.stringify(text)});
    el.click();
    return true;
  })()`
}

function setInput(selector, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('找不到输入框: ' + ${JSON.stringify(selector)});
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`)
}

try {
  let target = null
  for (let attempt = 0; attempt < 60 && target === null; attempt += 1) {
    await sleep(300)
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json())
      target = list.find((item) => item.type === 'page') ?? null
    } catch (error) {
      target = null
    }
  }
  if (target === null) throw new Error('连不上 Electron 调试端口')
  ws = await connect(target.webSocketDebuggerUrl)
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const slot = pending.get(message.id)
    if (slot === undefined) return
    pending.delete(message.id)
    if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
    else slot.resolve(message.result)
  }
  await send('Runtime.enable')
  await waitFor('document.readyState === "complete"')

  // 等 React 首屏出来（Splash → onboarding / home），再判断 profile 是否隔离。
  await waitFor('!!document.querySelector(".onboarding") || !!document.querySelector(".home-screen") || !!document.querySelector(".boot-error")', 20000)
  const isolated = await evaluate('!!document.querySelector(".onboarding")')
  if (!isolated) {
    const screen = await evaluate('({ onboarding: !!document.querySelector(".onboarding"), home: !!document.querySelector(".home-screen"), boot: document.querySelector(".boot-error")?.textContent || "" })')
    console.log('SKIP: 独立 userData 没生效，放弃探针（不碰真实数据）', JSON.stringify(screen))
    process.exit(2)
  }

  // onboarding：开始下潜 → API 模式 → 继续 → 先跳过
  await evaluate(clickText('.onboarding-primary', '开始下潜'))
  await sleep(200)
  await evaluate(clickText('.mode-card', 'API'))
  await sleep(150)
  await evaluate(clickText('.onboarding-primary', '继续'))
  await sleep(200)
  await evaluate(clickText('.onboarding-primary', '先跳过'))
  await waitFor('!!document.querySelector(".dock-item")', 10000)

  // 工坊：默认项目应该自动种了范例
  await evaluate(clickText('.dock-item', '工坊'))
  await waitFor('!!document.querySelector(".workshop-screen")')
  // 种子写入是异步的：等文件列表真的出现再断言。
  await waitFor('document.querySelectorAll(".file-row").length > 0', 8000)
  await sleep(200)
  const seeded = await evaluate(`({
    select: document.querySelector('.workspace-select') !== null,
    rows: document.querySelectorAll('.file-row').length,
  })`)
  check('工坊有项目选择器', seeded?.select === true, seeded)
  check('默认项目自动种了范例文件', seeded?.rows === 2, seeded)

  // 新建项目 → 空
  await evaluate(clickText('.project-actions button', '新建项目'))
  await waitFor('!!document.querySelector(".modal-card")')
  await evaluate(setInput('.modal-body input', '探针项目'))
  await evaluate(clickText('.modal-foot button', '创建'))
  await sleep(500)
  const emptyProject = await evaluate(`({
    rows: document.querySelectorAll('.file-row').length,
    empty: (document.querySelector('.file-empty')?.textContent || ''),
    label: (document.querySelector('.workspace-select .select-value-label')?.textContent || ''),
  })`)
  check('新项目是空的（不再塞范例）', emptyProject?.rows === 0 && emptyProject?.empty.includes('还没有文件'), emptyProject)
  check('项目切换器显示新项目名', emptyProject?.label.includes('探针项目'), emptyProject)

  // 新建文件 → 重命名
  await evaluate(clickText('.file-pane header button', '新建'))
  await waitFor('!!document.querySelector(".modal-card")')
  await evaluate(setInput('.modal-body input', 'probe.html'))
  await evaluate(clickText('.modal-foot button', '创建'))
  await sleep(400)
  await evaluate(`(() => { document.querySelector('.file-row')?.click(); return true })()`)
  await sleep(200)
  await evaluate(clickText('.file-actions button', '重命名'))
  await waitFor('!!document.querySelector(".modal-card")')
  await evaluate(setInput('.modal-body input', 'renamed.html'))
  await evaluate(clickText('.modal-foot button', '保存'))
  await sleep(500)
  const renamed = await evaluate(`[...document.querySelectorAll('.file-row')].map((n) => n.textContent || '')`)
  check('文件重命名生效', Array.isArray(renamed) && renamed.some((text) => text.includes('renamed.html')), renamed)

  // 项目改名
  await evaluate(clickText('.project-actions button', '项目设置'))
  await waitFor('!!document.querySelector(".modal-card")')
  await evaluate(setInput('.modal-body input', '探针项目2'))
  await evaluate(clickText('.modal-foot button', '保存名字'))
  await sleep(400)
  const renamedProject = await evaluate(`(document.querySelector('.workspace-select .select-value-label')?.textContent || '')`)
  check('项目改名生效', renamedProject.includes('探针项目2'), renamedProject)

  // 切回默认项目，再切回来删除项目
  await evaluate(`(() => { document.querySelector('.workspace-select .select-trigger').click(); return true })()`)
  await waitFor('!!document.querySelector(".select-option")')
  await evaluate(clickText('.select-option', '默认项目'))
  await sleep(600)
  const backToDefault = await evaluate(`document.querySelectorAll('.file-row').length`)
  check('切回默认项目能看到范例文件', backToDefault === 2, backToDefault)

  await evaluate(`(() => { document.querySelector('.workspace-select .select-trigger').click(); return true })()`)
  await waitFor('!!document.querySelector(".select-option")')
  await evaluate(clickText('.select-option', '探针项目2'))
  await sleep(500)
  await evaluate(clickText('.project-actions button', '项目设置'))
  await waitFor('!!document.querySelector(".modal-card")')
  await evaluate(clickText('.modal-body button', '删除这个项目'))
  await waitFor('!!document.querySelector(".confirm-message")')
  await evaluate(clickText('.modal-foot button', '删除'))
  await sleep(700)
  const afterDelete = await evaluate(`({
    label: (document.querySelector('.workspace-select .select-value-label')?.textContent || ''),
    options: [...document.querySelectorAll('.workspace-select .select-value-label')].length,
  })`)
  check('删除项目后回到默认项目', afterDelete?.label.includes('默认项目'), afterDelete)

  // 回首页（工坊页没有 dock，要点头部的返回）
  await evaluate(`(() => { document.querySelector('button[aria-label="返回"]')?.click(); return true })()`)
  await waitFor('!!document.querySelector(".dock-item")')
  await evaluate(clickText('.dock-item', '对话'))
  await waitFor('!!document.querySelector("textarea")')
  await evaluate(setInput('textarea', '你好'))
  await sleep(200)
  await evaluate(`(() => { document.querySelector('.send-button')?.click(); return true })()`)
  await sleep(1200)
  await evaluate(`(() => { document.querySelector('button[aria-label="导出为 Markdown"]')?.click(); return true })()`)
  await waitFor('!!document.querySelector(".export-select-list")', 6000)
  const exportState = await evaluate(`({
    rows: document.querySelectorAll('.export-select-row').length,
    checked: document.querySelectorAll('.export-select-row input:checked').length,
    toolbar: [...document.querySelectorAll('.export-toolbar button')].map((n) => n.textContent || ''),
  })`)
  check('导出弹窗列出每条消息且默认全选', exportState?.rows >= 2 && exportState?.checked === exportState?.rows, exportState)
  check('导出弹窗有全选/全不选/只要提问/只要回答', Array.isArray(exportState?.toolbar)
    && exportState.toolbar.some((text) => text.includes('全选'))
    && exportState.toolbar.some((text) => text.includes('全不选'))
    && exportState.toolbar.some((text) => text.includes('只要提问'))
    && exportState.toolbar.some((text) => text.includes('只要回答')), exportState?.toolbar)

  await evaluate(clickText('.export-toolbar button', '全不选'))
  await sleep(300)
  const noneSelected = await evaluate(`(() => {
    const foot = [...document.querySelectorAll('.inline-actions .primary-button')].map((node) => ({
      text: (node.textContent || '').trim(),
      disabled: node.disabled === true,
    }));
    return {
      checked: document.querySelectorAll('.export-select-row input:checked').length,
      foot,
      modals: document.querySelectorAll('.modal-card').length,
    };
  })()`)
  const exportButton = noneSelected?.foot?.find((item) => item.text.includes('分享')) ?? null
  check('全不选后导出按钮禁用', noneSelected?.checked === 0 && exportButton?.disabled === true, noneSelected)

  await evaluate(clickText('.export-toolbar button', '只要回答'))
  await sleep(200)
  const onlyReplies = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.export-select-row')];
    return rows.filter((row) => row.querySelector('input').checked).map((row) => row.querySelector('.export-role')?.textContent || '');
  })()`)
  check('「只要回答」只勾选助手消息', Array.isArray(onlyReplies) && onlyReplies.length > 0 && onlyReplies.every((role) => role !== '我'), onlyReplies)
} catch (error) {
  console.error('PROBE ERROR', error instanceof Error ? error.message : error)
  checks.push({ name: 'probe', ok: false })
} finally {
  if (ws !== null) ws.close()
  child.kill()
  await sleep(800)
  rmSync(TMP, { recursive: true, force: true })
}

const failed = checks.filter((item) => item.ok !== true)
console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
process.exit(failed.length === 0 ? 0 : 1)
