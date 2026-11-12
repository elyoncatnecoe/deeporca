#!/usr/bin/env node
/**
 * scripts/verify-select-ui.mjs
 *
 * 「设置页点『供应商』/『模型』下拉 → 弹出系统白底弹窗」的回归验证脚本。
 *
 * 背景（用户反馈）：手机端设置页这些下拉全是原生 <select>，Android WebView 会打开
 * **系统弹窗**，配色跟 Activity 主题走，浅色/自动主题下就是整块白屏，和深色海面主题冲突。
 * 修复方向（task-1/task-2）：把 18 处原生 <select> 换成 App 内自绘的深色下拉
 * （组件是 src/components/ui.tsx 的 Select，样式统一 .select-*），并给模型字段加能力标签。
 *
 * 本脚本分两个阶段：
 *
 *   static（不需要 Electron，纯源码断言，node:fs 读文件）
 *     S1. src/components/*.tsx 中已不存在 `<select`（注释里的不算）
 *     S2. src/components/ui.tsx 导出了下拉组件（正则兼容 Select / Dropdown / Picker 命名；
 *         找不到就 FAIL 并把 ui.tsx 实际导出名单列出来）
 *     S2b. ui.tsx 里有 aria-haspopup + listbox（runtime 定位契约）
 *     S3. src/styles.css 里有 >= 3 条 .select- 前缀的样式规则
 *     S4. info 级：模型能力标签类名（.model-tag / .chip / .tag）是否存在
 *
 *   runtime（必须 --attach，连 Lead 已启动的 Electron，绝不自己 spawn）
 *     R0. Emulation.setDeviceMetricsOverride {390x844, dsf 2.75, mobile:true}
 *     R1. 进设置页（同 scripts/verify-keyboard-insets.mjs 的 openSettings：
 *         先 .home-dock .dock-item[4]，回退文本含「设置」的按钮；失败先 reload 重试一次）
 *     R2. 用 aria-haspopup="listbox" 定位「供应商」字段的下拉触发器并点开
 *     R3. 断言 listbox 存在、面板背景非白（r/g/b 全 > 200 视为白；listbox 自身透明时
 *         沿祖先链取真正上色的那一层，并记录 border-radius / max-height / z-index）
 *     R4. 断言页面上不存在任何**可见**的原生 <select>
 *     R5. 断言 listbox 内 role="option" >= 1
 *     R6. 点第 2 个 option → 面板关闭 + 触发器文本变成该 option 的 label
 *         （「供应商」只有一个内置选项时，自动改用「思考强度」等其它下拉完成这一条，JSON 里注明）
 *     R7. 截图 shots/verify-select-open.png、verify-select-picked.png、verify-model-status.png
 *     R8. 用 bundled Python + Pillow 按面板 bounding box × 截图实际缩放比例裁剪
 *         verify-select-open.png，算平均亮度，断言 < 120（深色），并打印数值
 *     R9. 触发器主文案不被截断（断言名 trigger-label-not-truncated）：选中长 label
 *         的选项后，量 .select-value-label 是否被压窄 → 被压窄且设了 text-overflow:ellipsis
 *         就意味着用户会看到「…」。判据见下方「⚠️ 教训」。
 *
 * ⚠️ 教训：判断文本是否被截断，**不能用 scrollWidth / clientWidth**（R9 为什么这么写）
 *
 *   这两者都是**整数**（布局单元会取整），亚像素溢出被直接抹平。本项目实测过一个
 *   真人可见、却测不出来的缺陷：
 *
 *     .select-value-label 的 getBoundingClientRect().width = 212.521   （可用宽）
 *     该 label 文本的真实渲染宽度                    = 212.667   （需要宽）
 *     → 溢出 0.146px，浏览器**已经渲染出省略号**，截图肉眼可见「deepseek-chat-web（当前…」
 *     → 但 scrollWidth = clientWidth = 213（被取整成同一个整数），
 *       `scrollWidth <= clientWidth + 1` 判为「没截断」→ 断言假通过。
 *
 *   同理不能靠 canvas 的 measureText 去「猜」文本宽度：实测同一段文字
 *   range 量出 216px、canvas 量出 214px，字体度量与真实排版有 ±2px 偏差，
 *   落在临界区（就差零点几像素）时会漏判。
 *
 *   本脚本采用的**确定性判据**（不依赖任何容差猜测）：
 *     1) 把节点的约束临时放开（flex:0 0 auto / overflow:visible / text-overflow:clip /
 *        white-space:nowrap），直接问浏览器「它本来需要多宽」= naturalWidth；
 *     2) 与受约束时的实际宽度 constrainedWidth 相减得 deficit；
 *     3) deficit > 0.02px 且该元素 text-overflow 为 ellipsis → 必然渲染「…」→ FAIL；
 *     4) 量完立即还原 inline style，不污染页面。
 *   这样连 0.146px 这种亚像素截断也能稳定抓到。HINT 被压缩属于设计意图
 *   （flex 让位），只记 info 级 info-trigger-hint-squeeze，不阻断。
 *
 *   对应的样式契约（styles.css）：`.select-value-label` 必须是 flex: 0 0 auto
 *   （主文案主动作、永不退让），`.select-trigger-hint` 是唯一让位方
 *   （flex: 0 1 auto + min-width: 0）。若有人把 label 改回 `0 1 auto`，
 *   R9 会立刻 FAIL —— 这是有意为之的保护。
 *
 * 用法：
 *   node scripts/verify-select-ui.mjs --phase=static             # 只做源码断言（不连 Electron）
 *   node scripts/verify-select-ui.mjs --attach --phase=runtime   # 连 9351 已开实例，只跑运行时
 *   node scripts/verify-select-ui.mjs --attach                   # 默认 phase=all：static + runtime
 *   可选：--port=9351（默认 9351，也可用环境变量 VERIFY_PORT）
 *   可选：--attach    必须（runtime 阶段）。不提供时脚本只跑 static 并把 runtime 标记为 skipped，
 *                     绝不会自己 spawn Electron —— 本沙箱里 spawn Chromium 会 0x80000003 崩溃。
 *
 * 前置（runtime）：由 Lead 在**完整权限**终端里先启动，且已重新 build（dist/ 必须是修复后的产物）：
 *   node_modules\electron\dist\electron.exe . --remote-debugging-port=9351
 *
 * 退出码：全部断言通过 0，否则 1。
 * 写作用域：scripts/verify-select-ui.mjs、shots/verify-select-*.png（不碰 src/、android/、electron/、package.json）。
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = path.join(ROOT, 'shots')
const COMPONENTS_DIR = path.join(ROOT, 'src', 'components')
const UI_SRC = path.join(COMPONENTS_DIR, 'ui.tsx')
const CSS_SRC = path.join(ROOT, 'src', 'styles.css')

/** 移动视口：iPhone 13/14 逻辑尺寸，Android 3x 屏等价 DPR 2.75。 */
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2.75, mobile: true }
/** 白色判定：r/g/b 三个通道都 > 200 → 视为白（FAIL）。 */
const WHITE_CHANNEL = 200
/** 面板平均亮度阈值：必须 < 120 才算深色。 */
const LUMA_MAX = 120
/** 裁剪区域的最小 CSS 尺寸，太小说明定位/渲染异常，裁剪结果不可信。 */
const MIN_CROP_SIDE = 20
/** .select-panel 自身背景 alpha 下限：再低就属于「靠下层背景撑颜色」，真机浅色底会露白。 */
const PANEL_MIN_ALPHA = 0.8
/** 模型下拉 option 里应出现的能力词（用户抱怨的就是「只看到一排裸 id」）。 */
const MODEL_CAPABILITY_WORDS = ['看图', '推理', '旗舰', '旧版', '网页', '自定义']

const argv = new Map(
  process.argv.slice(2).map((raw) => {
    const text = raw.replace(/^--/, '')
    const eq = text.indexOf('=')
    if (eq < 0) return [text, true]
    return [text.slice(0, eq), text.slice(eq + 1)]
  }),
)

const PORT = Number(argv.get('port') || process.env.VERIFY_PORT || 9351)
const PHASE = String(argv.get('phase') || 'all').toLowerCase()
/** attach 模式：只连外部已开的 CDP 实例。runtime 阶段强制要求。 */
const ATTACH = Boolean(argv.get('attach'))
const ATTACH_TIMEOUT_MS = Number(process.env.VERIFY_ATTACH_TIMEOUT_SEC || 60) * 1000

if (!['static', 'runtime', 'all'].includes(PHASE)) {
  console.error(`[verify] 未知 --phase=${PHASE}（可选 static / runtime / all）`)
  process.exitCode = 2
  process.exit()
}

const result = {
  script: 'scripts/verify-select-ui.mjs',
  startedAt: new Date().toISOString(),
  phase: PHASE,
  port: PORT,
  attach: ATTACH,
  viewport: VIEWPORT,
  static: null,
  runtime: null,
  pass: false,
}

const rel = (p) => path.relative(ROOT, p)
const round = (n, digits = 1) => {
  const f = 10 ** digits
  return Math.round(Number(n) * f) / f
}

/* ------------------------------------------------------------------ CDP 客户端 */

let ws = null
let seq = 1
const pending = new Map()

const send = (method, params = {}) => {
  const id = seq++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown'
    throw new Error('Runtime.evaluate 失败: ' + detail + ' :: ' + String(expression).slice(0, 160))
  }
  return r.result?.value
}

async function shot(name) {
  const img = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(SHOTS, { recursive: true })
  const file = path.join(SHOTS, `${name}.png`)
  writeFileSync(file, Buffer.from(img.data, 'base64'))
  return file
}

/**
 * 截一张「区域特写」：用 clip 参数按 CSS px 裁出触发器那一行（含少量留白），
 * 方便肉眼确认「（当前…」这类截断是否修好。
 * clip.scale 用 1：clip 的 width 是 CSS px，若再乘 dsf 会得到 dsf² 倍的大图；
 * 1 CSS px = 1 输出像素，尺寸可控且缩略图里看得清文字。
 */
async function shotClip(name, rect, padding = 10) {
  const x = Math.max(0, rect.x - padding)
  const y = Math.max(0, rect.y - padding)
  const width = Math.max(1, rect.w + padding * 2)
  const height = Math.max(1, rect.h + padding * 2)
  const img = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width, height, scale: 1 },
    captureBeyondViewport: false,
  })
  mkdirSync(SHOTS, { recursive: true })
  const file = path.join(SHOTS, `${name}.png`)
  writeFileSync(file, Buffer.from(img.data, 'base64'))
  return file
}

async function connect(url) {
  ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败: ' + url))
  })
  ws.onmessage = (event) => {
    let msg = null
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    if (!msg.id) return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
    else p.resolve(msg.result)
  }
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('CDP 连接已关闭'))
    pending.clear()
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', VIEWPORT)
  await sleep(700)
}

/**
 * attach：等外部 Electron 暴露 CDP 端口后连上去。**不会** spawn 任何进程。
 * 连不上时给出明确操作指引（谁该做什么）。
 */
async function attachToRunning() {
  console.log(`[verify] attach 模式：等待外部 Electron 在 127.0.0.1:${PORT} 暴露 CDP（最多 ${Math.round(ATTACH_TIMEOUT_MS / 1000)}s）...`)
  const deadline = Date.now() + ATTACH_TIMEOUT_MS
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      const page = pages.find((t) => String(t.url || '').includes('index.html')) || pages[0]
      if (page) {
        await connect(page.webSocketDebuggerUrl)
        console.log('[verify] attach 成功:', String(page.url || '').slice(0, 140))
        return page.url
      }
    } catch (error) {
      lastError = error
    }
    await sleep(400)
  }
  throw new Error(
    `attach 失败：127.0.0.1:${PORT} 上等不到可用的 CDP 页面。` +
      '请由 Lead 在完整权限终端启动（本沙箱起 Electron 会 0x80000003 崩溃，脚本不会自己 spawn）：\n' +
      `  node_modules\\electron\\dist\\electron.exe . --remote-debugging-port=${PORT}\n` +
      '并确认 dist/ 已是重新 build 过的修复后产物。' +
      (lastError ? `（lastError=${lastError.message}）` : ''),
  )
}

/* ---------------------------------------------------- 页面内工具（注入一次） */

/**
 * 注入 window.__vsel 工具集。全部走 Runtime.evaluate，用 dispatchEvent 模拟
 * pointerdown/mousedown/pointerup/mouseup/click，兼容 onClick 与 pointerdown 两种写法。
 * 用 String.raw 保证正则里的 \s 等原样送到页面。
 *
 * 面板结构按 select-fixer 的实现对齐但做了容错：
 *   .select-wrap > button.select-trigger[aria-haspopup=listbox]
 *   portal 到 body 的 .select-panel > .select-list[role=listbox] > button.select-option[role=option]
 * 只要 role/aria 契约在，即使类名换成 .dropdown-* 也能工作。
 */
const INSTALL_HELPERS = String.raw`(() => {
  const norm = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  const alphaOf = (bg) => {
    const m = String(bg || '').match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const parts = m[1].split(/[,/\s]+/).map(Number).filter((n) => !isNaN(n));
    if (parts.length < 3) return null;
    return parts.length >= 4 ? parts[3] : 1;
  };
  const vis = (el) => {
    if (!el) return false;
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (Number(cs.opacity) < 0.05) return false;
    return true;
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x * 10) / 10,
      y: Math.round(r.y * 10) / 10,
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      top: Math.round(r.top * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
    };
  };
  const headText = (f) => {
    const head = f.children && f.children[0];
    if (head && head.tagName === 'SPAN') return norm(head.textContent);
    const span = f.querySelector(':scope > span');
    return span ? norm(span.textContent) : norm(f.textContent).slice(0, 40);
  };
  const fieldNameOf = (el) => {
    if (!el || !el.closest) return '';
    const f = el.closest('.field');
    return f ? headText(f) : '';
  };
  /**
   * 沿祖先链（只到面板根节点为止）找真正上色的那一层：
   * listbox 自己常常是透明的，背景在 .select-panel 上；但不要一路走到 body，
   * 否则会把 App 的深色底当成面板背景，失去验证意义。
   */
  const effectiveBackground = (el, stop) => {
    let node = el;
    while (node) {
      const cs = getComputedStyle(node);
      const bg = cs.backgroundColor;
      const a = alphaOf(bg);
      if (a !== null && a > 0.05) {
        return {
          background: bg,
          alpha: a,
          source: node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).trim().split(/\s+/).join('.') : ''),
          same: node === el,
        };
      }
      if (stop && node === stop) break;
      node = node.parentElement;
    }
    // 到面板根还没找到不透明底色：多半用了 background-image（渐变/玻璃），
    // 记下 gradient 标记，交给像素亮度断言兜底。
    const stopCs = stop ? getComputedStyle(stop) : null;
    return {
      background: 'transparent',
      alpha: 0,
      source: 'none',
      same: false,
      gradient: !!(stopCs && stopCs.backgroundImage && stopCs.backgroundImage !== 'none'),
      backgroundImage: stopCs ? String(stopCs.backgroundImage || 'none').slice(0, 120) : null,
    };
  };
  const realClick = (el) => {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0,
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }, base)));
    } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, base, { buttons: 1 })));
    try {
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }, base)));
    } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
    return true;
  };
  const haspopups = () => [...document.querySelectorAll('[aria-haspopup]')].map((el, i) => ({
    index: i,
    tag: el.tagName.toLowerCase(),
    haspopup: el.getAttribute('aria-haspopup'),
    role: el.getAttribute('role'),
    expanded: el.getAttribute('aria-expanded'),
    disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
    text: norm(el.textContent).slice(0, 80),
    ariaLabel: el.getAttribute('aria-label'),
    field: fieldNameOf(el),
    classes: String(el.className || '').slice(0, 120),
    visible: vis(el),
    rect: rectOf(el),
  }));
  const fieldLabels = () => [...document.querySelectorAll('.field')].map(headText);
  const triggerInfo = (i) => {
    const el = [...document.querySelectorAll('[aria-haspopup]')][i];
    if (!el) return null;
    return {
      index: i,
      text: norm(el.textContent),
      valueText: (() => {
        const v = el.querySelector('.select-value, [class*="value"]');
        return v ? norm(v.textContent) : norm(el.textContent);
      })(),
      ariaExpanded: el.getAttribute('aria-expanded'),
      ariaLabel: el.getAttribute('aria-label'),
      field: fieldNameOf(el),
      classes: String(el.className || '').slice(0, 120),
      visible: vis(el),
      rect: rectOf(el),
    };
  };
  const clickHaspopup = (i) => {
    const el = [...document.querySelectorAll('[aria-haspopup]')][i];
    return el ? realClick(el) : false;
  };
  /**
   * 把第 i 个 aria-haspopup 元素滚进视口并返回中心点（CSS px）。
   * 给 Input.dispatchMouseEvent 兜底点击用：真实鼠标事件能命中那些只监听原生
   * pointerdown 的实现（纯 JS dispatchEvent 造的事件 isTrusted=false）。
   */
  const haspopupCenter = (i) => {
    const el = [...document.querySelectorAll('[aria-haspopup]')][i];
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    return {
      x: Math.round((r.left + r.width / 2) * 100) / 100,
      y: Math.round((r.top + r.height / 2) * 100) / 100,
      visible: vis(el),
      rect: rectOf(el),
    };
  };
  /** 按 field 文本重新定位触发器索引（面板开关后 DOM 顺序可能变化，索引会过期）。 */
  const haspopupIndexOfField = (fieldText, excludeIndex) => {
    const list = [...document.querySelectorAll('[aria-haspopup]')];
    for (let i = 0; i < list.length; i += 1) {
      if (excludeIndex !== undefined && i === excludeIndex) continue;
      const name = fieldNameOf(list[i]);
      if (name === fieldText) return i;
    }
    return -1;
  };
  const listbox = () => {
    const boxes = [...document.querySelectorAll('[role="listbox"]')];
    const selects = [...document.querySelectorAll('select')];
    const visibleSelects = selects.filter(vis).map((el) => ({
      id: el.id || null,
      name: el.getAttribute('name'),
      classes: String(el.className || '').slice(0, 120),
      value: el.value,
      text: norm(el.textContent).slice(0, 80),
      rect: rectOf(el),
    }));
    // 面板外层：优先 .select-panel（portal 容器），否则用 listbox 自己。
    const panelOf = (el) => el.closest('.select-panel, [class*="panel"]') || el;
    const ready = boxes.filter((el) => {
      const p = panelOf(el);
      if (p.className && /is-placing|is-empty/.test(String(p.className))) return false;
      return vis(el) && vis(p);
    });
    const list = ready[0] || null;
    const base = {
      listboxTotal: boxes.length,
      listboxVisible: ready.length,
      selectTotal: selects.length,
      visibleSelects,
    };
    if (!list) {
      return Object.assign(base, { panel: null, optionCount: 0, options: [] });
    }
    const panel = panelOf(list);
    const pcs = getComputedStyle(panel);
    const lcs = getComputedStyle(list);
    const options = [...list.querySelectorAll('[role="option"]')].slice(0, 30).map((el, i) => {
      const labelEl = el.querySelector('.select-option-label, [class*="label"]');
      const hintEl = el.querySelector('.select-option-hint, [class*="hint"]');
      const tagsEl = el.querySelector('.select-tags, [class*="tag"]');
      // 能力徽章元素：Lead 要求「模型下拉的 option 必须带标签」，两种类名都认。
      const tagEls = [...el.querySelectorAll('.model-tag, .select-tag')];
      let mainText = labelEl ? norm(labelEl.textContent) : '';
      if (!mainText) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('.select-tags, [class*="tag"], .select-option-hint, [class*="hint"]').forEach((n) => n.remove());
        mainText = norm(clone.textContent);
      }
      return {
        index: i,
        text: norm(el.textContent).slice(0, 160),
        label: mainText.slice(0, 120),
        hint: hintEl ? norm(hintEl.textContent).slice(0, 80) : null,
        tags: tagsEl ? norm(tagsEl.textContent).slice(0, 80) : null,
        tagCount: tagEls.length,
        tagTexts: tagEls.map((t) => norm(t.textContent)).filter(Boolean).slice(0, 8),
        innerText: norm(el.innerText || el.textContent).slice(0, 160),
        ariaLabel: norm(el.getAttribute('aria-label') || ''),
        selected: el.getAttribute('aria-selected'),
        ariaDisabled: el.getAttribute('aria-disabled'),
        disabledAttr: el.hasAttribute('disabled'),
        visible: vis(el),
        classes: String(el.className || '').slice(0, 120),
        background: getComputedStyle(el).backgroundColor,
        color: getComputedStyle(el).color,
        rect: rectOf(el),
      };
    });
    return Object.assign(base, {
      panel: {
        tag: panel.tagName.toLowerCase(),
        classes: String(panel.className || '').slice(0, 160),
        isListboxItself: panel === list,
        background: pcs.backgroundColor,
        effective: effectiveBackground(list, panel),
        borderRadius: pcs.borderRadius,
        maxHeight: pcs.maxHeight,
        zIndex: pcs.zIndex,
        position: pcs.position,
        overflowY: pcs.overflowY,
        boxShadow: pcs.boxShadow,
        backdropFilter: pcs.backdropFilter || null,
        opacity: pcs.opacity,
        backgroundAlpha: alphaOf(pcs.backgroundColor),
        rect: rectOf(panel),
        listbox: {
          classes: String(list.className || '').slice(0, 160),
          role: list.getAttribute('role'),
          ariaLabel: list.getAttribute('aria-label'),
          background: lcs.backgroundColor,
          overflowY: lcs.overflowY,
          maxHeight: lcs.maxHeight,
          rect: rectOf(list),
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
        },
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
      },
      optionCount: options.length,
      options,
    });
  };
  const clickOption = (i) => {
    const list = [...document.querySelectorAll('[role="listbox"]')].filter(vis)[0];
    if (!list) return false;
    const opts = [...list.querySelectorAll('[role="option"]')];
    return opts[i] ? realClick(opts[i]) : false;
  };
  const pressEscape = () => {
    const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    const target = document.activeElement || document.body;
    try { target.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (e) {}
    try { document.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (e) {}
    try { window.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (e) {}
    return true;
  };
  const clickOutside = () => {
    const el = document.querySelector('.screen-header h1') || document.querySelector('.screen-header') || document.querySelector('.settings-body');
    return el ? realClick(el) : false;
  };
  const scrollToField = (labelText) => {
    const fields = [...document.querySelectorAll('.field')];
    const exact = fields.filter((f) => headText(f) === labelText);
    const loose = fields.filter((f) => headText(f).indexOf(labelText) >= 0);
    const target = exact[0] || loose[0] || null;
    if (!target) return { found: false, available: fields.map(headText) };
    let scroller = null;
    let node = target.parentElement;
    while (node) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 4) {
        scroller = node;
        break;
      }
      node = node.parentElement;
    }
    if (scroller) {
      const tr = target.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      scroller.scrollTop = Math.max(0, scroller.scrollTop + (tr.top - sr.top) - sr.height * 0.22);
    } else {
      try { target.scrollIntoView({ block: 'center' }); } catch (e) {}
    }
    return {
      found: true,
      scroller: scroller ? String(scroller.className || '') : 'scrollIntoView',
      rect: rectOf(target),
      fieldText: headText(target),
    };
  };
  /**
   * 测量触发器内文本是否被截断。
   *
   * ⚠️ 关键教训：不能用 scrollWidth / clientWidth 判断！
   * 二者都是**整数**（布局单元取整），亚像素溢出会被抹平。实测：
   *   label rectWidth=212.521，文本真实宽=212.667 → 溢出 0.146px，
   *   但 scrollWidth=clientWidth=213，看起来「没截断」，
   *   而 text-overflow:ellipsis 只要溢出就会渲染省略号（截图确认显示「（当前…」）。
   * 因此这里用**确定性判据**（不依赖亚像素容差）：把节点的约束临时放开
   * （flex:0 0 auto / overflow:visible / text-overflow:clip），量它「本来需要多宽」，
   * 再与受约束时的实际宽度比 —— deficit > 0 就说明它被压窄了，
   * 而只要被压窄且设了 text-overflow:ellipsis，浏览器就会渲染省略号（截图已证实）。
   * 量完立即还原 inline style，不污染页面。
   * hint（.select-trigger-hint）被压缩反而是设计意图（flex:0 1 auto + min-width:0，
   * 它是唯一的让位方），记 info，不阻断。
   */
  const triggerTextFit = (i) => {
    const el = [...document.querySelectorAll('[aria-haspopup]')][i];
    if (!el) return null;
    /**
     * 放开约束量自然宽度，得出真实 deficit。
     * deficit > TOL 视为「被压缩 / 渲染省略号」。
     */
    const measure = (node) => {
      const cs = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const constrainedWidth = Math.round(rect.width * 1000) / 1000;
      // 临时放开约束
      const saved = {
        flex: node.style.flex,
        minWidth: node.style.minWidth,
        overflow: node.style.overflow,
        textOverflow: node.style.textOverflow,
        whiteSpace: node.style.whiteSpace,
        width: node.style.width,
      };
      node.style.flex = '0 0 auto';
      node.style.minWidth = '0';
      node.style.overflow = 'visible';
      node.style.textOverflow = 'clip';
      node.style.whiteSpace = 'nowrap';
      const naturalWidth = Math.round(node.getBoundingClientRect().width * 1000) / 1000;
      // 还原
      node.style.flex = saved.flex;
      node.style.minWidth = saved.minWidth;
      node.style.overflow = saved.overflow;
      node.style.textOverflow = saved.textOverflow;
      node.style.whiteSpace = saved.whiteSpace;
      node.style.width = saved.width;
      const deficit = Math.round((naturalWidth - constrainedWidth) * 1000) / 1000;
      return {
        constrainedWidth,
        naturalWidth,
        deficit,
        // 确定性判定：被压窄 + 该元素本身设了 ellipsis → 必然渲染省略号
        truncating: deficit > 0.02 && cs.textOverflow === 'ellipsis',
        squeezed: deficit > 0.02,
        paddingLR: [cs.paddingLeft, cs.paddingRight],
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        intTruncated: node.scrollWidth > node.clientWidth + 1,
        textOverflow: cs.textOverflow,
        flex: cs.flex,
        visible: vis(node),
      };
    };
    const pick = (sel) => {
      const node = el.querySelector(sel);
      if (!node) return null;
      const m = measure(node);
      return {
        selector: sel,
        text: norm(node.textContent),
        textLength: String(node.textContent || '').length,
        ...m,
      };
    };
    const valueEl = el.querySelector('.select-value');
    const valueCs = valueEl ? getComputedStyle(valueEl) : null;
    const valueRect = valueEl ? valueEl.getBoundingClientRect() : null;
    return {
      triggerIndex: i,
      field: fieldNameOf(el),
      fullText: norm(el.textContent),
      valueContainer: valueEl
        ? {
            scrollWidth: valueEl.scrollWidth,
            clientWidth: valueEl.clientWidth,
            rectWidth: valueRect ? Math.round(valueRect.width * 100) / 100 : null,
            display: valueCs.display,
            gap: valueCs.gap,
            overflow: valueCs.overflow,
            truncated: valueEl.scrollWidth > valueEl.clientWidth + 1,
          }
        : null,
      label: pick('.select-value-label'),
      hint: pick('.select-trigger-hint'),
      chevron: !!el.querySelector('.select-chevron'),
    };
  };
  const tagsNearField = (labelText) => {
    const fields = [...document.querySelectorAll('.field')];
    const target = fields.filter((f) => headText(f) === labelText)[0] || fields.filter((f) => headText(f).indexOf(labelText) >= 0)[0] || null;
    const scope = target ? target.closest('section') || target.parentElement : document.querySelector('.settings-body');
    if (!scope) return { found: false };
    const candidates = [...scope.querySelectorAll('[class*="model-tag"], [class*="model-tags"], [class*="tag"], .chip, .tag')].filter(vis);
    return {
      found: true,
      targetFound: !!target,
      count: candidates.length,
      classes: [...new Set(candidates.map((el) => String(el.className || '')))].slice(0, 20),
      texts: [...new Set(candidates.map((el) => norm(el.textContent)).filter(Boolean))].slice(0, 24),
    };
  };
  const viewportInfo = () => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  });
  window.__vsel = {
    norm, vis, rectOf, fieldNameOf, headText, effectiveBackground, realClick, haspopups,
    fieldLabels, triggerInfo, clickHaspopup, haspopupCenter, haspopupIndexOfField, listbox,
    clickOption, pressEscape, clickOutside, scrollToField, tagsNearField, viewportInfo, triggerTextFit,
  };
  return true;
})()`

async function installHelpers() {
  await ev(INSTALL_HELPERS)
}

/**
 * 用 CDP Input.dispatchMouseEvent 发一次「真实」左键点击（isTrusted=true）。
 * 仅作为 JS dispatchEvent 失败时的兜底：真实事件会走浏览器命中测试，
 * 能命中只监听原生 pointerdown 的实现。task 要求以此为主、这里只兜底。
 */
async function realMouseClickAt(x, y) {
  const base = { x, y, button: 'left', clickCount: 1, buttons: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
  return true
}

/* ------------------------------------------------------------------ 静态断言 */

/**
 * 去掉 JS/TS/TSX 注释，但保持字符长度与换行不变（行号可直接对应）。
 * 字符串字面量原样保留 —— 字符串里拼 '<select' 仍会被 S1 判为命中（有意为之：
 * 这种绕过路径也应该被抓到）。
 */
function stripJsComments(text) {
  const chars = text.split('')
  const n = chars.length
  let i = 0
  while (i < n) {
    const c = chars[i]
    const d = chars[i + 1]
    if (c === '/' && d === '/') {
      let j = i
      while (j < n && chars[j] !== '\n') {
        chars[j] = ' '
        j += 1
      }
      i = j
      continue
    }
    if (c === '/' && d === '*') {
      let j = i
      while (j < n && !(chars[j] === '*' && chars[j + 1] === '/')) {
        if (chars[j] !== '\n') chars[j] = ' '
        j += 1
      }
      for (let k = j; k < Math.min(j + 2, n); k += 1) chars[k] = ' '
      i = j + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i += 1
      while (i < n) {
        if (chars[i] === '\\') {
          i += 2
          continue
        }
        if (chars[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    i += 1
  }
  return chars.join('')
}

function stripCssComments(text) {
  const chars = text.split('')
  const n = chars.length
  let i = 0
  while (i < n) {
    if (chars[i] === '/' && chars[i + 1] === '*') {
      let j = i
      while (j < n && !(chars[j] === '*' && chars[j + 1] === '/')) {
        if (chars[j] !== '\n') chars[j] = ' '
        j += 1
      }
      for (let k = j; k < Math.min(j + 2, n); k += 1) chars[k] = ' '
      i = j + 2
      continue
    }
    i += 1
  }
  return chars.join('')
}

const lineAt = (text, index) => {
  let line = 1
  for (let k = 0; k < index && k < text.length; k += 1) if (text[k] === '\n') line += 1
  return line
}

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function fileStatSafe(file) {
  try {
    const s = statSync(file)
    return { file: rel(file), bytes: s.size, mtime: s.mtime.toISOString() }
  } catch {
    return { file: rel(file), bytes: null, mtime: null }
  }
}

function listComponentFiles() {
  try {
    return readdirSync(COMPONENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.(tsx|jsx)$/.test(d.name))
      .map((d) => path.join(COMPONENTS_DIR, d.name))
      .sort()
  } catch {
    return []
  }
}

/** 递归列 src 下所有 .tsx/.jsx，用于 info 级「别处还有没有原生 select」。 */
function listAllSourceFiles(dir = path.join(ROOT, 'src')) {
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listAllSourceFiles(full))
    else if (/\.(tsx|jsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

function runStaticChecks() {
  const checks = []
  const add = (name, pass, detail, required = true, data) => {
    checks.push({ name, pass: !!pass, required, detail, ...(data === undefined ? {} : { data }) })
    return !!pass
  }

  const componentFiles = listComponentFiles()
  const sources = [...componentFiles, CSS_SRC].map(fileStatSafe)
  const selectScene = []
  const dynamicScenes = []
  let commentsStrippedNote = ''

  /* ---- S1：src/components 下不再有原生 <select ---- */
  if (componentFiles.length === 0) {
    add('components-found', false, `${rel(COMPONENTS_DIR)} 下没找到任何 .tsx 文件（路径或项目结构变了？）`)
  } else {
    add('components-found', true, `扫描 ${componentFiles.length} 个组件文件：${componentFiles.map((f) => path.basename(f)).join(', ')}`)
  }

  for (const file of componentFiles) {
    const raw = readTextSafe(file)
    if (raw == null) continue
    const stripped = stripJsComments(raw)
    const re = /<select[\s/>]/g
    let m = re.exec(stripped)
    while (m) {
      selectScene.push({
        file: path.basename(file),
        line: lineAt(stripped, m.index),
        snippet: raw.slice(m.index, m.index + 40).replace(/\s+/g, ' '),
      })
      m = re.exec(stripped)
    }
    for (const d of stripped.matchAll(/createElement\(\s*['"]select['"]/g)) {
      dynamicScenes.push({ file: path.basename(file), line: lineAt(stripped, d.index), snippet: 'createElement("select")' })
    }
    if (path.basename(file) === 'Settings.tsx' && raw.includes('<select') && !stripped.includes('<select')) {
      commentsStrippedNote = 'Settings.tsx 里的 <select 只出现在注释中（已按注释忽略）'
    }
  }

  const byFile = {}
  for (const s of selectScene) byFile[s.file] = (byFile[s.file] || 0) + 1
  add(
    'no-native-select-in-components',
    selectScene.length === 0,
    selectScene.length === 0
      ? `src/components 下已无 <select（注释内容不计；共扫描 ${componentFiles.length} 个文件）${commentsStrippedNote ? '；' + commentsStrippedNote : ''}`
      : `仍有 ${selectScene.length} 处原生 <select（注释里的不算）：` +
          selectScene.slice(0, 24).map((s) => `${s.file}:${s.line}`).join(', ') +
          (selectScene.length > 24 ? ` …等 ${selectScene.length} 处` : ''),
    true,
    { byFile, items: selectScene.slice(0, 40) },
  )

  add(
    'info-no-dynamic-select',
    dynamicScenes.length === 0,
    dynamicScenes.length === 0
      ? '没有 createElement("select") 这类动态创建原生下拉的写法'
      : `info：发现 ${dynamicScenes.length} 处动态创建 select：${dynamicScenes.slice(0, 6).map((s) => s.file + ':' + s.line).join(', ')}`,
    false,
    dynamicScenes.slice(0, 10),
  )

  /* ---- info：src 其它地方还有没有原生 select ---- */
  const otherSelects = []
  for (const file of listAllSourceFiles()) {
    if (path.dirname(file) === COMPONENTS_DIR) continue
    const raw = readTextSafe(file)
    if (raw == null) continue
    const stripped = stripJsComments(raw)
    for (const m of stripped.matchAll(/<select[\s/>]/g)) otherSelects.push({ file: rel(file), line: lineAt(stripped, m.index) })
  }
  add(
    'info-no-native-select-outside-components',
    otherSelects.length === 0,
    otherSelects.length === 0
      ? 'src 其余目录（非 components）也没有原生 <select'
      : `info：components 之外仍有 ${otherSelects.length} 处 <select：${otherSelects.slice(0, 10).map((s) => s.file + ':' + s.line).join(', ')}`,
    false,
    otherSelects.slice(0, 20),
  )

  /* ---- S2：ui.tsx 导出了下拉组件 ---- */
  const uiText = readTextSafe(UI_SRC)
  let dropdownExport = null
  let uniqueExports = []
  if (uiText == null) {
    add('ui-tsx-exists', false, `读不到 ${rel(UI_SRC)}（文件不存在或没权限）`)
  } else {
    add('ui-tsx-exists', true, `${rel(UI_SRC)} 存在，${uiText.length} 字符`)
    const exportedNames = []
    for (const m of uiText.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g)) exportedNames.push(m[1])
    for (const m of uiText.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const piece of m[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/)[0].trim()
        if (name) exportedNames.push(name)
      }
    }
    uniqueExports = [...new Set(exportedNames)]
    dropdownExport =
      uniqueExports.find((name) => /^(Select|Dropdown|Picker|Combobox|SelectInput|DropdownSelect|SelectField|SelectMenu)$/i.test(name)) ||
      uniqueExports.find((name) => /(select|dropdown|picker|combobox)/i.test(name)) ||
      null
    add(
      'ui-exports-dropdown-component',
      !!dropdownExport,
      dropdownExport
        ? `ui.tsx 导出下拉组件：${dropdownExport}（兼容 Select/Dropdown/Picker/Combobox 命名）；全部导出 = ${uniqueExports.join(', ')}`
        : `ui.tsx 里没找到下拉组件导出（期望名字含 Select / Dropdown / Picker / Combobox）。实际导出名单 = [${
            uniqueExports.length ? uniqueExports.join(', ') : '（没有任何 export function/const）'
          }]；请让 select-fixer 确认组件名与导出方式（若用了 export default，请改成具名导出，或同步本脚本的正则）`,
      true,
      { exports: uniqueExports, dropdownExport },
    )
  }

  /* ---- S2b：ui.tsx 里必须有 aria-haspopup / listbox（runtime 定位依据） ---- */
  const hasHaspopup = uiText != null && /aria-haspopup/.test(uiText)
  const hasListbox = uiText != null && /listbox/i.test(uiText)
  add(
    'ui-dropdown-aria-contract',
    hasHaspopup && hasListbox,
    `ui.tsx：aria-haspopup ${hasHaspopup ? '有' : '缺失'}，listbox ${hasListbox ? '有' : '缺失'}；runtime 阶段靠 aria-haspopup="listbox" 定位触发器、靠 role="listbox" 定位面板`,
  )

  /* ---- S3：styles.css 里 >= 3 条 .select- 规则 ---- */
  const cssRaw = readTextSafe(CSS_SRC)
  if (cssRaw == null) {
    add('css-exists', false, `读不到 ${rel(CSS_SRC)}`)
    add('css-select-rules', false, 'styles.css 缺失，无法统计 .select- 规则')
  } else {
    const css = stripCssComments(cssRaw)
    const classMatches = [...css.matchAll(/\.select-[A-Za-z0-9_-]+/g)].map((m) => m[0])
    const uniqueClasses = [...new Set(classMatches)]
    // 只统计「选择器后紧跟 {」的规则块，避免命中属性值里的误匹配。
    const ruleMatches = [...css.matchAll(/([^{};]*?\.select-[A-Za-z0-9_-]+[^{};]*?)\{/g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
    add(
      'css-select-rules',
      ruleMatches.length >= 3,
      `styles.css 命中 .select-* 规则 ${ruleMatches.length} 条（要求 >= 3），涉及类名 ${uniqueClasses.length} 个：${
        uniqueClasses.slice(0, 20).join(', ') || '（无）'
      }${ruleMatches.length ? '；前几条选择器：' + ruleMatches.slice(0, 6).map((s) => s.slice(0, 60)).join(' | ') : ''}`,
      true,
      { ruleCount: ruleMatches.length, classCount: uniqueClasses.length, classes: uniqueClasses.slice(0, 40) },
    )
  }

  /* ---- S4：模型能力标签类名（info，不阻断） ---- */
  if (cssRaw != null) {
    const css = stripCssComments(cssRaw)
    const modelTag = /\.model-tag(s)?\b/.test(css)
    const chip = /\.chip\b/.test(css)
    const tag = /\.tag(s)?\b/.test(css)
    add(
      'info-model-tag-classes',
      modelTag || chip || tag,
      `模型能力标签类名：.model-tag=${modelTag ? '有' : '无'}，.chip=${chip ? '有' : '无'}，.tag=${tag ? '有' : '无'}（info 级，不阻断；task-2 负责加标签）`,
      false,
      { modelTag, chip, tag },
    )
  }

  /* ---- S6：触发器 flex 契约（防回归，本条守的是 trigger-label-not-truncated） ---- */
  if (cssRaw != null) {
    const css = stripCssComments(cssRaw)
    /** 抽某个选择器块里的声明体。 */
    const blockOf = (selector) => {
      const m = css.match(new RegExp(`\\${selector.replace(/^\./, '.')}\\s*\\{([^}]*)\\}`))
      return m ? m[1].replace(/\s+/g, ' ') : null
    }
    const labelBlock = blockOf('.select-value-label')
    const hintBlock = blockOf('.select-trigger-hint')
    // label 必须是「不收缩」：flex: 0 0 auto（或 flex-shrink: 0）
    const labelNoShrink = !!labelBlock && /flex\s*:\s*0\s+0\s+auto/.test(labelBlock)
    // hint 必须是可收缩且有 min-width:0，否则它无法让位
    const hintShrinks = !!hintBlock && /min-width\s*:\s*0/.test(hintBlock) && /flex\s*:\s*0\s+1\s+auto/.test(hintBlock)
    const labelHasEllipsis = !!labelBlock && /text-overflow\s*:\s*ellipsis/.test(labelBlock)
    add(
      'css-trigger-flex-contract',
      labelNoShrink && hintShrinks,
      labelNoShrink && hintShrinks
        ? `.select-value-label 为 flex: 0 0 auto（主文案不收缩），.select-trigger-hint 为 flex: 0 1 auto + min-width: 0（唯一让位方）` +
            (labelHasEllipsis ? '；label 保留 ellipsis 兜底（超长名仍可截）' : '；label 无 ellipsis 兜底')
        : `触发器 flex 契约被破坏，会导致主文案被 hint 挤到亚像素级截断（R9 会 FAIL）。实测：\n` +
            `  .select-value-label 块 = ${labelBlock === null ? '未找到' : JSON.stringify(labelBlock)}（要求 flex: 0 0 auto，${
              labelNoShrink ? '当前满足' : '当前不满足'
            }）\n` +
            `  .select-trigger-hint 块 = ${hintBlock === null ? '未找到' : JSON.stringify(hintBlock)}（要求 flex: 0 1 auto + min-width: 0，${
              hintShrinks ? '当前满足' : '当前不满足'
            }）`,
      true,
      { labelBlock, hintBlock, labelNoShrink, hintShrinks, labelHasEllipsis },
    )
  }

  const required = checks.filter((c) => c.required)
  const failed = required.filter((c) => !c.pass)
  return {
    ok: failed.length === 0,
    phase: 'static',
    sources,
    checks,
    requiredTotal: required.length,
    requiredFailed: failed.map((c) => c.name),
    summary: failed.length === 0 ? '静态断言全部通过' : `静态断言失败 ${failed.length} 项：${failed.map((c) => c.name).join(', ')}`,
  }
}

function printStatic(stat) {
  if (!stat) return
  const okCount = stat.checks.filter((c) => c.required && c.pass).length
  console.log(`[verify] ===== static: ${stat.ok ? 'PASS' : 'FAIL'} (${okCount}/${stat.requiredTotal} required) =====`)
  for (const c of stat.checks) {
    console.log(`  - [${c.pass ? 'ok' : 'FAIL'}${c.required ? '' : ' |info'}] ${c.name}: ${c.detail}`)
  }
}

/* ------------------------------------------------------- Python 像素统计 */

function findPython() {
  const candidates = []
  if (process.env.VERIFY_PYTHON) candidates.push(process.env.VERIFY_PYTHON)
  if (process.env.DSH_HOME) {
    candidates.push(path.join(process.env.DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  }
  candidates.push(path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  for (const c of candidates) {
    if (c && existsSync(c)) return { python: c, source: 'dsh-bundled' }
  }
  return { python: 'python', source: 'PATH' }
}

/**
 * 用 bundled Python + Pillow 算「面板区域平均亮度」。
 *
 * 坐标换算：页面上拿到的是 CSS px 的 bounding box；截图是设备像素（390 × 2.75 ≈ 1073 宽），
 * 所以缩放比例 = 截图宽度 / window.innerWidth，直接把 cssWidth 交给 python 算，
 * 比写死 devicePixelRatio 更稳（Chromium 对 2.75 会取整，且偶发 1px 视口差）。
 *
 * 受 Windows 沙箱限制（Node 用管道 stdio 捕获子进程输出会 EPERM），
 * 这里让 python 把结果写进临时 JSON，再用 fs 读回来，stdio 用 'ignore'。
 */
function listboxLuminance(imagePath, rect, cssWidth) {
  const { python, source } = findPython()
  const outJson = path.join(os.tmpdir(), `dsh-select-luma-${process.pid}-${Date.now()}.json`)
  const code = [
    'import json, sys',
    'from PIL import Image, ImageStat',
    'img_path, out_path = sys.argv[1], sys.argv[2]',
    'x, y, w, h, css_w = (float(v) for v in sys.argv[3:8])',
    'im = Image.open(img_path).convert("RGB")',
    'iw, ih = im.size',
    'scale = (iw / css_w) if css_w > 0 else 1.0',
    'left = max(0, min(int(round(x * scale)), iw - 1))',
    'top = max(0, min(int(round(y * scale)), ih - 1))',
    'right = max(left + 1, min(int(round((x + w) * scale)), iw))',
    'bottom = max(top + 1, min(int(round((y + h) * scale)), ih))',
    'crop = im.crop((left, top, right, bottom))',
    'stat = ImageStat.Stat(crop)',
    'r, g, b = stat.mean[0], stat.mean[1], stat.mean[2]',
    'luma = 0.299 * r + 0.587 * g + 0.114 * b',
    'gray = ImageStat.Stat(crop.convert("L")).mean[0]',
    'payload = {',
    '  "pngWidth": iw, "pngHeight": ih, "scale": round(scale, 4),',
    '  "cropPx": {"left": left, "top": top, "right": right, "bottom": bottom, "w": right - left, "h": bottom - top},',
    '  "meanRgb": [round(r, 2), round(g, 2), round(b, 2)],',
    '  "meanLuma": round(luma, 2), "meanGray": round(gray, 2),',
    '}',
    'json.dump(payload, open(out_path, "w"))',
  ].join('\n')

  try {
    const r = spawnSync(
      python,
      ['-c', code, imagePath, outJson, String(rect.x), String(rect.y), String(rect.w), String(rect.h), String(cssWidth)],
      { stdio: 'ignore', cwd: ROOT, timeout: 120000 },
    )
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`python exit=${r.status}`)
    const stat = JSON.parse(readFileSync(outJson, 'utf8'))
    return { ok: true, python: rel(python) || python, pythonSource: source, threshold: LUMA_MAX, ...stat }
  } catch (error) {
    return { ok: false, python, pythonSource: source, error: String(error && error.message ? error.message : error) }
  } finally {
    try {
      rmSync(outJson, { force: true })
    } catch {
      /* ignore */
    }
  }
}

/* --------------------------------------------------------------- 运行时流程 */

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (error) {
      lastError = error
    }
    await sleep(150)
  }
  if (lastError) console.log(`[verify] waitUntil(${label}) 最后一次异常：${lastError.message}`)
  return null
}

async function waitForApp(timeoutMs = 25000) {
  const ok = await waitUntil(
    async () => ev(`!!document.querySelector('.home-dock .dock-item') || !!document.querySelector('.screen-panel')`),
    timeoutMs,
    'app-ready',
  )
  if (!ok) throw new Error('等待应用页面就绪超时（.home-dock .dock-item / .screen-panel 都没出现）')
  return true
}

async function reloadApp() {
  await send('Page.reload', { ignoreCache: true })
  await sleep(800)
  try {
    await send('Emulation.setDeviceMetricsOverride', VIEWPORT)
  } catch {
    /* ignore */
  }
  await waitForApp()
  await sleep(250)
}

/**
 * 进设置页：与 scripts/verify-keyboard-insets.mjs 的 openSettings 同款策略
 * （优先 .home-dock .dock-item[4]，回退文本含「设置」的可点元素）。
 * attach 到已有实例时页面可能已经停在设置页，直接复用。
 */
async function openSettings() {
  const existing = await ev(`!!document.querySelector('.screen.settings-screen .screen-panel')`)
  let navHow = 'already-open'
  if (!existing) {
    navHow = await ev(`(() => {
      const items = document.querySelectorAll('.home-dock .dock-item');
      if (items.length >= 5) { items[4].click(); return 'dock-item[4]'; }
      const candidates = [...document.querySelectorAll('button, [role="button"], a')];
      const hit = candidates.find((el) => /设置|settings/i.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')));
      if (hit) { hit.click(); return 'text-fallback'; }
      return null;
    })()`)
    if (!navHow) throw new Error('无法进入设置页：既没有第 5 个 .home-dock .dock-item，也没有文本含「设置」的可点元素')
  }

  const ready = await waitUntil(
    async () =>
      ev(`(() => {
        const panel = document.querySelector('.screen.settings-screen .screen-panel');
        if (!panel) return false;
        const r = panel.getBoundingClientRect();
        return r.height > 0;
      })()`),
    12000,
    'settings-panel',
  )
  if (!ready) throw new Error('设置页 .screen-panel 未出现或高度为 0（进入设置失败）')
  await sleep(300)
  return navHow
}

/** 进设置页；失败先 reload 重试一次（任务要求）。 */
async function enterSettingsWithRetry() {
  try {
    await waitForApp(8000)
    return await openSettings()
  } catch (first) {
    console.log('[verify] 首次进入设置页失败，reload 后重试一次：', first.message)
    await reloadApp()
    return await openSettings()
  }
}

/** 面板关闭兜底：先看自然关闭，再 Esc，再点空白处。 */
async function ensurePanelClosed() {
  const probeClosed = async () => {
    const p = await ev('window.__vsel.listbox()')
    return p.listboxVisible === 0 ? p : null
  }
  let closed = await waitUntil(probeClosed, 4000, 'panel-closed-natural')
  if (closed) return { closed: true, how: 'natural' }
  await ev('window.__vsel.pressEscape()')
  closed = await waitUntil(probeClosed, 2000, 'panel-closed-esc')
  if (closed) return { closed: true, how: 'escape' }
  await ev('window.__vsel.clickOutside()')
  closed = await waitUntil(probeClosed, 2500, 'panel-closed-outside')
  return { closed: !!closed, how: closed ? 'outside-click' : 'none' }
}

const parseRgb = (value) => {
  const m = String(value || '').match(/rgba?\(([^)]+)\)/i)
  if (!m) return null
  const parts = m[1]
    .split(/[,/\s]+/)
    .map((s) => Number(s))
    .filter((n) => !Number.isNaN(n))
  if (parts.length < 3) return null
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 ? parts[3] : 1 }
}

/** 触发器文本是否体现了所选 option 的 label。 */
function textReflectsChoice(triggerText, option) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  const trigger = norm(triggerText)
  if (!trigger) return { pass: false, matched: null, candidates: [] }
  const candidates = []
  if (option.label) candidates.push(norm(option.label))
  if (option.ariaLabel) candidates.push(norm(option.ariaLabel))
  if (option.text) {
    candidates.push(norm(option.text))
    for (const seg of String(option.text).split(/[\n|·—–:：]/)) {
      const s = norm(seg)
      if (s.length >= 2) candidates.push(s)
    }
  }
  const unique = [...new Set(candidates)].filter((s) => s.length >= 2)
  const matched = unique.find((c) => trigger.includes(c) || (trigger.length >= 3 && c.includes(trigger))) || null
  return { pass: !!matched, matched, candidates: unique.slice(0, 10) }
}

async function describePageState() {
  try {
    const haspopups = await ev('window.__vsel.haspopups()')
    const fields = await ev('window.__vsel.fieldLabels()')
    const url = await ev('location.href')
    return {
      url,
      haspopups: haspopups.map((d) => ({
        index: d.index,
        tag: d.tag,
        haspopup: d.haspopup,
        field: d.field,
        text: d.text.slice(0, 48),
        visible: d.visible,
      })),
      fields,
    }
  } catch (error) {
    return { error: '读取页面状态失败: ' + error.message }
  }
}

async function runRuntime() {
  const rt = {
    ok: false,
    mode: 'attach',
    port: PORT,
    viewport: VIEWPORT,
    url: null,
    nav: null,
    trigger: null,
    haspopups: null,
    viewportInfo: null,
    open: null,
    pick: null,
    pixel: null,
    modelStatus: null,
    shots: {},
    checks: [],
    errors: [],
  }
  const add = (name, pass, detail, data) => {
    rt.checks.push({ name, pass: !!pass, detail, ...(data === undefined ? {} : { data }) })
    return !!pass
  }

  rt.url = await attachToRunning()

  /**
   * 先无条件 reload 一次：attach 到的窗口可能还停着「构建前」的旧页面
   * （Lead 起 Electron 前刚 build 过 dist），不 reload 会测到旧 DOM 而误报 FAIL。
   * 顺带保证每次都从首页开始，跑完也不影响窗口（不关闭、不杀进程）。
   */
  console.log('[verify] 无条件 Page.reload 一次，确保测的是构建后的新页面')
  try {
    await reloadApp()
    rt.reloaded = true
  } catch (error) {
    console.log('[verify] reload 后页面未就绪，再等一次：', error.message)
    await sleep(1500)
    await waitForApp(25000)
    rt.reloaded = 'retried'
  }

  rt.nav = await enterSettingsWithRetry()
  add('settings-opened', true, `进入设置页方式：${rt.nav}`)

  await installHelpers()
  const viewport = await ev('window.__vsel.viewportInfo()')
  rt.viewportInfo = viewport
  add(
    'viewport-mobile',
    Math.abs(viewport.innerWidth - VIEWPORT.width) <= 2 && viewport.dpr > 2,
    `视口 ${viewport.innerWidth}x${viewport.innerHeight} @dpr ${round(viewport.dpr, 3)}（期望 ${VIEWPORT.width}x${VIEWPORT.height} @2.75）`,
  )

  const haspopups = await ev('window.__vsel.haspopups()')
  rt.haspopups = haspopups
  const visibleHaspopups = haspopups.filter((d) => d.visible && !d.disabled)
  const provider =
    visibleHaspopups.find((d) => /供应商/.test(d.field)) || visibleHaspopups.find((d) => /listbox/i.test(String(d.haspopup))) || null

  if (!provider) {
    const state = await describePageState()
    add(
      'provider-trigger-found',
      false,
      '设置页里找不到可用的下拉触发器（aria-haspopup）。已看到的 aria-haspopup 元素：' +
        (visibleHaspopups.length
          ? visibleHaspopups.map((d) => `#${d.index} tag=${d.tag} field="${d.field}" text="${d.text.slice(0, 40)}"`).join(' | ')
          : '（一个都没有）') +
        `；页面 .field 标签 = ${JSON.stringify(state.fields)}。` +
        '若下拉组件还没合并 / dist 未重新 build，请先完成 task-1 再跑本脚本。',
      { state, haspopups },
    )
    rt.errors.push('provider-trigger-not-found')
    try {
      rt.shots.open = rel(await shot('verify-select-open'))
    } catch {
      /* ignore */
    }
    return rt
  }

  rt.trigger = {
    index: provider.index,
    field: provider.field,
    text: provider.text,
    haspopup: provider.haspopup,
    ariaExpanded: provider.expanded,
    classes: provider.classes,
  }
  add(
    'provider-trigger-found',
    true,
    `定位到下拉触发器：field="${provider.field || '(无 .field 包裹)'}" text="${provider.text.slice(0, 48)}" aria-haspopup=${provider.haspopup}（index=${provider.index}）`,
  )

  /* ------------------------------ 打开面板 + 断言 1/2/3 ------------------------------ */
  const openProbe = async () => {
    const p = await ev('window.__vsel.listbox()')
    // 等位置算完（.select-panel.is-placing 期间是不可用的占位）
    return p.panel && p.panel.rect.w >= 8 && p.panel.rect.h >= 8 ? p : null
  }
  await ev(`window.__vsel.clickHaspopup(${provider.index})`)
  let probe = await waitUntil(openProbe, 8000, 'listbox-open')
  if (!probe) {
    // JS dispatchEvent 没打开：用真实鼠标事件在原坐标兜底点一次（isTrusted=true）。
    const center = await ev(`window.__vsel.haspopupCenter(${provider.index})`)
    if (center && center.visible) {
      console.log(`[verify] JS 点击未打开面板，改用 Input.dispatchMouseEvent 在 (${center.x}, ${center.y}) 兜底点击一次`)
      await realMouseClickAt(center.x, center.y)
      probe = await waitUntil(openProbe, 6000, 'listbox-open-real-mouse')
      if (probe) rt.openMode = 'input-dispatchMouseEvent-fallback'
    }
  }
  if (probe) rt.openMode = rt.openMode || 'js-dispatchEvent'

  if (!probe) {
    try {
      rt.shots.open = rel(await shot('verify-select-open'))
    } catch {
      /* ignore */
    }
    const state = await describePageState()
    const raw = await ev('window.__vsel.listbox()')
    add(
      'listbox-open',
      false,
      `点击「${provider.field || provider.text}」触发器后 8s 内没有出现可用的 role="listbox"（可见且已定位）。` +
        `当前 listbox 状态：总数=${raw.listboxTotal}，可用=${raw.listboxVisible}。` +
        `页面 aria-haspopup 元素：${JSON.stringify(state.haspopups)}。` +
        '请确认面板写了 role="listbox"，且打开后不是 display:none / opacity:0 / .is-placing 常驻。',
      { state, raw },
    )
    rt.errors.push('listbox-not-opened')
    return rt
  }

  await sleep(420) // 等展开过渡动画结束，保证截图与裁剪一致
  const settled = await ev('window.__vsel.listbox()')
  rt.open = settled.panel ? settled : probe
  const panel = rt.open.panel
  add(
    'listbox-open',
    true,
    `面板已展开：tag=${panel.tag} class="${panel.classes}" position=${panel.position} z-index=${panel.zIndex} 尺寸=${panel.rect.w}x${panel.rect.h}` +
      `；内层 listbox="${panel.listbox.classes}" 内容高=${panel.listbox.scrollHeight}/${panel.listbox.clientHeight}`,
  )

  // 断言 1：面板背景不是白色（listbox 自身透明时沿祖先链取真正上色的那层）
  const effective = panel.effective
  const rgb = parseRgb(effective.background) || parseRgb(panel.background)
  const isWhite = !!rgb && rgb.r > WHITE_CHANNEL && rgb.g > WHITE_CHANNEL && rgb.b > WHITE_CHANNEL && (rgb.a == null || rgb.a > 0.15)
  add(
    'listbox-background-not-white',
    !isWhite,
    isWhite
      ? `面板背景是白的！effective background-color=${effective.background}（来自 ${effective.source}；r/g/b 三个都 >${WHITE_CHANNEL} 即判为白），正是用户看到的「系统白屏」现象`
      : `面板 effective background-color=${effective.background}（来自 ${effective.source}；判白阈值 r/g/b 全 > ${WHITE_CHANNEL}）；` +
          `listbox 自身=${panel.listbox.background}；` +
          `border-radius=${panel.borderRadius}，max-height=${panel.maxHeight}，z-index=${panel.zIndex}，backdrop-filter=${panel.backdropFilter || 'none'}`,
    {
      effectiveBackground: effective.background,
      effectiveSource: effective.source,
      listboxOwnBackground: panel.listbox.background,
      rgba: rgb,
      borderRadius: panel.borderRadius,
      maxHeight: panel.maxHeight,
      zIndex: panel.zIndex,
      position: panel.position,
      backdropFilter: panel.backdropFilter,
      listboxMaxHeight: panel.listbox.maxHeight,
      listboxOverflowY: panel.listbox.overflowY,
    },
  )

  // 断言 1b：面板自身必须是不透明实色底（alpha >= 0.8），
  // 防止「透明面板套在深色页面上」蒙混过关 —— 真机上若页面底是浅色就露白。
  const panelAlpha = panel.backgroundAlpha
  const alphaOk = typeof panelAlpha === 'number' && panelAlpha >= PANEL_MIN_ALPHA
  add(
    'panel-opaque-enough',
    alphaOk,
    alphaOk
      ? `.select-panel 自身 background-color=${panel.background}，alpha=${panelAlpha} >= ${PANEL_MIN_ALPHA}（不靠下层背景兜白）`
      : `.select-panel 自身 background-color=${panel.background}，alpha=${panelAlpha === null ? '无法解析' : panelAlpha}，要求 >= ${PANEL_MIN_ALPHA}；` +
          '透明面板在浅色页面/浅色系统下会露白，请给 .select-panel 一个实色底（如 rgba(5,22,31,0.98)）',
    { backgroundColor: panel.background, alpha: panelAlpha, threshold: PANEL_MIN_ALPHA },
  )

  // 断言 2：页面上没有可见的原生 <select>
  const selectOk = rt.open.visibleSelects.length === 0
  add(
    'no-visible-native-select',
    selectOk,
    selectOk
      ? `页面上没有任何可见的原生 <select>（DOM 内 select 总数=${rt.open.selectTotal}）`
      : `仍存在 ${rt.open.visibleSelects.length} 个可见的原生 <select>：${rt.open.visibleSelects
          .map((s) => `class="${s.classes}" value="${s.value}" ${s.rect.w}x${s.rect.h}@(${s.rect.x},${s.rect.y})`)
          .join(' | ')}`,
    { visibleSelects: rt.open.visibleSelects, selectTotal: rt.open.selectTotal },
  )

  // 断言 3：role=option >= 1
  const optionOk = rt.open.optionCount >= 1
  add(
    'listbox-has-options',
    optionOk,
    optionOk
      ? `listbox 内 role="option" 共 ${rt.open.optionCount} 个：${rt.open.options
          .slice(0, 6)
          .map((o) => `"${(o.label || o.text).slice(0, 32)}"`)
          .join(', ')}`
      : 'listbox 内没有任何 role="option"（面板是空的）',
    { optionCount: rt.open.optionCount, options: rt.open.options.slice(0, 12) },
  )

  // 截图 1：展开态
  const openShot = await shot('verify-select-open')
  rt.shots.open = rel(openShot)

  // 像素断言：面板区域平均亮度 < 120（裁剪框用面板外层 rect，含真实背景与内边距）
  const cssWidth = viewport.innerWidth
  const rectForCrop = panel.rect
  const dimOk = rectForCrop.w >= MIN_CROP_SIDE && rectForCrop.h >= MIN_CROP_SIDE
  const pixel = dimOk
    ? listboxLuminance(openShot, rectForCrop, cssWidth)
    : { ok: false, error: `面板 bounding box 太小（${rectForCrop.w}x${rectForCrop.h} CSS px，要求各 >= ${MIN_CROP_SIDE}），裁剪区域不可信` }
  rt.pixel = { ...pixel, cssRect: rectForCrop, cssWidth, listboxRect: panel.listbox.rect }
  if (pixel.ok) {
    const lumaOk = pixel.meanLuma < LUMA_MAX
    add(
      'panel-dark-luminance',
      lumaOk,
      `面板区域平均亮度 = ${pixel.meanLuma}（阈值 < ${LUMA_MAX}；meanRGB=[${pixel.meanRgb.join(', ')}]，crop=${pixel.cropPx.w}x${pixel.cropPx.h} 设备px，scale=${pixel.scale}，png=${pixel.pngWidth}x${pixel.pngHeight}）` +
        (lumaOk ? '' : ' → 面板偏亮，接近白屏'),
      {
        meanLuma: pixel.meanLuma,
        meanRgb: pixel.meanRgb,
        meanGray: pixel.meanGray,
        cropPx: pixel.cropPx,
        scale: pixel.scale,
        pngSize: [pixel.pngWidth, pixel.pngHeight],
      },
    )
    console.log(
      `[verify] 面板平均亮度 = ${pixel.meanLuma}（阈值 < ${LUMA_MAX}），meanRGB=[${pixel.meanRgb.join(', ')}]，裁剪 ${pixel.cropPx.w}x${pixel.cropPx.h}px @scale ${pixel.scale}`,
    )
  } else {
    add('panel-dark-luminance', false, `像素统计失败：${pixel.error}（python=${pixel.python || 'n/a'}，source=${pixel.pythonSource || 'n/a'}）`)
  }

  /* -------------------------- 断言 4：点第 2 个 option -------------------------- */

  // 「供应商」内置只有一个选项，这时改用「思考强度」等其它下拉完成这一条。
  let pickTrigger = provider
  let pickProbe = rt.open
  if (rt.open.optionCount < 2) {
    console.log(`[verify] 「${provider.field || provider.text}」只有 ${rt.open.optionCount} 个选项，改用其它下拉验证选中流程`)
    const closedHint = await ensurePanelClosed()
    // 用最新的触发器列表重新算索引：面板开关会改变 DOM，之前抓的 index 可能过期。
    const freshHaspopups = (await ev('window.__vsel.haspopups()')).filter((d) => d.visible && !d.disabled)
    const effort =
      freshHaspopups.find((d) => /思考强度/.test(d.field)) || freshHaspopups.find((d) => !/供应商/.test(d.field)) || null
    if (!effort) {
      add(
        'pick-second-option',
        false,
        `「${provider.field || provider.text}」只有 ${rt.open.optionCount} 个选项，且找不到可用于替代验证的第二个下拉（页面上 aria-haspopup 元素：${
          freshHaspopups.map((d) => d.field || d.text.slice(0, 20)).join(', ') || '无'
        }；面板关闭=${closedHint.how}）`,
      )
      rt.errors.push('pick-trigger-missing')
      return rt
    }
    await ev(`window.__vsel.clickHaspopup(${effort.index})`)
    const effortOpenProbe = async () => {
      const p = await ev('window.__vsel.listbox()')
      return p.panel && p.optionCount >= 2 ? p : null
    }
    let effortProbe = await waitUntil(effortOpenProbe, 8000, 'second-listbox-open')
    if (!effortProbe) {
      const center = await ev(`window.__vsel.haspopupCenter(${effort.index})`)
      if (center && center.visible) {
        console.log(`[verify] 第二个下拉 JS 点击未打开，改用真实鼠标事件在 (${center.x}, ${center.y}) 兜底`)
        await realMouseClickAt(center.x, center.y)
        effortProbe = await waitUntil(effortOpenProbe, 6000, 'second-listbox-open-real-mouse')
      }
    }
    if (!effortProbe) {
      add('pick-second-option', false, `改用「${effort.field || effort.text}」下拉后仍拿不到 >=2 个 role="option"（首个面板关闭=${closedHint.how}）`)
      rt.errors.push('pick-listbox-missing')
      return rt
    }
    await sleep(320)
    pickTrigger = effort
    pickProbe = await ev('window.__vsel.listbox()')
  }

  // 默认点第 2 项；若它恰好就是当前值（触发器文案已经是它），换一个不同的项，避免「没变化也算过」。
  const triggerBefore = await ev(`window.__vsel.triggerInfo(${pickTrigger.index})`)
  const beforeText = triggerBefore ? triggerBefore.valueText || triggerBefore.text : ''
  let pickIndex = 1
  const already = textReflectsChoice(beforeText, pickProbe.options[pickIndex] || {})
  if (already.pass) {
    const alt = pickProbe.options.findIndex((o, i) => i >= 1 && o.disabledAttr !== true && !textReflectsChoice(beforeText, o).pass)
    if (alt >= 0) pickIndex = alt
  }
  const targetOption = pickProbe.options[pickIndex]
  const closedAfter = async () => {
    const p = await ev('window.__vsel.listbox()')
    return p.listboxVisible === 0 ? p : null
  }
  let clicked = await ev(`window.__vsel.clickOption(${pickIndex})`)
  let closed = await waitUntil(closedAfter, 5000, 'listbox-closed-after-pick')
  if (clicked && !closed) {
    // JS 点击没生效：用真实鼠标事件点该 option 的中心兜底。
    const optRect = targetOption && targetOption.rect
    if (optRect) {
      console.log(`[verify] JS 点击 option 后面板未关闭，改用真实鼠标事件在 (${optRect.x + optRect.w / 2}, ${optRect.y + optRect.h / 2}) 兜底`)
      await realMouseClickAt(Math.round((optRect.x + optRect.w / 2) * 100) / 100, Math.round((optRect.y + optRect.h / 2) * 100) / 100)
      closed = await waitUntil(closedAfter, 5000, 'listbox-closed-after-pick-real-mouse')
    }
  }

  // 重新按 field 找触发器（选中后 DOM 可能重排，索引未必稳定）
  const afterHaspopups = await ev('window.__vsel.haspopups()')
  const triggerAfter = afterHaspopups.find((d) => d.field === pickTrigger.field) || afterHaspopups.find((d) => d.index === pickTrigger.index) || null
  const afterText = triggerAfter ? triggerAfter.text : ''
  const reflect = triggerAfter ? textReflectsChoice(afterText, targetOption) : { pass: false, matched: null, candidates: [] }
  const pickClosedOk = !!closed

  add(
    'panel-closes-after-pick',
    clicked && pickClosedOk,
    (clicked ? '' : '点击第 2 个 option 失败（clickOption 返回 false，面板或选项可能不可点）') +
      (clicked && pickClosedOk
        ? `点击第 ${pickIndex + 1} 个 option 后面板已关闭（listbox 不可见）`
        : clicked
          ? `点击第 ${pickIndex + 1} 个 option 后面板仍开着（listbox 仍可见）`
          : '') +
      `；触发器 aria-expanded=${triggerAfter ? triggerAfter.ariaExpanded : 'n/a'}`,
  )
  add(
    'trigger-text-updated',
    reflect.pass,
    `点选前触发器文本="${beforeText.slice(0, 60)}"，点选后="${afterText.slice(0, 60)}"；第 ${pickIndex + 1} 个 option 的 label="${
      (targetOption && (targetOption.label || targetOption.text) || '').slice(0, 60)
    }"` +
      (targetOption && targetOption.ariaLabel ? ` aria-label="${targetOption.ariaLabel}"` : '') +
      '；' +
      (reflect.pass ? `命中候选「${reflect.matched}」` : `未命中任何候选（候选=${JSON.stringify(reflect.candidates)}）`),
    {
      pickField: pickTrigger.field,
      pickIndex,
      before: beforeText,
      after: afterText,
      option: targetOption
        ? { label: targetOption.label, hint: targetOption.hint, tags: targetOption.tags, text: targetOption.text, selected: targetOption.selected }
        : null,
      matched: reflect.matched,
      candidates: reflect.candidates,
      ariaExpandedAfter: triggerAfter ? triggerAfter.ariaExpanded : null,
    },
  )
  rt.pick = {
    field: pickTrigger.field,
    index: pickIndex,
    clicked,
    closed: pickClosedOk,
    triggerBefore: beforeText,
    triggerAfter: afterText,
    option: targetOption || null,
    matched: reflect.matched,
    candidates: reflect.candidates,
    usedFallbackField: pickTrigger.index !== provider.index,
  }

  rt.shots.picked = rel(await shot('verify-select-picked'))

  /* --------------------- 模型下拉：option 必须带能力标签 --------------------- */
  // 用户原话是「模型列表那边……模型的状态」，所以这条是本次修复的重点验收项：
  // 展开「模型」下拉后，至少有一个 option 内含 .model-tag 或 .select-tag，
  // 且该 option 的可见文本里出现「看图/推理/旗舰/网页/自定义」之类的能力词。
  try {
    const closedForModel = await ensurePanelClosed()
    const modelIndex = await ev(`window.__vsel.haspopupIndexOfField('模型')`)
    if (modelIndex < 0) {
      const fields = await ev('window.__vsel.fieldLabels()')
      add('model-options-have-tags', false, `设置页找不到标签为「模型」的下拉触发器；现有 .field 标签 = ${JSON.stringify(fields)}`)
    } else {
      const modelOpenProbe = async () => {
        const p = await ev('window.__vsel.listbox()')
        return p.panel && p.optionCount >= 1 ? p : null
      }
      await ev(`window.__vsel.clickHaspopup(${modelIndex})`)
      let modelProbe = await waitUntil(modelOpenProbe, 8000, 'model-listbox-open')
      if (!modelProbe) {
        const center = await ev(`window.__vsel.haspopupCenter(${modelIndex})`)
        if (center && center.visible) {
          await realMouseClickAt(center.x, center.y)
          modelProbe = await waitUntil(modelOpenProbe, 6000, 'model-listbox-open-real-mouse')
        }
      }
      if (!modelProbe) {
        add('model-options-have-tags', false, `展开「模型」下拉失败（首个面板关闭=${closedForModel.how}），拿不到 option 无法校验标签`)
      } else {
        await sleep(420)
        const modelPanel = await ev('window.__vsel.listbox()')
        rt.modelOptions = modelPanel
        rt.shots.modelOpen = rel(await shot('verify-model-open'))
        const withTag = modelPanel.options.filter((o) => o.tagCount > 0)
        const tagClasses = new Set()
        const withWord = withTag.filter((o) => MODEL_CAPABILITY_WORDS.some((w) => (o.tagTexts || []).some((t) => t.includes(w)) || (o.innerText || '').includes(w)))
        // 也单独校验「可见文本里出现能力词」（不依赖 tag 元素，兼容只写文案的实现）
        const anyWordInText = modelPanel.options.some((o) => MODEL_CAPABILITY_WORDS.some((w) => (o.innerText || '').includes(w)))
        for (const o of withTag) for (const t of o.tagTexts || []) tagClasses.add(t)
        const optSummary = modelPanel.options
          .slice(0, 8)
          .map((o) => `#${o.index} tags=${JSON.stringify(o.tagTexts)} innerText="${(o.innerText || '').slice(0, 60)}"`)
          .join(' | ')
        add(
          'model-options-have-tags',
          withTag.length >= 1 && withWord.length >= 1,
          withTag.length >= 1 && withWord.length >= 1
            ? `「模型」下拉 ${modelPanel.optionCount} 个 option 中 ${withTag.length} 个带能力标签（.model-tag/.select-tag），` +
                `其中 ${withWord.length} 个可见文本含能力词；标签内容 = ${JSON.stringify([...tagClasses].slice(0, 12))}`
            : `「模型」下拉的 option ${withTag.length === 0 ? '一个都没有 .model-tag/.select-tag' : '有标签但文本里找不到能力词'}（optionCount=${modelPanel.optionCount}）。` +
                `各 option 实际内容：${optSummary}。请给 Select 的 options[].tags 传 modelTags(id)（task-2）。`,
          {
            optionCount: modelPanel.optionCount,
            optionsWithTags: withTag.length,
            optionsWithWord: withWord.length,
            tagTexts: [...tagClasses].slice(0, 12),
            anyCapabilityWordInText: anyWordInText,
            options: modelPanel.options.slice(0, 8).map((o) => ({ index: o.index, label: o.label, tagTexts: o.tagTexts, innerText: o.innerText })),
          },
        )
        const closedAfterModel = await ensurePanelClosed()
        rt.modelDropdown = {
          field: '模型',
          triggerIndex: modelIndex,
          optionCount: modelPanel.optionCount,
          optionsWithTags: withTag.length,
          optionsWithCapabilityWord: withWord.length,
          tagTexts: [...tagClasses].slice(0, 12),
          closedHow: closedAfterModel.how,
        }
      }
    }
  } catch (error) {
    add('model-options-have-tags', false, `模型下拉标签校验异常：${error.message}`)
    rt.errors.push('model-options-check-failed')
  }

  /* ------------- 触发器文本不被截断（本轮核心：修「deepseek-v4.1-flash（当前） · 自定...」） ------------- */
  /**
   * 用户看到的就是触发器这一行。修复前 .select-value 把 label 和 hint 拼成一句话整体省略，
   * 模型名一长就把「· 自定义模型名」吃掉，甚至截到主文案。
   * 现在断言：选中长 label 的选项后，.select-value-label 的 scrollWidth <= clientWidth + 1
   * （主文案完整显示）；hint 被压缩属设计意图，只记 info。
   */
  try {
    await ensurePanelClosed()
    // 优先用「模型」下拉（当前值 deepseek-v4.1-flash（当前）就是最贴近用户场景的长名）。
    const triggerIdx = await ev(`window.__vsel.haspopupIndexOfField('模型')`)
    const idx = triggerIdx >= 0 ? triggerIdx : 0
    const openProbe2 = async () => {
      const p = await ev('window.__vsel.listbox()')
      return p.panel && p.optionCount >= 1 ? p : null
    }
    await ev(`window.__vsel.clickHaspopup(${idx})`)
    let fitProbe = await waitUntil(openProbe2, 8000, 'fit-listbox-open')
    if (!fitProbe) {
      const center = await ev(`window.__vsel.haspopupCenter(${idx})`)
      if (center && center.visible) {
        await realMouseClickAt(center.x, center.y)
        fitProbe = await waitUntil(openProbe2, 6000, 'fit-listbox-open-real-mouse')
      }
    }
    if (!fitProbe) {
      add('trigger-label-not-truncated', false, `为了校验触发器文本，展开「模型」下拉失败（index=${idx}），无法执行选中流程`)
      rt.errors.push('trigger-fit-listbox-missing')
    } else {
      await sleep(320)
      const fitPanel = await ev('window.__vsel.listbox()')
      // 选「label 最长」的那一项：最能暴露截断问题。
      let longest = 0
      for (const o of fitPanel.options) {
        if ((o.disabledAttr === true)) continue
        if (String(o.label || o.text || '').length > String(fitPanel.options[longest]?.label || '').length) longest = o.index
      }
      const beforeFit = await ev(`window.__vsel.triggerTextFit(${idx})`)
      const clickedFit = await ev(`window.__vsel.clickOption(${longest})`)
      await waitUntil(async () => {
        const p = await ev('window.__vsel.listbox()')
        return p.listboxVisible === 0 ? p : null
      }, 5000, 'fit-panel-closed')
      await sleep(360) // 等 React 重渲染完触发器文案

      // 选中后按 field 重查索引（DOM 顺序可能变），再测量。
      const idxAfter = await ev(`window.__vsel.haspopupIndexOfField('模型')`)
      const measureIdx = idxAfter >= 0 ? idxAfter : idx
      const fit = await ev(`window.__vsel.triggerTextFit(${measureIdx})`)
      rt.triggerFit = { before: beforeFit, after: fit, pickedOptionIndex: longest, clicked: clickedFit }

      if (!fit) {
        add('trigger-label-not-truncated', false, `选中后找不到「模型」触发器（index=${measureIdx}），无法测量文本截断`)
        rt.errors.push('trigger-fit-measure-missing')
      } else if (!fit.label) {
        add(
          'trigger-label-not-truncated',
          false,
          '触发器里找不到 .select-value-label 元素（修复前的实现是 label+hint 拼在 .select-value 里）。' +
            `触发器完整文本="${fit.fullText}"，valueContainer=${JSON.stringify(fit.valueContainer)}。` +
            '请确认 ui.tsx 的触发器已拆成 .select-value-label + .select-trigger-hint 两个子项。',
          { fit },
        )
        rt.errors.push('trigger-label-element-missing')
      } else {
        /**
         * 确定性判据：放开约束量「自然宽度」，与受约束宽度比。
         * deficit > 0.02px 且元素设了 text-overflow:ellipsis → 浏览器必然渲染「…」。
         *
         * 为什么不用 scrollWidth/clientWidth：二者是整数，实测 label
         * constrained=215.917 / natural=216（deficit 0.083px）时
         * scrollWidth=clientWidth=213/214，完全看不出差异，会假通过。
         * 为什么不用 canvas 量文本宽度：字体度量与真实排版有 ±2px 偏差（实测 range=216 canvas=214），
         * 落在临界区时会漏判。放开约束直接问浏览器「它本来想要多宽」最可靠。
         */
        const labelOk = !fit.label.truncating
        const hintSqueezed = !!fit.hint && fit.hint.squeezed
        add(
          'trigger-label-not-truncated',
          labelOk,
          (labelOk
            ? `主文案未被截断：.select-value-label 受约束宽=${fit.label.constrainedWidth} = 自然宽=${fit.label.naturalWidth}（deficit=${fit.label.deficit}px）`
            : `主文案被截断（浏览器已渲染「…」）！.select-value-label 自然宽=${fit.label.naturalWidth} > 实际可用=${fit.label.constrainedWidth}，` +
              `被压窄 ${fit.label.deficit}px（text-overflow=${fit.label.textOverflow}）。文本="${fit.label.text}"`) +
            `；触发器完整文本="${fit.fullText}"` +
            (fit.hint
              ? `；hint="${fit.hint.text}" 受约束宽=${fit.hint.constrainedWidth} 自然宽=${fit.hint.naturalWidth}` +
                (hintSqueezed ? `（hint 让位收缩 ${fit.hint.deficit}px，属预期，info）` : '（hint 完整显示）')
              : '；该触发器无 .select-trigger-hint'),
          {
            label: fit.label,
            hint: fit.hint,
            valueContainer: fit.valueContainer,
            fullText: fit.fullText,
            hintSqueezed,
            pickedOptionIndex: longest,
            before: beforeFit && beforeFit.label
              ? {
                  text: beforeFit.label.text,
                  constrainedWidth: beforeFit.label.constrainedWidth,
                  naturalWidth: beforeFit.label.naturalWidth,
                  deficit: beforeFit.label.deficit,
                  truncating: beforeFit.label.truncating,
                }
              : null,
          },
        )
        if (fit.hint) {
          add(
            'info-trigger-hint-squeeze',
            true,
            hintSqueezed
              ? `info：.select-trigger-hint 被压缩（受约束宽 ${fit.hint.constrainedWidth} < 自然宽 ${fit.hint.naturalWidth}，让位 ${fit.hint.deficit}px），` +
                  '即 hint 优先收缩、主文案优先保住 —— 这正是 hint 作为唯一让位方的预期效果'
              : `info：.select-trigger-hint 完整显示（受约束宽 ${fit.hint.constrainedWidth} = 自然宽 ${fit.hint.naturalWidth}）`,
            { hint: fit.hint, squeezed: hintSqueezed },
          )
        }
        // 触发器特写：clip 到触发器那一行，肉眼确认没有「自定...」
        try {
          const trigInfo = await ev(`window.__vsel.triggerInfo(${measureIdx})`)
          if (trigInfo && trigInfo.rect) {
            rt.shots.trigger = rel(await shotClip('verify-model-trigger', trigInfo.rect, 12))
          }
          rt.shots.modelOpenAfter = rel(await shot('verify-model-open'))
        } catch (shotError) {
          console.log('[verify] 触发器特写截图失败：', shotError.message)
        }
      }
    }
  } catch (error) {
    add('trigger-label-not-truncated', false, `触发器文本截断校验异常：${error.message}`)
    rt.errors.push('trigger-fit-check-failed')
  }

  /* ------------------------------ 模型状态标签截图 ------------------------------ */
  try {
    const scroll = await ev(`window.__vsel.scrollToField('模型')`)
    await sleep(500)
    const tags = await ev(`window.__vsel.tagsNearField('模型')`)
    rt.modelStatus = { scroll, tags }
    rt.shots.modelStatus = rel(await shot('verify-model-status'))
    add(
      'model-status-evidence',
      true,
      `已滚动到「${scroll.found ? scroll.fieldText || '模型' : '模型（未找到，截当前视口）'}」字段并截图；附近标签元素 ${tags.count || 0} 个（classes=${JSON.stringify(
        (tags.classes || []).slice(0, 6),
      )}，texts=${JSON.stringify((tags.texts || []).slice(0, 8))}）`,
      { scroll, tags },
    )
    if (scroll && scroll.found === false) {
      add('model-field-found', false, `没找到标签为「模型」的 .field，现有字段：${JSON.stringify(scroll.available)}`)
    }
  } catch (error) {
    add('model-status-evidence', false, `模型状态截图失败：${error.message}`)
    rt.errors.push('model-status-failed')
  }

  const passed = rt.checks.filter((c) => c.pass === true)
  const failed = rt.checks.filter((c) => c.pass !== true)
  rt.ok = failed.length === 0 && rt.errors.length === 0
  rt.passedCount = passed.length
  rt.failedCount = failed.length
  rt.failedNames = failed.map((c) => c.name)
  return rt
}

/* ---------------------------------------------------------------------- 主流程 */

function printRuntime(rt) {
  if (!rt) return
  if (rt.skipped) {
    console.log(`[verify] runtime 跳过：${rt.reason || rt.error || '(未提供原因)'}`)
    if (rt.error) console.log(`[verify] ${rt.error}`)
    return
  }
  console.log(`[verify] ===== runtime: ${rt.ok ? 'PASS' : 'FAIL'} (${rt.passedCount || 0} passed / ${rt.failedCount || 0} failed) =====`)
  for (const c of rt.checks || []) console.log(`  - [${c.pass ? 'ok' : 'FAIL'}] ${c.name}: ${c.detail}`)
  if (rt.shots && Object.keys(rt.shots).length) console.log('[verify] 截图：', JSON.stringify(rt.shots))
  for (const e of rt.errors || []) console.log(`  ! error: ${e}`)
}

async function main() {
  console.log(`[verify] script=scripts/verify-select-ui.mjs port=${PORT} phase=${PHASE} attach=${ATTACH}`)

  if (PHASE === 'runtime') {
    result.static = { skipped: true, reason: '--phase=runtime' }
  } else {
    result.static = runStaticChecks()
    printStatic(result.static)
  }

  if (PHASE === 'static') {
    result.runtime = { skipped: true, reason: '--phase=static' }
  } else if (!ATTACH) {
    // 绝不自己 spawn Electron：本沙箱里 Chromium 会 0x80000003 崩溃。
    result.runtime = {
      ok: false,
      skipped: true,
      reason: '未提供 --attach',
      error:
        'runtime 阶段必须加 --attach，并先由 Lead 在完整权限终端启动 Electron：\n' +
        `  node_modules\\electron\\dist\\electron.exe . --remote-debugging-port=${PORT}\n` +
        '本脚本不会自己 spawn Electron（沙箱会 0x80000003 崩溃）。',
      checks: [],
      shots: {},
    }
    printRuntime(result.runtime)
  } else {
    console.log('[verify] ===== runtime（attach 到外部 Electron）=====')
    try {
      result.runtime = await runRuntime()
    } catch (error) {
      result.runtime = {
        ok: false,
        mode: 'attach',
        checks: result.runtime?.checks || [],
        shots: result.runtime?.shots || {},
        errors: [`runtime 异常：${error && error.message ? error.message : String(error)}`],
        stack: error && error.stack ? String(error.stack).split('\n').slice(0, 8) : null,
      }
      console.error('[verify] runtime 异常:', error && error.message ? error.message : error)
    }
    printRuntime(result.runtime)
  }

  const staticOk = PHASE === 'runtime' ? true : !!result.static?.ok
  const runtimeOk = PHASE === 'static' ? true : !!result.runtime?.ok
  result.pass = !!(staticOk && runtimeOk)
}

try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true })
  await main()
} catch (error) {
  result.pass = false
  result.errors = [String(error && error.stack ? error.stack : error)]
  console.error('[verify] 异常:', error && error.message ? error.message : error)
} finally {
  // attach 模式：只断开 WebSocket，不杀 Electron、不关窗口。
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  ws = null
  result.finishedAt = new Date().toISOString()
  console.log('[verify] ===== JSON 汇总 =====')
  console.log(JSON.stringify({ static: result.static, runtime: result.runtime, pass: result.pass }, null, 2))
  console.log(`[verify] VERIFY RESULT: ${result.pass ? 'PASS' : 'FAIL'} (phase=${result.phase})`)
  if (!result.pass) process.exitCode = 1
}
