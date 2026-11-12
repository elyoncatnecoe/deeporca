/**
 * PoW 解算的 worker 线程。
 *
 * 为什么必须单独开线程：解一道 DeepSeekHashV1 挑战要在难度范围内（通常 14 万次）
 * 逐个算 SHA3 置换，实测约 5 秒。放在主进程里跑会把事件循环整个堵死——那 5 秒内
 * 窗口不响应、IPC 不处理、动画全停，用户感觉就是「发一条消息整个 App 卡住」。
 *
 * 这里只做一件事：收挑战 → 解 → 回答案。
 */

import { parentPort } from 'node:worker_threads'
import { solvePow, type PowChallenge } from './pow'

interface RequestMessage {
  id: number
  challenge: PowChallenge
}

parentPort?.on('message', (message: RequestMessage) => {
  try {
    const answer = solvePow(message.challenge)
    parentPort?.postMessage({ id: message.id, ok: true, answer })
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})