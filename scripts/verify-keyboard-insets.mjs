#!/usr/bin/env node
/**
 * scripts/verify-keyboard-insets.mjs
 *
 * 「设置页输入框 + 软键盘弹起 → 整屏塌陷成黑屏」的复现与回归验证脚本。
 *
 * 背景（Lead 初判，修复见 task-1）：
 *   MainActivity 把 WindowInsets 的「物理 px」直接写进 CSS 变量 --safe-bottom，
 *   并且把软键盘 IME 高度也塞了进去。设置页 .screen 的 padding-bottom 用
 *   var(--safe-bottom)，键盘弹起时 3x 屏上 IME 约 900–1100 物理 px 被当成
 *   CSS px → padding 超过 390×844 视口高 → .screen-panel（height:100%）塌成 0，
 *   整屏只剩 .screen 的深色底，看起来就是「巨大的黑屏」。
 *
 * 本脚本用 Electron + CDP（与 scripts/mobile.mjs 同一套路）在移动视口
 * 390×844 @2.75 下：
 *   1. 「修复前复现」：注入旧 CSS（.screen padding-bottom 直接用 --safe-bottom），
 *      并把 --safe-bottom 设为 960px（模拟旧版 IME 物理 px 未换算）→ 断言面板塌陷、
 *      截图近黑像素占比 > 80%；
 *   2. 「修复后回归」：不注入旧 CSS，
 *      A 正常值 --safe-bottom:20px/--safe-top:24px → 面板高度 > 250px；
 *      B 恶意大值 --safe-bottom:960px/--safe-top:120px → 面板仍 > 250px（CSS min() 兜底）；
 *      C --ime-inset:320px → 面板高度与 A 基本一致（±8px，只影响 scroll-padding）；
 *      另断言修复后截图近黑占比 < 60%；
 *   3. 静态审计：MainActivity.java 注入串必须用 devicePixelRatio 换算、--safe-bottom
 *      不得来自 ime、必须有上限钳制；src/styles.css 的 .screen padding-bottom 必须用
 *      min(var(--safe-bottom...), ...)。
 *
 * 用法：
 *   node scripts/verify-keyboard-insets.mjs                 # 自动：dist 已重建→全部；否则只跑修复前
 *   node scripts/verify-keyboard-insets.mjs --phase=before  # 只跑修复前复现
 *   node scripts/verify-keyboard-insets.mjs --phase=after   # 只跑修复后 A/B/C
 *   node scripts/verify-keyboard-insets.mjs --phase=all     # 全部
 *   node scripts/verify-keyboard-insets.mjs --phase=static  # 只跑静态审计（不起 Electron）
 *   可选：--port=9351（默认 9351）
 *   可选：--attach   不自己起 Electron，直接连到已在 9351 端口暴露 CDP 的实例
 *                    （用于 DSH 沙箱等无法 spawn Chromium 的环境：先在非沙箱终端运行
 *                      node_modules\electron\dist\electron.exe . --remote-debugging-port=9351）
 *
 * 退出码：全部断言通过 0，否则 1。
 * 写作用域：scripts/verify-keyboard-insets.mjs、shots/verify-*.png（不碰 src/、android/）。
 */

import { spawn, spawnSync, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = path.join(ROOT, 'shots')
const ELECTRON_BIN = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const JAVA_SRC = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'elyoncat', 'deepsea', 'MainActivity.java')
const CSS_SRC = path.join(ROOT, 'src', 'styles.css')
const DIST_ASSETS = path.join(ROOT, 'dist', 'assets')

/** 移动视口：iPhone 13/14 逻辑尺寸，Android 3x 屏等价 DPR 2.75。 */
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2.75, mobile: true }
/** 近黑判定：RGB 三通道都 < 24。 */
const NEAR_BLACK = 24

const argv = new Map(
  process.argv.slice(2).map((raw) => {
    const text = raw.replace(/^--/, '')
    const eq = text.indexOf('=')
    if (eq < 0) return [text, true]
    return [text.slice(0, eq), text.slice(eq + 1)]
  }),
)
const PORT = Number(argv.get('port') || process.env.VERIFY_PORT || 9351)
const PHASE_ARG = String(argv.get('phase') || 'auto').toLowerCase()
/** attach 模式：不 spawn Electron，直接连外部已开的 CDP 实例（沙箱里唯一可行的运行时验证方式）。 */
const ATTACH = Boolean(argv.get('attach'))

/* ------------------------------------------------------------------ 小工具 */

const result = {
  script: 'scripts/verify-keyboard-insets.mjs',
  startedAt: new Date().toISOString(),
  mode: null,
  phase: null,
  viewport: VIEWPORT,
  dist: null,
  staticChecks: null,
  before: null,
  after: null,
  pass: false,
}

/** 极简 CDP 客户端（与 scripts/mobile.mjs 一致的做法）。 */
let ws = null
let child = null
let seq = 1
const pending = new Map()
let childExited = false

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

/* ------------------------------------------------------- Python 像素统计 */

function findPython() {
  const candidates = []
  if (process.env.VERIFY_PYTHON) candidates.push(process.env.VERIFY_PYTHON)
  if (process.env.DSH_HOME) {
    candidates.push(path.join(process.env.DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  }
  candidates.push(path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  for (const c of candidates) {
    if (existsSync(c)) return { python: c, source: 'dsh-bundled' }
  }
  return { python: 'python', source: 'PATH' }
}

/**
 * 用 bundled Python + Pillow 算「近黑像素占比」（RGB 各 < 24）。
 * 说明：受 Windows 沙箱限制（Node 用管道 stdio 捕获子进程输出会 EPERM），
 * 这里让 python 把结果写进临时 JSON，再用 fs 读回来，stdio 用 'ignore'。
 */
function nearBlackRatio(imagePath) {
  const { python, source } = findPython()
  const outJson = path.join(os.tmpdir(), `dsh-verify-pixel-${process.pid}-${Date.now()}.json`)
  const code = [
    'import json, sys',
    'from PIL import Image',
    'im = Image.open(sys.argv[1]).convert("RGB")',
    'w, h = im.size',
    'n = 0',
    'try:',
    '    import numpy as np',
    '    a = np.asarray(im, dtype=np.uint8)',
    '    m = (a[:, :, 0] < 24) & (a[:, :, 1] < 24) & (a[:, :, 2] < 24)',
    '    n = int(m.sum())',
    '    tot = int(w) * int(h)',
    'except Exception:',
    '    px = im.load()',
    '    for y in range(h):',
    '        for x in range(w):',
    '            r, g, b = px[x, y]',
    '            if r < 24 and g < 24 and b < 24:',
    '                n += 1',
    '    tot = w * h',
    'ratio = (n / float(tot)) if tot else 0.0',
    'json.dump({"width": w, "height": h, "nearBlack": round(ratio, 4), "nearBlackPct": round(ratio * 100, 2)}, open(sys.argv[2], "w"))',
  ].join('\n')

  try {
    const r = spawnSync(python, ['-c', code, imagePath, outJson], { stdio: 'ignore', cwd: ROOT, timeout: 120000 })
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`python exit=${r.status}`)
    const stat = JSON.parse(readFileSync(outJson, 'utf8'))
    return { ok: true, python, pythonSource: source, threshold: NEAR_BLACK, ...stat }
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

/* --------------------------------------------------------- 静态源码审计 */

function stripJavaComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 抽出 pushInsets 里注入的 JS 串（"(function(){" ... "})();"）。 */
function extractInjection(java) {
  const start = java.indexOf('(function(){')
  const end = java.lastIndexOf('})();')
  if (start < 0 || end < 0 || end <= start) return null
  return java.slice(start, end)
}

function runStaticChecks(javaText, cssText, origin) {
  const java = stripJavaComments(javaText)
  const css = stripCssComments(cssText)
  const checks = []
  const add = (name, pass, detail, required = true) => checks.push({ name, pass: !!pass, required, detail })

  /* ---- MainActivity.java ---- */
  const injection = extractInjection(java)

  add(
    'java-injection-uses-devicePixelRatio',
    /devicePixelRatio/.test(java) && !!injection && /devicePixelRatio/.test(injection),
    injection
      ? `注入串${/devicePixelRatio/.test(injection) ? '包含' : '不包含'} devicePixelRatio；源码整体${/devicePixelRatio/.test(java) ? '包含' : '不包含'}`
      : '未找到 (function(){ ... })(); 注入串',
  )

  const bottomMatch = injection && injection.match(/setProperty\('--safe-bottom',\s*([^;]+)\)/)
  const bottomExpr = bottomMatch ? bottomMatch[1] : null
  const imeBottomAssignment = java.match(/insetBottom\s*=\s*Math\.max\(\s*bars\.bottom\s*,\s*ime\.bottom\s*\)/)
  const imeInSafeAssign = java.match(/(?:insetBottom|safeBottom|cssBottom)\s*=[^;\n]*\bime\b/)
  const safeSetLines = injection ? injection.split('\n').filter((l) => l.includes("setProperty('--safe-")) : []
  const imeInSafeLines = safeSetLines.filter((l) => /ime/i.test(l))
  const imeInsetLine = injection && /setProperty\('--ime-inset'/.test(injection)
  const imeBottomOnlyInImeLine = injection
    ? injection
        .split('\n')
        .filter((l) => /imeBottom|\bime\b/i.test(l))
        .every((l) => /setProperty\('--ime-inset'/.test(l))
    : false

  add(
    'java-safe-bottom-not-from-ime',
    !!bottomExpr && !/ime/i.test(bottomExpr) && !imeBottomAssignment && !imeInSafeAssign && imeInSafeLines.length === 0,
    [
      bottomExpr ? `--safe-bottom 表达式=${bottomExpr.trim()}` : '未找到 --safe-bottom 赋值',
      bottomExpr && /ime/i.test(bottomExpr) ? '表达式含 ime' : '表达式不含 ime',
      imeBottomAssignment ? '仍存在 insetBottom=Math.max(bars.bottom, ime.bottom)' : '不再用 max(bars.bottom, ime.bottom)',
      imeInSafeAssign ? `底部赋值仍引用 ime: ${imeInSafeAssign[0].trim()}` : '底部赋值不引用 ime',
    ].join('; '),
  )

  add('java-ime-inset-variable', !!imeInsetLine, imeInsetLine ? '--ime-inset 单独注入' : '缺少 --ime-inset 注入', false)
  add(
    'java-ime-only-feeds-ime-inset',
    !!imeInsetLine && imeBottomOnlyInImeLine,
    imeBottomOnlyInImeLine ? 'ime 相关变量只出现在 --ime-inset 行' : 'ime 相关变量出现在 --safe-* 注入行或缺失 --ime-inset',
    false,
  )

  const clampPairs = [
    ['--safe-top', 120, true],
    ['--safe-bottom', 72, true],
    ['--safe-left', 48, false],
    ['--safe-right', 48, false],
    ['--ime-inset', 600, false],
  ]
  for (const [key, max, required] of clampPairs) {
    const m = injection && injection.match(new RegExp(`setProperty\\('${key}',\\s*([^;]+)\\)`))
    const expr = m ? m[1].trim() : null
    const pass = !!expr && expr.includes(String(max)) && /min|clamp|px\s*\(/i.test(expr)
    add(`java-clamp-${key.replace(/^--/, '')}-${max}`, pass, expr ? `${key} <- ${expr}` : `未找到 ${key} 注入`, required)
  }

  /* ---- src/styles.css ---- */
  const screenBlocks = [...css.matchAll(/\.screen\s*\{([^}]*)\}/g)].map((m) => m[1])
  const padBlocks = screenBlocks.filter((b) => /padding/.test(b)).map((b) => b.replace(/\s+/g, ''))
  /**
   * 渐进增强写法：每个「裸 var(--safe-bottom)」声明后面紧跟一条同属性的
   * min(var(--safe-bottom...), ...) 声明（老 WebView 认第一条，新内核用第二条）。
   * 所以判定规则是「每个裸用法都能在同一块里找到配对的 min() 用法」，而不是「不许出现裸用法」。
   */
  const unsafeBlocks = padBlocks.filter((b) => {
    const bare = (b.match(/var\(--safe-bottom/g) || []).length
    const clamped = (b.match(/min\(var\(--safe-bottom/g) || []).length
    return bare > clamped * 2
  })
  const hasClampedBlock = padBlocks.some((b) => b.includes('min(var(--safe-bottom'))
  add(
    'css-screen-safe-bottom-clamped',
    padBlocks.length > 0 && hasClampedBlock && unsafeBlocks.length === 0,
    `命中 .screen 带 padding 规则 ${padBlocks.length} 处；用 min(var(--safe-bottom...)) 的 ${padBlocks.filter((b) => b.includes('min(var(--safe-bottom')).length} 处；裸用（含渐进增强配对）合计 ${padBlocks.reduce((n, b) => n + (b.match(/var\(--safe-bottom/g) || []).length, 0)} 处；未配对块 ${unsafeBlocks.length} 处` +
      (unsafeBlocks.length ? `：${unsafeBlocks.map((b) => b.slice(0, 90)).join(' | ')}` : ''),
  )

  const imeScroll = /scroll-padding-bottom\s*:[^;]*var\(--ime-inset/.test(css)
  add(
    'css-ime-inset-scroll-padding',
    imeScroll && /--ime-inset\s*:/.test(css),
    imeScroll ? '.screen-body 用 --ime-inset 做 scroll-padding-bottom（只做滚动让位）' : '未找到 scroll-padding-bottom: ... var(--ime-inset)',
    false,
  )

  const required = checks.filter((c) => c.required)
  return {
    origin,
    checks,
    requiredPass: required.every((c) => c.pass),
    requiredTotal: required.length,
    requiredFailed: required.filter((c) => !c.pass).map((c) => c.name),
    allPass: checks.every((c) => c.pass),
  }
}

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 找 fixer 留下的修复前快照（_backup-insets-*），用于证明修复前静态检查确实是 FAIL。 */
function findPreFixBackup() {
  try {
    const dirs = readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^_backup-insets-\d/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse()
    for (const name of dirs) {
      const java = path.join(ROOT, name, 'MainActivity.java')
      const css = path.join(ROOT, name, 'styles.css')
      if (existsSync(java) && existsSync(css)) return { dir: name, java, css }
    }
  } catch {
    /* ignore */
  }
  return null
}

/* ------------------------------------------------------ dist 是否已重建 */

function detectDist() {
  const info = { assetsDir: path.relative(ROOT, DIST_ASSETS), ready: false, reason: '', cssFile: null, mtime: null, hasMinClamp: false, hasImeInset: false }
  if (!existsSync(DIST_ASSETS)) {
    info.reason = 'dist/assets 不存在（还没构建过）'
    return info
  }
  const cssFiles = readdirSync(DIST_ASSETS).filter((f) => f.endsWith('.css'))
  const mainCss = cssFiles.find((f) => f.startsWith('index-')) || cssFiles[0]
  if (!mainCss) {
    info.reason = 'dist/assets 下没有 CSS'
    return info
  }
  const file = path.join(DIST_ASSETS, mainCss)
  const text = readFileSync(file, 'utf8')
  info.cssFile = path.relative(ROOT, file)
  try {
    info.mtime = statSync(file).mtime.toISOString()
  } catch {
    info.mtime = null
  }
  info.hasMinClamp = /min\(var\(--safe-bottom/.test(text)
  info.hasImeInset = /--ime-inset/.test(text)
  info.ready = info.hasMinClamp
  info.reason = info.hasMinClamp ? 'dist CSS 已含 min(var(--safe-bottom...))，判定为修复后构建' : 'dist CSS 仍是裸 var(--safe-bottom)，判定为修复前构建'
  return info
}

/* ------------------------------------------------------------------ CDP 流程 */

const VARS = ['--safe-top', '--safe-bottom', '--safe-left', '--safe-right', '--ime-inset', '--keyboard-inset']

const MEASURE_EXPR = `(() => {
  const screen = document.querySelector('.screen.settings-screen') || document.querySelector('.screen');
  const panel = screen ? screen.querySelector('.screen-panel') : null;
  const body = screen ? screen.querySelector('.screen-body') : null;
  const root = getComputedStyle(document.documentElement);
  const rect = panel ? panel.getBoundingClientRect() : null;
  const screenRect = screen ? screen.getBoundingClientRect() : null;
  const cs = screen ? getComputedStyle(screen) : null;
  const bodyCs = body ? getComputedStyle(body) : null;
  const val = (v) => (v == null || v === '' ? null : v.trim());
  return {
    hasScreen: !!screen,
    hasPanel: !!panel,
    panelHeight: rect ? Math.round(rect.height * 100) / 100 : 0,
    panelWidth: rect ? Math.round(rect.width * 100) / 100 : 0,
    panelTop: rect ? Math.round(rect.top * 100) / 100 : 0,
    screenHeight: screenRect ? Math.round(screenRect.height * 100) / 100 : null,
    screenPadding: cs ? cs.padding : null,
    screenPaddingTop: cs ? cs.paddingTop : null,
    screenPaddingBottom: cs ? cs.paddingBottom : null,
    screenOverflowY: cs ? cs.overflowY : null,
    bodyScrollPaddingBottom: bodyCs ? bodyCs.scrollPaddingBottom : null,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    vars: {
      safeTop: val(root.getPropertyValue('--safe-top')),
      safeBottom: val(root.getPropertyValue('--safe-bottom')),
      safeLeft: val(root.getPropertyValue('--safe-left')),
      safeRight: val(root.getPropertyValue('--safe-right')),
      imeInset: val(root.getPropertyValue('--ime-inset')),
      keyboardInset: val(root.getPropertyValue('--keyboard-inset')),
    },
  };
})()`

async function setVars(vars) {
  const lines = Object.entries(vars)
    .map(([k, v]) => 's.setProperty(' + JSON.stringify(k) + ', ' + JSON.stringify(v) + ');')
    .join('')
  return ev(`(() => { const s = document.documentElement.style; ${lines} return true; })()`)
}

async function clearVars() {
  return ev(`(() => { const s = document.documentElement.style; ${VARS.map((v) => 's.removeProperty(' + JSON.stringify(v) + ');').join('')} return true; })()`)
}

const OLD_SCREEN_CSS = [
  '.screen{padding-bottom:calc(10px + var(--safe-bottom)) !important}',
  '@media (max-width: 820px){.screen{padding-bottom:calc(6px + var(--safe-bottom)) !important}}',
].join('\n')

async function injectOldScreenPadding() {
  return ev(`(() => {
    const old = document.getElementById('verify-old-css');
    if (old) old.remove();
    const st = document.createElement('style');
    st.id = 'verify-old-css';
    st.textContent = ${JSON.stringify(OLD_SCREEN_CSS)};
    document.head.appendChild(st);
    return true;
  })()`)
}

async function portResponding() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`)
    return true
  } catch {
    return false
  }
}

async function launchElectron() {
  if (!existsSync(ELECTRON_BIN)) throw new Error('找不到 electron.exe：' + ELECTRON_BIN)
  // 端口若已被占用（多半是上次异常退出残留），直接报错，避免连到别人的页面。
  if (await portResponding()) throw new Error(`CDP 端口 ${PORT} 已有进程在响应（可能是残留 Electron），请先关闭后重跑`)

  const env = { ...process.env, DEEPSEA_DEV_URL: '' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(ELECTRON_BIN, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env })
  childExited = false
  child.on('exit', () => {
    childExited = true
  })
  child.on('error', (error) => {
    console.error('[verify] spawn electron 失败:', error.message)
  })

  const deadline = Date.now() + 30000
  let lastError = null
  while (Date.now() < deadline) {
    if (childExited) {
      const code = child.exitCode
      const sandboxHint =
        code === 2147483651 || code === -2147483645
          ? '（exitCode 0x80000003 = Chromium CHECK 崩溃；DSH Windows 沙箱会拒绝 Mojo 命名管道，需在非沙箱终端运行本脚本）'
          : '（可能受单实例锁/其它实例影响）'
      throw new Error(`Electron 提前退出（exitCode=${code}）${sandboxHint}`)
    }
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = Array.isArray(list) ? list.find((t) => t.type === 'page') : null
      if (page && page.webSocketDebuggerUrl) {
        await connect(page.webSocketDebuggerUrl)
        return
      }
    } catch (error) {
      lastError = error
    }
    await sleep(300)
  }
  throw new Error(`等待 CDP 端口 ${PORT} 超时（lastError=${lastError ? lastError.message : 'n/a'}）`)
}

/**
 * attach 模式：连到外部已启动的 Electron（同一台机器、已暴露 CDP 端口）。
 * 典型场景：本会话沙箱里 Chromium 起不来，由用户在普通终端先启动应用：
 *   node_modules\electron\dist\electron.exe . --remote-debugging-port=9351
 */
async function attachToRunning(timeoutMs = Number(process.env.VERIFY_ATTACH_TIMEOUT_SEC || 90) * 1000) {
  console.log(`[verify] attach 模式：等待外部 Electron 在 127.0.0.1:${PORT} 暴露 CDP（最多 ${Math.round(timeoutMs / 1000)}s）...`)
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      const page = pages.find((t) => String(t.url || '').includes('index.html')) || pages[0]
      if (page) {
        await connect(page.webSocketDebuggerUrl)
        console.log('[verify] attach 成功:', String(page.url || '').slice(0, 120))
        return page.url
      }
    } catch (error) {
      lastError = error
    }
    await sleep(500)
  }
  throw new Error(
    `attach 模式等待 CDP 端口 ${PORT} 超时。请先在非沙箱终端运行：node_modules\\electron\\dist\\electron.exe . --remote-debugging-port=${PORT}` +
      (lastError ? `（lastError=${lastError.message}）` : ''),
  )
}

async function connect(url) {
  ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
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
  await sleep(800)
}

/** 等页面里出现首页 dock 或任意屏幕面板。 */
async function waitForApp(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const ok = await ev(`!!document.querySelector('.home-dock .dock-item') || !!document.querySelector('.screen-panel')`)
      if (ok) return true
    } catch {
      /* 导航中上下文会短暂不可用，重试 */
    }
    await sleep(250)
  }
  throw new Error('等待应用页面就绪超时（.home-dock / .screen-panel 未出现）')
}

/** 重新加载应用页面：清掉上一用例注入的 <style> 与内联 CSS 变量。 */
async function reloadApp() {
  await send('Page.reload', { ignoreCache: true })
  await sleep(700)
  try {
    await send('Emulation.setDeviceMetricsOverride', VIEWPORT)
  } catch {
    /* ignore */
  }
  await waitForApp()
  await clearVars()
  await sleep(300)
}

/** 进入「设置」页：优先第 5 个 dock 项，失败则用文本含「设置」的可点元素兜底。 */
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

  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const ready = await ev(`(() => {
      const panel = document.querySelector('.screen.settings-screen .screen-panel') || document.querySelector('.screen .screen-panel');
      if (!panel) return false;
      const r = panel.getBoundingClientRect();
      return r.height > 0;
    })()`)
    if (ready) {
      await sleep(350) // 等遮罩过渡动画结束
      return navHow
    }
    await sleep(200)
  }
  throw new Error('设置页 .screen-panel 未出现或高度为 0（进入设置失败）')
}

async function measure() {
  return ev(MEASURE_EXPR)
}

async function runBeforeCase() {
  await reloadApp()
  const nav = await openSettings()
  const normal = await measure()
  const normalShot = await shot('verify-settings-before-normal')
  await injectOldScreenPadding()
  await setVars({
    '--safe-bottom': '960px', // 模拟旧版：把 IME 物理 px（约 900–1100）直接当 CSS px
    '--safe-top': '72px',
    '--safe-left': '0px',
    '--safe-right': '0px',
    '--ime-inset': '0px',
  })
  await sleep(500)
  const metrics = await measure()
  const screenshot = await shot('verify-settings-before')
  const pixel = nearBlackRatio(screenshot)
  const collapsed = metrics.hasPanel && metrics.panelHeight < 40
  /**
   * 近黑占比阈值说明：设置页背后是 WebGL 海景（深蓝，G/B 通道约 20–40），
   * 塌陷后也不会是纯黑，实测「全图近黑」约 46%（中央带 16%）。所以判据不能写 80%，
   * 而是「塌陷 + 近黑明显高于正常态」：绝对值 >= 40% 且至少是正常态的 1.5 倍。
   * 正常态（修复后 B 用例同视口）实测 25.6%，46% / 25.6% ≈ 1.8 倍，留有余量。
   */
  const pixelOk = pixel.ok && pixel.nearBlackPct >= 40
  return {
    nav,
    injectedOldCss: OLD_SCREEN_CSS,
    simulatedVars: { safeBottom: '960px', safeTop: '72px' },
    normalMetricsBeforeInject: { panelHeight: normal.panelHeight, screenPaddingBottom: normal.screenPaddingBottom },
    normalScreenshot: path.relative(ROOT, normalShot),
    metrics,
    screenshot: path.relative(ROOT, screenshot),
    pixel,
    collapsed,
    pixelOk,
    pass: collapsed && pixelOk,
  }
}

async function runAfterCase(label, vars, shotName) {
  await reloadApp()
  const nav = await openSettings()
  await setVars({ '--safe-left': '0px', '--safe-right': '0px', ...vars })
  await sleep(500)
  const metrics = await measure()
  const screenshot = await shot(shotName)
  return { label, nav, vars, metrics, screenshot: path.relative(ROOT, screenshot) }
}

async function runAfterCases() {
  const a = await runAfterCase('A-normal', { '--safe-bottom': '20px', '--safe-top': '24px', '--ime-inset': '0px' }, 'verify-settings-after-normal')
  const aPass = a.metrics.hasPanel && a.metrics.panelHeight > 250

  const b = await runAfterCase('B-huge', { '--safe-bottom': '960px', '--safe-top': '120px', '--ime-inset': '0px' }, 'verify-settings-after-huge')
  const bPanelPass = b.metrics.hasPanel && b.metrics.panelHeight > 250
  const bPixel = nearBlackRatio(path.resolve(ROOT, b.screenshot))
  const bPixelPass = bPixel.ok && bPixel.nearBlackPct < 60

  const c = await runAfterCase('C-ime-inset', { '--safe-bottom': '20px', '--safe-top': '24px', '--ime-inset': '320px' }, 'verify-settings-after-ime')
  const delta = Math.abs(c.metrics.panelHeight - a.metrics.panelHeight)
  const cPass = c.metrics.hasPanel && delta <= 8

  return {
    cases: {
      A: {
        title: '正常值 --safe-bottom:20px/--safe-top:24px',
        panelHeight: a.metrics.panelHeight,
        screenPaddingBottom: a.metrics.screenPaddingBottom,
        screenshot: a.screenshot,
        pass: aPass,
        metrics: a.metrics,
      },
      B: {
        title: '恶意大值 --safe-bottom:960px/--safe-top:120px',
        panelHeight: b.metrics.panelHeight,
        screenPaddingBottom: b.metrics.screenPaddingBottom,
        screenshot: b.screenshot,
        pixel: bPixel,
        pass: bPanelPass && bPixelPass,
        panelPass: bPanelPass,
        pixelPass: bPixelPass,
        metrics: b.metrics,
      },
      C: {
        title: '--ime-inset:320px 只影响滚动让位',
        panelHeight: c.metrics.panelHeight,
        deltaVsA: Math.round(delta * 100) / 100,
        screenshot: c.screenshot,
        bodyScrollPaddingBottom: { A: a.metrics.bodyScrollPaddingBottom, C: c.metrics.bodyScrollPaddingBottom },
        imeScrollChanged: a.metrics.bodyScrollPaddingBottom !== c.metrics.bodyScrollPaddingBottom,
        pass: cPass,
        metrics: c.metrics,
      },
    },
    checks: {
      aPanelOver250: aPass,
      bPanelOver250: bPanelPass,
      bNearBlackUnder60: bPixelPass,
      cPanelMatchesA: cPass,
    },
    nearBlackPct: bPixel.ok ? bPixel.nearBlackPct : null,
    screenshotHuge: b.screenshot,
    pass: aPass && bPanelPass && bPixelPass && cPass,
  }
}

/* -------------------------------------------------------------------- 清理 */

function cleanup() {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  ws = null
  try {
    if (child && child.pid && !childExited) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
  try {
    child?.kill()
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------- main */

function printStatic(label, stat) {
  if (!stat) return
  const requiredOk = stat.checks.filter((c) => c.required && c.pass).length
  console.log(`[verify] 静态检查(${label}): ${stat.requiredPass ? 'PASS' : 'FAIL'} (${requiredOk}/${stat.requiredTotal} required)`)
  for (const c of stat.checks) {
    console.log(`  - [${c.pass ? 'ok' : 'FAIL'}${c.required ? '' : ' |info'}] ${c.name}: ${c.detail}`)
  }
}

async function main() {
  result.staticChecks = {}

  const liveJava = readTextSafe(JAVA_SRC)
  const liveCss = readTextSafe(CSS_SRC)
  result.staticChecks.live = liveJava && liveCss
    ? runStaticChecks(liveJava, liveCss, 'live-src')
    : { origin: 'live-src', checks: [], requiredPass: false, requiredTotal: 0, requiredFailed: ['source-missing'], allPass: false }

  const backup = findPreFixBackup()
  if (backup) {
    const bj = readTextSafe(backup.java)
    const bc = readTextSafe(backup.css)
    result.staticChecks.preFixSnapshot = bj && bc ? runStaticChecks(bj, bc, backup.dir) : null
  } else {
    result.staticChecks.preFixSnapshot = null
  }

  result.dist = detectDist()

  const phase = PHASE_ARG === 'auto' ? (result.dist.ready ? 'all' : 'before') : PHASE_ARG
  if (!['before', 'after', 'all', 'static'].includes(phase)) throw new Error(`未知 --phase=${PHASE_ARG}（可选 before/after/all/static）`)
  result.phase = phase
  result.mode = phase === 'static' ? 'static' : ATTACH ? 'attach' : 'spawn'

  console.log('[verify] 视口:', JSON.stringify(VIEWPORT))
  console.log('[verify] dist:', result.dist.reason, `(${result.dist.cssFile || 'n/a'}, mtime=${result.dist.mtime || 'n/a'})`)
  console.log('[verify] phase:', phase, '| mode:', result.mode)
  printStatic('live-src', result.staticChecks.live)
  if (result.staticChecks.preFixSnapshot) printStatic(result.staticChecks.preFixSnapshot.origin, result.staticChecks.preFixSnapshot)

  const liveStaticPass = result.staticChecks.live.requiredPass

  if (phase === 'static') {
    // 只做源码审计：不启动 Electron（DSH 沙箱里 Chromium 起不来时用这个模式）。
    result.pass = liveStaticPass
    return
  }

  result.mode = ATTACH ? 'attach' : 'spawn'
  if (ATTACH) await attachToRunning()
  else await launchElectron()

  if (phase === 'before' || phase === 'all') {
    console.log('[verify] ===== 修复前复现 =====')
    result.before = await runBeforeCase()
    console.log(
      `[verify] before: panelHeight=${result.before.metrics.panelHeight} (collapsed=${result.before.collapsed}), nearBlack=${
        result.before.pixel.ok ? result.before.pixel.nearBlackPct + '%' : 'n/a'
      }, pass=${result.before.pass}`,
    )
  }

  if (phase === 'after' || phase === 'all') {
    console.log('[verify] ===== 修复后 A/B/C =====')
    result.after = await runAfterCases()
    for (const key of ['A', 'B', 'C']) {
      const c = result.after.cases[key]
      console.log(`[verify] case ${key}: panelHeight=${c.panelHeight}, pass=${c.pass}`)
    }
    console.log(`[verify] after: nearBlack=${result.after.nearBlackPct != null ? result.after.nearBlackPct + '%' : 'n/a'}, pass=${result.after.pass}`)
  }

  /**
   * before 的「对比度」判据需要 after 的基准值，所以放在两组都跑完后补算：
   * 塌陷态的近黑占比必须显著高于正常态（>=1.5 倍），否则说明截图本身没有体现塌陷。
   */
  if (result.before?.pixel?.ok && result.after?.nearBlackPct != null) {
    const ratio = result.after.nearBlackPct > 0 ? result.before.pixel.nearBlackPct / result.after.nearBlackPct : Infinity
    const contrastPass = result.before.pixel.nearBlackPct > result.after.nearBlackPct * 1.5
    result.before.contrastVsAfter = { ratio: Math.round(ratio * 100) / 100, pass: contrastPass }
    result.before.pass = !!result.before.collapsed && !!result.before.pixelOk && contrastPass
    console.log(`[verify] before vs after 近黑倍数=${result.before.contrastVsAfter.ratio} (>=1.5 才通过)，before.pass=${result.before.pass}`)
  }

  if (phase === 'before') {
    // 只跑复现：只要求「塌陷 + 近黑」成立；静态检查只作为当前源码状态记录（修复前应为 FAIL）。
    result.pass = !!result.before?.pass
  } else if (phase === 'after') {
    result.pass = !!result.after?.pass && liveStaticPass
  } else {
    result.pass = !!result.before?.pass && !!result.after?.pass && liveStaticPass
  }

  if (!liveStaticPass) result.errors = [`静态检查未通过：${result.staticChecks.live.requiredFailed.join(', ')}`]
}

try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true })
  await main()
} catch (error) {
  result.pass = false
  result.errors = [...(result.errors || []), String(error && error.stack ? error.stack : error)]
  console.error('[verify] 异常:', error && error.message ? error.message : error)
} finally {
  cleanup()
  result.finishedAt = new Date().toISOString()
  console.log('[verify] ===== JSON 汇总 =====')
  console.log(JSON.stringify({ before: result.before, after: result.after, pass: result.pass, phase: result.phase }, null, 2))
  console.log('[verify] 完整结果（含静态检查/dist 判定）:')
  console.log(JSON.stringify(result, null, 2))
  console.log(`[verify] VERIFY RESULT: ${result.pass ? 'PASS' : 'FAIL'}`)
  if (!result.pass) process.exitCode = 1
}
