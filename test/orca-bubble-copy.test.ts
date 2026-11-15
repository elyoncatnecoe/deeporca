import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 3D 虎鲸气泡的文案守卫。
 *
 * 那个气泡是 App 自己写死的台词，看起来就是「虎鲸本人在说话」；而助手名是用户
 * 随便改的。以前它会拼出「夜里好。我是<自定义名>。」—— 等于让 App 替用户念出
 * 任意文字，有人就是这么整活的（把名字改成坏话，气泡里就显示出来）。
 *
 * 所以这条守卫盯两件事：
 *   1. 气泡文案里不许出现用户可控的助手名（也不许用它自称）；
 *   2. 普通说话 / 打招呼不挂名字标签，只有「心里想 / 被摸了 / 在听你说」这类
 *      固定状态词才显示标签行。
 *
 * 注意：只守 3D 气泡。标题区、聊天气泡署名这些「一眼看得出是人改过的」地方
 * 保持原样，不在本条需求范围内。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

const bubble = stripComments(read('src/components/OrcaBubble.tsx'))

test('气泡文案不引用助手名，也不用名字自称', () => {
  assert.doesNotMatch(bubble, /findAssistant/, '气泡不该再去查助手名')
  assert.doesNotMatch(bubble, /\$\{name\}/, '台词里不许拼助手名')
  assert.doesNotMatch(bubble, /我是\$\{/, '不许用助手名自称')
  assert.doesNotMatch(bubble, /我是/, '气泡台词里不该再出现「我是…」这种自我介绍')
})

test('打招呼只剩问候语', () => {
  assert.match(bubble, /text: `\$\{greeting\(\)\}。`/, '打招呼台词应该是「夜里好。」这类，不带名字')
})

test('普通说话与打招呼不挂名字标签，只有固定状态词才显示标签行', () => {
  assert.match(
    bubble,
    /label: speech\.kind === 'thought' \? '心里想' : speech\.kind === 'pet' \? '被摸了' : ''/,
    '说话类气泡不挂标签',
  )
  assert.match(bubble, /label: '', text: `\$\{greeting\(\)\}。`/, '打招呼不挂标签')
  assert.match(bubble, /shown\.label !== '' &&/, '标签为空时整行不渲染')
})

test('无障碍标签也不再拼名字', () => {
  assert.doesNotMatch(bubble, /aria-label=\{`\$\{shown\.label\}：/, '空标签时会拼出「：…」这种怪串')
  assert.match(bubble, /shown\.label === '' \?/, '空标签走另一条文案')
})
