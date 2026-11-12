import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Android Keystore 安全存储（任务 2B）。
 *
 * android-secure.ts 内部是 bundler 风格的无扩展名 import，node 的 ESM 解析器不认，
 * 所以先装一个 resolve 钩子（与 test/settings-migration.test.ts 同一套办法），
 * 再动态 import —— 这样测的是真正的判断逻辑，而不是测试里另抄一份。
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

const {
  SecureStorageError,
  androidSecureGet,
  androidSecureRemove,
  androidSecureSet,
  classifyPluginError,
} = await import('../src/lib/android-secure.ts')
const { SECURE_READ_ERROR_MESSAGE } = await import('../src/lib/secure-types.ts')

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** 一个可观测的假 Keystore：记录调用次数，便于断言「什么都没写」。 */
function makeDeps(options: {
  pluginGet?: () => Promise<string | null>
  pluginSet?: (value: string) => Promise<void>
  pluginRemove?: () => Promise<void>
  legacy?: string | null
} = {}) {
  const state = {
    setCalls: [] as string[],
    removeCalls: 0,
    legacyValue: options.legacy ?? null,
    legacyRemoveCalls: 0,
  }
  const deps = {
    pluginGet: options.pluginGet ?? (async () => null),
    pluginSet:
      options.pluginSet ??
      (async (value: string) => {
        state.setCalls.push(value)
      }),
    pluginRemove:
      options.pluginRemove ??
      (async () => {
        state.removeCalls += 1
      }),
    legacyGet: () => state.legacyValue,
    legacyRemove: () => {
      state.legacyRemoveCalls += 1
      state.legacyValue = null
    },
  }
  return { deps, state }
}

test('B1 插件写入失败：必须抛 SecureStorageError', async () => {
  const { deps } = makeDeps({
    pluginSet: async () => {
      throw new Error('keystore locked')
    },
  })
  await assert.rejects(() => androidSecureSet(deps, 'sk-new'), SecureStorageError)
})

test('B2 写入失败时不得降级写 localStorage（依赖里根本没有写明文的通道）', () => {
  // 类型层面就堵死了：AndroidSecureDeps 只有 legacyGet / legacyRemove，没有 legacySet。
  // 这里再加一条源码断言，防止将来有人偷偷加回来。断言前先剥注释 ——
  // 注释里为了解释历史会提到 localStorage，那不是代码。
  const source = fs
    .readFileSync(path.join(root, 'src/lib/android-secure.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
  assert.equal(/localStorage/.test(source), false, 'android-secure.ts 的代码里不应出现 localStorage')
  assert.equal(/legacySet/.test(source), false, '迁移只读不写：不得有 legacySet')
})

test('B3 旧 localStorage 明文迁移失败：必须保留旧值', async () => {
  const { deps, state } = makeDeps({
    legacy: 'sk-legacy-plain',
    pluginSet: async () => {
      throw new Error('keystore unavailable')
    },
  })
  const result = await androidSecureGet(deps)

  assert.equal(result.value, 'sk-legacy-plain', '迁移失败时旧值必须仍能读到')
  assert.equal(state.legacyValue, 'sk-legacy-plain', '迁移失败绝不能删掉旧明文')
  assert.equal(state.legacyRemoveCalls, 0, '迁移失败不得调用 legacyRemove')
  assert.equal(result.status, 'unavailable', '值能用但写入一定失败 → unavailable')
})

test('B4 迁移成功后才允许删除旧 localStorage 值', async () => {
  const { deps, state } = makeDeps({ legacy: 'sk-legacy-plain' })
  const result = await androidSecureGet(deps)

  assert.deepEqual(state.setCalls, ['sk-legacy-plain'], '必须先把旧值搬进 Keystore')
  assert.equal(result.value, 'sk-legacy-plain')
  assert.equal(result.status, 'available')
  assert.equal(state.legacyRemoveCalls, 1, '迁移成功后才删旧值')
  assert.equal(state.legacyValue, null, '迁移成功后旧明文应被清掉')
})

test('B5 读取失败不得伪装成「尚未配置 Key」', async () => {
  const { deps } = makeDeps({
    pluginGet: async () => {
      throw new Error('UserNotAuthenticatedException')
    },
  })
  const result = await androidSecureGet(deps)

  assert.equal(result.value, null)
  assert.equal(result.status, 'read-error', '暂时性读取失败必须报 read-error，不能报「没配置」')
})

test('B5b 读取失败 + 存在旧明文：必须立即 read-error，禁止进入迁移（不得覆盖 Keystore 凭证）', async () => {
  const calls = { legacyGet: 0, pluginSet: 0, legacyRemove: 0 }
  const deps = {
    pluginGet: async (): Promise<string | null> => {
      throw new Error('UserNotAuthenticatedException')
    },
    pluginSet: async (): Promise<void> => {
      calls.pluginSet += 1
    },
    pluginRemove: async (): Promise<void> => {},
    legacyGet: (): string | null => {
      calls.legacyGet += 1
      return 'sk-legacy-plain'
    },
    legacyRemove: (): void => {
      calls.legacyRemove += 1
    },
  }

  const result = await androidSecureGet(deps)

  assert.equal(result.status, 'read-error')
  assert.equal(result.value, null, '读失败时不能把旧明文当成当前凭证返回')
  assert.equal(calls.legacyGet, 0, '读失败时不得读旧明文')
  assert.equal(calls.pluginSet, 0, '读失败时不得写 Keystore（会覆盖可能仍有效的凭证）')
  assert.equal(calls.legacyRemove, 0, '读失败时不得删旧明文')
})

test('B6 插件未注册 → unavailable（而不是 read-error）', async () => {
  const { deps } = makeDeps({
    pluginGet: async () => {
      throw new Error('DeepSeaSecure is not implemented on android')
    },
  })
  const result = await androidSecureGet(deps)
  assert.equal(result.status, 'unavailable')
})

test('B7 插件正常成功路径：直接返回存储值', async () => {
  const { deps, state } = makeDeps({ pluginGet: async () => 'sk-stored-in-keystore' })
  const result = await androidSecureGet(deps)

  assert.equal(result.value, 'sk-stored-in-keystore')
  assert.equal(result.status, 'available')
  assert.equal(state.setCalls.length, 0, '读成功时不该发生迁移写入')
})

test('B8 插件正常但没有值、也没有旧明文 → 这才是真的「没配置」', async () => {
  const { deps } = makeDeps({ pluginGet: async () => null, legacy: null })
  const result = await androidSecureGet(deps)

  assert.equal(result.value, null)
  assert.equal(result.status, 'available', '插件正常且无值，才可以判定为未配置')
})

test('B9 写入成功路径不回归', async () => {
  const { deps, state } = makeDeps()
  await androidSecureSet(deps, 'sk-brand-new')
  assert.deepEqual(state.setCalls, ['sk-brand-new'])
})

test('B10 删除成功：插件删掉之后才清旧明文残留', async () => {
  const { deps, state } = makeDeps({ legacy: 'sk-legacy' })
  await androidSecureRemove(deps)

  assert.equal(state.removeCalls, 1, '必须真的调了插件删除')
  assert.equal(state.legacyRemoveCalls, 1, '插件成功后清旧明文')
  assert.equal(state.legacyValue, null)
})

test('B13 删除失败：必须抛错，且不得清掉旧明文、不得伪装成功', async () => {
  const { deps, state } = makeDeps({
    legacy: 'sk-legacy',
    pluginRemove: async () => {
      throw new Error('keystore delete failed')
    },
  })

  await assert.rejects(() => androidSecureRemove(deps), SecureStorageError)
  assert.equal(state.legacyRemoveCalls, 0, '插件没删成功就不能动旧明文')
  assert.equal(state.legacyValue, 'sk-legacy', '旧值必须保留')
})

test('B11 插件异常分类', () => {
  assert.equal(classifyPluginError(new Error('X is not implemented')), 'unavailable')
  assert.equal(classifyPluginError(new Error('no such plugin')), 'unavailable')
  assert.equal(classifyPluginError(new Error('KeystoreException')), 'read-error')
  assert.equal(classifyPluginError('weird string'), 'read-error')
})

test('B12 用户可见文案就是需求指定的那一句', () => {
  assert.equal(SECURE_READ_ERROR_MESSAGE, '安全存储读取失败，请勿重新输入Key，建议重启应用')
})
