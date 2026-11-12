/**
 * 媒体（生图 / 语音）的「获取可用模型」纯逻辑层。
 *
 * 和 model-catalog.ts 同一套思路：不碰 React、不碰 IndexedDB，只在 Node 里
 * 拼地址 / 拼鉴权 / 解析响应 / 按能力过滤。界面（Media.tsx）只负责显示与勾选。
 *
 * 与聊天的区别：
 * - 媒体协议多出 minimax / elevenlabs，且是独立配置（imageApi / speechApi），
 *   所以不能直接复用聊天 Provider 的 PROTOCOLS / chatHeaders；
 * - 很多协议并不提供 /models：aliyun、minimax 是典型，遇到就返回 null，
 *   由界面提示「请手填」，而不是假装能检测。
 */

import { netRequest } from './net.ts'
import type { ImageApiConfig, SpeechApiConfig } from './types'

export type MediaKind = 'image' | 'speech'

/** 媒体目录需要的最小配置形状（Image/Speech 都满足）。 */
export type MediaCatalogConfig = Pick<ImageApiConfig, 'protocol' | 'baseUrl' | 'apiKey' | 'extraHeaders'>

/** 拉回来的一个模型（字段可缺省，各家给的东西不一样）。 */
export type MediaModel = { id: string; name?: string }

/** 拉取结果。失败一律给中文 reason，不抛异常。 */
export type MediaCatalogResult =
  | { ok: true; models: MediaModel[] }
  | { ok: false; reason: string }

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 4 * 1024 * 1024

const NO_BASE_URL_REASON = '请先填写 API 地址，再获取。'
const NO_KEY_REASON = '请先填 API Key，再获取。'
const NO_LIST_REASON = '该协议不提供模型列表，请手动填写模型名。'
const EMPTY_REASON = '该提供商没有列出任何模型，请手动填写。'
const SHAPE_REASON = '该地址的模型列表格式无法识别，请手动填写。'
const TOO_BIG_REASON = '响应超过 4MB，无法解析'

/**
 * 把用户填的地址收敛成「站点根」，各家再自己拼路径。
 *
 * 常见误填：把完整的 /images/generations、/audio/speech 甚至 /models 贴进
 * baseUrl。这里先剥掉，避免拼出 .../models/models 这种必然 404 的地址。
 */
function siteRoot(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '')
  for (const suffix of ['/images/generations', '/audio/speech', '/chat/completions', '/models']) {
    if (base.toLowerCase().endsWith(suffix)) {
      base = base.slice(0, -suffix.length).replace(/\/+$/, '')
    }
  }
  return base
}

/**
 * 按协议拼「列出模型」的地址；返回 null 表示这个协议没有这个接口。
 *
 * - openai / openrouter：{root}/models
 * - gemini：{root}/models（root 一般已带 /v1beta）
 * - elevenlabs：{root}/v1/models（root 带不带 /v1 都兜住）
 * - minimax / aliyun：没有稳定公开列表 → null
 */
export function mediaModelsEndpoint(protocol: string, baseUrl: string): string | null {
  const root = siteRoot(baseUrl)
  if (root === '') return null
  switch (protocol) {
    case 'openai':
    case 'openrouter':
    case 'gemini':
      return `${root}/models`
    case 'elevenlabs':
      return root.toLowerCase().endsWith('/v1') ? `${root}/models` : `${root}/v1/models`
    default:
      return null
  }
}

/** 列模型用的请求头：鉴权照抄各协议，额外头最后覆盖。 */
export function mediaCatalogHeaders(config: MediaCatalogConfig): Record<string, string> {
  const key = config.apiKey.trim()
  const base: Record<string, string> = { accept: 'application/json' }
  if (config.protocol === 'gemini') base['x-goog-api-key'] = key
  else if (key !== '') base.Authorization = `Bearer ${key}`
  for (const [name, value] of Object.entries(config.extraHeaders ?? {})) {
    if (typeof value === 'string' && name.trim() !== '') base[name.trim()] = value
  }
  return base
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** 取出「模型数组」这一层；ElevenLabs 直接返回裸数组，也要认。返回 null = 形状不认识。 */
function extractEntries(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json
  const root = asRecord(json)
  if (root === null) return null
  if (Array.isArray(root.data)) return root.data
  if (Array.isArray(root.models)) return root.models
  return null
}

function modelId(entry: Record<string, unknown>): string {
  // ElevenLabs 用 model_id，Gemini 的 id 在 name 里带 models/ 前缀。
  const raw = pickString(entry, ['id', 'model_id', 'model', 'name'])
  if (raw === undefined) return ''
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw
}

function modalityList(entry: Record<string, unknown>): string[] {
  const out: string[] = []
  const arch = asRecord(entry.architecture)
  for (const value of [entry.output_modalities, arch?.output_modalities, entry.outputModalities]) {
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') out.push(item.toLowerCase())
    }
  }
  return out
}

function generationMethods(entry: Record<string, unknown>): string[] {
  const value = entry.supportedGenerationMethods ?? entry.supported_generation_methods
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase()) : []
}

/** 生图模型的 id 特征（没有能力字段时的兜底）。 */
const IMAGE_ID_HINT = /(dall-?e|gpt-image|imagen|image|seedream|flux|stable-?diffusion|sd-?\d|kolors|ideogram|recraft|qwen-image|wan\d|hunyuan-image|midjourney)/i
/** 语音 / TTS 模型的 id 特征。 */
const SPEECH_ID_HINT = /(tts|text-to-speech|audio|speech|voice|eleven|cosyvoice|sambert|fish-speech|gpt-4o-mini-tts)/i

/** 判断一个条目是否属于目标类别：能力字段优先，认不出来再按 id 猜。 */
function looksLike(entry: Record<string, unknown>, id: string, kind: MediaKind): boolean {
  const mods = modalityList(entry)
  if (kind === 'image' && mods.includes('image')) return true
  if (kind === 'speech' && mods.includes('audio')) return true
  const methods = generationMethods(entry)
  if (kind === 'image' && methods.includes('predict')) return true
  if (kind === 'speech' && methods.some((method) => method.includes('tts'))) return true
  return kind === 'image' ? IMAGE_ID_HINT.test(id) : SPEECH_ID_HINT.test(id)
}

/** 解析模型列表；按 id 去重保序。 */
export function parseMediaCatalog(json: unknown, kind: MediaKind): MediaModel[] {
  const entries = extractEntries(json)
  if (entries === null) return []
  const out: MediaModel[] = []
  const seen = new Set<string>()
  for (const raw of entries) {
    const entry = asRecord(raw)
    if (entry === null) continue
    const id = modelId(entry)
    if (id === '' || seen.has(id)) continue
    if (!looksLike(entry, id, kind)) continue
    seen.add(id)
    const name = pickString(entry, ['name', 'display_name', 'displayName'])
    out.push(name !== undefined && name !== id ? { id, name } : { id })
  }
  return out
}

/** 过滤后一个都不剩时退回「全部模型」——宁可让用户自己挑，也别用启发式把对的挡掉。 */
function allModels(json: unknown): MediaModel[] {
  const entries = extractEntries(json)
  if (entries === null) return []
  const out: MediaModel[] = []
  const seen = new Set<string>()
  for (const raw of entries) {
    const entry = asRecord(raw)
    if (entry === null) continue
    const id = modelId(entry)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name = pickString(entry, ['name', 'display_name', 'displayName'])
    out.push(name !== undefined && name !== id ? { id, name } : { id })
  }
  return out
}

/**
 * 去提供商那里要一份「能生图 / 能语音」的模型列表。
 *
 * 所有失败都收敛成 { ok:false, reason }；手动填写的入口不受影响。
 */
export async function fetchMediaModels(
  config: MediaCatalogConfig,
  kind: MediaKind,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MediaCatalogResult> {
  const url = mediaModelsEndpoint(config.protocol, config.baseUrl)
  if (url === null) {
    return { ok: false, reason: config.baseUrl.trim() === '' ? NO_BASE_URL_REASON : NO_LIST_REASON }
  }
  if (config.apiKey.trim() === '' && config.protocol !== 'gemini') {
    return { ok: false, reason: NO_KEY_REASON }
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const outer = options.signal
  const relayAbort = (): void => controller.abort()
  if (outer !== undefined) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', relayAbort, { once: true })
  }

  try {
    const response = await netRequest({
      url,
      method: 'GET',
      headers: mediaCatalogHeaders(config),
      signal: controller.signal,
      timeoutMs,
    })
    if (response.status >= 400) {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: `${url} 返回 ${response.status}，请检查 API Key` }
      }
      return { ok: false, reason: `${url} 返回 ${response.status}` }
    }
    const declared = Number(response.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, reason: TOO_BIG_REASON }
    if (response.text.length > MAX_BODY_BYTES) return { ok: false, reason: TOO_BIG_REASON }
    let json: unknown
    try {
      json = JSON.parse(response.text) as unknown
    } catch {
      return { ok: false, reason: `${url} 的响应不是 JSON` }
    }
    if (extractEntries(json) === null) return { ok: false, reason: SHAPE_REASON }
    const filtered = parseMediaCatalog(json, kind)
    const models = filtered.length > 0 ? filtered : allModels(json)
    if (models.length === 0) return { ok: false, reason: EMPTY_REASON }
    return { ok: true, models }
  } catch {
    if (timedOut) return { ok: false, reason: `请求超时（${seconds} 秒），请检查地址或网络` }
    if (outer?.aborted === true) return { ok: false, reason: '已取消' }
    return { ok: false, reason: `无法连接到 ${url}` }
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', relayAbort)
  }
}
