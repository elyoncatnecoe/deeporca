import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SessionRemoveError,
  createSessionStore,
  type SessionFsLike,
  type WebSession,
} from '../electron/web-session.ts'
import type { SafeStorageLike } from '../electron/secure-store.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 网页登录态的持久化（修复 2）。
 *
 * 守的是四条：
 *   1. 写不进去时内存要回滚 —— 不能「UI 说已登录、磁盘还是旧会话」；
 *   2. 换账号写失败时，盘上的旧会话必须失效 —— 否则重启会复活旧账号；
 *   3. 旧版明文迁移**只有加密写入成功后**才算完成，失败时原文件原样保留；
 *   4. 重启后（新建一个 store 读同一份文件）状态必须和上次结束时一致。
 *
 * 这是**模拟测试**：safeStorage 用假的实现替换，真机行为见人工验收计划。
 */

function tempSessionFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-session-'))
  return { file: join(dir, 'deepseek-web-session.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function fakeSafe(options: { available?: boolean; decryptThrows?: boolean } = {}): SafeStorageLike {
  const available = options.available ?? true
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`SEALED(${plain})`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      if (options.decryptThrows === true) throw new Error('key unavailable')
      const match = /^SEALED\(([\s\S]*)\)$/.exec(buffer.toString('utf8'))
      if (match === null) throw new Error('not a sealed value')
      return match[1]
    },
  }
}

const SESSION_A: WebSession = { token: 'token-account-A', userAgent: 'UA/1', savedAt: 1000 }
const SESSION_B: WebSession = { token: 'token-account-B', userAgent: 'UA/2', savedAt: 2000 }

test('S1 正常保存：磁盘是密文，内存与磁盘一致', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const store = createSessionStore({ safe: fakeSafe(), file: () => file })
    const result = store.save(SESSION_A)

    assert.deepEqual(result, { ok: true })
    assert.equal(store.peek()?.token, SESSION_A.token)

    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as { token: string; sealed?: boolean }
    assert.equal(parsed.sealed, true, '必须标记为已加密')
    assert.equal(
      Buffer.from(parsed.token, 'base64').toString('utf8'),
      `SEALED(${SESSION_A.token})`,
      '落盘的 token 必须是密文（经 safeStorage 加密后的 base64）',
    )
    assert.equal(raw.includes(SESSION_A.token), false, '文件里不能出现明文 token')
  } finally {
    cleanup()
  }
})

test('S2 加密不可用：拒绝保存、内存回滚、磁盘不产生文件', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const store = createSessionStore({ safe: fakeSafe({ available: false }), file: () => file })
    const result = store.save(SESSION_A)

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'no-encryption')
    assert.equal(store.peek(), null, '失败后内存不能显示已登录')
    assert.equal(existsSync(file), false, '不能产生任何文件')
  } finally {
    cleanup()
  }
})

test('S3 写入失败：内存回滚，且不得留下「看起来登录了」的状态', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const store = createSessionStore({ safe: fakeSafe(), file: () => file })
    // 让写临时文件失败：在 .tmp 位置放一个目录。
    mkdirSync(`${file}.tmp`, { recursive: true })

    const result = store.save(SESSION_A)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'write-failed')
    assert.equal(store.peek(), null)
  } finally {
    cleanup()
  }
})

test('S4 换账号写失败：盘上的旧会话必须失效，重启不得复活旧账号', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const store = createSessionStore({ safe: fakeSafe(), file: () => file })
    assert.deepEqual(store.save(SESSION_A), { ok: true })
    assert.equal(existsSync(file), true, '前置：A 已经存下来了')

    // 让后续写入失败
    mkdirSync(`${file}.tmp`, { recursive: true })
    const failed = store.save(SESSION_B, { invalidateStale: true })

    assert.equal(failed.ok, false)
    assert.equal(store.peek(), null, '失败后内存回到未登录')
    assert.equal(existsSync(file), false, '旧账号 A 的会话文件必须失效')

    // 模拟重启
    const restarted = createSessionStore({ safe: fakeSafe(), file: () => file })
    assert.equal(restarted.load(), null, '重启后不得恢复旧账号')
  } finally {
    cleanup()
  }
})

test('S5 旧版明文迁移成功：读完变成密文，明文不再留在盘上', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    writeFileSync(file, JSON.stringify({ token: 'legacy-plain-token', userAgent: 'UA/old', savedAt: 1 }), 'utf8')

    const store = createSessionStore({ safe: fakeSafe(), file: () => file })
    const session = store.load()

    assert.equal(session?.token, 'legacy-plain-token', '迁移成功时本次仍要能登录')
    const raw = readFileSync(file, 'utf8')
    assert.equal(raw.includes('legacy-plain-token'), false, '迁移后不能还有明文 token')
    assert.match(raw, /sealed/, '迁移后应是 sealed 形状')
  } finally {
    cleanup()
  }
})

test('S6 旧版明文迁移失败：不假装成功、不删旧文件、不把明文会话装进内存', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const legacy = JSON.stringify({ token: 'legacy-plain-token', userAgent: 'UA/old', savedAt: 1 })
    writeFileSync(file, legacy, 'utf8')

    const store = createSessionStore({ safe: fakeSafe({ available: false }), file: () => file })
    const session = store.load()

    assert.equal(session, null, '迁移失败时不能静默继续用明文会话')
    assert.equal(readFileSync(file, 'utf8'), legacy, '旧文件必须原样保留（那是用户唯一一份）')
    const issue = store.takeIssue()
    assert.equal(issue?.kind, 'migration-failed')
    assert.match(issue?.message ?? '', /迁移|重新登录/)
  } finally {
    cleanup()
  }
})

test('S7 迁移失败后重启：状态一致，仍然不会假装已登录', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const legacy = JSON.stringify({ token: 'legacy-plain-token', userAgent: 'UA/old', savedAt: 1 })
    writeFileSync(file, legacy, 'utf8')

    const first = createSessionStore({ safe: fakeSafe({ available: false }), file: () => file })
    assert.equal(first.load(), null)

    const restarted = createSessionStore({ safe: fakeSafe({ available: false }), file: () => file })
    assert.equal(restarted.load(), null, '重启后依然不能把明文会话当成已登录')
    assert.equal(readFileSync(file, 'utf8'), legacy, '旧文件仍未被破坏')
  } finally {
    cleanup()
  }
})

test('S8 解密失败：不当成已登录，也不删文件', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const store = createSessionStore({ safe: fakeSafe(), file: () => file })
    store.save(SESSION_A)
    const before = readFileSync(file, 'utf8')

    const broken = createSessionStore({ safe: fakeSafe({ decryptThrows: true }), file: () => file })
    assert.equal(broken.load(), null)
    assert.equal(readFileSync(file, 'utf8'), before, '解密失败不能改动文件')
  } finally {
    cleanup()
  }
})

test('S9 forget：清内存并删文件，重启后无会话', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const store = createSessionStore({ safe: fakeSafe(), file: () => file })
    store.save(SESSION_A)
    store.forget()

    assert.equal(store.peek(), null)
    assert.equal(existsSync(file), false)
    assert.equal(createSessionStore({ safe: fakeSafe(), file: () => file }).load(), null)
  } finally {
    cleanup()
  }
})

test('S10 没有存档 = 未登录（正常状态，不产生问题提示）', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const store = createSessionStore({ safe: fakeSafe(), file: () => file })
    assert.equal(store.load(), null)
    assert.equal(store.takeIssue(), null)
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------------------------ */
/* 修复 P1-2：删除失败不得静默吞掉                                       */
/* ------------------------------------------------------------------ */

/** 可切换失败模式的假文件层（真实 fs 上很难稳定造出 EACCES / 占用）。 */
function statefulFs(state: { failWrites: boolean; failUnlink: boolean }): SessionFsLike {
  const err = (code: string): NodeJS.ErrnoException => {
    const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException
    error.code = code
    return error
  }
  return {
    readFile: () => {
      throw err('ENOENT')
    },
    writeFile: () => {
      if (state.failWrites) throw err('EACCES')
    },
    rename: () => {
      if (state.failWrites) throw err('EACCES')
    },
    unlink: () => {
      if (state.failUnlink) throw err('EPERM')
    },
    mkdirp: () => undefined,
  }
}

test('S11 换账号写失败且旧会话清不掉：必须抛 SessionRemoveError，且不得清空内存', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const state = { failWrites: false, failUnlink: false }
    const store = createSessionStore({ safe: fakeSafe(), file: () => file, fs: statefulFs(state) })
    assert.deepEqual(store.save(SESSION_A), { ok: true })

    state.failWrites = true
    state.failUnlink = true

    // 双重失败必须是**异常**，不能是「返回一个 ok:false 的对象」——
    // 对象很容易被调用方只判 ok 然后当成普通失败悄悄吞掉。
    assert.throws(
      () => store.save(SESSION_B, { invalidateStale: true }),
      (error: unknown) => {
        assert.ok(error instanceof SessionRemoveError, '必须是 SessionRemoveError')
        assert.match((error as Error).message, /未能清除/)
        assert.match((error as Error).message, /重启后可能恢复旧账号/)
        return true
      },
    )
    assert.equal(store.peek()?.token, SESSION_A.token, '旧会话还在时不能清内存、更不能声称已清除')
  } finally {
    cleanup()
  }
})

test('S12 forget 删除失败：必须抛 SessionRemoveError，且内存保持原样', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const state = { failWrites: false, failUnlink: false }
    const store = createSessionStore({ safe: fakeSafe(), file: () => file, fs: statefulFs(state) })
    store.save(SESSION_A)

    state.failWrites = true
    state.failUnlink = true
    assert.throws(() => store.forget(), SessionRemoveError)

    assert.equal(store.peek()?.token, SESSION_A.token, '删不掉就不能显示已登出')
  } finally {
    cleanup()
  }
})

test('S13 unlink 失败但截断成功：视为旧会话已失效，forget 成功', () => {
  const { file, cleanup } = tempSessionFile()
  try {
    const state = { failWrites: false, failUnlink: true }
    const store = createSessionStore({ safe: fakeSafe(), file: () => file, fs: statefulFs(state) })
    store.save(SESSION_A)

    assert.doesNotThrow(() => store.forget(), '空文件策略下旧 token 不会被读回，可视为成功')
    assert.equal(store.peek(), null)
  } finally {
    cleanup()
  }
})

test('S14 结构断言：webapi:forget 不吞删除失败（走 IPC rejection）', () => {
  const main = readFileSync(join(root, 'electron/main.ts'), 'utf8')
  const start = main.indexOf("trustedHandle('webapi:forget'")
  assert.ok(start >= 0, '找不到 webapi:forget handler')
  const nextHandler = main.indexOf("trustedHandle('webapi:send'", start)
  const handler = main.slice(start, nextHandler > start ? nextHandler : start + 400)
  assert.match(handler, /forgetWebSession\(\)/, 'handler 应直接调用 forgetWebSession')
  assert.doesNotMatch(handler, /catch/, '不得 catch 后把删除失败吞掉')
})
