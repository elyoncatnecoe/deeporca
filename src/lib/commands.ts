/**
 * 本地指令 → 虎鲸动作。
 *
 * 这一层完全不碰 API：用户说「转个圈」，函数直接命中，客户端自己驱动 3D 身体
 * 并回一句预制台词。模型那边只知道「我刚才转了个圈」（见 body.ts 的 note），
 * 不需要为了做个动作多跑一轮请求。
 *
 * 设计约束：
 * - 纯函数，方便 Node 单测；不 import 任何浏览器对象。
 * - 宁可不命中，也不要误命中：闲聊里出现「圈」不该让虎鲸开始转圈。
 *   所以只认短句（<= MAX_COMMAND_LENGTH）和明确的动词短语。
 */

export type OrcaAct =
  | 'spin'
  | 'dive'
  | 'surface'
  | 'nuzzle'
  | 'blow'
  | 'sleep'
  | 'wake'
  | 'shake'
  | 'approach'
  | 'calm'
  | 'play'

export interface OrcaCommand {
  act: OrcaAct
  /** 这次动作用的心情；留空表示不改。 */
  mood?: string
  /** 预制的一句回应，直接进气泡和对话。 */
  reply: string
}

/** 超过这个长度基本是在聊天，不是在给指令。 */
export const MAX_COMMAND_LENGTH = 18

interface ActSpec {
  act: OrcaAct
  mood?: string
  /** 命中用的关键词；越靠前越优先。 */
  keys: readonly string[]
  lines: readonly string[]
}

const SPECS: readonly ActSpec[] = [
  {
    act: 'spin',
    mood: 'playful',
    keys: ['转个圈', '转一圈', '转圈', '绕一圈', 'spin'],
    lines: ['转一圈给你看。', '晕了晕了。', '看好了——转！'],
  },
  {
    act: 'dive',
    mood: 'curious',
    keys: ['下潜', '潜下去', '往下游', '沉下去', 'dive'],
    lines: ['下去了。', '下面凉一点。', '我潜深一点看看。'],
  },
  {
    act: 'surface',
    mood: 'excited',
    keys: ['上浮', '浮上来', '上来', '冒个头', 'surface'],
    lines: ['上来了。', '水面有光。', '呼——换口气。'],
  },
  {
    act: 'nuzzle',
    mood: 'playful',
    keys: ['蹭蹭', '蹭我', '贴贴', '过来蹭', 'nuzzle'],
    lines: ['蹭到了。', '唔，这里。', '再靠近一点。'],
  },
  {
    act: 'blow',
    mood: 'playful',
    keys: ['吐泡泡', '吹泡泡', '泡泡', 'blow'],
    lines: ['啵。', '泡泡飘上去了。', '给你吹一串。'],
  },
  {
    act: 'sleep',
    mood: 'sleepy',
    keys: ['睡觉', '睡吧', '去睡', '休息吧', 'sleep'],
    lines: ['那我睡了。', '晚安。', '眼睛闭上了。'],
  },
  {
    act: 'wake',
    mood: 'curious',
    keys: ['醒来', '起床', '醒醒', '别睡了', 'wake'],
    lines: ['醒了。', '嗯？我睡多久了。', '睁眼了。'],
  },
  {
    act: 'shake',
    mood: 'playful',
    keys: ['甩水', '甩甩', '抖水', 'shake'],
    lines: ['甩你一身。', '水珠飞出去了。', '凉快。'],
  },
  {
    act: 'approach',
    mood: 'curious',
    keys: ['凑近', '靠近点', '过来', '离近点', 'approach'],
    lines: ['来了。', '我在这儿。', '近一点了。'],
  },
  {
    act: 'calm',
    mood: 'calm',
    keys: ['安静', '别动', '停下', '静止', 'calm'],
    lines: ['好，不动了。', '安静下来。', '嗯。'],
  },
  {
    act: 'play',
    mood: 'playful',
    keys: ['玩一下', '玩耍', '陪我玩', '玩吧', 'play'],
    lines: ['来玩。', '追我呀。', '好玩。'],
  },
]

/** 否定词：说了「别转圈」就不该转。 */
const NEGATIONS = ['别', '不要', '不用', '不许', 'stop']

/** 上一次说的台词，避免连着两次一模一样。 */
let lastLine = ''

function pickLine(lines: readonly string[]): string {
  const pool = lines.length > 1 ? lines.filter((line) => line !== lastLine) : lines
  const line = pool[Math.floor(Math.random() * pool.length)] ?? lines[0] ?? ''
  lastLine = line
  return line
}

/** 单测用：把「不重复上一条」的状态清掉。 */
export function resetCommandState(): void {
  lastLine = ''
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s，。！？、,.!?~…]+/g, '')
    .replace(/[（(].*?[)）]/g, '')
}

/**
 * 认出「这是一句给虎鲸的指令」，返回动作和预制回应；否则 null。
 *
 * 只在短句里找关键词，且要求关键词前面没有否定词。长句子（超过
 * MAX_COMMAND_LENGTH）一律当成聊天，交给模型。
 */
export function parseCommand(text: string): OrcaCommand | null {
  const raw = text.trim()
  if (raw === '' || raw.length > MAX_COMMAND_LENGTH) return null
  const flat = normalize(raw)
  if (flat === '') return null

  for (const spec of SPECS) {
    for (const key of spec.keys) {
      const at = flat.indexOf(key.toLowerCase())
      if (at === -1) continue
      const before = flat.slice(0, at)
      if (NEGATIONS.some((word) => before.includes(word))) continue
      return {
        act: spec.act,
        ...(spec.mood !== undefined ? { mood: spec.mood } : {}),
        reply: pickLine(spec.lines),
      }
    }
  }
  return null
}

/** 动作对应的中文名，给对话里的本地回复用。 */
export const ACT_LABELS: Record<OrcaAct, string> = {
  spin: '转圈',
  dive: '下潜',
  surface: '上浮',
  nuzzle: '蹭蹭',
  blow: '吐泡泡',
  sleep: '睡觉',
  wake: '醒来',
  shake: '甩水',
  approach: '凑近',
  calm: '安静',
  play: '玩耍',
}