import assert from 'node:assert/strict'
import test from 'node:test'
import {
  conversationToMarkdown,
  exportableMessages,
  markdownFileName,
  messageMarkdownFileName,
  messageToMarkdown,
  resolveExportTitle,
} from '../src/lib/export-markdown.ts'
import type { ChatMessage } from '../src/lib/types.ts'

let seq = 0
function msg(patch: Partial<ChatMessage>): ChatMessage {
  seq += 1
  return {
    id: `m${seq}`,
    conversationId: 'c1',
    role: 'assistant',
    content: '',
    createdAt: seq,
    ...patch,
  } as ChatMessage
}

test('单条消息：带角色标题和正文', () => {
  const md = messageToMarkdown(msg({ content: '今天海面很静。' }), { assistantName: '深鲸' })
  assert.ok(md.startsWith('### 深鲸'))
  assert.ok(md.includes('今天海面很静。'))
})

test('用户消息署名为「我」', () => {
  const md = messageToMarkdown(msg({ role: 'user', content: '你好' }), { assistantName: '深鲸' })
  assert.ok(md.startsWith('### 我'))
})

test('思考过程默认不导出，显式打开才带', () => {
  const message = msg({ content: '答案', reasoning: '先想一下' })
  assert.ok(!messageToMarkdown(message, {}).includes('先想一下'))
  const withReasoning = messageToMarkdown(message, { includeReasoning: true })
  assert.ok(withReasoning.includes('先想一下'))
  assert.ok(withReasoning.includes('<details>'))
})

test('工具消息、报错消息、空消息都不导出', () => {
  const messages = [
    msg({ role: 'tool', content: '工具结果' }),
    msg({ content: '出错了', status: 'error' }),
    msg({ content: '   ' }),
    msg({ content: '真正的回复' }),
  ]
  const kept = exportableMessages(messages)
  assert.equal(kept.length, 1)
  assert.equal(kept[0]?.content, '真正的回复')
})

test('分叉里没选中的候选不导出', () => {
  const messages = [
    msg({ content: '选中的', nodeId: 'n1', active: true }),
    msg({ content: '被挤掉的', nodeId: 'n1', active: false }),
  ]
  const kept = exportableMessages(messages)
  assert.equal(kept.length, 1)
  assert.equal(kept[0]?.content, '选中的')
})

test('整段对话：有标题、有正文、有文末元信息', () => {
  const messages = [
    msg({ role: 'user', content: '帮我写个函数' }),
    msg({ content: '```js\nconst a = 1\n```' }),
  ]
  const md = conversationToMarkdown(messages, { title: '写个函数', assistantName: '深鲸', model: 'deepseek-flash' })
  assert.ok(md.startsWith('# 写个函数'))
  assert.ok(md.includes('### 我'))
  assert.ok(md.includes('### 深鲸'))
  assert.ok(md.includes('const a = 1'), '代码块要原样保留')
  assert.ok(md.includes('deepseek-flash'))
})

test('文末元信息可以关掉', () => {
  const md = conversationToMarkdown([msg({ content: '嗨' })], { includeMeta: false })
  assert.ok(!md.includes('---'))
})

test('附件折成一行说明，不塞 data: 长串', () => {
  const message = msg({
    content: '看这张图',
    attachments: [{ id: 'a1', name: '海边.png', kind: 'image', size: 100, dataUrl: 'data:image/png;base64,AAAA' }] as never,
  })
  const md = messageToMarkdown(message, {})
  assert.ok(md.includes('[附件] 海边.png'))
  assert.ok(!md.includes('base64'))
})

test('文件名去掉非法字符并带日期', () => {
  const name = markdownFileName('a/b:c*d?e', new Date(2026, 9, 25))
  assert.ok(!/[\\/:*?"<>|]/.test(name))
  assert.ok(name.endsWith('-20261025.md'))
})

test('空标题回退成「对话」', () => {
  assert.ok(markdownFileName('', new Date(2026, 0, 1)).startsWith('对话-'))
})

test('单条文件名带角色和片段', () => {
  const name = messageMarkdownFileName(msg({ role: 'user', content: '今天天气怎么样' }), '深鲸', new Date(2026, 0, 1))
  assert.ok(name.startsWith('我-'))
  assert.ok(name.endsWith('.md'))
})

test('导出标题优先用对话标题，其次第一句用户消息', () => {
  const messages = [msg({ role: 'user', content: '第一句话' })]
  assert.equal(resolveExportTitle({ id: 'c1', title: '有标题', createdAt: 0, updatedAt: 0, model: '' }, messages), '有标题')
  assert.equal(resolveExportTitle({ id: 'c1', title: '新的对话', createdAt: 0, updatedAt: 0, model: '' }, messages), '第一句话')
  assert.equal(resolveExportTitle(undefined, []), '对话')
})

test('空对话导出不会崩', () => {
  const md = conversationToMarkdown([], { title: '空' })
  assert.ok(md.includes('# 空'))
})
test('思考过程开关：同一份数据，开与不开结果不同', () => {
  const messages = [
    msg({ role: 'user', content: '问题' }),
    msg({ content: '答案', reasoning: '推理过程在这里' }),
  ]
  const off = conversationToMarkdown(messages, { title: 'T', includeReasoning: false })
  const on = conversationToMarkdown(messages, { title: 'T', includeReasoning: true })
  assert.ok(!off.includes('推理过程在这里'))
  assert.ok(on.includes('推理过程在这里'))
  assert.ok(on.length > off.length)
})

test('元信息开关：关掉后不出现分隔线和时间', () => {
  const messages = [msg({ content: '内容' })]
  const off = conversationToMarkdown(messages, { includeMeta: false })
  const on = conversationToMarkdown(messages, { includeMeta: true, model: 'deepseek-flash' })
  assert.ok(!off.includes('---'))
  assert.ok(on.includes('---'))
  assert.ok(on.includes('deepseek-flash'))
})

test('单条导出：默认不带思考过程', () => {
  const md = messageToMarkdown(msg({ content: '正文', reasoning: '内部推理' }), { assistantName: '深鲸' })
  assert.ok(md.includes('正文'))
  assert.ok(!md.includes('内部推理'))
})

test('思考过程用 <details> 折起来，排在正文之前、每行都在引用块里', () => {
  const md = messageToMarkdown(
    msg({ content: '结论', reasoning: '第一步\n第二步' }),
    { includeReasoning: true, assistantName: '深鲸' },
  )
  assert.ok(md.includes('<details><summary>思考过程</summary>'))
  assert.ok(md.includes('</details>'))
  assert.ok(md.indexOf('<details>') < md.indexOf('结论'), '折叠块要在正文之前')
  assert.ok(md.includes('> 第一步'))
  assert.ok(md.includes('> 第二步'))
})

test('关掉思考过程时不留空的 <details> 壳', () => {
  const md = messageToMarkdown(msg({ content: '结论', reasoning: '内部推理' }), { includeReasoning: false })
  assert.ok(!md.includes('<details>'))
  assert.ok(!md.includes('内部推理'))
  assert.ok(md.includes('结论'))
})

test('整段导出：工具消息 / 报错消息 / 空消息都不进结果', () => {
  const messages = [
    msg({ role: 'user', content: '问题' }),
    msg({ role: 'tool', content: '工具结果', toolName: 'search' }),
    msg({ content: '出错了', status: 'error' }),
    msg({ content: '   ' }),
    msg({ content: '答案' }),
  ]
  const md = conversationToMarkdown(messages, { includeMeta: false })
  assert.ok(md.includes('问题'))
  assert.ok(md.includes('答案'))
  assert.ok(!md.includes('工具结果'))
  assert.ok(!md.includes('出错了'))
})

test('只有图片、正文为空的消息也要导出（附件行），不能被丢掉', () => {
  const messages = [
    msg({
      role: 'user',
      content: '',
      attachments: [
        { id: 'a1', name: '海边.png', mime: 'image/png', size: 100, kind: 'image', dataUrl: 'data:image/png;base64,AAAA' },
      ] as never,
    }),
  ]
  assert.equal(exportableMessages(messages).length, 1)
  const md = conversationToMarkdown(messages, { includeMeta: false })
  assert.ok(md.includes('[附件] 海边.png'))
  assert.ok(!md.includes('base64'), '不能把 data URL 塞进 markdown')
})

test('多个附件每个一行，顺序跟消息里一致', () => {
  const md = messageToMarkdown(msg({
    content: '看这几张',
    attachments: [
      { id: 'a1', name: '一.png', mime: 'image/png', size: 1, kind: 'image' },
      { id: 'a2', name: '二.txt', mime: 'text/plain', size: 1, kind: 'text', text: 'x' },
    ] as never,
  }), {})
  assert.ok(md.includes('> [附件] 一.png'))
  assert.ok(md.includes('> [附件] 二.txt'))
  assert.ok(md.indexOf('一.png') < md.indexOf('二.txt'))
})

test('消息之间留一个空行，两节不会粘在一起', () => {
  const md = conversationToMarkdown([msg({ content: '甲' }), msg({ content: '乙' })], { includeMeta: false })
  assert.ok(md.includes('甲\n\n### '))
})

test('不传标题时没有一级标题，只有正文', () => {
  const md = conversationToMarkdown([msg({ content: '正文' })], { includeMeta: false })
  assert.ok(!md.startsWith('# '))
  assert.ok(md.startsWith('### '))
})

test('元信息：没传模型名时只留时间，不出现空的「·」', () => {
  const md = conversationToMarkdown([msg({ content: '正文' })], { includeMeta: true, model: '' })
  const lastLine = md.trimEnd().split('\n').at(-1) ?? ''
  assert.ok(lastLine.startsWith('> '))
  assert.ok(!lastLine.includes('·'))
})

test('文件名：超长标题截到 40 字，日期后缀保留', () => {
  const name = markdownFileName('海'.repeat(80), new Date(2026, 0, 1))
  assert.ok(name.endsWith('-20260101.md'))
  assert.equal(name.length, 40 + '-20260101.md'.length)
})

test('文件名：非法字符换成空格，词不会粘在一起', () => {
  const name = markdownFileName('a/b', new Date(2026, 0, 1))
  assert.ok(name.startsWith('a b-'))
})

test('文件名：月日补零', () => {
  assert.ok(markdownFileName('标题', new Date(2026, 0, 5)).endsWith('-20260105.md'))
})

test('单条文件名：助手消息用助手名做前缀', () => {
  const name = messageMarkdownFileName(msg({ content: '答案内容' }), '深鲸', new Date(2026, 0, 1))
  assert.ok(name.startsWith('深鲸-'))
  assert.ok(name.includes('答案内容'))
})
