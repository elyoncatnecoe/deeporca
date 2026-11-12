/**
 * DeepSeekHashV1 —— chat.deepseek.com 发消息前要求的工作量证明。
 *
 * 算法：SHA3-256 的 sponge（rate 136、domain 0x06、32 字节摘要），但置换只跑
 * 23 轮（FIPS 202 的 KECCAK-p[1600,24] 跳过第 0 轮）。
 *
 * 关键认识：这**纯 JS 就能算**，不需要下载厂商的 wasm。
 * 之前那版去 fe-static.deepseek.com 下载 sha3_wasm_bg.wasm 再调 wasm_solve，
 * 既依赖那个 CDN 域名（常被网络/代理掐断），又要对上 wasm-bindgen 的 ABI，
 * 两个环节都脆——这正是「发不出去」的根因之一。
 *
 * 实现参考 volcanicll/magpie-deepseek-web-auth 的 src/pow.mjs（MIT），
 * 其摘要已与厂商 wasm 逐字节对齐、并与 node:crypto 的 SHA3-256 交叉验证。
 */

const LANE_MASK = (1n << 64n) - 1n
const RATE = 136
const OUT = 32

/** 按 x + 5*y 索引，与 FIPS 202 的状态坐标一致。 */
const ROTATION_OFFSETS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

/** DeepSeekHashV1 用 23 轮；标准 SHA3-256 用 24 轮。 */
const DEEPSEEK_HASH_ROUNDS = 23
const SHA3_DOMAIN_SUFFIX = 0x06
const HEX = '0123456789abcdef'

/** 难度上限：厂商通常给 144000，设个界防止恶意挑战把机器钉死。 */
export const MAX_DIFFICULTY = 5_000_000

function rotateLeft(value: bigint, amount: number): bigint {
  if (amount === 0) return value
  const shift = BigInt(amount)
  return ((value << shift) | (value >> (64n - shift))) & LANE_MASK
}

/** KECCAK-p[1600,24] 的后 rounds 轮；DeepSeekHashV1 跳过第 0 轮。 */
function permute(state: bigint[], rounds: number): void {
  const columnParity = new Array<bigint>(5)
  const thetaMix = new Array<bigint>(5)
  const rhoPi = new Array<bigint>(25)
  for (let round = ROUND_CONSTANTS.length - rounds; round < ROUND_CONSTANTS.length; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      columnParity[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!
    }
    for (let x = 0; x < 5; x += 1) {
      thetaMix[x] = columnParity[(x + 4) % 5]! ^ rotateLeft(columnParity[(x + 1) % 5]!, 1)
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) state[x + 5 * y] = state[x + 5 * y]! ^ thetaMix[x]!
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const destinationX = y
        const destinationY = (2 * x + 3 * y) % 5
        const lane = x + 5 * y
        rhoPi[destinationX + 5 * destinationY] = rotateLeft(state[lane]!, ROTATION_OFFSETS[lane]!)
      }
    }
    for (let y = 0; y < 5; y += 1) {
      const row = 5 * y
      for (let x = 0; x < 5; x += 1) {
        state[x + row] = rhoPi[x + row]! ^ (~rhoPi[((x + 1) % 5) + row]! & LANE_MASK & rhoPi[((x + 2) % 5) + row]!)
      }
    }
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!
  }
}

/** 吸收一个完整 rate 块。 */
function absorb(state: bigint[], bytes: Uint8Array, offset: number, rounds: number): void {
  for (let index = 0; index < RATE; index += 1) {
    const lane = index >>> 3
    state[lane] = state[lane]! ^ (BigInt(bytes[offset + index]!) << BigInt((index & 7) * 8))
  }
  permute(state, rounds)
}

/** SHA3-256 的 sponge，轮数可选：24 是标准 SHA3-256，23 是 DeepSeekHashV1。 */
export function sha3Digest(input: string, rounds: number): string {
  const bytes = new TextEncoder().encode(input)
  const state = new Array<bigint>(25).fill(0n)
  let offset = 0
  while (offset + RATE <= bytes.length) {
    absorb(state, bytes, offset, rounds)
    offset += RATE
  }
  const remaining = bytes.length - offset
  for (let index = 0; index < remaining; index += 1) {
    state[index >>> 3] = state[index >>> 3]! ^ (BigInt(bytes[offset + index]!) << BigInt((index & 7) * 8))
  }
  state[remaining >>> 3] = state[remaining >>> 3]! ^ (BigInt(SHA3_DOMAIN_SUFFIX) << BigInt((remaining & 7) * 8))
  state[(RATE - 1) >>> 3] = state[(RATE - 1) >>> 3]! ^ (0x80n << 56n)
  permute(state, rounds)
  let digest = ''
  for (let index = 0; index < OUT; index += 1) {
    const byte = Number((state[index >>> 3]! >> BigInt((index & 7) * 8)) & 0xffn)
    digest += HEX[byte >>> 4]
    digest += HEX[byte & 0x0f]
  }
  return digest
}

export function deepSeekHashV1(input: string): string {
  return sha3Digest(input, DEEPSEEK_HASH_ROUNDS)
}

/** 挑战比对的前缀：salt、expire_at，然后接 nonce。 */
export function powPrefix(challenge: { salt: string; expireAt: number }): string {
  return `${challenge.salt}_${challenge.expireAt}_`
}

export interface PowChallenge {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expireAt: number
  signature: string
  targetPath: string
}

const DIGEST_HEX = /^[a-f0-9]{64}$/i

function checkChallenge(challenge: PowChallenge): string {
  if (challenge.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`PoW 算法是 ${challenge.algorithm}，不是 DeepSeekHashV1`)
  }
  if (!DIGEST_HEX.test(challenge.challenge)) {
    throw new Error('PoW 挑战不是 64 位十六进制摘要')
  }
  if (challenge.salt === '') throw new Error('PoW 挑战没有 salt')
  if (!Number.isSafeInteger(challenge.difficulty) || challenge.difficulty < 1) {
    throw new Error('PoW 难度不合法')
  }
  if (challenge.difficulty > MAX_DIFFICULTY) {
    throw new Error(`PoW 难度 ${challenge.difficulty} 超过上限 ${MAX_DIFFICULTY}`)
  }
  if (!Number.isSafeInteger(challenge.expireAt)) throw new Error('PoW 挑战没有 expire_at')
  return powPrefix(challenge)
}

/**
 * 解一道挑战：在 [0, difficulty) 里找摘要等于 challenge 的 nonce。
 *
 * 同步、有界。每个候选只把 nonce 的字节折进已吸收好的前缀状态里，
 * 不为每个候选重新分配——和厂商自己的解算器一样。
 */
export function solvePow(
  challenge: PowChallenge,
  options: { onProgress?: (tried: number) => void; tick?: number } = {},
): number {
  const prefix = checkChallenge(challenge)
  const prefixBytes = new TextEncoder().encode(prefix)
  const baseState = new Array<bigint>(25).fill(0n)
  let offset = 0
  while (offset + RATE <= prefixBytes.length) {
    absorb(baseState, prefixBytes, offset, DEEPSEEK_HASH_ROUNDS)
    offset += RATE
  }
  const tailLength = prefixBytes.length - offset
  // 状态是 25 个 64 位 lane，每个 lane 装 8 字节，所以尾部需要的 lane 数是
  // ceil(tailLength / 8)，不是 /4。写成 /4 会在 tailLength 落在 101–135 时
  // 分配出 26–34 个 lane，后面的「把 tail 异或进 state」循环就会读到
  // baseState[25]（undefined），触发「undefined ^ 0n」的 TypeError，PoW 直接失败。
  const tail = new Array<bigint>(Math.ceil(tailLength / 8)).fill(0n)
  for (let index = 0; index < tailLength; index += 1) {
    tail[index >>> 3] = tail[index >>> 3]! ^ (BigInt(prefixBytes[offset + index]!) << BigInt((index & 7) * 8))
  }
  const wanted = challenge.challenge.toLowerCase()
  const target = new Array<bigint>(OUT >>> 3).fill(0n)
  for (let index = 0; index < OUT; index += 1) {
    const byte = BigInt(`0x${wanted.slice(index * 2, index * 2 + 2)}`)
    target[index >>> 3] = target[index >>> 3]! | (byte << BigInt((index & 7) * 8))
  }
  const state = new Array<bigint>(25).fill(0n)
  const { difficulty } = challenge
  const tick = options.tick ?? 8192
  for (let nonce = 0; nonce < difficulty; nonce += 1) {
    state.length = 0
    for (let lane = 0; lane < 25; lane += 1) state[lane] = baseState[lane]!
    for (let lane = 0; lane < tail.length; lane += 1) state[lane] = state[lane]! ^ tail[lane]!
    let position = tailLength
    const text = String(nonce)
    for (let index = 0; index < text.length; index += 1) {
      state[position >>> 3] = state[position >>> 3]! ^ (BigInt(text.charCodeAt(index)) << BigInt((position & 7) * 8))
      position += 1
      if (position === RATE) {
        permute(state, DEEPSEEK_HASH_ROUNDS)
        position = 0
      }
    }
    state[position >>> 3] = state[position >>> 3]! ^ (BigInt(SHA3_DOMAIN_SUFFIX) << BigInt((position & 7) * 8))
    state[(RATE - 1) >>> 3] = state[(RATE - 1) >>> 3]! ^ (0x80n << 56n)
    permute(state, DEEPSEEK_HASH_ROUNDS)
    let matched = true
    for (let lane = 0; lane < target.length; lane += 1) {
      if (state[lane] !== target[lane]) {
        matched = false
        break
      }
    }
    if (matched) return nonce
    if (options.onProgress !== undefined && nonce % tick === tick - 1) options.onProgress(nonce + 1)
  }
  throw new Error(`PoW 在 ${difficulty} 次内没解出来`)
}

/** 拼成 x-ds-pow-response 头（base64 的 JSON）。 */
export function powHeader(challenge: PowChallenge, answer: number, targetPath?: string): string {
  const body = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath ?? challenge.targetPath,
  }
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
}