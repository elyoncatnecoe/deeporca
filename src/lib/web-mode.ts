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
          var carry = ''
          var stream = new ReadableStream<Uint8Array>({
            start: function (controller: ReadableStreamDefaultController<Uint8Array>): void {
              function pump(): void {
                reader.read().then(function (chunk: ReadableStreamReadResult<Uint8Array>): void {
                  if (chunk.done) {
                    if (carry !== '') controller.enqueue(encoder.encode(carry))
                    controller.close()
                    return
                  }
                  var value = chunk.value === undefined ? new Uint8Array(0) : chunk.value
                  var text = carry + decoder.decode(value, { stream: true })
                  carry = ''
                  // 保留可能是半个 CONTENT_FILTER 的尾巴，等下一段拼完整再改写。
                  var keep = text.length
                  for (var k = 1; k < MARK.length; k += 1) {
                    if (text.slice(text.length - k) === MARK.slice(0, k)) {
                      keep = text.length - k
                      break
                    }
                  }
                  carry = text.slice(keep)
                  var out = text.slice(0, keep).split(MARK).join('FINISHED')
                  if (out !== '') controller.enqueue(encoder.encode(out))
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
              return typeof value === 'string' ? value.split(MARK).join('FINISHED') : value
            },
          })
        }
      }
    } catch (error) {
      /* 改不了就算了，不打断 fetch 那条路 */
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
        mountPetOnce()
      }, 500)
    })
    observer.observe(document.body, { childList: true, subtree: true })

    // SPA 偶尔整块换掉 body，观察器可能丢；低频兜底
    window.setInterval(function (): void {
      syncAvatars()
      revealCensored()
      mountPetOnce()
    }, 4000)

    ;(window as unknown as { deepseaAvatars?: unknown }).deepseaAvatars = {
      sync: syncAvatars,
      /** 手动解除内容遮挡（控制台里调一下，遇到拦截时立刻还原一次）。 */
      reveal: revealCensored,
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
