import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MEMORY_FOOTER,
  MEMORY_HEADER,
  SIMILAR_THRESHOLD,
  admitMemory,
  containment,
  inferMemoryType,
  jaccard,
  looksLikeRepeat,
  memoryPromptBlock,
  memoryReadEnabled,
  memoryTier,
  memoryVisibleTo,
  normalizeCandidate,
  planUpsert,
  sanitizeExtras,
  selectForPrompt,
  tokenize,
} from '../src/lib/memory-core.ts'
import { estimateTokens, formatTokens } from '../src/lib/tokens.ts'
import type { Assistant, MemoryEntry, Settings } from '../src/lib/types.ts'

function memory(patch: Partial<MemoryEntry> & { text: string }): MemoryEntry {
  return {
    id: patch.id ?? 'm',
    text: patch.text,
    type: patch.type ?? 'profile',
    tags: patch.tags ?? [],
    importance: patch.importance ?? 1,
    scope: patch.scope ?? 'global',
    characterId: patch.characterId,
    pending: patch.pending,
    history: patch.history,
    createdAt: patch.createdAt ?? 1_700_000_000_000,
    updatedAt: patch.updatedAt ?? 1_700_000_000_000,
    pinned: patch.pinned ?? false,
  }
}

test('准入：稳定事实放过，寒暄/一次性任务/凭证挡掉', () => {
  assert.equal(admitMemory('用户叫小林，是一名前端工程师').ok, true)
  assert.equal(admitMemory('你好！').reason, 'greeting')
  assert.equal(admitMemory('嗯').reason, 'length')
  assert.equal(admitMemory('帮我查一下明天的天气').reason, 'transient')
  assert.equal(admitMemory('我的密码是 abc12345').reason, 'sensitive')
  assert.equal(admitMemory('token: sk-abcd1234efgh').reason, 'sensitive')
})

test('类型推断兜底：身份/偏好/项目能分开', () => {
  assert.equal(inferMemoryType('我叫小林'), 'profile')
  assert.equal(inferMemoryType('我更喜欢喝美式'), 'preference')
  assert.equal(inferMemoryType('我在做 DeepSea 这个项目'), 'project')
})

test('分层：身份偏好常驻，项目按需，情景不注入，置顶可提级', () => {
  assert.equal(memoryTier('profile'), 0)
  assert.equal(memoryTier('preference'), 0)
  assert.equal(memoryTier('project'), 1)
  assert.equal(memoryTier('relationship'), 2)
  assert.equal(memoryTier('other'), 2)
  assert.equal(memoryTier('relationship', true), 0)
})

test('读闸门：助手总开关关掉就全停，全局关掉也全停，助手没表态跟随全局', () => {
  const on = { memoryEnabled: true, assistantsEnabled: true } as Settings
  const off = { memoryEnabled: false, assistantsEnabled: true } as Settings
  // 助手总开关关掉：整个记忆系统不参与（纯净对话）。
  const assistantOff = { memoryEnabled: true, assistantsEnabled: false } as Settings
  assert.equal(memoryReadEnabled(on, undefined), true)
  assert.equal(memoryReadEnabled(off, undefined), false)
  assert.equal(memoryReadEnabled(assistantOff, undefined), false)
  assert.equal(memoryReadEnabled(assistantOff, { memoryEnabled: true } as Assistant), false)
  assert.equal(memoryReadEnabled(on, { memoryEnabled: null } as Assistant), true)
  assert.equal(memoryReadEnabled(on, { memoryEnabled: false } as Assistant), false)
  assert.equal(memoryReadEnabled(on, { memoryEnabled: true } as Assistant), true)
  // 助手说读也救不回全局关掉的情况。
  assert.equal(memoryReadEnabled(off, { memoryEnabled: true } as Assistant), false)
})

test('可见范围：全局共享，私聊只归主人，待确认一概不注入', () => {
  const shared = memory({ text: '全局', scope: 'global' })
  const mine = memory({ text: '私聊 a1', scope: 'character', characterId: 'a1' })
  const other = memory({ text: '私聊 a2', scope: 'character', characterId: 'a2' })
  const pending = memory({ text: '待确认', scope: 'global', pending: true })
  assert.equal(memoryVisibleTo(shared, 'a1'), true)
  assert.equal(memoryVisibleTo(mine, 'a1'), true)
  assert.equal(memoryVisibleTo(mine, 'a2'), false)
  assert.equal(memoryVisibleTo(other, 'a1'), false)
  assert.equal(memoryVisibleTo(pending, 'a1'), false)
})

test('冲突处理：完全一样跳过，能覆盖的算更新，半像不像的只登记待确认', () => {
  const existing = [memory({ id: 'old', text: '用户叫小林' })]
  assert.deepEqual(planUpsert({ text: '用户叫小林', type: 'profile', scope: 'global' }, existing), {
    action: 'skip',
    targetId: 'old',
  })
  // 补细节 = 同一条的新版本。
  assert.deepEqual(planUpsert({ text: '用户叫小林，是一名前端工程师', type: 'profile', scope: 'global' }, existing), {
    action: 'update',
    targetId: 'old',
    similarity: 1,
  })
  // 换了内容但话题撞车 = 冲突，绝不覆盖。
  assert.deepEqual(
    planUpsert({ text: '用户住在上海', type: 'profile', scope: 'global' }, [memory({ id: 'addr', text: '用户住在北京' })]),
    { action: 'pending' },
  )
  // 无关的另起一条。
  assert.deepEqual(
    planUpsert({ text: '用户养了一只猫', type: 'profile', scope: 'global' }, [memory({ id: 'kid', text: '用户有一个三岁的女儿' })]),
    { action: 'add' },
  )
})

test('冲突只在同一 scope+type 里判定，不跨桶误伤', () => {
  const existing = [memory({ id: 'p', text: '用户住在北京', type: 'profile' })]
  assert.deepEqual(planUpsert({ text: '用户住在上海', type: 'preference', scope: 'global' }, existing), { action: 'add' })
  const scoped = [memory({ id: 'c', text: '用户住在北京', type: 'profile', scope: 'character', characterId: 'a1' })]
  assert.deepEqual(planUpsert({ text: '用户住在上海', type: 'profile', scope: 'global' }, scoped), { action: 'add' })
})

test('重复检测：同一件事换个说法能认出来，无关的话不认', () => {
  assert.equal(looksLikeRepeat('我在写 DeepSea 的记忆系统', ['DeepSea 的记忆系统今天又改了一版']), true)
  assert.equal(looksLikeRepeat('我今天加班到十点', ['明天天气怎么样']), false)
})

test('候选收口：文本去掉多余空白，scope/characterId 补齐', () => {
  assert.deepEqual(normalizeCandidate({ text: '  用户叫小林  了 ', type: 'profile' }, { scope: 'global' }), {
    text: '用户叫小林 了',
    type: 'profile',
    scope: 'global',
    characterId: undefined,
  })
  assert.deepEqual(
    normalizeCandidate({ text: '用户叫小林', type: '不认识' }, { scope: 'character', characterId: 'a1' }),
    { text: '用户叫小林', type: 'other', scope: 'character', characterId: 'a1' },
  )
  // 说私聊却没给归属：归属留空，落库时会被丢掉，而不是偷偷塞进全局。
  const orphan = normalizeCandidate({ text: 'x', scope: 'character' }, { scope: 'global' })
  assert.equal(orphan.scope, 'character')
  assert.equal(orphan.characterId, undefined)
})

test('附加字段收口：tags 去脏、importance 夹到 0-5', () => {
  assert.deepEqual(sanitizeExtras({ text: 'x', tags: ['a', 3, 'b'], importance: 9 }), { tags: ['a', 'b'], importance: 5 })
  assert.deepEqual(sanitizeExtras({ text: 'x' }), { tags: [], importance: 1 })
})

test('注入集合：常驻 + 本项目 + 当前助手私聊；情景、待确认、别人的私聊都不进', () => {
  const memories = [
    memory({ id: 'id', text: '用户叫小林，是一名前端工程师', importance: 3 }),
    memory({ id: 'pref', text: '用户喜欢简洁的中文回答', type: 'preference', importance: 2 }),
    memory({ id: 'proj', text: 'DeepSea 正在重做记忆系统', type: 'project' }),
    memory({ id: 'mine', text: '该助手称呼用户为船长', type: 'preference', scope: 'character', characterId: 'a1' }),
    memory({ id: 'other', text: '别的助手才知道的事', type: 'preference', scope: 'character', characterId: 'a2' }),
    memory({ id: 'mood', text: '用户最近心情一般', type: 'relationship' }),
    memory({ id: 'wait', text: '用户住在火星', pending: true }),
    memory({ id: 'unrelated', text: '用户维护着一个 Go 服务', type: 'project' }),
  ]
  const selection = selectForPrompt({ memories, characterId: 'a1', budget: 800, hint: 'DeepSea 记忆系统' })
  const ids = selection.active.map((item) => item.id).sort()
  assert.deepEqual(ids, ['id', 'mine', 'pref', 'proj'])
  assert.equal(selection.hidden, 0)

  // 反过来切到助手 B：B 看不到 A 的私聊，但共享的常驻记忆照旧。
  const other = selectForPrompt({ memories, characterId: 'a2', budget: 800, hint: 'DeepSea 记忆系统' })
  const otherIds = other.active.map((item) => item.id).sort()
  assert.deepEqual(otherIds, ['id', 'other', 'pref', 'proj'])
})

test('注入集合：没有相关线索时，项目记忆不跟着走', () => {
  const memories = [
    memory({ id: 'id', text: '用户叫小林，是一名前端工程师' }),
    memory({ id: 'proj', text: 'DeepSea 正在重做记忆系统', type: 'project' }),
  ]
  assert.deepEqual(selectForPrompt({ memories, characterId: 'a1', budget: 800 }).active.map((item) => item.id), ['id'])
  assert.deepEqual(
    selectForPrompt({ memories, characterId: 'a1', budget: 800, hint: '完全无关的天气话题' }).active.map((item) => item.id),
    ['id'],
  )
})

test('预算：超了按重要度截断并报出「未启用 N 条」', () => {
  const memories = [
    memory({ id: 'a', text: '用户叫小林，是一名前端工程师', importance: 5 }),
    memory({ id: 'b', text: '用户喜欢简洁的中文回答', importance: 3 }),
    memory({ id: 'c', text: '用户的生日是三月三日', importance: 1 }),
  ]
  const total = memories.reduce((sum, item) => sum + estimateTokens(item.text), 0)
  const selection = selectForPrompt({ memories, characterId: 'a1', budget: total - 1 })
  assert.ok(selection.usedTokens <= total - 1)
  assert.equal(selection.active.length + selection.hidden, memories.length)
  assert.ok(selection.hidden >= 1)
  // 重要度高的先留下。
  assert.equal(selection.active[0]?.id, 'a')
})

test('预算：置顶的排在最前面，挤掉别人也要带上', () => {
  const memories = [
    memory({ id: 'a', text: '用户叫小林，是一名前端工程师', importance: 5 }),
    memory({ id: 'b', text: '用户喜欢简洁的中文回答', importance: 1, pinned: true }),
  ]
  const selection = selectForPrompt({ memories, characterId: 'a1', budget: 800 })
  assert.deepEqual(selection.active.map((item) => item.id), ['b', 'a'])
})

test('预算为 0 时一条都不带，但把漏掉的条数如实报出来', () => {
  const memories = [memory({ id: 'a', text: '用户叫小林', importance: 5 })]
  const selection = selectForPrompt({ memories, characterId: 'a1', budget: 0 })
  assert.deepEqual(selection.active, [])
  assert.equal(selection.hidden, 1)
})

test('注入块：不给编号、不报类型，只留「默认知道」的口气', () => {
  const block = memoryPromptBlock([
    memory({ text: '用户叫小林，是一名前端工程师' }),
    memory({ text: '用户喜欢简洁的中文回答', type: 'preference' }),
  ])
  assert.ok(block.startsWith(MEMORY_HEADER))
  assert.ok(block.endsWith(MEMORY_FOOTER))
  assert.equal(block.split('\n').filter((line) => line.startsWith('- ')).length, 2)
  assert.doesNotMatch(block, /\[记忆/)
  assert.doesNotMatch(block, /\[(profile|preference|project|relationship|other)\]/)
  assert.doesNotMatch(block, /关于你|偏好|项目|相处/)
  assert.equal(memoryPromptBlock([]), '')
})

test('token 估算：中文比英文贵，格式化不丢可读性', () => {
  assert.ok(estimateTokens('中文五个字') > estimateTokens('abcde'))
  assert.equal(estimateTokens(''), 0)
  assert.equal(formatTokens(800), '800')
  assert.equal(formatTokens(1500), '1.5k')
  assert.equal(formatTokens(12000), '12k')
})

test('相似度工具：包含度认细化，Jaccard 认话题撞车', () => {
  const short = tokenize('用户常用 TypeScript')
  const long = tokenize('用户常用 TypeScript 和 Python')
  assert.ok(containment(short, long) > SIMILAR_THRESHOLD)
  assert.ok(jaccard(tokenize('用户住在北京'), tokenize('用户住在上海')) > 0.35)
  assert.equal(containment([], short), 0)
})

test('省 token：注入块只加一句一条，框架开销压到几个 token/条', () => {
  const items = [
    memory({ text: '用户叫小林，是一名前端工程师' }),
    memory({ text: '用户喜欢简洁的中文回答', type: 'preference' }),
    memory({ text: '用户在做一个叫 DeepSea 的桌面客户端', type: 'project' }),
  ]
  const block = memoryPromptBlock(items)
  const bodyTokens = items.reduce((sum, item) => sum + estimateTokens(item.text), 0)
  // 头部 + 脚都有固定成本，另加每条的「- 」前缀；上限给足余量。
  const fixed = estimateTokens(MEMORY_HEADER + MEMORY_FOOTER)
  assert.ok(estimateTokens(block) - bodyTokens <= fixed + items.length * 6)
})
