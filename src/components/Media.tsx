import { useState } from 'react'
import { Check, Eye, EyeOff, ImagePlus, Mic, RefreshCw, Sparkles } from 'lucide-react'
import { useAppStore } from '../lib/store'
import { checkImageApiConfig, checkSpeechApiConfig, testImageConfig, testSpeechConfig } from '../lib/media-api'
import { fetchMediaModels, type MediaModel } from '../lib/media-catalog'
import type { ImageApiConfig, MediaApiProtocol, SpeechApiConfig } from '../lib/types'
import { ListTextarea, ScreenHeader, Select, Switch, headerLines, parseHeaderLines } from './ui'
import { ModelPicker } from './ModelPicker'
import { confirmDialog } from './ConfirmDialog'

const IMAGE_PROTOCOL_OPTIONS = [
  { value: 'openrouter', label: 'OpenRouter', hint: 'Image API /images' },
  { value: 'openai', label: 'OpenAI 兼容', hint: '/images/generations' },
  { value: 'gemini', label: 'Google Gemini / Imagen', hint: 'Imagen :predict / Gemini 图像生成' },
  { value: 'aliyun', label: '阿里百炼', hint: '万相 / Qwen-Image 同步接口' },
]

const SPEECH_PROTOCOL_OPTIONS = [
  { value: 'openrouter', label: 'OpenRouter', hint: 'Chat Completions 音频输出' },
  { value: 'openai', label: 'OpenAI 兼容', hint: '/audio/speech' },
  { value: 'gemini', label: 'Google Gemini TTS', hint: 'generateContent 音频输出' },
  { value: 'minimax', label: 'MiniMax TTS', hint: '/t2a_v2' },
  { value: 'aliyun', label: '阿里百炼 TTS', hint: 'Qwen-TTS' },
  { value: 'elevenlabs', label: 'ElevenLabs', hint: '/v1/text-to-speech' },
]

const IMAGE_DEFAULT_BASE: Record<MediaApiProtocol, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  aliyun: 'https://dashscope.aliyuncs.com/api/v1',
  minimax: 'https://api.minimaxi.com/v1',
  elevenlabs: 'https://api.elevenlabs.io',
}

const SPEECH_DEFAULT_BASE: Record<MediaApiProtocol, string> = { ...IMAGE_DEFAULT_BASE, minimax: 'https://api.minimaxi.com/v1' }

const DEFAULT_VOICE: Record<MediaApiProtocol, string> = {
  openrouter: 'alloy',
  openai: 'alloy',
  gemini: 'Kore',
  minimax: 'English_Graceful_Lady',
  aliyun: 'Cherry',
  elevenlabs: '',
}

function imageModelPlaceholder(protocol: MediaApiProtocol): string {
  if (protocol === 'openrouter') return '例如 bytedance-seed/seedream-4.5'
  if (protocol === 'openai') return '例如 gpt-image-1'
  if (protocol === 'gemini') return '例如 imagen-3.0-generate-002 或 gemini-2.5-flash-image'
  if (protocol === 'aliyun') return '例如 qwen-image / wan2.7-image'
  return '模型名'
}

function speechModelPlaceholder(protocol: MediaApiProtocol): string {
  if (protocol === 'openrouter') return '例如 openai/gpt-4o-audio-preview'
  if (protocol === 'openai') return '例如 gpt-4o-mini-tts'
  if (protocol === 'gemini') return '例如 gemini-2.5-flash-preview-tts'
  if (protocol === 'minimax') return '例如 speech-2.6-turbo'
  if (protocol === 'aliyun') return '例如 qwen3-tts-flash'
  return '例如 eleven_multilingual_v2'
}

function voicePlaceholder(protocol: MediaApiProtocol): string {
  if (protocol === 'gemini') return '例如 Kore'
  if (protocol === 'minimax') return '例如 English_Graceful_Lady'
  if (protocol === 'aliyun') return '例如 Cherry'
  if (protocol === 'elevenlabs') return '例如 voice_id'
  return 'alloy'
}

function defaultBaseFor(protocol: MediaApiProtocol, kind: 'image' | 'speech'): string {
  return kind === 'image' ? IMAGE_DEFAULT_BASE[protocol] : SPEECH_DEFAULT_BASE[protocol]
}

function protocolOf(value: string): MediaApiProtocol {
  return value as MediaApiProtocol
}

const IMAGE_SIZES = [
  { value: 'auto', label: '自动' },
  { value: '1024x1024', label: '1024 × 1024（方图）' },
  { value: '1536x1024', label: '1536 × 1024（横图）' },
  { value: '1024x1536', label: '1024 × 1536（竖图）' },
  { value: '1K', label: '1K（OpenRouter 档位）' },
  { value: '2K', label: '2K（OpenRouter 档位）' },
]

const QUALITY_OPTIONS = [
  { value: '', label: '不指定' },
  { value: 'auto', label: 'auto' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
]

/** 生图与语音设置页：两块独立 API 配置，互不影响聊天供应商。 */
export function MediaScreen() {
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [showImageKey, setShowImageKey] = useState(false)
  const [showSpeechKey, setShowSpeechKey] = useState(false)
  const [imageStatus, setImageStatus] = useState('')
  const [speechStatus, setSpeechStatus] = useState('')
  const [imagePreview, setImagePreview] = useState('')
  const [imageBusy, setImageBusy] = useState(false)
  const [speechBusy, setSpeechBusy] = useState(false)

  // 「获取可用模型」的临时状态：拉回来的候选 + 弹窗开关 + 错误提示。
  const [imageFound, setImageFound] = useState<MediaModel[]>([])
  const [imagePickerOpen, setImagePickerOpen] = useState(false)
  const [imageFetching, setImageFetching] = useState(false)
  const [imageFetchError, setImageFetchError] = useState('')
  const [speechFound, setSpeechFound] = useState<MediaModel[]>([])
  const [speechPickerOpen, setSpeechPickerOpen] = useState(false)
  const [speechFetching, setSpeechFetching] = useState(false)
  const [speechFetchError, setSpeechFetchError] = useState('')

  const updateImage = (patch: Partial<ImageApiConfig>): void => {
    void actions.setSettings({ imageApi: { ...settings.imageApi, ...patch } })
  }

  const updateSpeech = (patch: Partial<SpeechApiConfig>): void => {
    void actions.setSettings({ speechApi: { ...settings.speechApi, ...patch } })
  }

  const onTestImage = async (): Promise<void> => {
    const error = checkImageApiConfig(settings.imageApi)
    if (error !== '') {
      setImageStatus(error)
      return
    }
    const ok = await confirmDialog({
      title: '试生成一张图片？',
      message: '会向生图 API 发一次真实请求并消耗额度。继续吗？',
      confirmText: '试生成',
    })
    if (!ok) return
    setImageBusy(true)
    setImageStatus('')
    setImagePreview('')
    try {
      const images = await testImageConfig(settings.imageApi)
      const first = images[0]
      if (first !== undefined) {
        setImagePreview(first.dataUrl)
        setImageStatus(`生成成功（${images.length} 张）`)
      }
    } catch (error) {
      setImageStatus(error instanceof Error ? error.message : '生成失败')
    } finally {
      setImageBusy(false)
    }
  }

  const onTestSpeech = async (): Promise<void> => {
    const error = checkSpeechApiConfig(settings.speechApi)
    if (error !== '') {
      setSpeechStatus(error)
      return
    }
    setSpeechBusy(true)
    setSpeechStatus('')
    try {
      const audio = await testSpeechConfig(settings.speechApi)
      const player = new Audio(audio.dataUrl)
      await player.play().catch(() => undefined)
      setSpeechStatus('试听已生成（如果没声音，请检查设备音量或点播放器）')
    } catch (error) {
      setSpeechStatus(error instanceof Error ? error.message : '语音生成失败')
    } finally {
      setSpeechBusy(false)
    }
  }

  const imageError = checkImageApiConfig(settings.imageApi)
  const speechError = checkSpeechApiConfig(settings.speechApi)

  const fetchImageModels = async (): Promise<void> => {
    setImageFetching(true)
    setImageFetchError('')
    const result = await fetchMediaModels(settings.imageApi, 'image')
    setImageFetching(false)
    if (!result.ok) {
      setImageFetchError(result.reason)
      return
    }
    setImageFound(result.models)
    setImagePickerOpen(true)
  }

  const fetchSpeechModels = async (): Promise<void> => {
    setSpeechFetching(true)
    setSpeechFetchError('')
    const result = await fetchMediaModels(settings.speechApi, 'speech')
    setSpeechFetching(false)
    if (!result.ok) {
      setSpeechFetchError(result.reason)
      return
    }
    setSpeechFound(result.models)
    setSpeechPickerOpen(true)
  }

  return (
    <div className="screen settings-screen">
      <div className="screen-panel">
        <ScreenHeader
          title="生图与语音"
          subtitle="独立于聊天模型的媒体 API；Key 只加密存在本机"
          onBack={() => actions.setScreen('settings')}
          actions={(
            <button type="button" className="primary-button" onClick={() => actions.setScreen('settings')}>
              <Check size={16} /> 完成
            </button>
          )}
        />

        <div className="screen-body settings-body">
          <section className="settings-card">
            <h2><ImagePlus size={17} /> 生图 API</h2>
            <p className="settings-hint">
              模型调用 <code>generate_image</code> 时使用。支持 OpenRouter、OpenAI 兼容、Gemini / Imagen、阿里百炼；
              选中协议时会自动填入对应默认地址，也可手动改。
              只有你明确要求画图/改图时模型才会调用，普通聊天和发图聊天不会自动生图。
            </p>

            <Switch
              checked={settings.imageApi.enabled}
              onChange={(checked) => updateImage({ enabled: checked })}
              label="启用生图"
            />

            <div className="field-row">
              <label className="field">
                <span>协议</span>
                <Select
                  ariaLabel="生图协议"
                  value={settings.imageApi.protocol}
                  onChange={(value) => {
                    const next = protocolOf(value)
                    const previousDefault = defaultBaseFor(settings.imageApi.protocol, 'image')
                    const baseUrl = settings.imageApi.baseUrl.trim() === '' || settings.imageApi.baseUrl.replace(/\/+$/, '') === previousDefault
                      ? defaultBaseFor(next, 'image')
                      : settings.imageApi.baseUrl
                    updateImage({ protocol: next, baseUrl })
                  }}
                  options={IMAGE_PROTOCOL_OPTIONS}
                />
              </label>
              <div className="field">
                <span>模型</span>
                <div className="input-with-action">
                  <input
                    value={settings.imageApi.model}
                    onChange={(event) => updateImage({ model: event.target.value })}
                    placeholder={imageModelPlaceholder(settings.imageApi.protocol)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void fetchImageModels()}
                    disabled={imageFetching}
                    title="从该提供商拉取模型列表，再挑一个"
                  >
                    {imageFetching ? '正在获取…' : '获取可用模型'}
                  </button>
                </div>
                {imageFetchError !== '' && <p className="status-fail">{imageFetchError}</p>}
              </div>
            </div>

            <label className="field">
              <span>API 地址</span>
              <input
                value={settings.imageApi.baseUrl}
                onChange={(event) => updateImage({ baseUrl: event.target.value })}
                placeholder={IMAGE_DEFAULT_BASE[settings.imageApi.protocol]}
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            <label className="field">
              <span>API Key</span>
              <div className="input-with-action">
                <input
                  type={showImageKey ? 'text' : 'password'}
                  value={settings.imageApi.apiKey}
                  onChange={(event) => updateImage({ apiKey: event.target.value })}
                  placeholder="sk-or-v1-…"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="text-button" onClick={() => setShowImageKey(!showImageKey)} aria-label={showImageKey ? '隐藏生图 Key' : '显示生图 Key'}>
                  {showImageKey ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>

            <div className="field-row">
              <label className="field">
                <span>默认尺寸</span>
                <Select
                  ariaLabel="默认尺寸"
                  value={settings.imageApi.defaultSize}
                  onChange={(value) => updateImage({ defaultSize: value })}
                  options={IMAGE_SIZES}
                />
              </label>
              <label className="field">
                <span>质量</span>
                <Select
                  ariaLabel="生图质量"
                  value={settings.imageApi.quality}
                  onChange={(value) => updateImage({ quality: value })}
                  options={QUALITY_OPTIONS}
                />
              </label>
              <label className="field">
                <span>超时（秒）</span>
                <input
                  type="number"
                  min={30}
                  max={600}
                  value={Math.round(settings.imageApi.timeoutMs / 1000)}
                  onChange={(event) => {
                    const seconds = Number(event.target.value)
                    if (Number.isFinite(seconds) && seconds > 0) updateImage({ timeoutMs: Math.round(seconds * 1000) })
                  }}
                />
              </label>
            </div>

            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => setImageStatus(imageError || '配置完整，可以试生成')}>
                <Check size={15} /> 检查配置
              </button>
              <button type="button" className="ghost-button" onClick={() => void onTestImage()} disabled={imageBusy || imageError !== ''}>
                {imageBusy ? <RefreshCw size={15} className="spin" /> : <Sparkles size={15} />} 试生成一张
              </button>
            </div>
            {imageStatus !== '' && <p className={imageError === '' ? 'settings-hint' : 'status-fail'}>{imageStatus}</p>}
            {imagePreview !== '' && <img className="media-test-preview" src={imagePreview} alt="生图测试结果" />}

            <details className="advanced">
              <summary>高级请求头</summary>
              <p className="settings-hint">一行一个 <code>Key: Value</code>，会覆盖默认的 Authorization；普通供应商留空即可。</p>
              <label className="field">
                <span>额外请求头</span>
                <ListTextarea
                  rows={3}
                  value={headerLines(settings.imageApi.extraHeaders)}
                  resetKey={`image:${settings.imageApi.protocol}:${settings.imageApi.baseUrl}`}
                  placeholder={'HTTP-Referer: https://example.com\nX-Custom-Header: value'}
                  onText={(text) => updateImage({ extraHeaders: parseHeaderLines(text) })}
                />
              </label>
            </details>
          </section>

          <section className="settings-card">
            <h2><Mic size={17} /> 语音 API（TTS）</h2>
            <p className="settings-hint">
              模型调用 <code>speak</code> 时使用。支持 OpenRouter、OpenAI 兼容、Gemini TTS、MiniMax、阿里百炼 TTS、ElevenLabs；
              选中协议时会自动填入对应默认地址，也可手动改。
              生成后只显示播放器，<strong>需要你自己点播放</strong>。
            </p>

            <Switch
              checked={settings.speechApi.enabled}
              onChange={(checked) => updateSpeech({ enabled: checked })}
              label="启用语音"
            />

            <div className="field-row">
              <label className="field">
                <span>协议</span>
                <Select
                  ariaLabel="语音协议"
                  value={settings.speechApi.protocol}
                  onChange={(value) => {
                    const next = protocolOf(value)
                    const previousDefault = defaultBaseFor(settings.speechApi.protocol, 'speech')
                    const baseUrl = settings.speechApi.baseUrl.trim() === '' || settings.speechApi.baseUrl.replace(/\/+$/, '') === previousDefault
                      ? defaultBaseFor(next, 'speech')
                      : settings.speechApi.baseUrl
                    const voice = settings.speechApi.voice.trim() === '' || settings.speechApi.voice === DEFAULT_VOICE[settings.speechApi.protocol]
                      ? DEFAULT_VOICE[next]
                      : settings.speechApi.voice
                    updateSpeech({ protocol: next, baseUrl, voice })
                  }}
                  options={SPEECH_PROTOCOL_OPTIONS}
                />
              </label>
              <div className="field">
                <span>模型</span>
                <div className="input-with-action">
                  <input
                    value={settings.speechApi.model}
                    onChange={(event) => updateSpeech({ model: event.target.value })}
                    placeholder={speechModelPlaceholder(settings.speechApi.protocol)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void fetchSpeechModels()}
                    disabled={speechFetching}
                    title="从该提供商拉取模型列表，再挑一个"
                  >
                    {speechFetching ? '正在获取…' : '获取可用模型'}
                  </button>
                </div>
                {speechFetchError !== '' && <p className="status-fail">{speechFetchError}</p>}
              </div>
              <label className="field">
                <span>音色</span>
                <input
                  value={settings.speechApi.voice}
                  onChange={(event) => updateSpeech({ voice: event.target.value })}
                  placeholder={voicePlaceholder(settings.speechApi.protocol)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </div>

            <label className="field">
              <span>API 地址</span>
              <input
                value={settings.speechApi.baseUrl}
                onChange={(event) => updateSpeech({ baseUrl: event.target.value })}
                placeholder={SPEECH_DEFAULT_BASE[settings.speechApi.protocol]}
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            <label className="field">
              <span>API Key</span>
              <div className="input-with-action">
                <input
                  type={showSpeechKey ? 'text' : 'password'}
                  value={settings.speechApi.apiKey}
                  onChange={(event) => updateSpeech({ apiKey: event.target.value })}
                  placeholder="sk-or-v1-…"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="text-button" onClick={() => setShowSpeechKey(!showSpeechKey)} aria-label={showSpeechKey ? '隐藏语音 Key' : '显示语音 Key'}>
                  {showSpeechKey ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>

            <div className="field-row">
              <label className="field">
                <span>格式</span>
                <Select
                  ariaLabel="语音格式"
                  value={settings.speechApi.format}
                  onChange={(value) => updateSpeech({ format: value === 'wav' ? 'wav' : value === 'opus' ? 'opus' : 'mp3' })}
                  options={[{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }, { value: 'opus', label: 'OPUS' }]}
                />
              </label>
              <label className="field">
                <span>语速 {settings.speechApi.speed.toFixed(1)}×</span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={settings.speechApi.speed}
                  onChange={(event) => updateSpeech({ speed: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span>超时（秒）</span>
                <input
                  type="number"
                  min={30}
                  max={600}
                  value={Math.round(settings.speechApi.timeoutMs / 1000)}
                  onChange={(event) => {
                    const seconds = Number(event.target.value)
                    if (Number.isFinite(seconds) && seconds > 0) updateSpeech({ timeoutMs: Math.round(seconds * 1000) })
                  }}
                />
              </label>
            </div>

            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => setSpeechStatus(speechError || '配置完整，可以试听')}>
                <Check size={15} /> 检查配置
              </button>
              <button type="button" className="ghost-button" onClick={() => void onTestSpeech()} disabled={speechBusy || speechError !== ''}>
                {speechBusy ? <RefreshCw size={15} className="spin" /> : <Mic size={15} />} 试听一句
              </button>
            </div>
            {speechStatus !== '' && <p className={speechError === '' ? 'settings-hint' : 'status-fail'}>{speechStatus}</p>}

            <details className="advanced">
              <summary>高级请求头</summary>
              <p className="settings-hint">一行一个 <code>Key: Value</code>，会覆盖默认的 Authorization；普通供应商留空即可。</p>
              <label className="field">
                <span>额外请求头</span>
                <ListTextarea
                  rows={3}
                  value={headerLines(settings.speechApi.extraHeaders)}
                  resetKey={`speech:${settings.speechApi.protocol}:${settings.speechApi.baseUrl}`}
                  placeholder={'xi-api-key: your-key\nX-Custom-Header: value'}
                  onText={(text) => updateSpeech({ extraHeaders: parseHeaderLines(text) })}
                />
              </label>
            </details>
          </section>

          <section className="settings-card">
            <h2>说明</h2>
            <p className="settings-hint">
              生图/语音的 Key 和聊天 API Key 一样只保存在本机的安全存储里，不会进导出备份。
              生成的图片/语音保存在本机 IndexedDB，删除消息或对话时会一起清理，也不随备份导出。
            </p>
            <p className="settings-hint">
              「获取可用模型」按协议去问 /models：OpenRouter、OpenAI 兼容、Gemini、ElevenLabs 支持；
              阿里百炼、MiniMax 没有稳定的模型列表接口，会提示直接手填。
            </p>
          </section>

          <ModelPicker
            open={imagePickerOpen}
            title="选择生图模型"
            models={imageFound}
            existing={[]}
            onClose={() => { setImagePickerOpen(false); setImageFound([]) }}
            onConfirm={(ids) => {
              const first = ids[0]
              if (first !== undefined) updateImage({ model: first })
              setImagePickerOpen(false)
              setImageFound([])
            }}
          />
          <ModelPicker
            open={speechPickerOpen}
            title="选择语音模型"
            models={speechFound}
            existing={[]}
            onClose={() => { setSpeechPickerOpen(false); setSpeechFound([]) }}
            onConfirm={(ids) => {
              const first = ids[0]
              if (first !== undefined) updateSpeech({ model: first })
              setSpeechPickerOpen(false)
              setSpeechFound([])
            }}
          />
        </div>
      </div>
    </div>
  )
}
