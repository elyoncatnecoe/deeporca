/*
 * Web Audio sound effects, synthesised on the fly — no asset files, so the
 * single-file build stays self-contained.
 *
 * Ported from photo.html's audio system (dolphin whistle, dolphin clicks,
 * bubble, and a looping triangle-wave melody), with two deliberate changes:
 *
 *  - Frequencies are shifted down into the audible band. The reference whistles
 *    at 9-12 kHz and clicks at 8-14 kHz, which is realistic for a dolphin but
 *    effectively silent on a phone's speaker; 2-4 kHz keeps the character and
 *    is actually heard.
 *  - The melody is scheduled against the AudioContext clock rather than
 *    setTimeout, so it does not drift when the tab is busy.
 *
 * The whistle itself is no longer photo.html's: it is rebuilt from
 * an early orca whistle prototype, which has the rising-then-falling contour, the
 * vibrato and the 1.5x harmonic that make a synthetic tone read as an animal.
 */

const MELODY: ReadonlyArray<readonly [number, number]> = [
  [523.25, 0.4], [587.33, 0.4], [659.25, 0.4],
  [523.25, 0.4], [659.25, 0.4], [698.46, 0.8],
  [659.25, 0.4], [587.33, 0.4], [523.25, 0.8],
  [392.00, 0.4], [440.00, 0.4], [523.25, 0.8],
  [587.33, 0.4], [659.25, 0.4], [523.25, 0.8],
  [440.00, 0.4], [392.00, 0.4], [349.23, 1.2],
]

/** Gap between melody repeats, in seconds. */
const MELODY_GAP = 0.9

export interface AudioSystem {
  /** Create/resume the context. Must be called from a user gesture. */
  unlock: () => AudioContext | null
  playWhistle: () => void
  playClicks: () => void
  playBubble: () => void
  /** Short rising chime for a good photo. */
  playChime: () => void
  /** Camera shutter: two noise-free clicks. */
  playShutter: () => void
  /** Crunchy bites, for the orca eating a dropped token. */
  playMunch: () => void
  /** A bright coin "ting" when a token goes into the water. */
  playCoin: () => void
  setMusicEnabled: (on: boolean) => void
  isMusicEnabled: () => boolean
  dispose: () => void
}

export function createAudioSystem(): AudioSystem {
  let ctx: AudioContext | null = null
  let musicGain: GainNode | null = null
  let musicEnabled = false
  let musicTimer: number | null = null

  const ensure = (): AudioContext | null => {
    try {
      if (!ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AC) return null
        ctx = new AC()
        musicGain = ctx.createGain()
        musicGain.gain.value = 0.55
        musicGain.connect(ctx.destination)
      }
      if (ctx.state === 'suspended') void ctx.resume()
      return ctx
    } catch {
      return null
    }
  }

  /** One oscillator with an exponential decay envelope. */
  const blip = (
    audio: AudioContext,
    opts: {
      type: OscillatorType
      from: number
      to?: number
      duration: number
      peak: number
      at?: number
      destination?: AudioNode
    },
  ): void => {
    const start = audio.currentTime + (opts.at ?? 0)
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = opts.type
    osc.frequency.setValueAtTime(opts.from, start)
    if (opts.to !== undefined) {
      // exponentialRamp cannot cross zero; both bounds here are positive.
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), start + opts.duration * 0.85)
    }
    gain.gain.setValueAtTime(opts.peak, start)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + opts.duration)
    osc.connect(gain)
    gain.connect(opts.destination ?? audio.destination)
    osc.start(start)
    osc.stop(start + opts.duration + 0.02)
  }

  /**
   * 虎鲸哨音。照 an early orca whistle prototype 那套重写。
   *
   * 参考文件的结构是三层叠出来的，缺一层就不像活物：
   *
   *  1. 正弦主波走「起始 → 上升 → 回落」三段频率轮廓（1800~4000 起，先抬
   *     600~1800，再落 300~700）。旧版是单纯下滑音，听起来像电子提示音。
   *  2. 5~8Hz、深度 40~70Hz 的频率颤音。这是「生物感」的全部来源 ——
   *     没有颤音，再对的频率轮廓也只是合成器。
   *  3. 1.5 倍泛音，音量压到主音的三分之一，让音色带上一点金属芯。
   *
   * 增益包络是快起音（0.05s）→ 保持到 30% → 指数衰减到底：哨音是「吹出去」
   * 的，尾巴要收干净，否则点两下会叠成一团噪音。
   *
   * 每次调用的起始音高、颤音频率与深度、时长都随机，所以连点两下不会一模一样。
   */
  const playWhistle = (): void => {
    const audio = ensure()
    if (!audio) return
    const now = audio.currentTime
    // 哨音时长 0.6~1.0 秒，和参考文件一致。
    const duration = 0.6 + Math.random() * 0.4

    // ---------- 主振荡器：哨音基调 ----------
    const osc = audio.createOscillator()
    const oscGain = audio.createGain()
    osc.type = 'sine'
    const startFreq = 1800 + Math.random() * 2200
    const peakFreq = startFreq + 600 + Math.random() * 1200
    osc.frequency.setValueAtTime(startFreq, now)
    osc.frequency.linearRampToValueAtTime(peakFreq, now + duration * 0.5)
    osc.frequency.linearRampToValueAtTime(peakFreq - 300 - Math.random() * 400, now + duration)

    // 包络：从 0 起音。注意 exponentialRamp 不能从 0 出发，所以先用 linearRamp
    // 抬到 0.18，再让指数衰减接管。
    oscGain.gain.setValueAtTime(0, now)
    oscGain.gain.linearRampToValueAtTime(0.18, now + 0.05)
    oscGain.gain.setValueAtTime(0.18, now + duration * 0.3)
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + duration)

    // ---------- 颤音调制：5~8Hz，深度 40~70Hz ----------
    const vibrato = audio.createOscillator()
    const vibratoGain = audio.createGain()
    vibrato.frequency.value = 5 + Math.random() * 3
    vibratoGain.gain.value = 40 + Math.random() * 30
    vibrato.connect(vibratoGain)
    vibratoGain.connect(osc.frequency)

    // ---------- 泛音：1.5 倍频，音量低于主音 ----------
    const harmonic = audio.createOscillator()
    const harmonicGain = audio.createGain()
    harmonic.type = 'sine'
    harmonic.frequency.setValueAtTime(startFreq * 1.5, now)
    harmonic.frequency.linearRampToValueAtTime(peakFreq * 1.5, now + duration * 0.5)
    harmonic.frequency.linearRampToValueAtTime((peakFreq - 300) * 1.5, now + duration)
    harmonicGain.gain.setValueAtTime(0, now)
    harmonicGain.gain.linearRampToValueAtTime(0.06, now + 0.05)
    harmonicGain.gain.exponentialRampToValueAtTime(0.001, now + duration)

    // ---------- 混音输出 ----------
    const merger = audio.createGain()
    merger.gain.value = 0.7
    osc.connect(oscGain)
    harmonic.connect(harmonicGain)
    oscGain.connect(merger)
    harmonicGain.connect(merger)
    merger.connect(audio.destination)

    osc.start(now)
    harmonic.start(now)
    vibrato.start(now)
    // 停得比包络晚 0.1s：正好收在衰减到底之后，不会把尾巴切出咔哒声。
    osc.stop(now + duration + 0.1)
    harmonic.stop(now + duration + 0.1)
    vibrato.stop(now + duration + 0.1)
  }

  const playClicks = (): void => {
    const audio = ensure()
    if (!audio) return
    const count = 3 + Math.floor(Math.random() * 3)
    for (let i = 0; i < count; i++) {
      blip(audio, {
        type: 'sine',
        from: 2600 + Math.random() * 1600,
        duration: 0.05,
        peak: 0.13,
        at: i * 0.06,
      })
    }
  }

  const playBubble = (): void => {
    const audio = ensure()
    if (!audio) return
    blip(audio, { type: 'sine', from: 620, to: 240, duration: 0.35, peak: 0.09 })
  }

  const playChime = (): void => {
    const audio = ensure()
    if (!audio) return
    blip(audio, { type: 'sine', from: 1318.5, to: 1760, duration: 0.4, peak: 0.07 })
  }

  const playShutter = (): void => {
    const audio = ensure()
    if (!audio) return
    blip(audio, { type: 'square', from: 1900, duration: 0.03, peak: 0.07 })
    blip(audio, { type: 'square', from: 950, duration: 0.05, peak: 0.06, at: 0.06 })
  }

  /**
   * Three quick low bites. Square waves this low and this short read as a
   * crunch rather than a tone, which is what a token being eaten needs.
   */
  const playMunch = (): void => {
    const audio = ensure()
    if (!audio) return
    for (let i = 0; i < 3; i++) {
      blip(audio, {
        type: 'square',
        from: 150 + Math.random() * 90,
        duration: 0.06,
        peak: 0.1,
        at: i * 0.1,
      })
    }
  }

  /**
   * Two high partials a hair apart — the classic coin ping. A triangle for the
   * body and a sine an octave and a fifth above for the metallic edge.
   */
  const playCoin = (): void => {
    const audio = ensure()
    if (!audio) return
    blip(audio, { type: 'triangle', from: 1568, duration: 0.16, peak: 0.06 })
    blip(audio, { type: 'sine', from: 2349, duration: 0.22, peak: 0.04, at: 0.02 })
  }

  /** Schedule the whole melody against the audio clock. */
  const scheduleMelody = (audio: AudioContext): number => {
    let offset = 0
    for (const [freq, dur] of MELODY) {
      blip(audio, {
        type: 'triangle',
        from: freq,
        duration: dur * 0.9,
        peak: 0.12,
        at: offset,
        destination: musicGain ?? audio.destination,
      })
      offset += dur
    }
    return offset
  }

  const stopMusic = (): void => {
    musicEnabled = false
    if (musicTimer !== null) {
      window.clearTimeout(musicTimer)
      musicTimer = null
    }
  }

  const startMusic = (): void => {
    const audio = ensure()
    if (!audio || musicEnabled) return
    musicEnabled = true
    const loop = (): void => {
      if (!musicEnabled || !ctx) return
      const total = scheduleMelody(ctx)
      musicTimer = window.setTimeout(loop, (total + MELODY_GAP) * 1000)
    }
    loop()
  }

  return {
    unlock: ensure,
    playWhistle,
    playClicks,
    playBubble,
    playChime,
    playShutter,
    playMunch,
    playCoin,
    setMusicEnabled: (on: boolean) => {
      if (on) startMusic()
      else stopMusic()
    },
    isMusicEnabled: () => musicEnabled,
    dispose: () => {
      stopMusic()
      if (ctx) void ctx.close().catch(() => undefined)
      ctx = null
      musicGain = null
    },
  }
}
