import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 产物扫描：找出老 Android WebView 不支持的 ES2022+ 内置方法，
 * 并确认 src/lib/polyfills.ts 的补丁真的进了产物。
 *
 * 背景：构建工具的 target 只降**语法**，不 polyfill **内置方法**。
 * Array.prototype.at / Object.hasOwn 这类在旧内核上会抛
 * "xxx is not a function"，而且构建期完全不报错——我们就是这样白屏过一次。
 *
 * 匹配用「调用特征」而不是完整源码串：压缩器会改写引号和空白，
 * 按原样字符串匹配必然误报。
 */

const DIST = 'dist/assets'

/**
 * used:    产物里是否有人**调用**这个 API
 * patched: 产物里是否有**补丁**（给原型挂方法）
 */
const WATCHED = [
  {
    name: 'Array.prototype.at',
    // 数字、标识符、带正负号的都要认：`arr.at(0)`、`arr.at(-1)`、`arr.at(i)` 都是调用。
    // 之前只认字面量数字，`arr.at(i)` 会被漏检——正是「构建通过但老内核白屏」的口子。
    used: /\.at\(\s*[-+]?[\w$]/,
    patched: /\.at\s*[!=]==?\s*"function"|"at"\)|\.at\s*[!=]==?\s*typeof/,
  },
  {
    name: 'Object.hasOwn',
    used: /Object\.hasOwn\s*\(/,
    patched: /hasOwn\s*[!=]==?\s*"function"/,
  },
  {
    name: 'Array.prototype.findLast',
    used: /\.findLast\s*\(/,
    patched: /findLast\s*[!=]==?\s*"function"/,
  },
  {
    name: 'structuredClone',
    used: /\bstructuredClone\s*\(/,
    patched: /structuredClone\s*[!=]==?\s*"function"|structuredClone\s*=/,
  },
]

let files
try {
  files = readdirSync(DIST).filter((f) => f.endsWith('.js'))
} catch {
  console.error('找不到 ' + DIST + '，先跑 build')
  process.exit(1)
}

const all = files.map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n')

let missing = 0
for (const rule of WATCHED) {
  const used = rule.used.test(all)
  const patched = rule.patched.test(all)
  if (!used) continue
  if (patched) {
    console.log(`[已覆盖] ${rule.name}`)
  } else {
    console.error(`[缺 polyfill] ${rule.name} —— 产物在调用它，但没找到补丁`)
    missing += 1
  }
}

if (missing > 0) {
  console.error(`\n有 ${missing} 个 API 缺 polyfill：老 WebView 会抛 "is not a function" 并白屏。`)
  console.error('请在 src/lib/polyfills.ts 里补上对应实现。')
  process.exit(1)
}
console.log('ES 兼容检查通过')