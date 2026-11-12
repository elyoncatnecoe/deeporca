import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * T-14：媒体先写库、消息后写库，中间失败必须回滚。
 *
 * 事故形态：putMedia 写了几条、appendMessage 抛错 → media 表里留下 messageId
 * 指向不存在消息的记录。界面上永远看不见它们，字节却永久占着 IndexedDB 配额，
 * 用户只会觉得「空间莫名其妙就满了」。
 *
 * 为什么用源码断言而不是跑一遍：engine 依赖 IndexedDB 与 Capacitor，node 里跑不起来，
 * 而这条不变量（写媒体的失败路径上有回滚、消息落库失败时也回滚）恰好能在源码结构上说清。
 * 与 sending-state.test.ts / agent-loop.test.ts 同一套做法。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

/** 去掉注释，避免注释里解释规矩的字眼被当成代码（CRLF 检出也能正确切行）。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

const engine = stripComments(read('src/lib/engine.ts'))

test('T-14：写媒体的 catch 里必须回滚这一批（deleteMediaByMessage）', () => {
  const start = engine.indexOf('await putMedia(record)')
  assert.ok(start > 0, 'engine 里找不到 putMedia —— 结构变了，这条断言要跟着改')

  const messageStart = engine.indexOf('const message: ChatMessage = {', start)
  assert.ok(messageStart > start, '写媒体和拼消息的顺序变了')

  const block = engine.slice(start, messageStart)
  assert.ok(block.includes('} catch (error)'), 'putMedia 的循环没有 catch，失败会直接抛出去')
  assert.ok(
    block.includes('deleteMediaByMessage(messageId)'),
    'putMedia 失败后没有回滚 —— 已写入的媒体会变成孤儿',
  )
  assert.ok(block.includes('media.length = 0'), '回滚后没有把 media 清空，消息里仍会引用已删掉的记录')
})

test('T-14：消息最终没落库时，已经写进去的媒体也要收掉', () => {
  const messageStart = engine.indexOf('const message: ChatMessage = {')
  const returnAt = engine.indexOf('return { message, changed', messageStart)
  assert.ok(messageStart > 0 && returnAt > messageStart, 'runTool 的收尾结构变了')

  const block = engine.slice(messageStart, returnAt)
  assert.ok(block.includes('appendMessage(message)'), '找不到消息落库')
  assert.ok(
    block.includes('deleteMediaByMessage(messageId)'),
    'appendMessage 失败时没有回滚媒体 —— 这正是 T-14 的孤儿来源',
  )
})

test('T-14：回滚不能顺手把 T-05 的「停止时不写媒体」改掉', () => {
  assert.ok(
    engine.includes('mediaDrafts.length > 0 && !signal.aborted'),
    '被停止时仍然会写媒体，T-05 的语义被破坏了',
  )
})

test('T-14：deleteMediaByMessage 真的从 db 引入，不是自己造一个空实现', () => {
  const line = engine.split('\n').find((item) => item.includes('from \'./db\''))
  assert.ok(line !== undefined, 'engine 没有从 db 引入任何东西')
  assert.ok(line.includes('deleteMediaByMessage'), '没有引入 deleteMediaByMessage')
})
