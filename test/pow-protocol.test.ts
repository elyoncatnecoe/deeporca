import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { sha3Digest, deepSeekHashV1, solvePow, powHeader, powPrefix } from "../electron/pow.ts"

/** PoW 与协议层的回归测试。 */

/** 去掉注释行，只留真正会执行的代码——注释里提到旧方案不算数。 */
function codeOnly(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
}

test("SHA3-256 与 node:crypto 逐字节一致（钉住置换/填充/吸收）", () => {
  const cases = ["", "abc", "hello world", "x".repeat(135), "y".repeat(136), "z".repeat(300), "中文测试"]
  for (const input of cases) {
    const mine = sha3Digest(input, 24)
    const ref = createHash("sha3-256").update(input, "utf8").digest("hex")
    assert.equal(mine, ref, "输入长度 " + input.length)
  }
})

test("DeepSeekHashV1 是 23 轮，与标准 SHA3 不同", () => {
  assert.notEqual(deepSeekHashV1("abc"), sha3Digest("abc", 24))
  assert.equal(deepSeekHashV1("abc").length, 64)
})

test("前缀是 salt_expireAt_", () => {
  assert.equal(powPrefix({ salt: "s1", expireAt: 123 }), "s1_123_")
})

test("solvePow 能找到自洽的 nonce", () => {
  const salt = "test"
  const expireAt = 1700000000
  const answer = 3
  const digest = deepSeekHashV1(powPrefix({ salt, expireAt }) + answer)
  const challenge = { algorithm: "DeepSeekHashV1", challenge: digest, salt, difficulty: 100, expireAt, signature: "sig", targetPath: "/api/v0/chat/completion" }
  assert.equal(solvePow(challenge), answer)
})

test("solvePow 在长 salt（尾部 >100 字节）下也不越界", () => {
  // 回归：tail 数组曾按 ceil(tailLength/4) 分配，tailLength 落在 101–135 时
  // 会读取 baseState[25]（undefined），抛 "undefined ^ 0n"。用长度 100 的 salt
  // 让 prefix 长度落在危险区间，验证现在能正常解出。
  const salt = "s".repeat(100)
  const expireAt = 1700000000
  const answer = 2
  const prefix = powPrefix({ salt, expireAt })
  assert.ok((prefix.length % 136) > 100, `前缀长度 ${prefix.length} 未落在回归区间`)
  const digest = deepSeekHashV1(prefix + answer)
  const challenge = { algorithm: "DeepSeekHashV1", challenge: digest, salt, difficulty: 100, expireAt, signature: "sig", targetPath: "/api/v0/chat/completion" }
  assert.equal(solvePow(challenge), answer)
})

test("powHeader 是 base64 的 JSON，字段齐全", () => {
  const challenge = { algorithm: "DeepSeekHashV1", challenge: "a".repeat(64), salt: "s", difficulty: 1, expireAt: 1, signature: "sig", targetPath: "/api/v0/chat/completion" }
  const decoded = JSON.parse(Buffer.from(powHeader(challenge, 7, "/api/v0/chat/completion"), "base64").toString("utf8"))
  assert.equal(decoded.answer, 7)
  assert.equal(decoded.algorithm, "DeepSeekHashV1")
  assert.equal(decoded.target_path, "/api/v0/chat/completion")
})

test("PoW 是纯 JS，不再下载 wasm", () => {
  const api = codeOnly("electron/deepseek-api.ts")
  assert.ok(!api.includes("sha3_wasm_bg.wasm"), "仍在下载 wasm")
  assert.ok(!api.includes("wasm_solve"), "仍在调 wasm_solve")
  assert.ok(api.includes("solvePow"), "没有用本地 PoW")
})

test("SSE 解析区分 status 帧、close 事件与思考", () => {
  const sse = readFileSync("electron/sse.ts", "utf8")
  // 状态帧走 response/status 路径，不能当正文。
  assert.ok(sse.includes("response\\/status"), "没处理 status 路径")
  // close 事件结束一轮（引号形式不固定，只认词）。
  assert.ok(/close/.test(sse), "没处理 close 事件")
  assert.ok(sse.includes("THINKING"), "没区分思考 fragment")
})

test("请求体不带 model_type，且处理 INCOMPLETE 续写", () => {
  const api = codeOnly("electron/deepseek-api.ts")
  assert.ok(!api.includes("model_type"), "请求体不应带 model_type")
  assert.ok(api.includes("INCOMPLETE"), "没处理 INCOMPLETE")
  assert.ok(api.includes("/api/v0/chat/continue"), "没有 continue 续写")
  assert.ok(api.includes("x-client-timezone-offset"), "缺时区头")
})
