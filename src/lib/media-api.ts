import { netRequest, netRequestBinary, netStream, NetError } from './net.ts'
import { dataUrlOf, estimateDataUrlBytes, MAX_IMAGE_BYTES, mediaWithinLimit, parseDataUrl } from './media-store.ts'
import type { ImageApiConfig, SpeechApiConfig } from './types'

/**
 * 媒体 API 客户端（生图 + TTS）。
 *
 * 设计边界：
 * - 这一层只负责「按配置发请求、把响应变成 data URL」，不碰 IndexedDB / React；
 * - 协议适配按 `protocol` 分派，P0 支持 OpenRouter 与 OpenAI 兼容两种；
 * - 所有错误都收敛成可读中文的 MediaApiError，engine 会把 message 原样作为
 *   tool result 回给模型，用户看到的是「为什么没生成」而不是一段英文 JSON。
 */

export class MediaApiError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, detail: string) {
    super(friendlyMediaError(status, detail))
    this.name = 'MediaApiError'
    this.status = status
    this.detail = detail
  }
}

function friendlyMediaError(status: number, detail: string): string {
  if (status === 401) return '媒体 API Key 无效或已过期，请在设置 → 生图与语音里重新填写'
  if (status === 402) return '媒体 API 账户余额不足'
  if (status === 429) return '媒体 API 请求太频繁了，等几秒再试'
  if (status === 400) return `媒体接口拒绝了这次请求：${detail.slice(0, 220)}`
  if (status === 404) return `媒体接口地址或模型不存在：${detail.slice(0, 180)}`
  if (status === 413) return '生成的媒体太大，请换小一点的尺寸'
  if (status >= 500) return '媒体服务暂时不可用，稍后再试'
  return `媒体请求失败（${status}）：${detail.slice(0, 180)}`
}

/** 从各家错误体里刨出可读 message（OpenAI / OpenRouter / 中转站形状）。 */
export function errorDetailText(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string } | string
      message?: string
      detail?: string
    }
    if (typeof parsed.error === 'string') return parsed.error
    return parsed.error?.message ?? parsed.message ?? parsed.detail ?? text
  } catch {
    return text
  }
}

/** 拼接 API 地址；用户误把完整 endpoint 填进 baseUrl 时也尽量不重复拼。 */
export function mediaApiUrl(baseUrl: string, path: string): string {
  const root = baseUrl.trim().replace(/\/+$/, '')
  const cleanPath = path.replace(/^\/+/, '')
  if (root === '') return ''
  const lower = root.toLowerCase()
  // 用户把完整 endpoint 填进来时原样使用（只针对 P0 认识的四个路径）。
  for (const known of ['/chat/completions', '/images/generations', '/audio/speech', '/images']) {
    if (lower.endsWith(known)) return root
  }
  return `${root}/${cleanPath}`
}

function configHeaders(config: { apiKey: string; extraHeaders: Record<string, string> }): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = config.apiKey.trim()
  if (key !== '') headers.Authorization = `Bearer ${key}`
  // 自定义头最后覆盖：中转站常用自己的 Authorization 方案。
  for (const [name, value] of Object.entries(config.extraHeaders ?? {})) {
    if (typeof value === 'string' && name.trim() !== '') headers[name.trim()] = value
  }
  return headers
}

function hasConfig(baseUrl: string, apiKey: string, model: string): boolean {
  return baseUrl.trim() !== '' && apiKey.trim() !== '' && model.trim() !== ''
}

export function isImageConfigured(config: ImageApiConfig | undefined | null): config is ImageApiConfig {
  return config !== undefined && config !== null && config.enabled === true && hasConfig(config.baseUrl, config.apiKey, config.model)
}

export function isSpeechConfigured(config: SpeechApiConfig | undefined | null): config is SpeechApiConfig {
  return config !== undefined && config !== null && config.enabled === true && hasConfig(config.baseUrl, config.apiKey, config.model)
}

export interface ImageGenerationRequest {
  prompt: string
  /** auto / 1024x1024 / 1536x1024 / 1K / 2K ... */
  size?: string
  /** 1~4，默认 1。 */
  count?: number
  /** auto / low / medium / high；空串不传。 */
  quality?: string
  /** 参考图 data URL（图生图/编辑）。 */
  referenceImages?: string[]
}

export interface GeneratedImage {
  dataUrl: string
  mime: string
  width?: number
  height?: number
}

function pixelSize(size: string | undefined): { width?: number; height?: number } {
  if (size === undefined) return {}
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim())
  if (match === null) return {}
  const width = Number(match[1])
  const height = Number(match[2])
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {}
}

interface OpenRouterImageResponse {
  data?: Array<{ b64_json?: string; url?: string; media_type?: string }>
  error?: { message?: string }
}

interface ImagePayload {
  b64?: string
  url?: string
  mime: string
}

/** 从各家形状不一的响应里收集图片（b64 / url）。 */
function collectImagePayloads(value: unknown, out: ImagePayload[] = [], depth = 0): ImagePayload[] {
  if (depth > 12 || value === null || value === undefined) return out
  if (Array.isArray(value)) {
    for (const item of value) collectImagePayloads(item, out, depth + 1)
    return out
  }
  if (typeof value !== 'object') return out
  const record = value as Record<string, unknown>
  const mimeOf = (): string => {
    const raw = record.mimeType ?? record.mime_type ?? record.media_type ?? record.mediaType ?? record.content_type
    return typeof raw === 'string' && raw.startsWith('image/') ? raw : 'image/png'
  }
  const mime = mimeOf()
  const b64Keys = ['b64_json', 'bytesBase64Encoded', 'bytes_base64_encoded', 'image_base64', 'imageBase64']
  for (const key of b64Keys) {
    const raw = record[key]
    if (typeof raw === 'string' && raw.trim() !== '') {
      out.push({ b64: raw.trim(), mime })
    }
  }
  // Gemini 的 inlineData 用 { mimeType, data } 形状；只把“图片 mime”的 data 当图片，
  // 避免把音频 data 误收进来。
  if (mime.startsWith('image/')) {
    const inline = record.data ?? record.inlineData ?? record.inline_data
    if (typeof inline === 'string' && inline.trim() !== '') out.push({ b64: inline.trim(), mime })
  }
  const urlKeys = ['url', 'image_url', 'imageUrl', 'image', 'urls']
  for (const key of urlKeys) {
    const raw = record[key]
    if (typeof raw === 'string' && (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:image/'))) {
      out.push({ url: raw, mime })
    }
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === 'string' && (item.startsWith('http://') || item.startsWith('https://') || item.startsWith('data:image/'))) {
          out.push({ url: item, mime })
        }
      }
    }
  }
  for (const [key, child] of Object.entries(record)) {
    // 上面已经处理过的字段不再递归，避免重复；其余对象/数组继续找（如 output.choices[].message.content[]）。
    if (b64Keys.includes(key) || urlKeys.includes(key)) continue
    if (key === 'data' && typeof child === 'string') continue
    collectImagePayloads(child, out, depth + 1)
  }
  return out
}

/**
 * 去掉同一次响应里重复出现的图。
 *
 * 判重键不能用 base64 的前 80 个字符（T-16）：同一次返回多张 PNG 时，文件头、
 * 尺寸块、编码参数全都一样，前 80 字符往往逐字相同 —— 真图会被当成重复丢掉，
 * 用户要 4 张只拿到 1 张。这里用「长度 + 头 80 + 尾 80」：足够区分不同的图，
 * 又不会像完整 base64 那样给每张图再复制一份几十 MB 的字符串当 key。
 */
function dedupeKeyOf(payload: ImagePayload): string {
  if (payload.b64 === undefined) return `url:${payload.url ?? ''}`
  const b64 = payload.b64
  return `b64:${b64.length}:${b64.slice(0, 80)}:${b64.slice(-80)}`
}

function dedupePayloads(payloads: ImagePayload[]): ImagePayload[] {
  const seen = new Set<string>()
  const out: ImagePayload[] = []
  for (const payload of payloads) {
    const key = dedupeKeyOf(payload)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(payload)
  }
  return out
}

async function payloadToImage(
  payload: ImagePayload,
  config: ImageApiConfig,
  size: string | undefined,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const dimensions = pixelSize(size)
  if (payload.b64 !== undefined) {
    return { dataUrl: dataUrlOf(payload.mime, payload.b64), mime: payload.mime, ...dimensions }
  }
  const url = payload.url ?? ''
  if (url.startsWith('data:image/')) {
    const parsed = parseDataUrl(url)
    if (parsed !== null) return { dataUrl: dataUrlOf(parsed.mime, parsed.base64), mime: parsed.mime, ...dimensions }
  }
  const binary = await netRequestBinary({
    url,
    method: 'GET',
    signal,
    timeoutMs: Math.min(config.timeoutMs, 120000),
  })
  if (binary.status >= 400) throw new MediaApiError(binary.status, `下载生成图失败（${binary.status}）`)
  const mime = binary.mime.startsWith('image/') ? binary.mime : payload.mime
  return { dataUrl: dataUrlOf(mime, binary.base64), mime, ...dimensions }
}

function geminiRoot(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, '')
  if (root === '') return ''
  return root.endsWith('/v1beta') || root.endsWith('/v1') ? root : `${root}/v1beta`
}

function geminiHeaders(config: { apiKey: string; extraHeaders: Record<string, string> }): Record<string, string> {
  return {
    ...configHeaders(config),
    'x-goog-api-key': config.apiKey.trim(),
  }
}

function geminiAspectRatio(size: string | undefined): string | undefined {
  if (size === undefined || size === '' || size === 'auto') return undefined
  const pixel = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size)
  if (pixel !== null) {
    const width = Number(pixel[1])
    const height = Number(pixel[2])
    if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0) return undefined
    const ratio = width / height
    if (Math.abs(ratio - 1) < 0.05) return '1:1'
    if (Math.abs(ratio - 4 / 3) < 0.08) return '4:3'
    if (Math.abs(ratio - 3 / 4) < 0.08) return '3:4'
    if (Math.abs(ratio - 16 / 9) < 0.08) return '16:9'
    if (Math.abs(ratio - 9 / 16) < 0.08) return '9:16'
    if (Math.abs(ratio - 3 / 2) < 0.08) return '3:2'
    if (Math.abs(ratio - 2 / 3) < 0.08) return '2:3'
  }
  if (/^\d+K$/i.test(size.trim())) return undefined
  return undefined
}

/* --------------------------------------------------------- Gemini 生图 */

async function generateImageGemini(
  config: ImageApiConfig,
  request: ImageGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const count = Math.max(1, Math.min(4, Math.round(request.count ?? 1)))
  const model = config.model.trim()
  const size = request.size ?? config.defaultSize
  const root = geminiRoot(config.baseUrl)
  if (root === '') throw new MediaApiError(400, 'Gemini 生图地址为空')
  const isImagen = /imagen/i.test(model)
  if (isImagen && (request.referenceImages?.length ?? 0) > 0) {
    throw new MediaApiError(400, 'Gemini Imagen 暂不支持参考图生图；请切到支持 input_references 的协议，或去掉参考图')
  }
  let url = ''
  let body: Record<string, unknown>
  if (isImagen) {
    const parameters: Record<string, unknown> = { sampleCount: count }
    const aspectRatio = geminiAspectRatio(size)
    if (aspectRatio !== undefined) parameters.aspectRatio = aspectRatio
    url = `${root}/models/${encodeURIComponent(model)}:predict`
    body = { instances: [{ prompt: request.prompt }], parameters }
  } else {
    const parts: unknown[] = [{ text: request.prompt }]
    for (const dataUrl of request.referenceImages ?? []) {
      const parsed = parseDataUrl(dataUrl)
      if (parsed !== null) parts.push({ inlineData: { mimeType: parsed.mime, data: parsed.base64 } })
    }
    url = `${root}/models/${encodeURIComponent(model)}:generateContent`
    body = {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }
  }
  const response = await netRequest({
    url,
    method: 'POST',
    headers: geminiHeaders(config),
    body: JSON.stringify(body),
    signal,
    timeoutMs: config.timeoutMs,
  })
  if (response.status >= 400) throw new MediaApiError(response.status, errorDetailText(response.text))
  let parsed: unknown
  try {
    parsed = JSON.parse(response.text) as unknown
  } catch {
    throw new MediaApiError(502, 'Gemini 生图接口返回的不是 JSON')
  }
  const payloads = dedupePayloads(collectImagePayloads(parsed))
  const images: GeneratedImage[] = []
  for (const payload of payloads.slice(0, count)) images.push(await payloadToImage(payload, config, size, signal))
  if (images.length === 0) throw new MediaApiError(502, 'Gemini 生图接口没有返回图片')
  return images
}

/* --------------------------------------------------------- 阿里百炼生图 */

function aliyunSize(size: string | undefined): string | undefined {
  if (size === undefined || size === '' || size === 'auto') return undefined
  return size.replace(/[x×]/gi, '*')
}

async function generateImageAliyun(
  config: ImageApiConfig,
  request: ImageGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const count = Math.max(1, Math.min(4, Math.round(request.count ?? 1)))
  const size = request.size ?? config.defaultSize
  const content: Array<Record<string, unknown>> = [{ text: request.prompt }]
  for (const dataUrl of request.referenceImages ?? []) content.push({ image: dataUrl })
  const body = {
    model: config.model.trim(),
    input: { messages: [{ role: 'user', content }] },
    parameters: {
      n: count,
      ...(aliyunSize(size) !== undefined ? { size: aliyunSize(size) } : {}),
      ...(request.quality !== undefined && request.quality !== '' ? { quality: request.quality } : {}),
    },
  }
  const response = await netRequest({
    url: mediaApiUrl(config.baseUrl, '/services/aigc/multimodal-generation/generation'),
    method: 'POST',
    headers: configHeaders(config),
    body: JSON.stringify(body),
    signal,
    timeoutMs: config.timeoutMs,
  })
  if (response.status >= 400) throw new MediaApiError(response.status, errorDetailText(response.text))
  let parsed: unknown
  try {
    parsed = JSON.parse(response.text) as unknown
  } catch {
    throw new MediaApiError(502, '阿里百炼生图接口返回的不是 JSON')
  }
  const payloads = dedupePayloads(collectImagePayloads(parsed))
  const images: GeneratedImage[] = []
  for (const payload of payloads.slice(0, count)) images.push(await payloadToImage(payload, config, size, signal))
  if (images.length === 0) throw new MediaApiError(502, '阿里百炼生图接口没有返回图片')
  return images
}

async function generateImageOpenRouter(
  config: ImageApiConfig,
  request: ImageGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const count = Math.max(1, Math.min(4, Math.round(request.count ?? 1)))
  const size = request.size ?? config.defaultSize
  const body: Record<string, unknown> = {
    model: config.model.trim(),
    prompt: request.prompt,
    n: count,
  }
  if (size !== '' && size !== 'auto') body.size = size
  if (request.quality !== undefined && request.quality !== '') body.quality = request.quality
  if ((request.referenceImages?.length ?? 0) > 0) {
    body.input_references = request.referenceImages?.map((url) => ({
      type: 'image_url',
      image_url: { url },
    }))
  }
  const response = await netRequest({
    url: mediaApiUrl(config.baseUrl, '/images'),
    method: 'POST',
    headers: configHeaders(config),
    body: JSON.stringify(body),
    signal,
    timeoutMs: config.timeoutMs,
  })
  if (response.status >= 400) throw new MediaApiError(response.status, errorDetailText(response.text))
  let parsed: OpenRouterImageResponse
  try {
    parsed = JSON.parse(response.text) as OpenRouterImageResponse
  } catch {
    throw new MediaApiError(502, '生图接口返回的不是 JSON')
  }
  if (parsed.error?.message !== undefined) throw new MediaApiError(400, parsed.error.message)
  const rows = Array.isArray(parsed.data) ? parsed.data : []
  const images: GeneratedImage[] = []
  for (const row of rows) {
    const mime = row.media_type ?? 'image/png'
    if (typeof row.b64_json === 'string' && row.b64_json.trim() !== '') {
      images.push({ dataUrl: dataUrlOf(mime, row.b64_json.trim()), mime, ...pixelSize(size) })
      continue
    }
    if (typeof row.url === 'string' && row.url.trim() !== '') {
      const binary = await netRequestBinary({
        url: row.url,
        method: 'GET',
        signal,
        timeoutMs: Math.min(config.timeoutMs, 120000),
      })
      if (binary.status >= 400) throw new MediaApiError(binary.status, `下载生成图失败（${binary.status}）`)
      const inferred = row.media_type ?? binary.mime ?? 'image/png'
      images.push({ dataUrl: dataUrlOf(inferred, binary.base64), mime: inferred, ...pixelSize(size) })
    }
  }
  if (images.length === 0) throw new MediaApiError(502, '生图接口返回成功，但没有图片数据')
  return images.slice(0, count)
}

async function generateImageOpenAi(
  config: ImageApiConfig,
  request: ImageGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const count = Math.max(1, Math.min(4, Math.round(request.count ?? 1)))
  const body: Record<string, unknown> = {
    model: config.model.trim(),
    prompt: request.prompt,
    n: count,
    response_format: 'b64_json',
  }
  const size = request.size ?? config.defaultSize
  if (size !== '' && size !== 'auto') body.size = size
  if (request.quality !== undefined && request.quality !== '') body.quality = request.quality
  let response = await netRequest({
    url: mediaApiUrl(config.baseUrl, '/images/generations'),
    method: 'POST',
    headers: configHeaders(config),
    body: JSON.stringify(body),
    signal,
    timeoutMs: config.timeoutMs,
  })
  // 一些老网关不认 response_format，去掉再试一次（与 deepseek.ts 的 400 退避同思路）。
  if (response.status === 400 && response.text.includes('response_format')) {
    delete body.response_format
    response = await netRequest({
      url: mediaApiUrl(config.baseUrl, '/images/generations'),
      method: 'POST',
      headers: configHeaders(config),
      body: JSON.stringify(body),
      signal,
      timeoutMs: config.timeoutMs,
    })
  }
  if (response.status >= 400) throw new MediaApiError(response.status, errorDetailText(response.text))
  let parsed: OpenRouterImageResponse
  try {
    parsed = JSON.parse(response.text) as OpenRouterImageResponse
  } catch {
    throw new MediaApiError(502, '生图接口返回的不是 JSON')
  }
  if (parsed.error?.message !== undefined) throw new MediaApiError(400, parsed.error.message)
  const rows = Array.isArray(parsed.data) ? parsed.data : []
  const images: GeneratedImage[] = []
  for (const row of rows) {
    if (typeof row.b64_json === 'string' && row.b64_json.trim() !== '') {
      const mime = row.media_type ?? 'image/png'
      images.push({ dataUrl: dataUrlOf(mime, row.b64_json.trim()), mime, ...pixelSize(size) })
      continue
    }
    if (typeof row.url === 'string' && row.url.trim() !== '') {
      const binary = await netRequestBinary({
        url: row.url,
        method: 'GET',
        signal,
        timeoutMs: Math.min(config.timeoutMs, 120000),
      })
      if (binary.status >= 400) throw new MediaApiError(binary.status, `下载生成图失败（${binary.status}）`)
      const mime = binary.mime !== '' ? binary.mime : 'image/png'
      images.push({ dataUrl: dataUrlOf(mime, binary.base64), mime, ...pixelSize(size) })
    }
  }
  if (images.length === 0) throw new MediaApiError(502, '生图接口返回成功，但没有图片数据')
  return images.slice(0, count)
}

/** 一次生图最多带几张参考图。再多，请求体就只是白等一次超时。 */
const MAX_REFERENCE_IMAGES = 4

/** 生图入口：按协议分派。 */
export async function generateImages(
  config: ImageApiConfig,
  request: ImageGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  if (request.prompt.trim() === '') throw new MediaApiError(400, '提示词不能为空')
  if (request.prompt.length > 4000) throw new MediaApiError(400, '提示词太长（最多 4000 字）')
  /*
   * 参考图要过两道闸（T-19）：张数 ≤ 4、总量 ≤ 单张上限。
   *
   * 参考图是**内联**进请求体的：四张 16MB 的图拼起来就是 60MB+ 的 JSON，还要经
   * IPC 再复制一次，发出去之前基本就注定超时。以前这里只判「能不能 parse」，
   * 张数和体积完全不看，等于没设防。
   */
  const pickedReferences: string[] = []
  let referenceBytes = 0
  let droppedForSize = 0
  for (const url of request.referenceImages ?? []) {
    if (pickedReferences.length >= MAX_REFERENCE_IMAGES) break
    if (parseDataUrl(url) === null) continue
    if (!mediaWithinLimit('image', url)) {
      droppedForSize += 1
      continue
    }
    const bytes = estimateDataUrlBytes(url)
    if (referenceBytes + bytes > MAX_IMAGE_BYTES) {
      droppedForSize += 1
      continue
    }
    referenceBytes += bytes
    pickedReferences.push(url)
  }
  // 只因为「太大」才一张都不剩时说清楚；本来就不是 data URL 的照旧静默忽略。
  if (pickedReferences.length === 0 && droppedForSize > 0) {
    const limitMb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024))
    throw new MediaApiError(400, `参考图太大（单张上限 ${limitMb}MB），请压缩后再试`)
  }
  const cleanReferences = pickedReferences
  const normalized: ImageGenerationRequest = {
    ...request,
    prompt: request.prompt.trim(),
    ...(cleanReferences.length > 0 ? { referenceImages: cleanReferences } : { referenceImages: undefined }),
  }
  if (config.protocol === 'openrouter') return generateImageOpenRouter(config, normalized, signal)
  if (config.protocol === 'openai') return generateImageOpenAi(config, normalized, signal)
  if (config.protocol === 'gemini') return generateImageGemini(config, normalized, signal)
  if (config.protocol === 'aliyun') return generateImageAliyun(config, normalized, signal)
  throw new MediaApiError(400, `当前生图协议「${config.protocol}」还没有适配器`)
}

export interface SpeechAudio {
  dataUrl: string
  mime: string
}

function audioMime(format: SpeechApiConfig['format']): string {
  if (format === 'wav') return 'audio/wav'
  if (format === 'opus') return 'audio/ogg'
  return 'audio/mpeg'
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '')
  if (clean === '') return new Uint8Array()
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

interface AudioPayload {
  b64?: string
  hex?: string
  url?: string
  mime?: string
}

/** 从各家 TTS 响应里找音频：{audio:{data/url}} / {data:{audio:hex}} / inlineData。 */
function collectAudioPayloads(value: unknown, out: AudioPayload[] = [], depth = 0): AudioPayload[] {
  if (depth > 12 || value === null || value === undefined) return out
  if (Array.isArray(value)) {
    for (const item of value) collectAudioPayloads(item, out, depth + 1)
    return out
  }
  if (typeof value !== 'object') return out
  const record = value as Record<string, unknown>
  const mimeRaw = record.mimeType ?? record.mime_type ?? record.media_type ?? record.format
  const mime = typeof mimeRaw === 'string' ? mimeRaw : ''
  if (typeof record.data === 'string' && record.data.trim() !== '' && mime.startsWith('audio/')) {
    out.push({ b64: record.data.trim(), mime })
  }
  if (typeof record.audio === 'string' && record.audio.trim() !== '') {
    out.push({ hex: record.audio.trim() })
  }
  if (typeof record.audio === 'object' && record.audio !== null && !Array.isArray(record.audio)) {
    collectAudioPayloads(record.audio, out, depth + 1)
  }
  for (const key of ['audio_url', 'audioUrl']) {
    const raw = record[key]
    if (typeof raw === 'string' && raw.trim() !== '') out.push({ url: raw.trim() })
  }
  if (typeof record.url === 'string' && record.url.trim() !== '' && (mime.startsWith('audio/') || mime === '')) {
    // 只有确定在 audio 上下文时才会走到这里：调用方从 output.audio 递归进来。
    out.push({ url: record.url.trim() })
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'data' && typeof child === 'string') continue
    if (key === 'audio' || key === 'url') continue
    collectAudioPayloads(child, out, depth + 1)
  }
  return out
}

function hexToBase64(hex: string): string {
  const clean = hex.trim().replace(/^0x/i, '')
  if (clean === '' || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
    throw new MediaApiError(502, 'MiniMax 返回的音频不是合法十六进制')
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let index = 0; index < clean.length; index += 2) {
    bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16)
  }
  return bytesToBase64(bytes)
}

function sampleRateFromMime(mime: string): number {
  const match = /rate=(\d+)/i.exec(mime)
  return match === null ? 24000 : Number(match[1])
}

/** Gemini 的 TTS 通常返回 16-bit PCM（audio/L16），要包一层 WAV 头才能播放。 */
function pcm16ToWavBase64(pcmBase64: string, sampleRate: number): string {
  const pcm = decodeBase64ToBytes(pcmBase64)
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, pcm.length, true)
  const merged = concatBytes([new Uint8Array(header), pcm])
  return bytesToBase64(merged)
}

async function audioPayloadToSpeech(
  payload: AudioPayload,
  config: SpeechApiConfig,
  signal?: AbortSignal,
): Promise<SpeechAudio> {
  if (payload.hex !== undefined) {
    return { dataUrl: dataUrlOf(audioMime(config.format), hexToBase64(payload.hex)), mime: audioMime(config.format) }
  }
  if (payload.b64 !== undefined) {
    const mime = payload.mime ?? audioMime(config.format)
    if (/audio\/l16|audio\/pcm|audio\/raw/i.test(mime)) {
      return { dataUrl: dataUrlOf('audio/wav', pcm16ToWavBase64(payload.b64, sampleRateFromMime(mime))), mime: 'audio/wav' }
    }
    return { dataUrl: dataUrlOf(mime, payload.b64), mime }
  }
  if (payload.url !== undefined) {
    const binary = await netRequestBinary({
      url: payload.url,
      method: 'GET',
      signal,
      timeoutMs: Math.min(config.timeoutMs, 120000),
    })
    if (binary.status >= 400) throw new MediaApiError(binary.status, `下载语音失败（${binary.status}）`)
    const mime = binary.mime.startsWith('audio/') ? binary.mime : audioMime(config.format)
    return { dataUrl: dataUrlOf(mime, binary.base64), mime }
  }
  throw new MediaApiError(502, '语音接口没有返回音频数据')
}

/* --------------------------------------------------------- 各家 TTS */

async function synthesizeSpeechGemini(
  config: SpeechApiConfig,
  text: string,
  signal?: AbortSignal,
): Promise<SpeechAudio> {
  const root = geminiRoot(config.baseUrl)
  const body = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: config.voice },
        },
      },
    },
  }
  const response = await netRequest({
    url: `${root}/models/${encodeURIComponent(config.model.trim())}:generateContent`,
    method: 'POST',
    headers: geminiHeaders(config),
    body: JSON.stringify(body),
    signal,
    timeoutMs: config.timeoutMs,
  })
  if (response.status >= 400) throw new MediaApiError(response.status, errorDetailText(response.text))
  let parsed: unknown
  try {
    parsed = JSON.parse(response.text) as unknown
  } catch {
    throw new MediaApiError(502, 'Gemini TTS 返回的不是 JSON')
  }
  const payload = collectAudioPayloads(parsed)[0]
  if (payload === undefined) throw new MediaApiError(502, 'Gemini TTS 没有返回音频')
  return await audioPayloadToSpeech(payload, config, signal)
}

async function synthesizeSpeechMiniMax(
  config: SpeechApiConfig,
  text: string,
  signal?: AbortSignal,
): Promise<SpeechAudio> {
  const body = {
    model: config.model.trim(),
    text,
    stream: false,
    voice_setting: { voice_id: config.voice, speed: config.speed, vol: 1, pitch: 0 },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: config.format,
      channel: 1,
    },
  }
  const response = await netRequest({
    url: mediaApiUrl(config.baseUrl, '/t2a_v2'),
    method: 'POST',
    headers: configHeaders(config),
    body: JSON.stringify(body),
    signal,
    timeoutMs: config.timeoutMs,
  })
  if (response.status >= 400) throw new MediaApiError(response.status, errorDetailText(response.text))
  let parsed: unknown
  try {
    parsed = JSON.parse(response.text) as unknown
  } catch {
    throw new MediaApiError(502, 'MiniMax TTS 返回的不是 JSON')
  }
  const payload = collectAudioPayloads(parsed)[0]
  if (payload === undefined) throw new MediaApiError(502, 'MiniMax TTS 没有返回音频')
  return await audioPayloadToSpeech(payload, config, signal)
}

async function synthesizeSpeechAliyun(
  config: SpeechApiConfig,
  text: string,
  signal?: AbortSignal,
): Promise<SpeechAudio> {
  const body = {
    model: config.model.trim(),
    input: { text, voice: config.voice, language_type: 'Auto' },
    parameters: { rate: config.speed },
  }
  const response = await netRequest({
    url: mediaApiUrl(config.baseUrl, '/services/aigc/multimodal-generation/generation'),
    method: 'POST',
    headers: configHeaders(config),
    body: JSON.stringify(body),
    signal,
    timeoutMs: config.timeoutMs,
  })
  if (response.status >= 400) throw new MediaApiError(response.status, errorDetailText(response.text))
  let parsed: unknown
  try {
    parsed = JSON.parse(response.text) as unknown
  } catch {
    throw new MediaApiError(502, '阿里百炼 TTS 返回的不是 JSON')
  }
  const payload = collectAudioPayloads(parsed)[0]
  if (payload === undefined) throw new MediaApiError(502, '阿里百炼 TTS 没有返回音频')
  return await audioPayloadToSpeech(payload, config, signal)
}

async function synthesizeSpeechElevenLabs(
  config: SpeechApiConfig,
  text: string,
  signal?: AbortSignal,
): Promise<SpeechAudio> {
  const root = config.baseUrl.trim().replace(/\/+$/, '')
  const base = root.endsWith('/v1') ? root : `${root}/v1`
  const format = config.format === 'mp3' ? 'mp3_44100_128' : config.format === 'opus' ? 'opus_48000_128' : 'pcm_44100'
  const url = `${base}/text-to-speech/${encodeURIComponent(config.voice)}?output_format=${format}`
  const response = await netRequestBinary({
    url,
    method: 'POST',
    headers: {
      ...configHeaders(config),
      'xi-api-key': config.apiKey.trim(),
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: config.model.trim(),
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
    signal,
    timeoutMs: config.timeoutMs,
  })
  if (response.status >= 400) throw new MediaApiError(response.status, errorDetailText(response.text ?? ''))
  const mime = response.mime.startsWith('audio/') ? response.mime : audioMime(config.format)
  return { dataUrl: dataUrlOf(mime, response.base64), mime }
}

interface StreamAudioDelta {
  choices?: Array<{
    delta?: { audio?: { data?: string; transcript?: string } }
    message?: { audio?: { data?: string } }
  }>
}

/** 从 OpenRouter 的 SSE 里收集音频片段。返回“每段已解码的音频字节”。 */
async function synthesizeSpeechOpenRouter(
  config: SpeechApiConfig,
  text: string,
  signal?: AbortSignal,
): Promise<SpeechAudio> {
  const body = {
    model: config.model.trim(),
    messages: [
      {
        role: 'user',
        content: `请用语音逐字朗读下面这段文字，不要增加、不要解释、不要改变内容：\n\n${text}`,
      },
    ],
    modalities: ['text', 'audio'],
    audio: { voice: config.voice, format: config.format },
    stream: true,
  }
  const audioData: string[] = []
  let raw = ''
  const consumePayload = (payload: string): void => {
    if (payload === '[DONE]') return
    let parsed: StreamAudioDelta
    try {
      parsed = JSON.parse(payload) as StreamAudioDelta
    } catch {
      return
    }
    const choice = parsed.choices?.[0]
    const data = choice?.delta?.audio?.data ?? choice?.message?.audio?.data
    if (typeof data === 'string' && data.trim() !== '') audioData.push(data.trim())
  }
  const consumeText = (textChunk: string): void => {
    raw += textChunk
    /*
     * 优先按 SSE 的 data: 行解析；如果网关不按 SSE 返回，结束时再按 JSON 兜底。
     *
     * 事件边界必须容忍 CRLF（T-12）：`\r\n\r\n` 里并不含 `\n\n` 子串，以前用
     * indexOf('\n\n') 找边界，CRLF 网关一个事件都切不出来 —— 收尾时把整段 data:
     * 行拼成一个 payload 去 JSON.parse，必然失败，最后报「语音模型没有返回音频」。
     * deepseek.ts 的 SSE 解析一直用的是 /\r?\n\r?\n/，这里对齐。
     */
    let boundary = /\r?\n\r?\n/.exec(raw)
    while (boundary !== null) {
      const event = raw.slice(0, boundary.index)
      raw = raw.slice(boundary.index + boundary[0].length)
      const payload = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (payload !== '') consumePayload(payload)
      boundary = /\r?\n\r?\n/.exec(raw)
    }
  }

  const response = await netStream(
    {
      url: mediaApiUrl(config.baseUrl, '/chat/completions'),
      method: 'POST',
      headers: { ...configHeaders(config), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
      timeoutMs: config.timeoutMs,
    },
    { onChunk: consumeText },
  )
  // 流结束：把最后一段没有空行结尾的 event 处理掉。
  if (raw.trim() !== '') consumeText('\n\n')
  if (response.status >= 400) throw new MediaApiError(response.status, errorDetailText(response.text))
  // 非 SSE 的兼容路径：有的中转站忽略 stream，直接回完整 JSON。
  if (audioData.length === 0 && response.text.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(response.text) as StreamAudioDelta
      const data = parsed.choices?.[0]?.message?.audio?.data
      if (typeof data === 'string' && data.trim() !== '') audioData.push(data.trim())
    } catch {
      /* 已经按空音频处理 */
    }
  }
  if (audioData.length === 0) throw new MediaApiError(502, '语音模型没有返回音频（检查模型是否支持音频输出）')
  let bytes: Uint8Array
  try {
    // 正常情况：每个 SSE 分片是一段独立 base64，拼解码后的字节。
    bytes = concatBytes(audioData.map(decodeBase64ToBytes))
  } catch {
    // 个别网关按「整段 base64 的子串」分片，单独一段解不开；拼起来再解。
    bytes = decodeBase64ToBytes(audioData.join(''))
  }
  /*
   * 到这里 raw（整段响应原文）和 audioData（每片 base64）就没用了，而它们加起来
   * 通常比最终音频还大。显式放掉，别让它们陪着 dataUrl 一起常驻（T-20）。
   */
  raw = ''
  audioData.length = 0
  return { dataUrl: dataUrlOf(audioMime(config.format), bytesToBase64(bytes)), mime: audioMime(config.format) }
}

async function synthesizeSpeechOpenAi(
  config: SpeechApiConfig,
  text: string,
  signal?: AbortSignal,
): Promise<SpeechAudio> {
  const response = await netRequestBinary({
    url: mediaApiUrl(config.baseUrl, '/audio/speech'),
    method: 'POST',
    headers: { ...configHeaders(config), Accept: 'audio/mpeg' },
    body: JSON.stringify({
      model: config.model.trim(),
      input: text,
      voice: config.voice,
      response_format: config.format,
      speed: config.speed,
    }),
    signal,
    timeoutMs: config.timeoutMs,
  })
  const contentType = (response.headers['content-type'] ?? response.headers['Content-Type'] ?? '').toLowerCase()
  if (response.status >= 400) {
    throw new MediaApiError(response.status, errorDetailText(response.text ?? ''))
  }
  // 有些网关 200 也返回 JSON：{ data: { audio: 'base64' } }
  if (contentType.includes('application/json') || (response.text !== undefined && response.text.trim().startsWith('{'))) {
    try {
      const parsed = JSON.parse(response.text ?? '') as { data?: { audio?: string }; error?: { message?: string } }
      if (parsed.error?.message !== undefined) throw new MediaApiError(400, parsed.error.message)
      if (typeof parsed.data?.audio === 'string' && parsed.data.audio !== '') {
        return { dataUrl: dataUrlOf(audioMime(config.format), parsed.data.audio), mime: audioMime(config.format) }
      }
    } catch (error) {
      if (error instanceof MediaApiError) throw error
    }
    throw new MediaApiError(502, '语音接口没有返回音频数据')
  }
  if (response.base64 === '') throw new MediaApiError(502, '语音接口返回了空音频')
  const mime = response.mime.startsWith('audio/') ? response.mime : audioMime(config.format)
  return { dataUrl: dataUrlOf(mime, response.base64), mime }
}

/** TTS 入口：按协议分派。 */
export async function synthesizeSpeech(
  config: SpeechApiConfig,
  text: string,
  signal?: AbortSignal,
): Promise<SpeechAudio> {
  const clean = text.trim()
  if (clean === '') throw new MediaApiError(400, '要朗读的文字不能为空')
  if (clean.length > 2000) throw new MediaApiError(400, '一次最多朗读 2000 字，请分段调用 speak')
  if (config.protocol === 'openrouter') return synthesizeSpeechOpenRouter(config, clean, signal)
  if (config.protocol === 'openai') return synthesizeSpeechOpenAi(config, clean, signal)
  if (config.protocol === 'gemini') return synthesizeSpeechGemini(config, clean, signal)
  if (config.protocol === 'minimax') return synthesizeSpeechMiniMax(config, clean, signal)
  if (config.protocol === 'aliyun') return synthesizeSpeechAliyun(config, clean, signal)
  if (config.protocol === 'elevenlabs') return synthesizeSpeechElevenLabs(config, clean, signal)
  throw new MediaApiError(400, `当前语音协议「${config.protocol}」还没有适配器`)
}

/**
 * 配置完整度检查：不发任何计费请求。
 * 真正的“试生成/试听”由设置页单独按钮触发。
 */
export function checkImageApiConfig(config: ImageApiConfig): string {
  if (!config.enabled) return '生图 API 还没启用'
  if (config.baseUrl.trim() === '') return '请填生图 API 地址'
  if (config.apiKey.trim() === '') return '请填生图 API Key'
  if (config.model.trim() === '') return '请填生图模型名'
  return ''
}

export function checkSpeechApiConfig(config: SpeechApiConfig): string {
  if (!config.enabled) return '语音 API 还没启用'
  if (config.baseUrl.trim() === '') return '请填语音 API 地址'
  if (config.apiKey.trim() === '') return '请填语音 API Key'
  if (config.model.trim() === '') return '请填语音模型名'
  if (config.voice.trim() === '') return '请填音色'
  return ''
}

/** 设置页「试听一句」用；返回 data URL 供 Audio 播放。 */
export async function testSpeechConfig(config: SpeechApiConfig): Promise<SpeechAudio> {
  const error = checkSpeechApiConfig(config)
  if (error !== '') throw new MediaApiError(400, error)
  return synthesizeSpeech(config, '你好，我是深鲸。')
}

/** 设置页「试生成」用；只在用户二次确认后调用（会消耗额度）。 */
export async function testImageConfig(config: ImageApiConfig): Promise<GeneratedImage[]> {
  const error = checkImageApiConfig(config)
  if (error !== '') throw new MediaApiError(400, error)
  return generateImages(config, { prompt: '一只在深海里游动的虎鲸，水彩插画风格', count: 1 })
}

/** 是否为媒体 API 的取消错误（引擎里用来区分“用户停止”和“接口失败”）。 */
export function isMediaAbort(error: unknown): boolean {
  return error instanceof NetError && error.kind === 'aborted'
}
