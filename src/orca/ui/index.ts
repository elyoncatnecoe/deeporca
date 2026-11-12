import type { ThemeId } from '../scene/themes'
import { isTouchDevice } from '../quality'

export type AquariumMode = 'ambient' | 'interactive' | 'decorating'

export interface ThemeOption {
  id: ThemeId
  label: string
  emoji: string
}

export interface AquariumUIHandlers {
  onModeChange: (mode: AquariumMode) => void
  onThemeChange: (theme: ThemeId) => void
  onReset: () => void
  onClose: () => void
  onSelectDecor: (kindId: string) => void
  onPhoto: () => void
  onToggleMusic: () => void
  /** Arm / disarm feed mode. While armed, clicking a pet feeds it. */
  onFeed: () => void
  /** Put the orca back to the size it started at. */
  onResetGrowth: () => void
  /** Summon / send away the Clawd companion. */
  onToggleCompanion: () => void
  /** Summon / send away the GPT seal companion. */
  onToggleSeal: () => void
  /** Summon / send away the jellyfish companion. */
  onToggleJelly: () => void
  /** Ink outlines on/off for the orca and every companion together. */
  onToggleOutlines: () => void
}

export interface AquariumToolbar {
  root: HTMLElement
  setActiveTheme: (theme: ThemeId) => void
  setMusicEnabled: (on: boolean) => void
  setCompanionEnabled: (on: boolean) => void
  setSealEnabled: (on: boolean) => void
  setJellyEnabled: (on: boolean) => void
  setOutlinesEnabled: (on: boolean) => void
  /** Feed mode carries a ✓ while armed. */
  setFeedArmed: (on: boolean) => void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Small always-on-shell toggle button (used by the dsh plugin ambient mode). */
export function createShellToggle(onToggle: () => void): HTMLElement {
  const btn = el('button', 'orca-shell-toggle', '🐋 虎鲸海底')
  btn.type = 'button'
  btn.title = '打开虎鲸海底互动模式'
  btn.addEventListener('click', (event) => {
    event.stopPropagation()
    onToggle()
  })
  return btn
}

/** Full toolbar shown in interactive/decorating focus mode. */
export function createAquariumToolbar(handlers: AquariumUIHandlers, themes: ThemeOption[]): AquariumToolbar {
  const root = el('div', 'orca-toolbar')

  const closeBtn = el('button', 'orca-toolbar__btn', '✕ 返回')
  closeBtn.type = 'button'
  closeBtn.title = '退出互动模式'
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onClose()
  })

  /*
   * Feed is a mode, not an action. Pressing it arms the button (✓); the token
   * is only dropped once the player then clicks a pet. That two-step is what
   * keeps a stray tap from dropping food, and it leaves plain clicking free to
   * mean "pet this animal" again.
   */
  const feedBtn = el('button', 'orca-toolbar__btn', '🪙 投喂')
  feedBtn.type = 'button'
  feedBtn.title = '进入投喂模式：按钮变成 ✓ 之后，点一下虎鲸 / Clawd / 海豹，把 token 喂给它'
  feedBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onFeed()
  })

  // Paired with 投喂 on purpose: the one thing a player will want after
  // growing the orca a few times is a way back to the size it started at.
  const restoreBtn = el('button', 'orca-toolbar__btn', '↩️ 复原')
  restoreBtn.type = 'button'
  restoreBtn.title = '让小虎鲸回到原来的大小（累计吃掉多少 token 不会清零）'
  restoreBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onResetGrowth()
  })

  const decorBtn = el('button', 'orca-toolbar__btn', '🪸 布置')
  decorBtn.type = 'button'
  decorBtn.title = '进入水族缸布置模式'
  decorBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onModeChange('decorating')
  })

  const photoBtn = el('button', 'orca-toolbar__btn', '📷 拍照')
  photoBtn.type = 'button'
  photoBtn.title = '给虎鲸拍一张水族馆照片'
  photoBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onPhoto()
  })

  const resetBtn = el('button', 'orca-toolbar__btn', '♻️ 重置')
  resetBtn.type = 'button'
  resetBtn.title = '清空海底布置'
  resetBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onReset()
  })

  const outlineBtn = el('button', 'orca-toolbar__btn', '🖊️ 描边')
  outlineBtn.type = 'button'
  outlineBtn.title = '墨线描边开关：虎鲸 / Clawd / Seal-GPT 一起切换'
  outlineBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onToggleOutlines()
  })

  const musicBtn = el('button', 'orca-toolbar__btn', '🔇 音乐')
  musicBtn.type = 'button'
  musicBtn.title = '开启/关闭背景音乐'
  musicBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onToggleMusic()
  })

  // Three companions, three buttons: they are independent characters and the
  // player may keep any combination, but never two of the same one.
  const companionBtn = el('button', 'orca-toolbar__btn', '🦀 Clawd')
  companionBtn.type = 'button'
  companionBtn.title = '召唤/送走 Clawd 小伙伴（只有一只）'
  companionBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onToggleCompanion()
  })

  const sealBtn = el('button', 'orca-toolbar__btn', '🦭 Seal-GPT')
  sealBtn.type = 'button'
  sealBtn.title = '召唤/送走 Seal-GPT 小伙伴（只有一只）'
  sealBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onToggleSeal()
  })

  // 💠 rather than a jellyfish emoji: U+1FABC is Unicode 15 and does not exist
  // on the older Android WebViews this app still targets, where it renders as
  // a tofu box.
  const jellyBtn = el('button', 'orca-toolbar__btn', '💠 Userlly')
  jellyBtn.type = 'button'
  jellyBtn.title = '召唤/送走 Userlly 小伙伴（只有一只）'
  jellyBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onToggleJelly()
  })

  const themeGroup = el('div', 'orca-toolbar__themes')
  const themeButtons = new Map<ThemeId, HTMLElement>()
  for (const theme of themes) {
    const btn = el('button', 'orca-toolbar__theme', `${theme.emoji} ${theme.label}`)
    btn.type = 'button'
    btn.dataset.theme = theme.id
    btn.title = `切换到${theme.label}场景`
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      handlers.onThemeChange(theme.id)
    })
    themeGroup.append(btn)
    themeButtons.set(theme.id, btn)
  }

  root.append(closeBtn, feedBtn, restoreBtn, decorBtn, photoBtn, resetBtn, companionBtn, sealBtn, jellyBtn, outlineBtn, musicBtn, themeGroup)

  // Collapsed ☰ FAB — see .orca-menu in styles.ts. The bar is wider than a
  // phone and, more importantly, Chrome 61 (the minitool container's WebView)
  // has no env(safe-area-inset-*) support, so a top-anchored bar collides with
  // the status bar / notch. A bottom-right FAB sidesteps both: the Android nav
  // bar already reserves the space below the screen, so it needs no safe-area
  // math. The FAB is hidden in ambient mode together with the rest of the bar.
  const menu = el('div', 'orca-menu')
  const trigger = el('button', 'orca-menu__trigger', '☰')
  trigger.type = 'button'
  trigger.setAttribute('aria-label', '菜单')
  trigger.setAttribute('aria-expanded', 'false')
  const closeMenu = (): void => {
    menu.classList.remove('open')
    trigger.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onDocClick, true)
  }
  const onDocClick = (event: MouseEvent): void => {
    if (!menu.contains(event.target as Node)) closeMenu()
  }
  trigger.addEventListener('click', (event) => {
    event.stopPropagation()
    const open = menu.classList.toggle('open')
    trigger.setAttribute('aria-expanded', String(open))
    if (open) document.addEventListener('click', onDocClick, true)
    else document.removeEventListener('click', onDocClick, true)
  })
  // Tapping any item collapses the palette. Capture phase so it still fires even
  // though the buttons call stopPropagation to shield the canvas underneath.
  root.addEventListener('click', closeMenu, true)
  menu.append(trigger, root)

  return {
    root: menu,
    setActiveTheme: (theme: ThemeId) => {
      for (const [id, btn] of themeButtons) {
        btn.dataset.active = String(id === theme)
      }
    },
    setMusicEnabled: (on: boolean) => {
      musicBtn.textContent = on ? '🎵 音乐' : '🔇 音乐'
      musicBtn.dataset.active = String(on)
    },
    setCompanionEnabled: (on: boolean) => {
      companionBtn.textContent = on ? '🦀 Clawd ✓' : '🦀 Clawd'
      companionBtn.dataset.active = String(on)
    },
    setSealEnabled: (on: boolean) => {
      sealBtn.textContent = on ? '🦭 Seal-GPT ✓' : '🦭 Seal-GPT'
      sealBtn.dataset.active = String(on)
    },
    setJellyEnabled: (on: boolean) => {
      jellyBtn.textContent = on ? '💠 Userlly ✓' : '💠 Userlly'
      jellyBtn.dataset.active = String(on)
    },
    setOutlinesEnabled: (on: boolean) => {
      outlineBtn.textContent = on ? '🖊️ 描边 ✓' : '🖊️ 描边'
      outlineBtn.dataset.active = String(on)
    },
    setFeedArmed: (on: boolean) => {
      feedBtn.textContent = on ? '🪙 投喂 ✓' : '🪙 投喂'
      feedBtn.dataset.active = String(on)
    },
  }
}

/** Decor picker row shown while decorating. */
export function createDecorPicker(
  handlers: {
    onSelectDecor: (kindId: string) => void
    onBloomChange: (strength: number) => void
    onSkinChange: (skin: string) => void
    onRotateGhost: (delta: number) => void
    /** Leave decorating mode; the panel has no always-visible toolbar to do it. */
    onClose: () => void
  },
  catalog: { id: string; name: string }[],
  bloomStrength: number,
  /** False on the low tier, where the post chain has no bloom pass to tune. */
  bloomAvailable: boolean,
  skins: { id: string; label: string; dark: string; white: string }[],
  skinId: string,
): HTMLElement {
  const touch = isTouchDevice()
  const root = el('div', 'orca-decor-picker')
  // The picker used to lean on the always-visible top toolbar's ✕ to leave; now
  // that the menu is a collapsed ☰ FAB, the panel needs its own dismiss button
  // or there is no discoverable way out of decorating mode.
  const head = el('div', 'orca-decor-picker__head')
  const title = el(
    'div',
    'orca-decor-picker__title',
    touch
      ? '选装饰 → 点海底放置 · 拖动旋转 · 双指缩放'
      : '选择装饰后点击海底放置，滚轮旋转，右键删除',
  )
  const closeBtn = el('button', 'orca-decor-picker__close', '×')
  closeBtn.type = 'button'
  closeBtn.title = '完成布置'
  closeBtn.setAttribute('aria-label', '完成布置')
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onClose()
  })
  head.append(title, closeBtn)
  root.append(head)
  const row = el('div', 'orca-decor-picker__row')
  for (const item of catalog) {
    const chip = el('button', 'orca-decor-picker__chip', item.name)
    chip.type = 'button'
    chip.dataset.kind = item.id
    chip.addEventListener('click', (event) => {
      event.stopPropagation()
      handlers.onSelectDecor(item.id)
    })
    row.append(chip)
  }
  // A wheel is not available on a phone, so the rotation the wheel provides on
  // desktop is exposed as an explicit pair of buttons.
  for (const [label, delta, title2] of [
    ['↺', -0.4, '向左旋转装饰'],
    ['↻', 0.4, '向右旋转装饰'],
  ] as const) {
    const btn = el('button', 'orca-decor-picker__chip orca-decor-picker__rotate', label)
    btn.type = 'button'
    btn.title = title2
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      handlers.onRotateGhost(delta)
    })
    row.append(btn)
  }
  root.append(row)

  const glow = el('div', 'orca-decor-picker__glow')
  // No bloom pass on the low tier, so there is nothing for the slider to tune.
  if (!bloomAvailable) glow.style.display = 'none'
  const label = el('span', 'orca-decor-picker__glow-label', '光效强度')
  const value = el('span', 'orca-decor-picker__glow-value', String(bloomStrength.toFixed(2)))
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.className = 'orca-decor-picker__glow-slider'
  slider.min = '0'
  slider.max = '1.5'
  slider.step = '0.05'
  slider.value = String(bloomStrength)
  slider.addEventListener('input', (event) => {
    const v = Number((event.target as HTMLInputElement).value)
    value.textContent = v.toFixed(2)
    handlers.onBloomChange(v)
  })
  glow.append(label, slider, value)
  root.append(glow)

  const skinRow = el('div', 'orca-decor-picker__skins')
  const skinLabel = el('span', 'orca-decor-picker__glow-label', '虎鲸皮肤')
  skinRow.append(skinLabel)
  for (const skin of skins) {
    const btn = el('button', 'orca-decor-picker__chip', '')
    btn.type = 'button'
    btn.dataset.skin = skin.id
    btn.dataset.active = String(skin.id === skinId)
    btn.title = `切换到${skin.label}皮肤`
    const swatch = el('span', 'orca-decor-picker__skin-swatch')
    swatch.style.background = `linear-gradient(135deg, ${skin.dark} 0 50%, ${skin.white} 50% 100%)`
    const name = el('span', 'orca-decor-picker__skin-name', skin.label)
    btn.append(swatch, name)
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      for (const b of skinRow.querySelectorAll<HTMLElement>('[data-skin]')) {
        b.dataset.active = String(b.dataset.skin === skin.id)
      }
      handlers.onSkinChange(skin.id)
    })
    skinRow.append(btn)
  }
  root.append(skinRow)

  return root
}

