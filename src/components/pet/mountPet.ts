/**
 * 纸雕虎鲸 —— 无框架挂载器。
 *
 * 这个文件里的一切都必须能靠 `mountPet.toString()` 序列化进别的页面，所以：
 *   1. 不许 import 任何东西；
 *   2. 不许引用模块级常量（svg / css 都从参数传进来）；
 *   3. 所有辅助函数都写在 mountPet 函数体内。
 *
 * 两个容器共用同一份代码：
 *   - App 内（React）：useEffect 里调它，卸载时调返回的 dispose；
 *   - 网页模式（注入 chat.deepseek.com）：把函数体序列化后执行。
 *
 * 保留 shadow DOM：SVG 里的 #thickEdge、.orca-float 这些 id / class
 * 既不会污染 React，也不会和别人的页面撞车。
 */

export type PetPosition = { left: number; top: number }

export type PetOptions = {
  /** 边长，默认 110。 */
  size?: number
  /** 宿主层 z-index，默认 2147483647（注入网页时用）。 */
  zIndex?: number
  /** false = 纯装饰：不接收指针事件、不显示关闭按钮。 */
  interactive?: boolean
  /** true = 不出字卡（和 3D 同屏时用）。 */
  silent?: boolean
  /** 读取上次位置；不传则读 localStorage。 */
  getPosition?: () => PetPosition | null
  /** 位置变化时回调；不传则只写 localStorage。 */
  onPositionChange?: (position: PetPosition) => void
  /** 没有任何存档时的落点，默认右下角。 */
  defaultPosition?: PetPosition
  /** 用户点了关闭。 */
  onHide?: () => void
  /**
   * 右键菜单：返回「纸雕助手的默认提示词」文本。
   *
   * 网页模式下这份文本来自设置里可编辑的 webPetPrompt；手机没有右键，
   * 应用内设置页也提供同样的「复制默认提示词」按钮。
   */
  onCopyPetPrompt?: () => string
  /**
   * 右键菜单：返回要复制到剪贴板的「人设 + 常驻记忆」文本。
   *
   * 不传就不显示这个菜单项。网页模式注入时由 web-mode.ts 传一个返回
   * config 里预生成文本的回调（注入脚本没法访问 App 的 store）。
   */
  onCopyPersonaPrompt?: () => string
  /** 右键菜单：返回要复制的「记忆导出命令」文本。不传就不显示这一项。 */
  onCopyMemoryExportMarkdown?: () => string
}

export function mountPet(
  host: HTMLElement,
  svgMarkup: string,
  cssText: string,
  options: PetOptions = {},
): () => void {
  const PET_SIZE = typeof options.size === 'number' && options.size > 0 ? options.size : 110
  const SVG_SIZE = 190
  const ANGRY_THRESHOLD = 3
  const ANGRY_WINDOW = 2500
  const ANGRY_DURATION = 1750
  const SLEEP_TIMEOUT = 25000
  /** 触摸长按多久算「右键」（毫秒）。 */
  const LONG_PRESS_MS = 520
  const MAX_CARDS = 2
  const INTERACTIVE = options.interactive !== false
  const SILENT = options.silent === true

  const MESSAGES: { [key: string]: string[] } = {
    jump: ['嘿咻！🐋', '跳一个～', '看我！', '(๑•̀ㅂ•́)و✧', '咻——', '蹦！'],
    jumpRepeat: ['又跳～', '停不下来！', '跳跳跳！', '(๑>ᴗ<๑)', '累不累呀'],
    jumpAngry: ['哼！', '别烦我', '💢'],
    dorsal: ['最喜欢你摸这里 ❤', '痒痒的～', '再摸摸 (๑´ω`๑)', '好舒服～', '❤(ӦｖӦ｡)', '嘿嘿～'],
    dorsalAngry: ['走开！', '不要碰', '(╬ Ò﹏Ó)'],
    belly: ['啊呜～', '好吃！(๑´ڡ`๑)', '谢谢！', 'yummy~', '还想吃～', '美味！'],
    bellyFull: ['有点饱了…', '嗝～ (´-ω-`)', '够了啦', '吃不下了…', '别再喂了～'],
    bellyAngry: ['勉强吃一口', '哼', '下次不要了'],
    angryFirst: ['别戳了！', '生气了！💢', '(╬ Ò﹏Ó)', '真的生气了！', '哼！！'],
    angryMore: ['更生气了', '你完了 🔥', '不听不听', '৻( ˃̶͈◞◟˂̶͈ )'],
    calm: ['呼…', '算了 (￣▽￣)', '下次不许了', '原谅你了～'],
    drag: ['哇啊——', '放我下来', '去哪？', '晕…', '(ﾟДﾟ;)', '挣扎中…'],
    release: ['呼～', '回来了 (｡•́︿•̀｡)', '终于', '哎哟～'],
    sleep: ['困了…', 'Zzz', '晚安… (｡-ω-)', '打个盹'],
    wake: ['唔…', '谁啊…', '再睡一会', '(￣o￣) . z Z'],
  }

  // ---------- 宿主 ----------
  host.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:'
    + String(typeof options.zIndex === 'number' ? options.zIndex : 2147483647)
    + ';'

  const shadow: ShadowRoot = host.shadowRoot !== null ? host.shadowRoot : host.attachShadow({ mode: 'open' })
  shadow.innerHTML =
    '<style>' + cssText.split('${PET_SIZE}').join(String(PET_SIZE)) + '</style>'
    + '<div class="pet-wrapper" id="petWrapper">'
    + '<div class="cards-layer" id="cardsLayer"></div>'
    + '<div class="zzz-container"><div class="zzz">Z</div><div class="zzz">z</div><div class="zzz">z</div></div>'
    + '<div class="orca-svg-wrap" id="orcaWrap">' + svgMarkup + '</div>'
    + '<button type="button" class="close-btn" id="closeBtn" title="隐藏虎鲸">✕</button>'
    + '</div>'

  const petWrapper = shadow.getElementById('petWrapper') as HTMLDivElement
  const orcaWrap = shadow.getElementById('orcaWrap') as HTMLDivElement
  const orcaJumpLayer = shadow.getElementById('orcaJumpLayer') as unknown as SVGGElement
  const orcaMouseLayer = shadow.getElementById('orcaMouseLayer') as unknown as SVGGElement
  const orcaGroup = shadow.getElementById('orcaGroup') as unknown as SVGGElement
  const cardsLayer = shadow.getElementById('cardsLayer') as HTMLDivElement
  const closeBtn = shadow.getElementById('closeBtn') as HTMLButtonElement

  // ---------- 计时器集中管理，dispose 时一次清干净 ----------
  const timers: number[] = []
  let angryTimer = 0
  let angrySymbolInterval = 0
  let sleepTimer = 0

  function later(fn: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      const index = timers.indexOf(id)
      if (index !== -1) timers.splice(index, 1)
      fn()
    }, ms)
    timers.push(id)
    return id
  }

  function cancel(id: number): void {
    if (id === 0) return
    window.clearTimeout(id)
    window.clearInterval(id)
    const index = timers.indexOf(id)
    if (index !== -1) timers.splice(index, 1)
  }

  // ---------- 位置 ----------
  function clampIntoView(left: number, top: number): PetPosition {
    const maxLeft = Math.max(0, window.innerWidth - PET_SIZE)
    const maxTop = Math.max(0, window.innerHeight - PET_SIZE)
    return { left: Math.max(0, Math.min(maxLeft, left)), top: Math.max(0, Math.min(maxTop, top)) }
  }

  let savedPos: PetPosition | null = null
  if (typeof options.getPosition === 'function') {
    savedPos = options.getPosition()
  } else {
    try {
      const raw = window.localStorage.getItem('orcaPetPos')
      savedPos = raw === null ? null : (JSON.parse(raw) as PetPosition)
    } catch (error) {
      savedPos = null
    }
  }
  if (savedPos === null || typeof savedPos.left !== 'number' || typeof savedPos.top !== 'number') {
    savedPos = options.defaultPosition ?? {
      left: window.innerWidth - PET_SIZE - 20,
      top: window.innerHeight - PET_SIZE - 20,
    }
  }
  const startPos = clampIntoView(savedPos.left, savedPos.top)
  petWrapper.style.left = startPos.left + 'px'
  petWrapper.style.top = startPos.top + 'px'

  function savePos(): void {
    const left = parseFloat(petWrapper.style.left) || 0
    const top = parseFloat(petWrapper.style.top) || 0
    if (typeof options.onPositionChange === 'function') options.onPositionChange({ left, top })
    try {
      window.localStorage.setItem('orcaPetPos', JSON.stringify({ left, top }))
    } catch (error) {
      /* 隐私模式下 localStorage 可能不可写 */
    }
  }

  function onResize(): void {
    const next = clampIntoView(
      parseFloat(petWrapper.style.left) || 0,
      parseFloat(petWrapper.style.top) || 0,
    )
    petWrapper.style.left = next.left + 'px'
    petWrapper.style.top = next.top + 'px'
  }

  // ---------- 状态 ----------
  let isJumping = false
  let isSleeping = false
  let isAngry = false
  let isDragging = false
  let tailClickTimes: number[] = []
  let pointerState: {
    startX: number
    startY: number
    startLeft: number
    startTop: number
    startTime: number
    isDragging: boolean
    pointerId: number
  } | null = null
  let recentJumps: number[] = []
  /** 手机上「右键」就是长按：Android WebView 不一定派发 contextmenu，得自己计时。 */
  let longPressTimer = 0
  let longPressFired = false

  const lastMsgCache = new Map<string, { text: string; time: number }>()

  function pickMessage(key: string): string | null {
    const pool = MESSAGES[key]
    if (pool === undefined || pool.length === 0) return null
    const now = Date.now()
    const last = lastMsgCache.get(key)
    let text = pool[Math.floor(Math.random() * pool.length)]
    let attempts = 0
    while (last !== undefined && last.text === text && now - last.time < 1500 && attempts < 5) {
      text = pool[Math.floor(Math.random() * pool.length)]
      attempts = attempts + 1
    }
    lastMsgCache.set(key, { text, time: now })
    return text
  }

  // ---------- 字卡 ----------
  const activeCards: HTMLDivElement[] = []

  function dismissCard(card: HTMLDivElement): void {
    if (card.parentNode === null) return
    const index = activeCards.indexOf(card)
    if (index !== -1) activeCards.splice(index, 1)
    if (card.classList.contains('dismissing')) return
    card.classList.add('dismissing')
    later(() => {
      if (card.parentNode !== null) card.remove()
    }, 550)
  }

  function showSpeechCard(text: string | null, isAngryCard?: boolean): void {
    if (text === null || text === '' || SILENT) return
    while (activeCards.length >= MAX_CARDS) {
      const oldest = activeCards[0]
      activeCards.shift()
      dismissCard(oldest)
    }
    const card = document.createElement('div')
    card.className = isAngryCard === true ? 'speech-card angry' : 'speech-card'
    const rot = (Math.random() - 0.5) * 8
    card.style.setProperty('--rot', rot.toFixed(2) + 'deg')
    card.style.marginLeft = ((Math.random() - 0.5) * 30).toFixed(1) + 'px'
    const inner = document.createElement('div')
    inner.className = 'speech-card-inner'
    inner.textContent = text
    card.appendChild(inner)
    cardsLayer.appendChild(card)
    window.requestAnimationFrame(() => card.classList.add('show'))
    activeCards.push(card)
    const duration = 2200 + Math.random() * 600
    later(() => dismissCard(card), duration)
  }

  // ---------- 右键菜单 ----------
  //
  // 菜单挂在 shadow root 的直属节点上，不能放进 .pet-wrapper：关闭动画会给它加
  // transform，fixed 定位会跟着那个 transform 走。宿主是 fixed + inset:0 且没有
  // transform/filter，所以 clientX/clientY 可以直接当视口坐标用。
  const MENU_ITEMS: Array<{ label: string; run: () => string }> = []
  if (typeof options.onCopyPetPrompt === 'function') {
    MENU_ITEMS.push({ label: '📋 复制我的默认提示词', run: options.onCopyPetPrompt })
  }
  if (typeof options.onCopyPersonaPrompt === 'function') {
    MENU_ITEMS.push({ label: '🧠 复制人格 + 记忆提示词', run: options.onCopyPersonaPrompt })
  }
  if (typeof options.onCopyMemoryExportMarkdown === 'function') {
    MENU_ITEMS.push({ label: '📝 复制记忆导出命令（Markdown）', run: options.onCopyMemoryExportMarkdown })
  }

  let menuEl: HTMLDivElement | null = null

  function closeMenu(): void {
    if (menuEl !== null) menuEl.style.display = 'none'
  }

  /**
   * 兜底复制：shadow DOM 里的选区 document.execCommand('copy') 复制不到，
   * 所以临时 textarea 必须挂在 document.body 上。
   */
  function copyFallback(text: string): void {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'true')
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch (error) {
      ok = false
    }
    if (area.parentNode !== null) area.parentNode.removeChild(area)
    showSpeechCard(ok ? '已复制' : '复制失败，请手动选中')
  }

  function copyToClipboard(text: string): void {
    try {
      if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(
          () => showSpeechCard('已复制'),
          () => copyFallback(text),
        )
        return
      }
    } catch (error) {
      /* 落到兜底 */
    }
    copyFallback(text)
  }

  function ensureMenu(): HTMLDivElement {
    if (menuEl !== null) return menuEl
    const box = document.createElement('div')
    box.className = 'orca-context-menu'
    for (const item of MENU_ITEMS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'orca-context-menu-item'
      button.textContent = item.label
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        closeMenu()
        let text = ''
        try {
          text = item.run()
        } catch (error) {
          text = ''
        }
        if (typeof text !== 'string' || text.trim() === '') {
          showSpeechCard('没有可复制的内容')
          return
        }
        copyToClipboard(text)
      })
      box.appendChild(button)
    }
    shadow.appendChild(box)
    menuEl = box
    return box
  }

  function openMenu(clientX: number, clientY: number): void {
    if (MENU_ITEMS.length === 0) return
    const box = ensureMenu()
    box.style.display = 'block'
    const rect = box.getBoundingClientRect()
    const left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, clientX))
    const top = Math.max(4, Math.min(window.innerHeight - rect.height - 4, clientY))
    box.style.left = left + 'px'
    box.style.top = top + 'px'
  }

  function onMenuOutside(event: Event): void {
    if (menuEl === null || menuEl.style.display === 'none') return
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    if (path.indexOf(menuEl) !== -1) return
    closeMenu()
  }

  function onMenuKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeMenu()
  }

  // ---------- 爱心 ----------
  function spawnHearts(): void {
    for (let i = 0; i < 3; i++) {
      const heart = document.createElement('div')
      heart.className = 'heart-particle'
      const size = 8 + Math.random() * 6
      const dx = (Math.random() - 0.5) * 40
      const rise = 40 + Math.random() * 30
      const dur = 1.5 + Math.random()
      const delay = Math.random() * 0.3
      heart.style.setProperty('--hSize', size + 'px')
      heart.style.setProperty('--hDX', dx + 'px')
      heart.style.setProperty('--hRise', rise + 'px')
      heart.style.setProperty('--hDur', dur + 's')
      heart.style.setProperty('--hDelay', delay + 's')
      heart.style.left = '50%'
      heart.style.top = '20%'
      heart.innerHTML = '<div class="heart-shape"></div>'
      cardsLayer.appendChild(heart)
      later(() => {
        if (heart.parentNode !== null) heart.remove()
      }, (dur + delay) * 1000 + 200)
    }
  }

  // ---------- 生气符号 ----------
  function spawnAngrySymbol(): void {
    const symbol = document.createElement('div')
    symbol.className = 'angry-symbol'
    symbol.textContent = '💢'
    symbol.style.marginLeft = ((Math.random() - 0.5) * 20).toFixed(1) + 'px'
    symbol.style.animationDelay = (Math.random() * 0.2) + 's'
    cardsLayer.appendChild(symbol)
    later(() => {
      if (symbol.parentNode !== null) symbol.remove()
    }, 1000)
  }

  // ---------- 点哪儿了（viewBox 坐标） ----------
  function getOrcaPart(vx: number, vy: number): string {
    if (vx > 112 && vy < 98) return 'tail'
    if (Math.pow((vx - 104) / 24, 2) + Math.pow((vy - 55) / 22, 2) < 1) return 'dorsal'
    if (Math.pow((vx - 60) / 28, 2) + Math.pow((vy - 135) / 22, 2) < 1) return 'belly'
    return 'body'
  }

  function isOnOrca(vx: number, vy: number): boolean {
    return Math.pow((vx - 90) / 66, 2) + Math.pow((vy - 100) / 58, 2) < 1.2
  }

  // ---------- 互动 ----------
  function handleTailClick(): void {
    const now = Date.now()
    tailClickTimes.push(now)
    tailClickTimes = tailClickTimes.filter((time) => now - time < ANGRY_WINDOW)
    if (tailClickTimes.length >= ANGRY_THRESHOLD && !isAngry) {
      triggerAngry()
    } else if (isAngry) {
      cancel(angryTimer)
      angryTimer = later(calmDown, ANGRY_DURATION)
      spawnAngrySymbol()
      showSpeechCard(pickMessage('angryMore'), true)
    }
  }

  function handleDorsalClick(): void {
    if (isJumping) return
    triggerJump()
    spawnHearts()
    showSpeechCard(pickMessage(isAngry ? 'dorsalAngry' : 'dorsal'), isAngry)
  }

  function handleBellyClick(): void {
    if (isJumping) return
    triggerJump()
    showSpeechCard(pickMessage(isAngry ? 'bellyAngry' : 'belly'), isAngry)
  }

  function handleBodyClick(): void {
    if (isJumping) return
    triggerJump()
  }

  function triggerJump(): void {
    if (isJumping) return
    isJumping = true
    orcaJumpLayer.classList.remove('jumping')
    void orcaJumpLayer.getBoundingClientRect()
    orcaJumpLayer.classList.add('jumping')

    const now = Date.now()
    recentJumps = recentJumps.filter((time) => now - time < 3000)
    recentJumps.push(now)
    const isRepeat = recentJumps.length >= 3

    let key = 'jump'
    if (isAngry) key = 'jumpAngry'
    else if (isRepeat) key = 'jumpRepeat'
    showSpeechCard(pickMessage(key), isAngry)

    later(() => {
      orcaJumpLayer.classList.remove('jumping')
      isJumping = false
      resetSleepTimer()
    }, 1250)
  }

  function triggerAngry(): void {
    isAngry = true
    orcaGroup.classList.add('angry')
    orcaMouseLayer.classList.add('angry-shake')
    spawnAngrySymbol()
    angrySymbolInterval = window.setInterval(spawnAngrySymbol, 800)
    angryTimer = later(calmDown, ANGRY_DURATION)
    showSpeechCard(pickMessage('angryFirst'), true)
  }

  function calmDown(): void {
    isAngry = false
    tailClickTimes = []
    orcaGroup.classList.remove('angry')
    orcaMouseLayer.classList.remove('angry-shake')
    cancel(angryTimer)
    if (angrySymbolInterval !== 0) {
      window.clearInterval(angrySymbolInterval)
      angrySymbolInterval = 0
    }
    showSpeechCard(pickMessage('calm'))
  }

  function startSleep(): void {
    if (isSleeping || isJumping || isDragging || isAngry) return
    isSleeping = true
    petWrapper.classList.add('sleeping')
    showSpeechCard(pickMessage('sleep'))
  }

  function wakeUp(): void {
    if (!isSleeping) return
    isSleeping = false
    petWrapper.classList.remove('sleeping')
    showSpeechCard(pickMessage('wake'))
    resetSleepTimer()
  }

  function resetSleepTimer(): void {
    cancel(sleepTimer)
    if (isSleeping) wakeUp()
    sleepTimer = later(startSleep, SLEEP_TIMEOUT)
  }

  // ---------- 指针 ----------
  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    pointerState = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: parseFloat(petWrapper.style.left) || 0,
      startTop: parseFloat(petWrapper.style.top) || 0,
      startTime: Date.now(),
      isDragging: false,
      pointerId: event.pointerId,
    }
    // 触摸没有右键：按住不动 520ms 就当右键。
    // Android WebView 的长按不一定派发 contextmenu（我们还在原生侧压掉了
    // ActionMode），所以这里自己计时，两条路谁先到都行。
    if (event.pointerType === 'touch' && MENU_ITEMS.length > 0) {
      cancel(longPressTimer)
      longPressFired = false
      const atX = event.clientX
      const atY = event.clientY
      longPressTimer = later(() => {
        longPressTimer = 0
        longPressFired = true
        openMenu(atX, atY)
      }, LONG_PRESS_MS)
    }
    try {
      orcaWrap.setPointerCapture(event.pointerId)
    } catch (error) {
      /* 某些合成事件没有可捕获的指针 */
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (pointerState === null || pointerState.pointerId !== event.pointerId) return
    const dx = event.clientX - pointerState.startX
    const dy = event.clientY - pointerState.startY
    const distance = Math.hypot(dx, dy)

    if (!pointerState.isDragging && distance > 8) {
      // 手指一动就不算长按了。
      if (longPressTimer !== 0) {
        cancel(longPressTimer)
        longPressTimer = 0
      }
      pointerState.isDragging = true
      isDragging = true
      orcaWrap.classList.add('dragging')
      orcaMouseLayer.classList.add('is-dragging')
      if (isSleeping) wakeUp()
      showSpeechCard(pickMessage('drag'))
    }

    if (pointerState.isDragging) {
      petWrapper.style.left = (pointerState.startLeft + dx) + 'px'
      petWrapper.style.top = (pointerState.startTop + dy) + 'px'
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (pointerState === null || pointerState.pointerId !== event.pointerId) return
    if (longPressTimer !== 0) {
      cancel(longPressTimer)
      longPressTimer = 0
    }
    const firedLongPress = longPressFired
    longPressFired = false
    const dx = event.clientX - pointerState.startX
    const dy = event.clientY - pointerState.startY
    const distance = Math.hypot(dx, dy)
    const duration = Date.now() - pointerState.startTime
    const wasDragging = pointerState.isDragging
    const captured = pointerState.pointerId
    pointerState = null

    try {
      orcaWrap.releasePointerCapture(captured)
    } catch (error) {
      /* 同上 */
    }

    if (wasDragging) {
      isDragging = false
      orcaWrap.classList.remove('dragging')
      orcaMouseLayer.classList.remove('is-dragging')
      const next = clampIntoView(
        parseFloat(petWrapper.style.left) || 0,
        parseFloat(petWrapper.style.top) || 0,
      )
      petWrapper.style.left = next.left + 'px'
      petWrapper.style.top = next.top + 'px'
      savePos()
      showSpeechCard(pickMessage('release'))
      resetSleepTimer()
      return
    }

    if (firedLongPress) {
      // 长按已经弹了菜单，松手别再当成「戳虎鲸」。
      resetSleepTimer()
      return
    }

    if (distance < 12 && duration < 800) {
      const rect = orcaWrap.getBoundingClientRect()
      const vx = (event.clientX - rect.left) / rect.width * SVG_SIZE
      const vy = (event.clientY - rect.top) / rect.height * SVG_SIZE
      if (!isOnOrca(vx, vy)) return
      const part = getOrcaPart(vx, vy)
      if (part === 'tail') handleTailClick()
      else if (part === 'dorsal') handleDorsalClick()
      else if (part === 'belly') handleBellyClick()
      else handleBodyClick()
      resetSleepTimer()
    }
  }

  function onPointerCancel(): void {
    if (longPressTimer !== 0) {
      cancel(longPressTimer)
      longPressTimer = 0
    }
    longPressFired = false
    if (pointerState !== null && pointerState.isDragging) {
      isDragging = false
      orcaWrap.classList.remove('dragging')
      orcaMouseLayer.classList.remove('is-dragging')
    }
    pointerState = null
  }

  function onContextMenu(event: Event): void {
    event.preventDefault()
    if (MENU_ITEMS.length === 0) return
    const mouse = event as MouseEvent
    openMenu(mouse.clientX, mouse.clientY)
  }

  // ---------- 关闭 ----------
  function onCloseClick(event: Event): void {
    event.stopPropagation()
    petWrapper.style.transition = 'opacity 0.4s ease, transform 0.4s ease'
    petWrapper.style.opacity = '0'
    petWrapper.style.transform = 'scale(0.6)'
    later(() => {
      if (typeof options.onHide === 'function') {
        options.onHide()
        return
      }
      try {
        const until = Date.now() + 24 * 60 * 60 * 1000
        window.localStorage.setItem('orcaPetHiddenUntil', String(until))
      } catch (error) {
        /* 忽略 */
      }
      dispose()
    }, 400)
  }

  // ---------- 事件挂载 ----------
  window.addEventListener('resize', onResize)
  if (INTERACTIVE) {
    orcaWrap.addEventListener('pointerdown', onPointerDown)
    orcaWrap.addEventListener('pointermove', onPointerMove)
    orcaWrap.addEventListener('pointerup', onPointerUp)
    orcaWrap.addEventListener('pointercancel', onPointerCancel)
    orcaWrap.addEventListener('contextmenu', onContextMenu)
    orcaWrap.addEventListener('dragstart', onContextMenu)
    closeBtn.addEventListener('click', onCloseClick)
    // 菜单挂在 shadow 里，点外部要靠 document 捕获阶段收（composedPath 里能认出菜单本身）。
    document.addEventListener('pointerdown', onMenuOutside, true)
    window.addEventListener('keydown', onMenuKey)
    resetSleepTimer()
  } else {
    orcaWrap.style.pointerEvents = 'none'
    closeBtn.style.display = 'none'
  }

  let disposed = false

  function dispose(): void {
    if (disposed) return
    disposed = true
    window.removeEventListener('resize', onResize)
    orcaWrap.removeEventListener('pointerdown', onPointerDown)
    orcaWrap.removeEventListener('pointermove', onPointerMove)
    orcaWrap.removeEventListener('pointerup', onPointerUp)
    orcaWrap.removeEventListener('pointercancel', onPointerCancel)
    orcaWrap.removeEventListener('contextmenu', onContextMenu)
    orcaWrap.removeEventListener('dragstart', onContextMenu)
    closeBtn.removeEventListener('click', onCloseClick)
    document.removeEventListener('pointerdown', onMenuOutside, true)
    window.removeEventListener('keydown', onMenuKey)
    if (longPressTimer !== 0) {
      cancel(longPressTimer)
      longPressTimer = 0
    }
    closeMenu()
    if (menuEl !== null && menuEl.parentNode !== null) menuEl.parentNode.removeChild(menuEl)
    menuEl = null
    for (let i = 0; i < timers.length; i++) window.clearTimeout(timers[i])
    timers.length = 0
    cancel(angryTimer)
    cancel(sleepTimer)
    if (angrySymbolInterval !== 0) window.clearInterval(angrySymbolInterval)
    angrySymbolInterval = 0
    shadow.innerHTML = ''
    host.style.cssText = ''
  }

  return dispose
}
