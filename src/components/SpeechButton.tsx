import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX, Loader2 } from 'lucide-react'
import { isSpeechConfigured, synthesizeSpeech } from '../lib/media-api'
import { useAppStore } from '../lib/store'
import type { ChatMessage } from '../lib/types'

type SpeechState = 'idle' | 'loading' | 'playing'

/**
 * 传统「朗读这条回复」按钮。
 *
 * 和模型主动调用 `speak` 是两件事：
 * - `speak` 是模型决定要生成一段语音，作为工具结果显示播放器；
 * - 这里是用户在任何助手回复上点一下喇叭，把**这条消息的文字**交给 TTS 朗读。
 *
 * 两者共用设置里的「语音 API」，互不影响；这里不写 media 表（朗读是临时播放，
 * 不是消息内容的一部分），只在组件内缓存，避免重复点击反复花钱。
 */
function splitForSpeech(text: string, maxChars = 1800): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean === '') return []
  if (clean.length <= maxChars) return [clean]
  const chunks: string[] = []
  let rest = clean
  while (rest.length > maxChars) {
    // 优先在句号/问号/感叹号/换行处断开；找不到再硬切。
    const window = rest.slice(0, maxChars)
    const punctuation = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('\n'),
    )
    const cut = punctuation > maxChars * 0.5 ? punctuation + 1 : maxChars
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

export function SpeechButton({ message }: { message: ChatMessage }) {
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [state, setState] = useState<SpeechState>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const cacheRef = useRef<string[] | null>(null)
  const requestSeq = useRef(0)

  const signature = `${message.id}:${settings.speechApi.baseUrl}:${settings.speechApi.model}:${settings.speechApi.voice}:${message.content.length}`

  useEffect(() => {
    // 消息被编辑、语音配置变了：停掉旧的朗读并清缓存。
    requestSeq.current += 1
    if (audioRef.current !== null) {
      audioRef.current.pause()
      audioRef.current = null
    }
    cacheRef.current = null
    setState('idle')
  }, [signature])

  useEffect(() => {
    return () => {
      requestSeq.current += 1
      if (audioRef.current !== null) audioRef.current.pause()
    }
  }, [])

  const playFrom = (urls: string[], index: number): void => {
    if (index >= urls.length) {
      audioRef.current = null
      setState('idle')
      return
    }
    const audio = new Audio(urls[index] as string)
    audioRef.current = audio
    audio.onended = () => playFrom(urls, index + 1)
    audio.onerror = () => {
      audioRef.current = null
      setState('idle')
      actions.showToast('这段语音播放失败，可能格式不被设备支持')
    }
    void audio.play().catch(() => {
      // 浏览器/WebView 可能因自动播放策略拒绝；这是用户点击触发的，通常不会，
      // 真被拒时退回「再点一次」而不是丢一个静默错误。
      audioRef.current = null
      setState('idle')
      actions.showToast('播放被系统拦住了，再点一次喇叭试试')
    })
  }

  const stop = (): void => {
    if (audioRef.current !== null) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setState('idle')
  }

  const onClick = async (): Promise<void> => {
    if (state === 'playing') {
      stop()
      return
    }
    if (state === 'loading') return
    if (!isSpeechConfigured(settings.speechApi)) {
      actions.showToast('语音 API 还没配置；去「设置 → 生图与语音」填一下')
      return
    }
    const text = message.content.trim()
    if (text === '') return
    setState('loading')
    try {
      const chunks = splitForSpeech(text)
      if (chunks.length === 0) {
        setState('idle')
        return
      }
      const urls = cacheRef.current ?? await (async () => {
        const generated: string[] = []
        for (const chunk of chunks) {
          const audio = await synthesizeSpeech(settings.speechApi, chunk)
          generated.push(audio.dataUrl)
        }
        return generated
      })()
      cacheRef.current = urls
      setState('playing')
      playFrom(urls, 0)
    } catch (error) {
      setState('idle')
      actions.showToast(error instanceof Error ? error.message : '语音生成失败')
    }
  }

  if (message.content.trim() === '') return null

  return (
    <button
      type="button"
      className={`bubble-act${state !== 'idle' ? ' is-speaking' : ''}`}
      onClick={() => void onClick()}
      aria-label={state === 'playing' ? '停止朗读' : state === 'loading' ? '正在生成语音' : '朗读这条回复'}
      title={state === 'playing' ? '停止朗读' : '朗读这条回复'}
    >
      {state === 'loading' ? <Loader2 size={14} className="spin" /> : state === 'playing' ? <VolumeX size={14} /> : <Volume2 size={14} />}
    </button>
  )
}
