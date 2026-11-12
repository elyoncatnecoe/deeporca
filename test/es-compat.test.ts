import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

/**
 * 老 Android WebView 兼容性回归测试。
 *
 * 踩过的坑：依赖库（marked / react-dom）用了 ES2022 的 Object.hasOwn 与
 * Array.prototype.at，而构建工具的 target 只降语法不 polyfill 内置方法，
 * 于是老内核上抛 "this.events.at is not a function"，整页白屏。
 */

test("polyfills.ts 覆盖了产物里用到的 ES2022+ 方法", () => {
  const src = readFileSync("src/lib/polyfills.ts", "utf8")
  for (const name of ["at", "hasOwn", "findLast", "findLastIndex", "structuredClone"]) {
    assert.ok(src.includes(name), "polyfills.ts 缺少 " + name)
  }
})

test("main.tsx 里 polyfill 排在业务模块之前", () => {
  const src = readFileSync("src/main.tsx", "utf8")
  const poly = src.indexOf("./lib/polyfills")
  const app = src.indexOf("./App")
  assert.ok(poly >= 0, "main.tsx 没有引入 polyfills")
  assert.ok(poly < app, "polyfills 必须在 App 之前引入")
})

test("业务代码不再直接用 Array.prototype.at", () => {
  // body.ts 曾经用 events.at(-1)，是老内核上最早炸的地方。
  const body = readFileSync("src/lib/body.ts", "utf8")
  const code = body
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n")
  assert.ok(!/\.at\(/.test(code), "body.ts 仍有 .at() 调用，应改成下标访问")
})

test("构建 target 不高于 es2019（覆盖更多老内核）", () => {
  const cfg = readFileSync("vite.config.ts", "utf8")
  assert.ok(/target:\s*["\x27]es2019["\x27]/.test(cfg), "vite target 应为 es2019")
})
