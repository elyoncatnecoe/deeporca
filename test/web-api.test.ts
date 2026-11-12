import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

/** 回归测试：网页账号 HTTP 路线上踩过的坑。 */

const API = readFileSync("electron/deepseek-api.ts", "utf8")
const DS = readFileSync("src/lib/deepseek.ts", "utf8")
const MAIN = readFileSync("electron/main.ts", "utf8")
/** 登录 / 采集的 IPC handler 已抽到独立模块（便于做真实注册的集成测试）。 */
const LOGIN_IPC = readFileSync("electron/web-login-ipc.ts", "utf8")

test("Cookie 交给 session + credentials，不手工拼 header", () => {
  assert.ok(API.includes("credentials: " + String.fromCharCode(39) + "include" + String.fromCharCode(39)), "缺少 credentials include")
  assert.ok(!API.includes("cookie: await cookieHeader()"), "仍在手工拼 cookie 头")
})

test("人设只在首轮或它真的变了之后拼进 prompt", () => {
  // 判据从「是不是首轮」换成「和上次拼进去的是不是同一段文字」：
  // 只认首轮的话，用户中途改人设永远到不了网页线程；只认变化而没有稳定块
  // 的话，又会变成每条消息都重拼（见 test/web-persona.test.ts）。
  assert.ok(API.includes("needPersona"), "缺少 needPersona 判据")
  assert.ok(API.includes("persona !== thread.persona"), "没有和上次拼进去的人设比较")
  assert.ok(API.includes("thread.persona = persona"), "没有记住这次拼进去的人设")
  assert.ok(API.includes("systemPrompt"), "缺少 systemPrompt 入参")
})

test("渲染层只把稳定块交给网页账号，不再从 system 里刨", () => {
  assert.ok(DS.includes("systemPrompt: options.webContext"), "没把稳定块传下去")
  assert.ok(!DS.includes("webChatSystemText"), "仍在从整段 system 里取人设")
})

test("登录要等 token 出现并验证，不能开窗即采集", () => {
  assert.ok(MAIN.includes("LOGIN_TIMEOUT_MS"), "缺少登录超时")
  assert.ok(MAIN.includes("verifySession"), "登录后没有验证")
  assert.ok(LOGIN_IPC.includes("webapi:login"), "缺少 login IPC")
  // handler 挪到独立模块后，这两条语义必须仍然成立：
  assert.ok(LOGIN_IPC.includes("while ("), "登录应轮询等待，而不是开窗即采集")
  assert.ok(
    LOGIN_IPC.indexOf("deps.capture(win)") < LOGIN_IPC.indexOf("deps.verify()"),
    "必须先采集到 token 再验证",
  )
})

test("HTTP 模式只发最后一条用户消息，不重放历史", () => {
  assert.ok(DS.includes("lastUser"), "没取最后一条用户消息")
  assert.ok(!DS.includes("帮我接着回最后一条"), "仍在重放历史")
})
