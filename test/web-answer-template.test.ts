import test from 'node:test'
import assert from 'node:assert/strict'
import { PatchReader } from '../electron/sse.ts'

/**
 * 网页账号「安全拦截」的数据层修复（CONTENT_FILTER / TEMPLATE_RESPONSE）。
 *
 * 站点在命中内容审查时，会把真实回答以 RESPONSE 片段下发，再补一段
 * TEMPLATE_RESPONSE 模板并置 status=CONTENT_FILTER。以前两者都拼进同一段正文，
 * 用户看到的是「真正的回答 + 一段抱歉」。这里锁住：真实正文与模板分开，
 * 有真实正文时优先用它。
 */

test('RESPONSE + TEMPLATE_RESPONSE：真实正文不被模板污染', () => {
  const r = new PatchReader()
  r.apply({
    v: {
      response: {
        status: 'CONTENT_FILTER',
        fragments: [
          { type: 'RESPONSE', content: '这是真正的回答。' },
          { type: 'TEMPLATE_RESPONSE', content: '抱歉，我无法提供这个内容。' },
        ],
      },
    },
  })
  assert.equal(r.text, '这是真正的回答。')
  assert.equal(r.template, '抱歉，我无法提供这个内容。')
  assert.equal(r.status, 'CONTENT_FILTER')
  // 调用方（deepseek-api）的取用规则：有正文用正文，没有才用模板 —— 已在上面体现。
})

test('只有 TEMPLATE_RESPONSE（纯拒绝）：正文为空，模板待回落', () => {
  const r = new PatchReader()
  r.apply({ v: { response: { fragments: [{ type: 'TEMPLATE_RESPONSE', content: '无法回答' }] } } })
  assert.equal(r.text, '')
  assert.equal(r.template, '无法回答')
})

test('路径式追加（response/fragments/-1/content）落在最后一个片段的类型上', () => {
  const r = new PatchReader()
  r.apply({ v: { response: { fragments: [{ type: 'RESPONSE', content: '前半' }] } } })
  r.apply({ p: 'response/fragments/-1/content', o: 'APPEND', v: '后半' })
  assert.equal(r.text, '前半后半')
})

test('思考片段只进 reasoning，不混进正文', () => {
  const r = new PatchReader()
  r.apply({ v: { response: { fragments: [{ type: 'THINKING', content: '想一想' }, { type: 'RESPONSE', content: '答案' }] } } })
  assert.equal(r.reasoning, '想一想')
  assert.equal(r.text, '答案')
})
