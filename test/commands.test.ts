import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACT_LABELS,
  MAX_COMMAND_LENGTH,
  parseCommand,
  resetCommandState,
} from '../src/lib/commands.ts'

test('短口令能命中对应动作', () => {
  resetCommandState()
  const cases: Array<[string, string]> = [
    ['转个圈', 'spin'],
    ['转一圈', 'spin'],
    ['下潜', 'dive'],
    ['浮上来', 'surface'],
    ['蹭蹭', 'nuzzle'],
    ['吐泡泡', 'blow'],
    ['睡觉', 'sleep'],
    ['醒醒', 'wake'],
    ['甩水', 'shake'],
    ['过来', 'approach'],
    ['安静', 'calm'],
    ['陪我玩', 'play'],
  ]
  for (const [text, act] of cases) {
    const hit = parseCommand(text)
    assert.ok(hit !== null, `${text} 应该命中`)
    assert.equal(hit.act, act, `${text} 应该映射到 ${act}`)
    assert.ok(hit.reply.length > 0, `${text} 应该带一句预制回应`)
  }
})

test('英文别名也能命中', () => {
  resetCommandState()
  assert.equal(parseCommand('spin')?.act, 'spin')
  assert.equal(parseCommand('dive')?.act, 'dive')
  assert.equal(parseCommand('nuzzle')?.act, 'nuzzle')
})

test('否定词后面不触发动作', () => {
  resetCommandState()
  assert.equal(parseCommand('别转圈'), null)
  assert.equal(parseCommand('不要下潜'), null)
  assert.equal(parseCommand('不用甩水'), null)
})

test('长句当成聊天，不当指令', () => {
  resetCommandState()
  const long = '我在想为什么这个转圈的动画看起来有点卡顿，能不能帮我看看渲染循环哪里有问题'
  assert.ok(long.length > MAX_COMMAND_LENGTH)
  assert.equal(parseCommand(long), null)
  assert.equal(parseCommand(''), null)
  assert.equal(parseCommand('   '), null)
})

test('闲聊里不带动作词就不命中', () => {
  resetCommandState()
  assert.equal(parseCommand('今天天气不错'), null)
  assert.equal(parseCommand('帮我写个函数'), null)
  assert.equal(parseCommand('你好'), null)
})

test('标点和空白不影响命中', () => {
  resetCommandState()
  assert.equal(parseCommand('转个圈！')?.act, 'spin')
  // 用户手抖打了空格，去掉空白后还是同一句话，应当照样认出。
  assert.equal(parseCommand(' 转 个 圈 ')?.act, 'spin')
  assert.equal(parseCommand('转圈。')?.act, 'spin')
})

test('连续两次不会给出一模一样的台词', () => {
  resetCommandState()
  const first = parseCommand('转个圈')?.reply
  const second = parseCommand('转个圈')?.reply
  assert.ok(first !== undefined && second !== undefined)
  assert.notEqual(first, second)
})

test('每个动作都有中文名和 mood', () => {
  for (const act of Object.keys(ACT_LABELS) as Array<keyof typeof ACT_LABELS>) {
    assert.ok(ACT_LABELS[act].length > 0, `${act} 缺中文名`)
  }
})
test('本地指令不依赖任何网络/API 状态', () => {
  // 这条是这次改动的核心保证：parseCommand 是纯函数，没有 API key 的概念，
  // 也不 import 任何请求模块。命中即返回动作，调用方无需联网。
  resetCommandState()
  const hit = parseCommand('吐泡泡')
  assert.ok(hit !== null)
  assert.equal(hit.act, 'blow')
  assert.equal(typeof hit.reply, 'string')
})
