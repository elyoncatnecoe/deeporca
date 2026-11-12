import { useEffect, useMemo, useRef, useState } from 'react'
import { findAssistant } from '../lib/assistant'
import { bodyMind, type BodySpeech } from '../lib/body'
import { randomPoke } from '../lib/pokes'
import { stageBridge } from '../lib/stage-bridge'
import { useAppStore } from '../lib/store'

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return '夜里好'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

type Tone = 'say' | 'thought' | 'pet' | 'live'

interface Moment {
  label: string
  text: string
  tone: Tone
  /** Epoch ms after which the bubble fades away. Infinity while streaming. */
  until: number
}

/** How long the hello lingers when the home screen opens. */
const GREETING_DWELL = 5500

export function OrcaBubble() {
  const screen = useAppStore((state) => state.screen)
  const sending = useAppStore((state) => state.sending)
  const settings = useAppStore((state) => state.settings)
  // 气泡上署谁的名字：第一优先级助手（选中 → 退第一个），不再是单独的 orcaName。
  const name = findAssistant(settings, undefined).name
  const actions = useAppStore((state) => state.actions)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [speech, setSpeech] = useState<BodySpeech | null>(() => bodyMind.getSpeech())
  const [onScreen, setOnScreen] = useState(false)
  const [screenAt, setScreenAt] = useState(() => Date.now())
  const [tick, setTick] = useState(0)
  const hidden = screen !== 'home' && screen !== 'chat'

  useEffect(() => bodyMind.subscribe(setSpeech), [])

  useEffect(() => {
    if (speech === null) return
    const remaining = Math.max(0, speech.until - Date.now()) + 40
    const timer = window.setTimeout(() => setSpeech(bodyMind.getSpeech()), remaining)
    return () => window.clearTimeout(timer)
  }, [speech])

  // Walking back to the home screen is worth a fresh hello.
  const screenSeen = useRef(screen)
  useEffect(() => {
    if (screenSeen.current === screen) return
    screenSeen.current = screen
    setScreenAt(Date.now())
  }, [screen])

  // Follow the orca's head. Writing the transform straight to the node keeps
  // the sixty-a-second loop out of React; only entering/leaving the frame is
  // worth a render.
  useEffect(() => {
    const layer = layerRef.current
    if (layer === null) return
    let frame = 0
    let visible = false
    const tickFrame = (): void => {
      const position = stageBridge.current?.headPosition?.() ?? null
      if (position === null) {
        if (visible) {
          visible = false
          setOnScreen(false)
        }
      } else {
        if (!visible) {
          visible = true
          setOnScreen(true)
        }
        layer.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`
        layer.style.setProperty('--bubble-scale', position.scale.toFixed(3))
      }
      frame = requestAnimationFrame(tickFrame)
    }
    frame = requestAnimationFrame(tickFrame)
    return () => cancelAnimationFrame(frame)
  }, [hidden])

  /**
   * 气泡此刻该说什么，或者 null（安静）。
   *
   * 只允许两种内容：模型正在思考时的状态，以及本地预制短句（被摸、动作回应、
   * 回家问候）。**不再把回复正文塞进气泡**——正文该在对话框里读，飘在头上
   * 又慢又吵，而且刚说完就重复一遍很怪。
   */
  const moment = useMemo<Moment | null>(() => {
    const now = Date.now()
    if (speech !== null && now < speech.until) {
      return {
        label: speech.kind === 'thought' ? '心里想' : speech.kind === 'pet' ? '被摸了' : name,
        text: speech.text,
        tone: speech.kind,
        until: speech.until,
      }
    }
    // 思考中：只有一个短状态，不显示正文、不显示字数。
    if (sending) {
      return { label: '在听你说', text: '让我想一想…', tone: 'live', until: Infinity }
    }
    if (screen === 'home' && now - screenAt < GREETING_DWELL) {
      return { label: name, text: `${greeting()}。我是${name}。`, tone: 'say', until: screenAt + GREETING_DWELL }
    }
    return null
    // `tick` re-evaluates an expired moment so the bubble can fade out.
  }, [speech, sending, screen, screenAt, name, tick])

  useEffect(() => {
    if (moment === null || !Number.isFinite(moment.until)) return
    const delay = Math.max(0, moment.until - Date.now()) + 30
    const timer = window.setTimeout(() => setTick((value) => value + 1), delay)
    return () => window.clearTimeout(timer)
  }, [moment])

  // Keep the last words painted while the layer fades, so the bubble does not
  // blink to an empty shell on its way out.
  const lastMoment = useRef<Moment | null>(null)
  if (moment !== null) lastMoment.current = moment
  const shown = moment ?? lastMoment.current
  // Visibility follows the live moment, never the cached text: a stale line
  // must not keep the bubble on screen.
  const visible = moment !== null && onScreen && !hidden

  if (hidden) return null

  const poke = (): void => {
    if (screen !== 'chat') {
      actions.setScreen('chat')
      return
    }
    stageBridge.current?.poke?.()
    bodyMind.speak(randomPoke(), 'pet', 3200)
  }

  return (
    <div className="orca-bubble-layer" ref={layerRef} data-hidden={visible ? 'false' : 'true'}>
      {shown !== null && (
        <button
          type="button"
          className="orca-bubble"
          data-tone={shown.tone}
          onClick={poke}
          aria-label={`${shown.label}：${shown.text}。点击互动`}
          aria-hidden={visible ? undefined : true}
        >
          <span className="orca-bubble-top">
            <span className="orca-bubble-dot" data-live={sending ? 'true' : 'false'} />
            <span>{shown.label}</span>
          </span>
          <span className="orca-bubble-text">{shown.text}</span>
          <span className="orca-bubble-tail" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
