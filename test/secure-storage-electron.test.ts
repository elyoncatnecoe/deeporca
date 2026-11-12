import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  API_KEY_SLOT,
  SecureStoreReadError,
  SecureStoreUnavailableError,
  encryptValue,
  readSecureEntry,
  readSecureStoreFile,
  readSecureValue,
  removeSecureValue,
  writeSecureValue,
  type SafeStorageLike,
  type SecureStoreFsLike,
} from '../electron/secure-store.ts'

/**
 * Electron 安全存储（任务 2A）。
 *
 * 直接测 `electron/secure-store.ts` —— 那是 `secure:get` / `secure:set` 的完整实现，
 * main.ts 只是把真实的 safeStorage 和文件路径注入进去。这样测的是**真代码**，
 * 不是测试里另抄一份「先加密再写」的顺序（抄的那份永远不会发现顺序被改错）。
 *
 * 注意：这里是**模拟测试**，不是真机验证。`safeStorage` 用假的实现替换，
 * 真实 DPAPI 行为见 docs/BATCH1-MANUAL-TEST-PLAN.md。
 */

/** 假的 safeStorage：加密方式可辨认（SEALED(...)），便于断言文件里没有明文。 */
function fakeSafe(options: { available?: boolean } = {}): SafeStorageLike {
  const available = options.available ?? true
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`SEALED(${plain})`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8')
      const match = /^SEALED\(([\s\S]*)\)$/.exec(text)
      if (match === null) throw new Error('decrypt failed: not a sealed value')
      return match[1]
    },
  }
}

function tempSecureFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-secure-'))
  return { file: join(dir, 'secure.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const SECRET = 'sk-test-secret-0123456789'

test('A1 加密不可用：写入必须抛明确异常', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    assert.throws(
      () => writeSecureValue(fakeSafe({ available: false }), file, SECRET),
      SecureStoreUnavailableError,
      '加密不可用时必须抛 SecureStoreUnavailableError，而不是静默降级',
    )
  } finally {
    cleanup()
  }
})

test('A2 加密不可用：不得创建任何凭证文件（连 Base64 明文也不行）', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    assert.throws(() => writeSecureValue(fakeSafe({ available: false }), file, SECRET))
    assert.equal(existsSync(file), false, '加密不可用时不应该产生 secure.json')
  } finally {
    cleanup()
  }
})

test('A3 加密不可用：原有密文不得被清空或覆盖', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    writeSecureValue(fakeSafe(), file, 'sk-original-value')
    const before = readFileSync(file, 'utf8')
    assert.notEqual(before, '', '前置条件：文件里已有密文')

    assert.throws(() => writeSecureValue(fakeSafe({ available: false }), file, 'sk-new-value'))

    assert.equal(readFileSync(file, 'utf8'), before, '失败的写入不能改动原文件一个字节')
    const stillReadable = readSecureValue(fakeSafe(), file)
    assert.equal(stillReadable.value, 'sk-original-value', '原凭证必须仍可读回')
  } finally {
    cleanup()
  }
})

test('A4 加密可用：文件里只有密文，不含明文也不含 Base64 明文', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    writeSecureValue(fakeSafe(), file, SECRET)
    const raw = readFileSync(file, 'utf8')
    assert.equal(raw.includes(SECRET), false, '文件里不能出现明文 Key')
    assert.equal(
      raw.includes(Buffer.from(SECRET, 'utf8').toString('base64')),
      false,
      '文件里不能出现 Base64 编码的 Key（Base64 不是加密）',
    )
    assert.match(raw, /enc:/, '必须是 enc: 前缀的密文')
    assert.equal(raw.includes('raw:'), false, '不得写入 raw: 明文降级格式')
  } finally {
    cleanup()
  }
})

test('A5 加密可用：正常读写不回归', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    const safe = fakeSafe()
    writeSecureValue(safe, file, SECRET)
    const result = readSecureValue(safe, file)
    assert.equal(result.value, SECRET)
    assert.equal(result.status, 'available')
    assert.equal(result.needsMigration, false)
  } finally {
    cleanup()
  }
})

test('A6 旧版 raw: 明文：读到能读出，并就地升级成 enc:（不失效老用户）', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    const legacy = `raw:${Buffer.from('sk-legacy-plain', 'utf8').toString('base64')}`
    writeFileSync(file, JSON.stringify({ [API_KEY_SLOT]: legacy }), 'utf8')

    const result = readSecureValue(fakeSafe(), file)
    assert.equal(result.value, 'sk-legacy-plain', '旧格式必须仍能读出来')
    assert.equal(result.status, 'available')
    assert.equal(result.needsMigration, true)

    const after = readFileSync(file, 'utf8')
    assert.equal(after.includes('raw:'), false, '迁移后不应再留 raw: 明文')
    assert.match(after, /enc:/, '迁移后应是密文')
  } finally {
    cleanup()
  }
})

test('A7 解密失败：状态 read-error，且原文件一个字节都不变', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    writeSecureValue(fakeSafe(), file, 'sk-keep-me')
    const before = readFileSync(file, 'utf8')

    const broken: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(`SEALED(${plain})`, 'utf8'),
      decryptString: () => {
        throw new Error('key unavailable')
      },
    }
    const result = readSecureValue(broken, file)

    assert.equal(result.value, null)
    assert.equal(result.status, 'read-error', '解密失败必须报 read-error，不能报 available')
    assert.equal(readFileSync(file, 'utf8'), before, '读失败绝不能改动密文')
  } finally {
    cleanup()
  }
})

test('A8 「没有存档」与「读失败」必须能区分', () => {
  const safe = fakeSafe()
  const none = readSecureEntry(safe, {})
  assert.equal(none.value, null)
  assert.equal(none.status, 'available', '确实没配过 Key 时是 available')

  const unavailable = readSecureEntry(fakeSafe({ available: false }), {})
  assert.equal(unavailable.value, null)
  assert.equal(unavailable.status, 'unavailable', '加密后端缺失是 unavailable，不是「没配置」')

  const corrupt = readSecureEntry(safe, { [API_KEY_SLOT]: 'not-a-known-format' })
  assert.equal(corrupt.value, null)
  assert.equal(corrupt.status, 'read-error', '认不出的格式必须报 read-error，不能当成没配置')
})

test('A9 加密不可用时 encryptValue 直接抛错（写盘前的唯一闸门）', () => {
  assert.throws(() => encryptValue(fakeSafe({ available: false }), SECRET), SecureStoreUnavailableError)
})

/* ------------------------------------------------------------------ */
/* 修复 1：文件级错误必须与「没有存档」区分开                            */
/* ------------------------------------------------------------------ */

test('A10 文件不存在 = 正常的空存储，返回 {}', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    assert.deepEqual(readSecureStoreFile(file), {})
  } finally {
    cleanup()
  }
})

test('A11 损坏的 JSON 必须抛 SecureStoreReadError，而不是返回 {}', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    writeFileSync(file, '{ not json at all', 'utf8')
    assert.throws(() => readSecureStoreFile(file), SecureStoreReadError)
    assert.throws(() => readSecureValue(fakeSafe(), file), SecureStoreReadError)
  } finally {
    cleanup()
  }
})

test('A12 结构不合法（数组 / 值不是字符串）必须抛错', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    writeFileSync(file, '[1,2,3]', 'utf8')
    assert.throws(() => readSecureStoreFile(file), SecureStoreReadError, '数组不是合法存储结构')

    writeFileSync(file, JSON.stringify({ apiKey: 123 }), 'utf8')
    assert.throws(() => readSecureStoreFile(file), SecureStoreReadError, '值必须是字符串')
  } finally {
    cleanup()
  }
})

test('A13 权限不足（EACCES）必须包装成 SecureStoreReadError 抛出，不得变成 {}', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    // 注入一个「读一定失败」的文件层，精确模拟权限不足。
    // 不用目录冒充文件（EISDIR）—— 那只能证明「文件类型不对」，证明不了权限问题。
    const writes: string[] = []
    const eaccesFs: SecureStoreFsLike = {
      readFile: () => {
        const error = new Error('EACCES: permission denied, open \'secure.json\'') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      },
      writeFile: (_target, data) => {
        writes.push(data)
      },
      mkdirp: () => undefined,
    }

    assert.throws(
      () => readSecureStoreFile(file, eaccesFs),
      (error: unknown) => {
        assert.ok(error instanceof SecureStoreReadError, '必须是 SecureStoreReadError')
        assert.match((error as Error).message, /EACCES/, '错误信息要保留 EACCES')
        return true
      },
    )

    // 整条读取链路也必须抛，而不是返回空表。
    assert.throws(() => readSecureValue(fakeSafe(), file, eaccesFs), SecureStoreReadError)
    assert.deepEqual(writes, [], '读取失败不得触发任何写入')
  } finally {
    cleanup()
  }
})

test('A13b 权限不足时写入/删除都不得发生（不会覆盖原文件）', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    const original = '{"apiKey":"enc:keep-me"}'
    writeFileSync(file, original, 'utf8')

    const writes: string[] = []
    const eaccesFs: SecureStoreFsLike = {
      readFile: () => {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      },
      writeFile: (_target, data) => {
        writes.push(data)
      },
      mkdirp: () => undefined,
    }

    assert.throws(() => writeSecureValue(fakeSafe(), file, 'sk-new', eaccesFs), SecureStoreReadError)
    assert.throws(() => removeSecureValue(file, eaccesFs), SecureStoreReadError)
    assert.deepEqual(writes, [], '读不出来就不该写，否则会覆盖原凭证')
    assert.equal(readFileSync(file, 'utf8'), original, '真实文件必须原样保留')
  } finally {
    cleanup()
  }
})

test('A14 文件读不出来时，写入与删除都不得改动原文件（read-error 不得覆盖）', () => {
  const { file, cleanup } = tempSecureFile()
  try {
    const broken = '{ broken json'
    writeFileSync(file, broken, 'utf8')

    assert.throws(() => writeSecureValue(fakeSafe(), file, 'sk-should-not-land'))
    assert.throws(() => removeSecureValue(file))

    assert.equal(readFileSync(file, 'utf8'), broken, '损坏的文件必须原样保留，等人工处理')
  } finally {
    cleanup()
  }
})
