/**
 * 网页账号中继脚本 —— 注入 chat.deepseek.com 后，替用户「发消息 / 读回话」。
 *
 * 设计约束和 mountPet 一致：
 *   1. 这个函数会被 toString() 序列化后丢进别的页面执行，所以不许 import、
 *      不许引用模块级变量、只能写在函数体内；
 *   2. 必须是幂等的：deepseek 登录后会整页重载，脚本会在每次 dom-ready 重新注入。
 *
 * 为什么这么做：我们不去逆向 deepseek 的接口（那要处理 PoW / token 刷新），
 * 而是「遥控那个已登录的真浏览器」——登录态、Cookie、反爬都由浏览器自己处理。
 */

export type RelayState = {
  /** 是否正在等助手回话。 */
  busy: boolean
  /** 已经收到的正文。 */
  text: string
  /** 已经收到的思考过程（网页版「深度思考」折叠块里的内容）。 */
  reasoning?: string
  /** 本次回复是否结束。 */
  done: boolean
  /** 出错了的话，这里是一句人话。 */
  error?: string
}

/**
 * 注入脚本。返回一个可执行字符串，内部会挂 window.__deepseaRelay。
 *
 * 暴露三个方法：
 *   - setContext(text)  把人设/记忆前缀记下来，之后每条消息都拼在前面
 *   - send(text)        把一段话填进输入框并点发送，返回是否成功
 *   - getState()        读当前这条回复的进度（供主进程轮询）
 */
export function webRelayScript(): string {
  return ';(' + relayBootstrap.toString() + ')();'
}

function relayBootstrap(): void {
  var KEY = '__deepseaRelay'
  /**
   * localStorage 里记住「这段网页对话已经拼过哪一版设定」。
   *
   * 必须存在页面里而不是闭包里：App 一退出（WebView 重建 → 页面重载 → 脚本重新注入），
   * 闭包里的标记就没了，同一段网页对话又会被灌一遍人设——用户看到的就是
   * 「退出再进来，网页版又发了一次设定」。
   */
  var CTX_KEY = '__deepseaCtxSent'

  // 已经挂过就只刷新一下，避免重复绑定事件。
  var existing = (window as unknown as Record<string, unknown>)[KEY] as
    | { refresh?: () => void }
    | undefined
  if (existing !== undefined && typeof existing.refresh === 'function') {
    existing.refresh()
    return
  }

  var ctxPrefix = ''
  var busy = false
  var collected = ''
  var reasoning = ''
  var done = false
  var errorText = ''
  var baseline = 0
  /** 发送那一刻页面上已有多少个思考块，之后的增量才是本轮的。 */
  var baselineReasoning = 0
  /** 正文连续多少次轮询没变化。够了就认为这条回复结束。 */
  var stableTicks = 0
  /** 判定「说完了」需要的稳定轮询次数（400ms 一次 ≈ 2 秒）。 */
  var STABLE_TICKS = 5
  var pollTimer = 0
  var startedAt = 0

  /** 回复气泡的候选选择器。deepseek 改版时优先在这里补。 */
  var ANSWER_SELECTORS = [
    '.ds-markdown.ds-assistant-message-main-content',
    '.ds-assistant-message-main-content',
    '.ds-markdown',
  ]

  /**
   * 思考过程的候选选择器。
   *
   * 网页版把「深度思考」折叠在一段独立容器里，正文和它是两个节点。这里用
   * 类名片段匹配，因为 DeepSeek 的类名是哈希的，但思考块一直带语义前缀：
   *   - ds-think-content / ds-thinking-*   官方现用
   *   - think / reasoning / cot           历史版本与改版
   * 命中多个时取最后一个（当前这条回复的）。
   */
  var REASONING_SELECTORS = [
    '.ds-think-content',
    '[class*="ds-think"]',
    '[class*="thinking"]',
    '[class*="reasoning"]',
    '[class*="cot-content"]',
  ]

  /** 思考块的标题文案，用来在兜底扫描时认出容器。 */
  var REASONING_TITLES = ['已深度思考', '深度思考', '思考过程', 'Thinking', 'Reasoning']

  /** 输入框候选。 */
  var INPUT_SELECTORS = [
    'textarea',
    'div[contenteditable="true"]',
    '[contenteditable="true"]',
  ]

  function queryFirst(selectors: string[]): Element | null {
    for (var i = 0; i < selectors.length; i += 1) {
      var nodes = document.querySelectorAll(selectors[i])
      if (nodes.length > 0) return nodes[nodes.length - 1]
    }
    return null
  }

  function answerNodes(): Element[] {
    for (var i = 0; i < ANSWER_SELECTORS.length; i += 1) {
      var nodes = document.querySelectorAll(ANSWER_SELECTORS[i])
      if (nodes.length > 0) {
        var out: Element[] = []
        for (var j = 0; j < nodes.length; j += 1) out.push(nodes[j])
        return out
      }
    }
    return []
  }

  function textOf(node: Element | null): string {
    if (node === null) return ''
    var text = node.textContent
    return text === null ? '' : text
  }

  /** 读「这段网页对话已经拼过哪一版设定」。读不到就当没拼过。 */
  function readSentContext(): string {
    try {
      var value = window.localStorage.getItem(CTX_KEY)
      return value === null ? '' : value
    } catch (error) {
      // 隐私模式/禁用存储：退化成「每次重新拼」，至少不会漏设定。
      return ''
    }
  }

  function writeSentContext(text: string): void {
    try {
      window.localStorage.setItem(CTX_KEY, text)
    } catch (error) {
      /* 存不进去就只影响去重，不影响发送 */
    }
  }

  /**
   * 这个网页对话是不是空的。
   *
   * 页面重载后 deepseek 可能恢复上次那段对话，也可能停在一段新对话上；
   * 两者的区别就是页面上有没有助手气泡。空对话必须重新拼设定，
   * 否则模型完全不知道自己是「深鲸」。
   */
  function conversationIsEmpty(): boolean {
    return answerNodes().length === 0
  }

  /** 找到「发送」按钮：优先 aria-label，其次看输入框所在表单里的 button。 */
  function findSendButton(input: Element | null): HTMLElement | null {
    var byLabel = document.querySelectorAll('button[aria-label], button[title]')
    for (var i = 0; i < byLabel.length; i += 1) {
      var label = (byLabel[i].getAttribute('aria-label') ?? '') + (byLabel[i].getAttribute('title') ?? '')
      if (/send|发送|提交/i.test(label)) return byLabel[i] as HTMLElement
    }
    if (input !== null) {
      var form = input.closest('form')
      if (form !== null) {
        var buttons = form.querySelectorAll('button')
        for (var k = buttons.length - 1; k >= 0; k -= 1) {
          if ((buttons[k] as HTMLButtonElement).disabled !== true) return buttons[k] as HTMLElement
        }
      }
    }
    return null
  }

  /**
   * 把文本塞进输入框。
   *
   * 关键点：网页版的编辑器是 React 受控组件，直接改 .value 它自己的状态不知道，
   * 于是点发送后它「清空」清的是它以为的空值——输入框里的字就留在那儿了。
   * 必须走原型上的原生 setter 再派发 input 事件，React 才会把这次修改收进它的
   * 状态里，之后它自己清空才能真的清掉。
   */
  function fillInput(input: Element, text: string): boolean {
    if (input instanceof HTMLTextAreaElement) {
      var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      if (setter !== undefined && setter.set !== undefined) setter.set.call(input, text)
      else input.value = text
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    if (input instanceof HTMLElement) {
      input.focus()
      // contenteditable 走 execCommand 更接近真人输入：React 的 onInput 会收到，
      // 而且不会破坏它内部的光标/选区状态。
      var ok = false
      try {
        ok = document.execCommand('selectAll', false, undefined)
        if (ok) document.execCommand('insertText', false, text)
      } catch (error) {
        ok = false
      }
      if (!ok) {
        input.textContent = text
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
      }
      return true
    }
    return false
  }

  /**
   * 发送之后把输入框清空。
   *
   * 只依赖网页自己清空是不够的：它清的是它状态里的值，而我们写进去的字
   * 有时没进它的状态（尤其是 contenteditable 的编辑器）。这里主动再清一次，
   * 用户才不会看到自己刚发出去的话还留在输入框里。
   */
  function clearInput(): void {
    var input = queryFirst(INPUT_SELECTORS)
    if (input === null) return
    if (input instanceof HTMLTextAreaElement) {
      if (input.value === '') return
      fillInput(input, '')
      return
    }
    if (input instanceof HTMLElement) {
      if ((input.textContent ?? '') === '') return
      input.focus()
      try {
        document.execCommand('selectAll', false, undefined)
        document.execCommand('delete', false, undefined)
      } catch (error) {
        input.textContent = ''
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }))
      }
    }
  }

  /**
   * 读本轮回复的正文。
   *
   * 关键：网页版的「深度思考」块和正文常常是**同级**的 .ds-markdown 节点，
   * 按「第 baseline 个之后」取会把思考块也算进正文里（用户看到的就是思考
   * 混进回答）。所以这里逐个节点判定：落在思考容器里的跳过，剩下的才算正文。
   */
  function readLatest(): string {
    var nodes = answerNodes()
    if (nodes.length === 0) return ''
    var out = ''
    for (var i = 0; i < nodes.length; i += 1) {
      // 跳过发送前就存在的节点（属于历史轮次）。
      if (i < baseline) continue
      if (insideReasoning(nodes[i])) continue
      var piece = textOf(nodes[i]).trim()
      if (piece !== '') out += (out === '' ? '' : '\n') + piece
    }
    return out
  }

  /** 这个节点是不是落在某个思考容器里面。 */
  function insideReasoning(node: Element): boolean {
    for (var i = 0; i < REASONING_SELECTORS.length; i += 1) {
      if (node.closest(REASONING_SELECTORS[i]) !== null) return true
    }
    // 兜底：祖先里带「深度思考」这类标题文案的，也算思考块。
    var parent = node.parentElement
    var guard = 0
    while (parent !== null && guard < 6) {
      var head = textOf(parent).replace(/\s+/g, '')
      if (head.indexOf('已深度思考') === 0 || head.indexOf('深度思考') === 0) return true
      parent = parent.parentElement
      guard += 1
    }
    return false
  }

  /**
   * 页面上现在有多少个思考块。发送前记一次，之后只看新增的。
   */
  function countReasoning(): number {
    for (var i = 0; i < REASONING_SELECTORS.length; i += 1) {
      var nodes = document.querySelectorAll(REASONING_SELECTORS[i])
      if (nodes.length > 0) return nodes.length
    }
    return 0
  }

  /**
   * 读「深度思考」折叠块里的文字。
   *
   * 优先按类名找；找不到再兜底扫一遍，看哪个容器里有「已深度思考 / 深度思考」
   * 这类标题，取它旁边那块正文。取不到就返回空串——思考过程是加分项，
   * 不该因为它把整条回复搞坏。
   */
  function readReasoning(): string {
    for (var i = 0; i < REASONING_SELECTORS.length; i += 1) {
      var nodes = document.querySelectorAll(REASONING_SELECTORS[i])
      if (nodes.length === 0) continue
      var picked = ''
      // 只取 baselineReasoning 之后新增的，避免把上一轮的思考也算进来。
      for (var j = baselineReasoning; j < nodes.length; j += 1) {
        var piece = textOf(nodes[j]).trim()
        if (piece !== '') picked += (picked === '' ? '' : '\n') + piece
      }
      if (picked !== '') return picked
    }
    // 兜底：按标题文案找。
    for (var t = 0; t < REASONING_TITLES.length; t += 1) {
      var all = document.querySelectorAll('div, span, summary')
      for (var k = all.length - 1; k >= 0; k -= 1) {
        var node = all[k] as HTMLElement
        if (node.children.length !== 0) continue
        var label = (node.textContent || '').replace(/\s+/g, '')
        if (label.indexOf(REASONING_TITLES[t]) === -1) continue
        var box = node.parentElement
        if (box === null) continue
        var text = (box.textContent || '').replace(label, '').trim()
        if (text !== '') return text
      }
    }
    return ''
  }

  function tick(): void {
    if (!busy) return
    var latest = readLatest()
    if (latest !== '' && latest !== collected) {
      collected = latest
      // 正文变了就重置稳定计数：说明还在长。
      stableTicks = 0
    } else if (latest !== '') {
      stableTicks += 1
    }
    var thought = readReasoning()
    if (thought !== '' && thought !== reasoning) reasoning = thought

    // 结束判定：正文连续几次轮询都不再变化，就认为这条说完了。
    //
    // 以前靠「页面上的停止按钮消失」判断，但网页版在思考阶段本来就没有停止
    // 按钮，于是正文一出来就被误判成结束；反过来某些版本又一直挂着停止按钮，
    // 导致永远不结束（就是「一直显示正在思考」那个 bug）。用稳定性判断不依赖
    // 站点具体控件，对改版更耐受。
    var stable = stableTicks >= STABLE_TICKS && latest !== ''
    if (stable) {
      // 收尾时再抓一次思考过程：折叠块往往在回复结束后才完整。
      var finalThought = readReasoning()
      if (finalThought !== '') reasoning = finalThought
      done = true
      busy = false
      if (pollTimer !== 0) window.clearTimeout(pollTimer)
      pollTimer = 0
      return
    }
    pollTimer = window.setTimeout(tick, 400)
  }

  function send(text: string): boolean {
    var input = queryFirst(INPUT_SELECTORS)
    if (input === null) {
      errorText = '没找到对话框，先在这个窗口里打开一段对话'
      return false
    }
    // 设定只在这段网页对话里拼一次。
    //
    // 网页版自己会记住上下文，每条都拼一遍等于把设定反复灌进去：既浪费上下文，
    // 又会让网页那边看起来像用户一直在贴同一段话。判据有两条：
    //   1. 页面里已经记着这一版设定（localStorage）——跨页面重载/App 重启都有效；
    //   2. 页面里没有任何助手气泡——说明这是一段新对话，设定必须重新给。
    // 以前只看闭包里的标记，App 一重启就丢，于是每次重进都会重发一遍设定。
    var payload = text
    var injected = false
    if (ctxPrefix !== '') {
      var alreadySent = readSentContext() === ctxPrefix
      if (!alreadySent || conversationIsEmpty()) {
        payload = ctxPrefix + '\n\n' + text
        injected = true
      }
    } else {
      /*
       * 这一轮没有设定（助手关着）：顺手把旧标记清掉。
       * 覆盖「关助手时网页窗没开、setContext('') 没送到」的情况 —— 下次真正发送时
       * 把残留的 A 清掉，重新打开助手才能重新注入。
       */
      writeSentContext('')
    }
    // 先记下当前已有多少个助手气泡 / 思考块，之后的增量才是这次的回话。
    baseline = answerNodes().length
    baselineReasoning = countReasoning()
    collected = ''
    reasoning = ''
    stableTicks = 0
    done = false
    errorText = ''
    busy = true
    startedAt = Date.now()
    if (!fillInput(input, payload)) {
      busy = false
      errorText = '这个输入框填不进去'
      return false
    }
    // 填进去了才记「设定已拼过」：填不进去等于没发出去，下一轮还得拼。
    if (injected) writeSentContext(ctxPrefix)
    var button = findSendButton(input)
    if (button !== null) button.click()
    else {
      // 兜底：模拟回车。
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
    }
    // 等一拍再清：先让网页把这条读走，然后不管它自己清没清，我们都再清一次。
    window.setTimeout(clearInput, 120)
    window.setTimeout(clearInput, 600)
    if (pollTimer !== 0) window.clearTimeout(pollTimer)
    pollTimer = window.setTimeout(tick, 600)
    return true
  }

  function getState(): { busy: boolean; text: string; reasoning: string; done: boolean; error?: string } {
    return {
      busy: busy,
      text: collected,
      reasoning: reasoning,
      done: done,
      error: errorText === '' ? undefined : errorText,
    }
  }

  var api = {
    send: send,
    getState: getState,
    setContext: function (text: string): void {
      // 只记下最新的设定文本。要不要拼进下一条消息，由 send 里按「页面里记的是不是
      // 这一版」「页面是不是空对话」判断——上层每轮发送前都会同步一次设定，
      // 这里要是无条件重置标记，人设就会被每条消息重复灌进网页对话。
      ctxPrefix = text
      /*
       * 空设定 = 助手被关掉了：连「这一版已经拼过」的标记一起清掉。
       *
       * 不清的话，用户重新打开同一个助手、人设一个字都没变时，
       * send 里的 alreadySent 仍然成立，人设会被永久跳过。
       * 只清标记，不动网页对话本身（旧消息本来也撤不回来）。
       */
      if (text === '') writeSentContext('')
    },
    /** 页面重载后脚本会重跑，这里给老引用一个刷新入口。 */
    refresh: function (): void {
      /* no-op */
    },
  }

  ;(window as unknown as Record<string, unknown>)[KEY] = api
}