import { useEffect, useRef, useState } from 'react'
import { OrcaAquariumApp } from '../orca/app'
import { bodyMind } from '../lib/body'
import { onAppStateChange } from '../lib/platform'
import { randomPoke } from '../lib/pokes'
import { stageBridge, type StageApi } from '../lib/stage-bridge'
import { useAppStore } from '../lib/store'
import { OrcaBubble } from './OrcaBubble'

/**
 * The 3D tank is an imperative widget: React owns its lifetime, the orca app
 * owns everything inside the element. The game's own chrome is hidden by CSS;
 * only the scene and its canvas remain — the host redraws those controls in
 * React (see components/room).
 */
export function Stage() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<OrcaAquariumApp | null>(null)
  const [failed, setFailed] = useState(false)
  /*
   * 重建计数：WebGL 上下文丢了（长时间后台最常见）时 +1，整个水族馆推倒重来。
   * three 自己能从 contextlost 里恢复大部分状态，但我们的 EffectComposer/渲染目标
   * 不一定跟着恢复；重建是最稳的兜底，代价只是重拍一次场景。
   */
  const [rebuildKey, setRebuildKey] = useState(0)
  const aquariumTheme = useAppStore((state) => state.settings.aquariumTheme)
  const screen = useAppStore((state) => state.screen)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let app: OrcaAquariumApp | null = null
    try {
      app = new OrcaAquariumApp(host, { focus: true, theme: aquariumTheme })
      appRef.current = app
      const api: StageApi = {
        // ------------------------------------------------------ 对话层
        pulse: (kind) => app?.chatPulse(kind),
        pause: () => app?.pause(),
        resume: () => app?.resume(),
        setTheme: (next) => app?.setTheme(next),
        setSkin: (skin) => app?.setSkin(skin),
        perform: (directive) => app?.perform(directive),
        headPosition: () => app?.getHeadScreenPosition() ?? null,
        poke: () => app?.poke(),

        // ------------------------------------------------------ 布置层
        setRoomMode: (on) => {
          // The attribute is the only CSS hook the room screen needs; the game
          // chrome itself stays hidden either way (it is redrawn in React).
          host.dataset.room = on ? 'on' : 'off'
          if (on) return
          // Leaving the room must drop every "armed" state: a token dropped by
          // a stray tap on the chat screen is exactly what the two-step feed
          // mode exists to prevent.
          app?.setFeedArmed(false)
          app?.setMode('interactive')
        },
        getGameState: () =>
          app?.getGameState() ?? {
            mode: 'interactive',
            feedArmed: false,
            growth: 1,
            growthTarget: 1,
            feedCount: 0,
            growthFeeds: 0,
            skin: 'classic',
            bloomStrength: 0,
            music: false,
            companion: false,
            companionSeal: false,
            companionJelly: false,
            outlines: false,
            motionSpeed: 1,
            decorCount: 0,
            photoCount: 0,
          },
        onChange: (listener) => app?.onChange(listener) ?? (() => {}),

        setFeedArmed: (on) => app?.setFeedArmed(on),
        resetGrowth: () => app?.resetGrowth(),

        setDecorMode: (on) => app?.setMode(on ? 'decorating' : 'interactive'),
        getDecorKinds: () => app?.getDecorKinds() ?? [],
        selectDecor: (kindId) => app?.selectDecor(kindId),
        rotateGhost: (delta) => app?.rotateGhost(delta),
        resetDecor: () => app?.resetDecor(),
        setBloomStrength: (strength) => app?.setBloomStrength(strength),
        setMotionSpeed: (scale) => app?.setMotionSpeed(scale),

        getSkins: () => app?.getSkins() ?? [],

        takePhoto: async () => (await app?.takePhoto()) ?? null,
        getPhotos: () => app?.getPhotos() ?? [],
        deletePhoto: (id) => app?.deletePhoto(id),

        setCompanion: (on) => app?.setCompanion(on),
        setSealCompanion: (on) => app?.setSealCompanion(on),
        setJellyCompanion: (on) => app?.setJellyCompanion(on),
        setOutlines: (on) => app?.setOutlines(on),
        toggleMusic: () => app?.toggleMusic(),
      }
      stageBridge.current = api
      // Touching the body is how you get the bubble back once it has drifted
      // off, so a tap on the orca speaks just like a tap on the bubble.
      app.setPokeHandler(() => bodyMind.speak(randomPoke(), 'pet', 3200))
      // 引擎的提示（"Clawd 来啦"、"回到原来的大小"）以前写进一个被 CSS 藏掉的
      // div，等于全静默；现在转投宿主自己的 Toast。
      app.setToastHandler((text) => useAppStore.getState().actions.showToast(text))
      bodyMind.setProvider(() => ({
        ...(app as OrcaAquariumApp).getBodySnapshot(),
        screen: useAppStore.getState().screen,
      }))
      // 长后台回来最常见的是 GPU 上下文丢了：canvas 会发 webglcontextlost。
      // preventDefault 告诉浏览器「我会自己处理」，然后推倒重建（见 rebuildKey）。
      const canvas = host.querySelector('canvas')
      const onLost = (event: Event): void => {
        event.preventDefault()
        console.warn('[stage] WebGL context lost, rebuilding')
        setRebuildKey((key) => key + 1)
      }
      canvas?.addEventListener('webglcontextlost', onLost)
    } catch (error) {
      console.warn('[stage] WebGL unavailable', error)
      setFailed(true)
    }
    return () => {
      stageBridge.current = null
      appRef.current = null
      bodyMind.setProvider(null)
      app?.dispose()
    }
    // The aquarium is created once per mount; theme changes are applied below.
    // rebuildKey 变化 = 上下文丢了，重建整口缸。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildKey])

  // 回到前台：恢复渲染；如果上下文其实已经丢了（某些 ROM 不发 contextlost），
  // 用 isContextLost() 兜底判定，再重建一次。
  useEffect(() => {
    return onAppStateChange((active) => {
      if (!active) return
      const app = appRef.current
      if (app === null) return
      const canvas = hostRef.current?.querySelector('canvas')
      const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
      if (gl !== null && gl !== undefined && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
        setRebuildKey((key) => key + 1)
        return
      }
      app.resume()
    })
  }, [])

  useEffect(() => {
    appRef.current?.setTheme(aquariumTheme)
  }, [aquariumTheme])

  useEffect(() => {
    appRef.current?.setScreen(screen)
    bodyMind.setScreen(screen)
    if (screen === 'memory' || screen === 'workshop') appRef.current?.pause()
    else appRef.current?.resume()
  }, [screen])

  return (
    <div className="stage-wrap">
      <div className="stage" aria-hidden="true" ref={hostRef} />
      <OrcaBubble />
      {failed && (
        <div className="stage-fallback">
          <img src="./deepwhale.png" alt="" />
          <div>
            <strong>这片海暂时画不出来</strong>
            <span>设备没有可用的 WebGL，聊天和记忆仍然可用。</span>
          </div>
        </div>
      )}
    </div>
  )
}
