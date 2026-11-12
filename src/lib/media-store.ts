import type { MediaRecord, MessageMediaRef } from './types'

/**
 * 对话生成媒体的纯逻辑。
 *
 * 和 photo-store.ts 一样单独成模块：不碰 DOM、不碰 IndexedDB，所以能直接在
 * `node --test` 里跑真断言。媒体 API / engine / 渲染都只通过这里处理 data URL，
 * 避免各处的 `data:...;base64,` 解析规则漂移。
 */

/** 单张图片的 data URL 上限。OpenRouter 返回的 2K PNG 通常 2~5MB，留足余量。 */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024
/** 单段语音的 data URL 上限。一分钟 mp3 通常 < 2MB。 */
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024

export interface ParsedDataUrl {
  mime: string
  base64: string
}

/** 解析 `data:image/png;base64,AAAA`；非 base64 或格式不对返回 null。 */
export function parseDataUrl(url: string): ParsedDataUrl | null {
  const matched = /^data:([^;,]+)[^,]*;base64,([\s\S]+)$/.exec(url.trim())
  if (matched === null) return null
  const mime = matched[1]?.trim() ?? ''
  const base64 = matched[2]?.trim() ?? ''
  if (mime === '' || base64 === '') return null
  return { mime, base64 }
}

export function dataUrlOf(mime: string, base64: string): string {
  return `data:${mime || 'application/octet-stream'};base64,${base64}`
}

/** base64 字符串解码后的近似字节数（不算 data URL 前缀）。 */
export function estimateBase64Bytes(base64: string): number {
  const clean = base64.replace(/\s+/g, '')
  if (clean === '') return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

export function estimateDataUrlBytes(url: string): number {
  const parsed = parseDataUrl(url)
  return parsed === null ? 0 : estimateBase64Bytes(parsed.base64)
}

/** 媒体记录 → 消息里的轻量引用（绝不要带 dataUrl）。 */
export function mediaRefOf(record: MediaRecord): MessageMediaRef {
  return {
    id: record.id,
    kind: record.kind,
    mime: record.mime,
    ...(record.width !== undefined ? { width: record.width } : {}),
    ...(record.height !== undefined ? { height: record.height } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.alt !== undefined && record.alt !== '' ? { alt: record.alt.slice(0, 200) } : {}),
  }
}

/** 生成图/音频的替代文本：prompt 前 80 字，去掉换行。 */
export function mediaAltFromPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** 检查 data URL 是否在对应类型的体积上限内。 */
export function mediaWithinLimit(kind: 'image' | 'audio', dataUrl: string): boolean {
  const parsed = parseDataUrl(dataUrl)
  if (parsed === null) return false
  const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES
  return estimateBase64Bytes(parsed.base64) <= limit
}

/**
 * 从外部（备份/旧数据）读到的媒体记录做一次形状收敛。
 * 目前备份不含媒体，但旧版本/手动改库可能留下脏行，读取时不要炸。
 */
export function sanitizeMediaRecord(raw: unknown): MediaRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  if (typeof item.id !== 'string' || item.id === '') return null
  if (typeof item.conversationId !== 'string' || item.conversationId === '') return null
  if (typeof item.messageId !== 'string' || item.messageId === '') return null
  if (item.kind !== 'image' && item.kind !== 'audio') return null
  if (typeof item.mime !== 'string' || typeof item.dataUrl !== 'string') return null
  if (parseDataUrl(item.dataUrl) === null) return null
  return {
    id: item.id,
    conversationId: item.conversationId,
    messageId: item.messageId,
    kind: item.kind,
    mime: item.mime,
    dataUrl: item.dataUrl,
    ...(typeof item.prompt === 'string' ? { prompt: item.prompt } : {}),
    ...(typeof item.width === 'number' && Number.isFinite(item.width) ? { width: Math.round(item.width) } : {}),
    ...(typeof item.height === 'number' && Number.isFinite(item.height) ? { height: Math.round(item.height) } : {}),
    ...(typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) ? { durationMs: Math.round(item.durationMs) } : {}),
    ...(typeof item.alt === 'string' ? { alt: item.alt } : {}),
    createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
  }
}
