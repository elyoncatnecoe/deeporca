import test from 'node:test'
import assert from 'node:assert/strict'
import { REDACTED, dropRedactedHeaders, looksLikeSecret, redactHeaders } from '../src/lib/redact.ts'

/**
 * P0-1：备份脱敏。
 *
 * 备份被设计成「能进 git、可分享」，而代码自己鼓励把密钥放进请求头
 * （providers.ts 的自定义头、Mcp 的 Authorization）。旧实现只清 apiKey，
 * headers 原样进文件 —— 用户一导出上传，密钥就明文外泄了。
 */

test('P0-1：Bearer / sk- / JWT / 长随机串都算密钥', () => {
  assert.equal(looksLikeSecret('Bearer abc123'), true)
  assert.equal(looksLikeSecret('bearer abc123'), true)
  assert.equal(looksLikeSecret('sk-1234567890abcdef'), true)
  assert.equal(looksLikeSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'), true)
  assert.equal(looksLikeSecret('a'.repeat(40)), true)
  // 正常值不能被误伤。
  assert.equal(looksLikeSecret('https://example.com'), false)
  assert.equal(looksLikeSecret('DeepSea'), false)
  assert.equal(looksLikeSecret(''), false)
})

test('P0-1：敏感头按名字脱敏，普通头原样保留', () => {
  const headers = {
    Authorization: 'Bearer sk-secret',
    'x-api-key': 'whatever',
    'HTTP-Referer': 'https://example.com',
    'X-Title': 'DeepSea',
    Cookie: 'sid=abc',
  }
  const out = redactHeaders(headers) as Record<string, string>
  assert.equal(out.Authorization, REDACTED)
  assert.equal(out['x-api-key'], REDACTED)
  assert.equal(out.Cookie, REDACTED)
  assert.equal(out['HTTP-Referer'], 'https://example.com', '普通头要留着，备份才有意义')
  assert.equal(out['X-Title'], 'DeepSea')
})

test('P0-1：头名普通但值像密钥，也脱敏', () => {
  const out = redactHeaders({ 'X-Custom': 'Bearer abcdef' }) as Record<string, string>
  assert.equal(out['X-Custom'], REDACTED)
})

test('P0-1：脱敏保留头名（用户看得出自己配过什么）', () => {
  const out = redactHeaders({ Authorization: 'Bearer x' }) as Record<string, string>
  assert.deepEqual(Object.keys(out), ['Authorization'])
  assert.equal(out.Authorization, REDACTED)
})

test('P0-1：脏数据不炸', () => {
  assert.equal(redactHeaders(null), null)
  assert.equal(redactHeaders(undefined), undefined)
  assert.deepEqual(redactHeaders(['a']), ['a'])
  assert.deepEqual(redactHeaders({}), {})
})

test('P0-1：导入时把占位符丢掉，不会当成真请求头发出去', () => {
  const imported = dropRedactedHeaders({ Authorization: REDACTED, 'X-Title': 'DeepSea' }) as Record<string, string>
  assert.deepEqual(imported, { 'X-Title': 'DeepSea' })
  assert.deepEqual(dropRedactedHeaders(null), null)
})