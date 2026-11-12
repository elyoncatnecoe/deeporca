import test from 'node:test'
import assert from 'node:assert/strict'
import { webRelayScript } from '../src/lib/web-relay.ts'

/**
 * 行为测试：把中继脚本真的丢进一个假页面里跑。
 *
 * 复现的 bug：App 退出（WebView 重建 → 页面重载 → 脚本重新注入）后，同一段网页
 * 对话又被灌了一遍人设。原因是「已拼过设定」的标记只活在闭包里，页面一重载就没了。
 * 现在标记存在页面 localStorage 里，并且用「页面里有没有助手气泡」判断是不是新对话。
 */

/** 只实现脚本用到的那几个接口。 */
function makeStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    getItem(key: string): string | null {
      return map.has(key) ? (map.get(key) as string) : null
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value))
    },
    dump(): Record<string, string> {
      return Object.fromEntries(map)
    },
  }
}

class FakeTextarea {
  private text = ''

  get value(): string {
    return this.text
  }

  set value(next: string) {
    this.text = next
  }

  dispatchEvent(): boolean {
    return true
  }

  focus(): void {
    /* 假页面不需要焦点 */
  }

  closest(): null {
    return null
  }
}

interface FakePage {
  /** 页面里已有的助手气泡；发送时用来判断「是不是新对话」。 */
  answers: { textContent: string; closest(): null; parentElement: null }[]
  textarea: FakeTextarea
  sent: string[]
}

function makePage(answerCount: number): FakePage {
  const answers = []
  for (let index = 0; index < answerCount; index += 1) {
    answers.push({ textContent: `第 ${index + 1} 条回复`, closest: () => null, parentElement: null })
  }
  return { answers, textarea: new FakeTextarea(), sent: [] }
}

/** 跑一遍中继脚本，返回它挂在 window 上的 api。 */
function bootRelay(page: FakePage, storage: ReturnType<typeof makeStorage>) {
  const button = {
    disabled: false,
    getAttribute(name: string): string {
      return name === 'aria-label' ? 'send' : ''
    },
    click(): void {
      page.sent.push(page.textarea.value)
    },
  }
  const win: Record<string, unknown> = {
    localStorage: storage,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  }
  const doc = {
    querySelectorAll(selector: string): unknown[] {
      if (selector === 'textarea') return [page.textarea]
      if (selector === 'button[aria-label], button[title]') return [button]
      if (
        selector === '.ds-markdown.ds-assistant-message-main-content'
        || selector === '.ds-assistant-message-main-content'
        || selector === '.ds-markdown'
      ) {
        return page.answers
      }
      return []
    },
    execCommand: () => false,
  }
  const factory = new Function(
    'window',
    'document',
    'HTMLTextAreaElement',
    'HTMLElement',
    'Element',
    'Event',
    'InputEvent',
    'KeyboardEvent',
    webRelayScript(),
  )
  factory(win, doc, FakeTextarea, class {}, class {}, class {}, class {}, class {})
  return win.__deepseaRelay as {
    setContext(text: string): void
    send(text: string): boolean
  }
}

const CONTEXT = '【以下是你的设定，请在整段对话里保持】\n你是「深鲸」。'

test('新对话第一条消息带设定，第二条不带', () => {
  const page = makePage(0)
  const storage = makeStorage()
  const relay = bootRelay(page, storage)
  relay.setContext(CONTEXT)

  assert.equal(relay.send('你好'), true)
  assert.ok(page.textarea.value.startsWith(CONTEXT), '第一条没有带设定')

  // 网页那边回完了：页面上多了一条助手气泡。
  page.answers.push({ textContent: '你好呀', closest: () => null, parentElement: null })
  assert.equal(relay.send('再说一句'), true)
  assert.equal(page.textarea.value, '再说一句', '第二条又把设定灌进去了')
})

test('App 重启后（页面重载、同一段对话还在）不再重发设定', () => {
  const storage = makeStorage()
  // 第一次运行：新对话，发一条，设定拼进去。
  const first = makePage(0)
  const relayA = bootRelay(first, storage)
  relayA.setContext(CONTEXT)
  relayA.send('你好')
  assert.ok(first.textarea.value.startsWith(CONTEXT))

  // 退出 App 再进来：页面重载，脚本重新注入，但 deepseek 恢复了同一段对话
  // （页面上已经有助手气泡）。设定标记存在 localStorage 里，应该还记得。
  const restored = makePage(1)
  const relayB = bootRelay(restored, storage)
  relayB.setContext(CONTEXT)
  relayB.send('我回来了')

  assert.equal(restored.textarea.value, '我回来了', '重启后又被灌了一遍设定')
})

test('App 重启后落到一段全新的空对话，设定要重新给', () => {
  const storage = makeStorage()
  const first = makePage(0)
  const relayA = bootRelay(first, storage)
  relayA.setContext(CONTEXT)
  relayA.send('你好')

  // 重载后 deepseek 停在「新对话」上：页面里一条助手气泡都没有。
  const fresh = makePage(0)
  const relayB = bootRelay(fresh, storage)
  relayB.setContext(CONTEXT)
  relayB.send('新的一段')

  assert.ok(fresh.textarea.value.startsWith(CONTEXT), '空对话没有重新给设定')
})

test('换了助手（设定文本变了）要重拼一次，之后不再重拼', () => {
  const page = makePage(1)
  const storage = makeStorage({ __deepseaCtxSent: CONTEXT })
  const relay = bootRelay(page, storage)

  relay.setContext('【以下是你的设定，请在整段对话里保持】\n你是「小蓝」。')
  relay.send('第一句')
  assert.ok(page.textarea.value.startsWith('【以下是你的设定，请在整段对话里保持】\n你是「小蓝」。'), '换人设后没有重拼')

  page.answers.push({ textContent: '好的', closest: () => null, parentElement: null })
  relay.send('第二句')
  assert.equal(page.textarea.value, '第二句', '换人设后每条都重拼了')
})

test('标记存在页面的 localStorage 里（跨页面重载）', () => {
  const page = makePage(0)
  const storage = makeStorage()
  const relay = bootRelay(page, storage)
  relay.setContext(CONTEXT)
  relay.send('你好')

  assert.equal(storage.getItem('__deepseaCtxSent'), CONTEXT, '设定没有写进 localStorage')
})
