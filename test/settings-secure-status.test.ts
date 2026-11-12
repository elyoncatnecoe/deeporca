import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 安全存储状态机（任务 2C）。
 *
 * 测的是 settings.ts 里 `loadSettings` / `persistSettings` **真正调用的那两个函数**
 * （loadCredentialBlob / persistCredentialBlob）和它背后的 credential vault。
 *
 * 为什么不去直接跑 loadSettings：它会连带读 IndexedDB（node 里没有 indexedDB）。
 * 所以这里把「凭证这一层」单独测透，并在最后用源码断言保证 settings.ts 没有绕过
 * vault 直接写安全存储的路径 —— 绕过去就等于把这里测的规则全部作废。
 *
 * 这是**逻辑级/模拟测试**，不是真机验证。
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})

const settings = await import('../src/lib/settings.ts')
const credentials = await import('../src/lib/secure-credentials.ts')
const { SECURE_READ_ERROR_MESSAGE, SECURE_UNAVAILABLE_MESSAGE } = await import('../src/lib/secure-types.ts')

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

type Status = 'available' | 'unavailable' | 'read-error'

/** 可观测的假后端；`state.value` 代表「盘上的真实内容」，用来证明它没被改动。 */
function makeBackend(init: { value: string | null; status: Status }) {
  const calls = { read: 0, write: [] as string[], remove: 0 }
  const state = { value: init.value }
  const backend = {
    read: async (): Promise<{ value: string | null; status: Status }> => {
      calls.read += 1
      return { value: state.value, status: init.status }
    },
    write: async (value: string): Promise<void> => {
      calls.write.push(value)
      state.value = value
    },
    remove: async (): Promise<void> => {
      calls.remove += 1
      state.value = null
    },
  }
  return { backend, calls, state }
}

/** 装一个指定后端的 vault，并返回它的可观测状态。 */
function install(init: { value: string | null; status: Status }) {
  const harness = makeBackend(init)
  credentials.__setCredentialVaultForTest(credentials.createCredentialVault(harness.backend))
  return harness
}

test.after(() => {
  credentials.__resetCredentialVaultForTest()
})

const CIPHERTEXT = '{"provider-a":"cipher-blob"}'

test('C1 安全存储正常读取：状态 available，值原样返回', async () => {
  install({ value: CIPHERTEXT, status: 'available' })
  const blob = await settings.loadCredentialBlob()

  assert.equal(blob, CIPHERTEXT)
  assert.equal(settings.getSecureStorageStatus(), 'available')
})

test('C2 安全存储不可用：状态 unavailable，且不得当成「没配置」去写空值', async () => {
  const { calls, state } = install({ value: null, status: 'unavailable' })

  const blob = await settings.loadCredentialBlob()
  assert.equal(blob, '')
  assert.equal(settings.getSecureStorageStatus(), 'unavailable')

  // 只改普通设置（blob 为空）→ 静默跳过，不产生任何写/删。
  assert.equal(await settings.persistCredentialBlob('{}'), 'skipped')
  assert.deepEqual(calls.write, [])
  assert.equal(calls.remove, 0)
  assert.equal(state.value, null)

  // 想写新 Key → 明确拒绝，而不是假装成功。
  await assert.rejects(() => settings.persistCredentialBlob(CIPHERTEXT), {
    message: SECURE_UNAVAILABLE_MESSAGE,
  })
  assert.deepEqual(calls.write, [], '被拒绝的写入不能真的落盘')
})

test('C3 安全存储读取异常：状态 read-error，且不谎称「没配置」', async () => {
  install({ value: CIPHERTEXT, status: 'read-error' })

  const blob = await settings.loadCredentialBlob()
  assert.equal(blob, '')
  assert.equal(settings.getSecureStorageStatus(), 'read-error')
})

test('C4 read-error 后保存其他设置：绝不触碰原密文', async () => {
  const { calls, state } = install({ value: CIPHERTEXT, status: 'read-error' })
  await settings.loadCredentialBlob()

  // 「用户只是改了个主题」：凭证 blob 算出来是空集合。
  const outcome = await settings.persistCredentialBlob('{}')

  assert.equal(outcome, 'skipped', '空 blob 在 read-error 下必须静默跳过')
  assert.deepEqual(calls.write, [], '不能写入')
  assert.equal(calls.remove, 0, '不能删除（这就是以前会把凭证清掉的那个洞）')
  assert.equal(state.value, CIPHERTEXT, '盘上的密文必须一个字节都不变')
})

test('C5 read-error 后重新加载：状态保持，密文仍在', async () => {
  const { calls, state } = install({ value: CIPHERTEXT, status: 'read-error' })

  await settings.loadCredentialBlob()
  await settings.loadCredentialBlob()

  assert.equal(settings.getSecureStorageStatus(), 'read-error')
  assert.equal(calls.read, 2, '重新加载会重新尝试读')
  assert.equal(state.value, CIPHERTEXT, '两次读取都不能改动密文')
  assert.deepEqual(calls.write, [])
  assert.equal(calls.remove, 0)
})

test('C6 read-error 后尝试写入新 Key：明确报错，不覆盖可能可恢复的密文', async () => {
  const { calls, state } = install({ value: CIPHERTEXT, status: 'read-error' })
  await settings.loadCredentialBlob()

  await assert.rejects(() => settings.persistCredentialBlob('{"provider-a":"new-key"}'), {
    message: SECURE_READ_ERROR_MESSAGE,
  })

  assert.deepEqual(calls.write, [], '拒绝的写入不能落盘')
  assert.equal(calls.remove, 0)
  assert.equal(state.value, CIPHERTEXT, '原密文必须完好')
})

test('C7 任何失败路径都不破坏原密文（遍历所有状态 × 空/非空 blob）', async () => {
  const statuses: Status[] = ['unavailable', 'read-error']
  for (const status of statuses) {
    for (const blob of ['{}', '', '{"provider-a":"x"}']) {
      const { calls, state } = install({ value: CIPHERTEXT, status })
      await settings.loadCredentialBlob()
      try {
        await settings.persistCredentialBlob(blob)
      } catch {
        /* 拒绝是预期行为之一 */
      }
      assert.equal(state.value, CIPHERTEXT, `${status} + ${JSON.stringify(blob)}：密文被改动了`)
      assert.equal(calls.remove, 0, `${status} + ${JSON.stringify(blob)}：不该有删除`)
      if (blob === '{}' || blob === '') assert.deepEqual(calls.write, [], `${status} + 空 blob 不该写入`)
    }
  }
})

test('C8 available 路径不回归：写入 / 幂等跳过 / 清空删除', async () => {
  const { calls } = install({ value: '', status: 'available' })

  await settings.loadCredentialBlob()
  assert.equal(await settings.persistCredentialBlob('{"a":"1"}'), 'written')
  assert.deepEqual(calls.write, ['{"a":"1"}'])

  // 同一个 blob 再存一次不该重复写（设置页每按键都会走这条路）。
  assert.equal(await settings.persistCredentialBlob('{"a":"1"}'), 'skipped')
  assert.equal(calls.write.length, 1)

  assert.equal(await settings.persistCredentialBlob('{}'), 'removed')
  assert.equal(calls.remove, 1)
})

test('C9 settings.ts 不得绕过 vault 直接读写安全存储（否则上面全部作废）', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/settings.ts'), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')

  assert.equal(/secureSet\s*\(/.test(code), false, 'settings.ts 不能直接调 secureSet')
  assert.equal(/secureRemove\s*\(/.test(code), false, 'settings.ts 不能直接调 secureRemove')
  assert.match(code, /persistCredentialBlob\(/, 'persistSettings 必须走 vault')
  assert.match(code, /loadCredentialBlob\(/, 'loadSettings 必须走 vault')
})

test('C10 用户可见文案与需求逐字一致', () => {
  assert.equal(SECURE_READ_ERROR_MESSAGE, '安全存储读取失败，请勿重新输入Key，建议重启应用')
  assert.equal(/API Key/.test(SECURE_READ_ERROR_MESSAGE), false, '文案不能含「API Key」，否则会触发「去填 Key」链接')
})

test('C11 写入/删除失败时 store 必须回滚 settings（否则 UI 会显示「已清空」）', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/store.ts'), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')

  // 失败分支必须把上一份设置放回去，不能停留在乐观更新后的 next。
  assert.match(code, /set\(\{\s*settings:\s*previous\s*\}\)/, 'SecureStorageError 分支必须回滚 settings')
  // 提示语直接来自错误本身（包含「没有保存」/「删除失败」等完整说明）。
  assert.match(code, /showToast\(error\.message\)/, '必须把错误原文展示给用户')
})
