import petCssRaw from '../components/pet/pet.css?raw'
import petSvgRaw from '../components/pet/pet.svg?raw'
import { mountPet } from '../components/pet/mountPet'
import { DEFAULT_AVATARS } from './avatar-defaults'
import { currentAssistantAvatar } from '../components/Avatar'
import { avatarStore } from './avatars'
import { buildMemoryExportPrompt } from './persona-export'
import { useAppStore } from './store'
import { buildWebChatContextForSettings } from './web-context'

export type WebModeOptions = {
  avatar: boolean
  pet: boolean
}

type WebModeConfig = {
  avatar: boolean
  pet: boolean
  user: string | null
  assistant: string | null
  userDefault: string
  assistantDefault: string
  petSvg: string
  petCss: string
  /** 纸雕助手的默认提示词（设置里可编辑）。 */
  petPrompt: string
  /**
   * 右键菜单要复制的两段文本。
   *
   * 注入脚本跑在 chat.deepseek.com 里，访问不到 App 的 store，所以只能在这里
   * （注入那一刻）先把文本算好、随 config 带进去。改完人设/记忆后要重新打开
   * 网页版才会刷新。
   */
  personaPrompt: string
  memoryExportPrompt: string
}

/* eslint-disable complexity */
/**
 * 注入 chat.deepseek.com 的那段脚本。
 *
 * 要能被 `toString()` 序列化，所以：不 import、不引用模块级变量、不用可选链，
 * 只用 function / var。参数 `mountPetFn` 就是 mountPet 本体，由 webModeScript 拼进去。
 *
 * 真页面上的结构（2026-10 实测）：
 *   .ds-virtual-list-visible-items
 *     └ div                      ← 一行消息
 *         ├ .ds-message > .fbb737a4        ← 用户气泡（右对齐，只有一小块）
 *         └ .ds-message > .ds-markdown.ds-assistant-message-main-content  ← 助手正文
 *
 * 所以：行容器认 .ds-virtual-list-visible-items，锚点认「用户气泡 / 助手正文」，
 * 头像绝对定位贴在锚点左侧 36px 的空白处，绝不参与对方的排版和 React 树。
 */
function webModeBootstrap(config: WebModeConfig, mountPetFn: typeof mountPet): void {
  var HOST_ID = 'deepsea-pet-host'
  var STYLE_ID = 'deepsea-web-av-style'
  var AV_CLASS = 'deepsea-av'
  var ANCHOR_CLASS = 'deepsea-anchor'

  function ensureStyle(): void {
    if (document.getElementById(STYLE_ID) !== null) return
    if (document.head === null) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = [
      // overflow:visible 很关键：助手正文容器（.ds-markdown 之类）常带
      // overflow-x:auto 给代码块用，而头像是绝对定位在它里面的，
      // 一旦被它裁掉就表现为「头像被切边、露在框外」。
      '.' + AV_CLASS + '{position:absolute;top:2px;left:-36px;width:27px;height:27px;border-radius:0 !important;',
      'object-fit:contain;pointer-events:none;user-select:none;background:transparent !important;',
      'background-color:transparent !important;border:0 !important;box-shadow:none !important;z-index:2;}',
      '.' + AV_CLASS + '[data-default="true"]{object-fit:contain;border-radius:0 !important;filter:none !important;}',
      '.' + ANCHOR_CLASS + '{position:relative !important;overflow:visible !important;}',
      // 左侧没有空白可借用时（助手正文一般贴着消息列左边缘），给锚点留出
      // 34px 的槽位，把头像放进 padding 里 —— padding 属于盒子内部，
      // 即使祖先 overflow:hidden 也裁不到它。
      '.' + ANCHOR_CLASS + '[data-av-gutter="true"]{padding-left:34px !important;box-sizing:border-box !important;}',
      '.' + AV_CLASS + '[data-av-inside="true"]{left:0 !important;}',
      // 解除「内容安全」的前端遮挡：站点只用 CSS 把正文模糊/透明/文字遮罩掉，原文仍在
      // DOM 里。这里强制还原最常见几种遮挡（正常内容本来就是 none，不受影响）。
      '.ds-markdown, .ds-markdown *{filter:none !important;-webkit-text-security:none !important;text-shadow:none !important;}',
    ].join('')
    document.head.appendChild(style)
  }

  /**
   * 解锁官方「朗读 / TTS」按钮。
   *
   * 未灰度的账号前端不显示喇叭，但服务端接口是放行的：官方只读本地缓存的
   * 远程配置里每个模型的 `tts_feature` 来决定要不要显示。这里把它补成真值，
   * 并把 remoteVersion 抬高挡住服务端覆盖，然后刷新一次让前端重新读配置。
   *
   * 只改本地开关，不调接口 —— 播放器 / 音色 / 断线续传全走官方实现。
   * 用 sessionStorage 记一下，避免有异常时来回刷新。
   */
  function unlockTts(): void {
    var KEY = '__ds_remote_feature_store_model'
    var FLAG = 'deepsea-tts-unlocked'
    try {
      if (window.sessionStorage.getItem(FLAG) === '1') return
      var raw = window.localStorage.getItem(KEY)
      if (raw === null || raw === '') return
      var store = JSON.parse(raw)
      if (store === null || typeof store !== 'object') return
      var entries = store.entries
      var configs = entries && entries.model_configs && entries.model_configs.value
      if (!configs || typeof configs.length !== 'number') return
      var changed = false
      for (var i = 0; i < configs.length; i += 1) {
        var cfg = configs[i]
        if (cfg && typeof cfg === 'object' && !cfg.tts_feature) {
          cfg.tts_feature = {}
          changed = true
        }
      }
      if (!changed) {
        window.sessionStorage.setItem(FLAG, '1')
        return
      }
      store.remoteVersion = (store.remoteVersion || 0) + 1000
      window.localStorage.setItem(KEY, JSON.stringify(store))
      window.sessionStorage.setItem(FLAG, '1')
      window.location.reload()
    } catch (error) {
      /* 配置结构变了就算了，不打断其它注入 */
    }
  }

  function source(role: string): string {
    if (role === 'user') {
      return config.user !== null && config.user !== '' ? config.user : config.userDefault
    }
    return config.assistant !== null && config.assistant !== '' ? config.assistant : config.assistantDefault
  }

  function isDefault(role: string): boolean {
    if (role === 'user') return config.user === null || config.user === ''
    return config.assistant === null || config.assistant === ''
  }

  function makeAvatar(role: string): HTMLImageElement {
    var image = document.createElement('img')
    image.className = AV_CLASS
    image.setAttribute('data-role', role)
    image.setAttribute('data-default', isDefault(role) ? 'true' : 'false')
    image.setAttribute('alt', '')
    image.setAttribute('draggable', 'false')
    image.src = source(role)
    return image
  }

  function markAnchor(element: Element): void {
    if (element.classList.contains(ANCHOR_CLASS)) return
    element.classList.add(ANCHOR_CLASS)
  }

  /**
   * 摆放头像：先量「锚点左边还有多少空白」，再决定贴在左侧还是挪进 padding。
   *
   * 以前写死 `left:-36px`，等于默认「左侧一定有 36px 空白」。但助手正文容器
   * （.ds-assistant-message-main-content / .ds-markdown）通常是贴着消息列左边缘
   * 开始的，根本没有空白 —— 头像被顶到列外，被滚动容器或 markdown 的
   * overflow 裁掉一半，看起来就是「头像切边、露在框外」。
   *
   * 现在改成自适应：
   *   · 左侧空白 ≥ 30px：照旧贴在左边，偏移量夹在空白内，不会越界；
   *   · 否则：给锚点加 data-av-gutter（padding-left:34px），头像 left:0 落在
   *     padding 里。padding 属于盒子内部，祖先 overflow:hidden 也裁不到它。
   */
  function placeAvatar(anchor: Element, image: HTMLImageElement, row: Element, role: string): void {
    /*
     * 助手正文是满宽容器，左侧没有真正可借的空白；之前按「有空白就贴 negative left」摆，
     * 会被正文/标题容器的 overflow 裁掉几个像素（老 bug 的回归）。助手头像一律走进
     * padding 槽位：padding 属于盒子内部，任何祖先 overflow 都裁不到。用户气泡是右对齐
     * 小块、左侧空白充足，继续用 negative left。
     */
    if (role === 'assistant') {
      image.setAttribute('data-av-inside', 'true')
      anchor.setAttribute('data-av-gutter', 'true')
      image.style.left = ''
      return
    }
    var anchorLeft = anchor.getBoundingClientRect().left
    var rowLeft = row.getBoundingClientRect().left
    var room = anchorLeft - rowLeft
    if (room >= 30) {
      var offset = Math.min(36, Math.floor(room) - 2)
      image.removeAttribute('data-av-inside')
      anchor.removeAttribute('data-av-gutter')
      image.style.left = '-' + offset + 'px'
      return
    }
    image.setAttribute('data-av-inside', 'true')
    anchor.setAttribute('data-av-gutter', 'true')
    image.style.left = ''
  }

  /** 消息列表那一层。首选虚拟列表的已渲染容器，兜底用 .ds-markdown 的公共祖先。 */
  function rowList(): Element | null {
    var list = document.querySelector('.ds-virtual-list-visible-items')
    if (list !== null) return list
    var marks = document.querySelectorAll('.ds-markdown')
    if (marks.length === 0) return null
    var node: Element | null = marks[0].parentElement
    while (node !== null && node !== document.body) {
      var inside = 0
      for (var i = 0; i < marks.length; i += 1) {
        if (node.contains(marks[i])) inside += 1
      }
      if (inside === marks.length) return node
      node = node.parentElement
    }
    return null
  }

  function anchorFor(row: Element, role: string): Element | null {
    if (role === 'assistant') {
      var main = row.querySelector('.ds-assistant-message-main-content')
      if (main !== null) return main
      var mark = row.querySelector('.ds-markdown')
      if (mark !== null) return mark
      return row.querySelector('.ds-message')
    }
    var bubble = row.querySelector('.fbb737a4')
    if (bubble !== null) return bubble
    return row.querySelector('.ds-message')
  }

  /** DeepSeek 的正文容器有时不再挂 .ds-markdown，改认语义化的 main-content。 */
  function roleOf(row: Element): string {
    if (row.querySelector('.ds-assistant-message-main-content') !== null) return 'assistant'
    if (row.querySelector('.ds-markdown') !== null) return 'assistant'
    return 'user'
  }

  function syncAvatars(): void {
    if (!config.avatar) return
    if (document.body === null) return
    var list = rowList()
    if (list === null) return
    ensureStyle()

    var anchors: Element[] = []
    var rows = list.children
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] as HTMLElement
      var role = roleOf(row)
      // 用户行：空行（占位、过渡）跳过，免得给空气贴头像
      if (role === 'user' && (row.textContent || '').replace(/\s+/g, '') === '') continue
      if (row.getBoundingClientRect().height < 18) continue
      var anchor = anchorFor(row, role)
      if (anchor === null) continue
      anchors.push(anchor)

      var image = anchor.querySelector('.' + AV_CLASS) as HTMLImageElement | null
      if (image === null) {
        markAnchor(anchor)
        image = makeAvatar(role)
        anchor.appendChild(image)
      } else if (image.getAttribute('data-role') !== role) {
        // 虚拟列表会复用行，角色换了就换图
        image.setAttribute('data-role', role)
        image.setAttribute('data-default', isDefault(role) ? 'true' : 'false')
        image.src = source(role)
      }
      markAnchor(anchor)
      // 每轮都重新摆一次：布局变了（窗口缩放、换行、站点改版）也能自己纠正。
      placeAvatar(anchor, image, row, role)
    }

    // 清掉被复用到别处、已经不挂在锚点上的旧头像
    var all = document.querySelectorAll('.' + AV_CLASS)
    for (var k = 0; k < all.length; k += 1) {
      var node = all[k]
      var parent = node.parentElement
      if (parent === null) continue
      if (anchors.indexOf(parent) === -1 && parent.parentNode !== null) parent.removeChild(node)
    }
  }

  /**
   * 尽力解除「内容安全」的前端遮挡（模糊 / 半透明 / 文字遮罩）。
   *
   * 站点命中内容审查时往往已把原文渲染进 DOM，只是用 CSS 把它模糊/透明/遮住。这里只在
   * 正文区（.ds-markdown）及其上 3 层祖先上还原这些属性，尽量避免误伤其它界面；对正常
   * 内容这些属性本就是 none/1，是幂等的。
   */
  function revealCensored(): void {
    var marks = document.querySelectorAll('.ds-markdown')
    for (var i = 0; i < marks.length; i += 1) {
      var node: Element | null = marks[i]
      var depth = 0
      while (node !== null && node !== document.body && depth < 4) {
        var s = window.getComputedStyle(node)
        var style = (node as HTMLElement).style
        if (s.filter !== '' && s.filter !== 'none') style.setProperty('filter', 'none', 'important')
        var opacity = parseFloat(s.opacity)
        if (!isNaN(opacity) && opacity < 0.99) style.setProperty('opacity', '1', 'important')
        if (s.color === 'transparent' || /^rgba?\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(s.color)) {
          style.setProperty('color', 'inherit', 'important')
        }
        var security = (s as unknown as { webkitTextSecurity?: string }).webkitTextSecurity
        if (security !== undefined && security !== '' && security !== 'none') {
          style.setProperty('-webkit-text-security', 'none', 'important')
        }
        node = node.parentElement
        depth += 1
      }
    }
  }

  /** 最近一次聊天补全里解析出来的「真实回答」（RESPONSE 片段），用于在页面被模板替换时救回来。 */
  var capturedAnswer = ''

  /** 从原始 SSE 文本里解析出 RESPONSE 正文（对齐 electron/sse.ts 的 PatchReader，够用即可）。 */
  function parseAnswerFromSse(raw: string): string {
    var text = ''
    var lastKind = 'RESPONSE'
    function isThinking(kind: string): boolean {
      var k = kind.toUpperCase()
      return k === 'THINK' || k === 'THINKING' || k === 'REASONING' || k === 'SEARCH' || k.indexOf('TOOL') === 0
    }
    function append(kind: unknown, content: unknown): void {
      if (typeof content !== 'string' || content === '') return
      if (isThinking(String(kind === undefined ? '' : kind))) return
      text += content
    }
    function frags(list: unknown): void {
      if (!Array.isArray(list)) return
      for (var i = 0; i < list.length; i += 1) {
        var it = list[i] as Record<string, unknown> | null
        if (it === null || typeof it !== 'object') continue
        if (typeof it.type === 'string') lastKind = it.type
        if (typeof it.content === 'string') append(it.type, it.content)
      }
    }
    function patch(p: string, o: unknown, v: unknown): void {
      if (/^response\/fragments$/.test(p) && Array.isArray(v)) {
        frags(v)
        return
      }
      if (/^response\/fragments\/-1\//.test(p) && typeof v === 'string' && (o === 'APPEND' || o === 'SET' || o === undefined)) {
        append(lastKind, v)
      }
      var asRecord = v as Record<string, unknown> | null
      if (asRecord !== null && typeof asRecord === 'object' && Array.isArray(asRecord.fragments)) frags(asRecord.fragments)
    }
    function tree(v: unknown): void {
      var rec = v as Record<string, unknown>
      var inner = rec.v as Record<string, unknown> | undefined
      var r = (rec.response || (inner !== undefined ? inner.response : undefined)) as Record<string, unknown> | undefined
      if (r !== undefined && r !== null && typeof r === 'object' && Array.isArray(r.fragments)) frags(r.fragments)
    }
    function applyFrame(f: unknown): void {
      if (f === null || typeof f !== 'object') return
      var rec = f as Record<string, unknown>
      if (typeof rec.p === 'string') {
        patch(rec.p, rec.o, rec.v)
        return
      }
      if (typeof rec.v === 'string') {
        append(lastKind, rec.v)
        return
      }
      if (rec.v !== null && typeof rec.v === 'object') tree(rec.v)
    }
    try {
      var lines = raw.split('\n')
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i]
        if (line.indexOf('data:') !== 0) continue
        var payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        try {
          applyFrame(JSON.parse(payload))
        } catch (error) {
          /* 半帧，跳过 */
        }
      }
    } catch (error) {
      return ''
    }
    return text
  }

  var REFUSAL_MARKERS = ['暂时无法回答', '换个话题', '无法提供', '无法回答', '无法满足']

  /**
   * 处理一行 SSE。命中审查时后端会补一帧把 fragments 整个换成 TEMPLATE_RESPONSE
   * （见真实抓包：{"p":"fragments","v":[{"type":"TEMPLATE_RESPONSE",...}]}），前端照做就把
   * 已渲染的真实回答覆盖成模板。这里把这一帧里的 fragments 替换补丁改成前端不认的
   * 路径（等于丢弃），并把 CONTENT_FILTER 改成 FINISHED，真实回答就留住了。
   */
  function fixSseLine(line: string): string {
    if (line.indexOf('data:') !== 0) return line
    if (line.indexOf('TEMPLATE_RESPONSE') !== -1) {
      var out = line.split('"p":"fragments"').join('"p":"__ds_fragments_ignored"')
      return out.split('CONTENT_FILTER').join('FINISHED')
    }
    return line.split('CONTENT_FILTER').join('FINISHED')
  }

  /** 最后一条助手气泡若显示的是审查模板、而我们抓到了真实回答，就把模板换成真实回答。 */
  function applyCapturedAnswer(): void {
    if (capturedAnswer === '') return
    var marks = document.querySelectorAll('.ds-markdown')
    if (marks.length === 0) return
    var last = marks[marks.length - 1] as HTMLElement
    var current = last.textContent === null ? '' : last.textContent
    // 只处理「短模板」：正常长回答里也可能出现「抱歉」之类的词，别误替换。
    if (current.length > 120) return
    var hit = false
    for (var i = 0; i < REFUSAL_MARKERS.length; i += 1) {
      if (current.indexOf(REFUSAL_MARKERS[i]) !== -1) {
        hit = true
        break
      }
    }
    if (!hit || current === capturedAnswer) return
    last.textContent = capturedAnswer
  }

  /**
   * 去掉网页版的「安全拦截」。
   *
   * 站点命中内容审查时，会在流里把 status 置成 CONTENT_FILTER，前端随之丢弃已经渲染的
   * 真实回答、改显示一句「暂时无法回答」的模板。真实正文其实在同一股流里早就下发过了
   * （所以「前端能监听到」）。这里在 fetch 层把流里的 CONTENT_FILTER 改写成 FINISHED，
   * 前端就会正常把真实回答留在界面上。只拦 /api/v0/chat/ 的 SSE；改写是流式的，跨分片
   * 被切断的标记用 carry 兜住。
   */
  function uncensorStream(): void {
    var win = window as unknown as { __deepseaUncensor?: boolean }
    if (win.__deepseaUncensor === true) return
    if (typeof window.fetch !== 'function') return
    win.__deepseaUncensor = true
    var origFetch = window.fetch
    var MARK = 'CONTENT_FILTER'
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      var url = ''
      try {
        url = typeof input === 'string' ? input : (input as Request).url || ''
      } catch (error) {
        url = ''
      }
      var pending = origFetch.call(window, input, init)
      if (url.indexOf('/api/v0/chat/') === -1) return pending
      return pending.then(function (resp: Response): Response {
        try {
          if (resp === null || resp.body === null || typeof resp.body.getReader !== 'function') return resp
          var contentType = (resp.headers && resp.headers.get('content-type')) || ''
          if (contentType.indexOf('text/event-stream') === -1) return resp
          var reader = resp.body.getReader()
          var decoder = new TextDecoder()
          var encoder = new TextEncoder()
          var lineBuf = ''
          var rawAcc = ''
          var stream = new ReadableStream<Uint8Array>({
            start: function (controller: ReadableStreamDefaultController<Uint8Array>): void {
              function emit(lines: string[]): void {
                if (lines.length === 0) return
                var out = ''
                for (var li = 0; li < lines.length; li += 1) out += fixSseLine(lines[li]) + '\n'
                controller.enqueue(encoder.encode(out))
              }
              function pump(): void {
                reader.read().then(function (chunk: ReadableStreamReadResult<Uint8Array>): void {
                  if (chunk.done) {
                    if (lineBuf !== '') emit([lineBuf])
                    lineBuf = ''
                    if (rawAcc !== '') {
                      var parsed = parseAnswerFromSse(rawAcc)
                      if (parsed !== '') capturedAnswer = parsed
                      rawAcc = ''
                    }
                    controller.close()
                    return
                  }
                  var value = chunk.value === undefined ? new Uint8Array(0) : chunk.value
                  var decoded = decoder.decode(value, { stream: true })
                  rawAcc += decoded
                  lineBuf += decoded
                  var lines = lineBuf.split('\n')
                  var tail = lines.pop()
                  lineBuf = tail === undefined ? '' : tail
                  emit(lines)
                  pump()
                }).catch(function (error: unknown): void {
                  controller.error(error)
                })
              }
              pump()
            },
          })
          return new Response(stream, { status: resp.status, statusText: resp.statusText, headers: resp.headers })
        } catch (error) {
          return resp
        }
      })
    } as typeof fetch

    // 有些前端用 XHR（axios 的 xhr 适配器）跑 SSE。给 responseText 套一层 getter，
    // 读出来的内容里同样把 CONTENT_FILTER 换成 FINISHED —— 站点自己解析时就会当成正常结束。
    try {
      var xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype
      if (xhrProto !== undefined && xhrProto !== null) {
        var desc = Object.getOwnPropertyDescriptor(xhrProto, 'responseText')
        var getter = desc === undefined ? undefined : (desc.get as ((this: XMLHttpRequest) => string) | undefined)
        if (getter !== undefined) {
          var boundGetter: (this: XMLHttpRequest) => string = getter
          Object.defineProperty(xhrProto, 'responseText', {
            configurable: true,
            enumerable: desc !== undefined && desc.enumerable === true,
            get: function (this: XMLHttpRequest): string {
              var value = boundGetter.call(this)
              if (typeof value !== 'string' || value === '') return value
              var cache = this as unknown as { __dsLen?: number; __dsOut?: string }
              if (cache.__dsLen === value.length && typeof cache.__dsOut === 'string') return cache.__dsOut
              var parts = value.split('\n')
              for (var pi = 0; pi < parts.length; pi += 1) parts[pi] = fixSseLine(parts[pi])
              var outValue = parts.join('\n')
              cache.__dsLen = value.length
              cache.__dsOut = outValue
              return outValue
            },
          })
        }
      }
    } catch (error) {
      /* 改不了就算了，不打断 fetch 那条路 */
    }

    // XHR 流式：load 时把整段响应原文也解析一遍，抓到真实回答就存起来。
    try {
      var proto2 = window.XMLHttpRequest && window.XMLHttpRequest.prototype
      if (proto2 !== undefined && proto2 !== null) {
        var origOpen = proto2.open
        if (typeof origOpen === 'function') {
          proto2.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void {
            ;(this as unknown as { __deepseaUrl?: string }).__deepseaUrl = String(url)
            ;(origOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest])
          } as unknown as typeof origOpen
        }
        var origSend = proto2.send
        if (typeof origSend === 'function') {
          proto2.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
            var xhr = this
            try {
              xhr.addEventListener('load', function (): void {
                try {
                  var u = String((xhr as unknown as { __deepseaUrl?: string }).__deepseaUrl || '')
                  if (u.indexOf('/api/v0/chat/') === -1) return
                  var body = xhr.responseText
                  if (typeof body === 'string' && body !== '') {
                    var parsed = parseAnswerFromSse(body)
                    if (parsed !== '') capturedAnswer = parsed
                  }
                } catch (error) {
                  /* 忽略 */
                }
              })
            } catch (error) {
              /* 忽略 */
            }
            ;(origSend as (...a: unknown[]) => void).apply(this, args)
          } as unknown as typeof origSend
        }
      }
    } catch (error) {
      /* 忽略 */
    }
  }

  function mountPetOnce(): void {
    if (!config.pet) return
    if (document.body === null) return
    if (document.getElementById(HOST_ID) !== null) return
    var host = document.createElement('div')
    host.id = HOST_ID
    document.body.appendChild(host)
    try {
      mountPetFn(host, config.petSvg, config.petCss, {
        size: 110,
        zIndex: 2147483000,
        interactive: true,
        // 右下角被网页皮肤的模式按钮占了，纸雕往上让一格
        defaultPosition: { left: window.innerWidth - 132, top: window.innerHeight - 268 },
        onHide: function (): void {
          host.style.display = 'none'
        },
        // 纸雕助手：默认提示词（设置里可编辑），手机上由设置页的「复制」按钮给出。
        onCopyPetPrompt: function (): string {
          return config.petPrompt
        },
        // 注入脚本里没有 store，只能复制注入那一刻算好的文本。
        onCopyPersonaPrompt: function (): string {
          return config.personaPrompt
        },
        onCopyMemoryExportMarkdown: function (): string {
          return config.memoryExportPrompt
        },
      })
    } catch (error) {
      if (host.parentNode !== null) host.parentNode.removeChild(host)
    }
  }

  function boot(): void {
    // 越早接管 fetch 越好：把内容审查的 CONTENT_FILTER 改写成 FINISHED，别让前端丢正文。
    uncensorStream()
    // 先尝试解锁官方朗读；若这次触发了刷新，后面的注入会在刷新后的 dom-ready 再来一次。
    unlockTts()
    mountPetOnce()
    syncAvatars()
    if (document.body === null) return

    var scheduled = false
    var observer = new MutationObserver(function (): void {
      if (scheduled) return
      scheduled = true
      window.setTimeout(function (): void {
        scheduled = false
        syncAvatars()
        revealCensored()
        applyCapturedAnswer()
        mountPetOnce()
      }, 500)
    })
    observer.observe(document.body, { childList: true, subtree: true })

    // SPA 偶尔整块换掉 body，观察器可能丢；低频兜底
    window.setInterval(function (): void {
      syncAvatars()
      revealCensored()
      applyCapturedAnswer()
      mountPetOnce()
    }, 4000)

    ;(window as unknown as { deepseaAvatars?: unknown }).deepseaAvatars = {
      sync: syncAvatars,
      /** 手动解除内容遮挡（控制台里调一下，遇到拦截时立刻还原一次）。 */
      reveal: revealCensored,
      /** 抓到并解析出的「真实回答」，排查用。 */
      raw: function (): string {
        return capturedAnswer
      },
      /** 控制台里 deepseaAvatars.dump() 能看到认了几行、认成什么角色 —— 排查用。 */
      dump: function (): unknown {
        var list = rowList()
        if (list === null) return { rows: 0, note: '没找到消息列表' }
        var out: Array<{ role: string; anchor: string; hasAvatar: boolean; height: number }> = []
        for (var i = 0; i < list.children.length; i += 1) {
          var row = list.children[i] as HTMLElement
          var role = roleOf(row)
          var anchor = anchorFor(row, role)
          out.push({
            role: role,
            anchor: anchor === null ? 'none' : String(anchor.className).slice(0, 40),
            hasAvatar: anchor !== null && anchor.querySelector('.' + AV_CLASS) !== null,
            height: Math.round(row.getBoundingClientRect().height),
          })
        }
        return { rows: out.length, items: out }
      },
    }
  }

  // 页面一注入就接管 fetch，抢在站点自己的请求逻辑之前（不等 DOMContentLoaded）。
  uncensorStream()

  if (document.body === null) {
    document.addEventListener('DOMContentLoaded', boot, { once: true } as AddEventListenerOptions)
  } else {
    boot()
  }
}
/* eslint-enable complexity */

/** 网页模式要注入的完整 JS：纸雕 + 头像。 */
export function webModeScript(options: WebModeOptions): string {
  // 右键菜单的两段文本：页面里访问不到 App 的 store，所以先算好随 config 带进去。
  const { settings, memories } = useAppStore.getState()
  /*
   * 网页端贴哪个「助手头像」：助手开着就用**当前助手自己的**那张，关掉才回落到设置里的。
   *
   * 以前这里永远取 avatarStore（设置级），于是用户在助手页换了头像、网页端纹丝不动 ——
   * 就是用户反馈的「两个头像打架」。
   * 注：emoji 头像没有图片源（注入脚本只画 <img>），`avatarSrc` 是空串，这里会回落到设置头像。
   */
  const ownAssistantAvatar = currentAssistantAvatar(settings).avatarSrc
  const config: WebModeConfig = {
    avatar: options.avatar,
    pet: options.pet,
    user: avatarStore.get('user'),
    assistant: ownAssistantAvatar !== '' ? ownAssistantAvatar : avatarStore.get('assistant'),
    userDefault: DEFAULT_AVATARS.user,
    assistantDefault: DEFAULT_AVATARS.assistant,
    petSvg: petSvgRaw,
    petCss: petCssRaw,
    petPrompt: settings.webPetPrompt,
    personaPrompt: buildWebChatContextForSettings(settings, memories),
    memoryExportPrompt: buildMemoryExportPrompt(settings, memories),
  }
  return (
    ';(function(){var mountPet='
    + mountPet.toString()
    + ';('
    + webModeBootstrap.toString()
    + ')('
    + JSON.stringify(config)
    + ',mountPet);})();'
  )
}
