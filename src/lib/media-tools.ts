import { generateImages, isImageConfigured, isMediaAbort, isSpeechConfigured, MediaApiError, synthesizeSpeech } from './media-api.ts'
import { mediaAltFromPrompt } from './media-store.ts'
import type { ImageApiConfig, Settings, SpeechApiConfig } from './types'

/**
 * 对话内的两个媒体工具。
 *
 * 和工坊文件工具/MCP 工具一样，都是 OpenAI function 定义；区别是：
 * - 它们不在 workspace.ts（那个模块的 executeTool 三参签名被历史测试锁着，也没有 AbortSignal）；
 * - 是否暴露给模型由设置里的「生图 API / 语音 API 是否启用且填全」决定；
 * - 生图工具必须只由用户显式要求触发 —— 普通 RP 里模型不能自作主张画图。
 */

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image'
export const SPEAK_TOOL_NAME = 'speak'

export const GENERATE_IMAGE_TOOL = {
  type: 'function',
  function: {
    name: GENERATE_IMAGE_TOOL_NAME,
    description: [
      'Generate an image from a text prompt and show it in the conversation.',
      'ONLY call this when the user explicitly asks to draw, generate, create, edit or design an image/picture/illustration/poster/avatar/wallpaper/logo.',
      'NEVER call this proactively: do not generate an image just because the user uploaded a photo, described a scene, or is role-playing.',
      'When the user asks to edit or reference an image they attached, set reference="last_user_images".',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed image prompt: subject, style, lighting, composition. Max 4000 characters.',
        },
        size: {
          type: 'string',
          description: 'Optional output size, e.g. auto / 1024x1024 / 1536x1024 / 1K / 2K. Leave empty to use the setting default.',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'How many images to generate, default 1.',
        },
        reference: {
          type: 'string',
          enum: ['none', 'last_user_images'],
          description: 'Use "last_user_images" only when the user explicitly asks to edit/reference the image(s) attached to their current message.',
        },
      },
      required: ['prompt'],
    },
  },
} as const

export const SPEAK_TOOL = {
  type: 'function',
  function: {
    name: SPEAK_TOOL_NAME,
    description: [
      'Convert text into speech and play it in the conversation.',
      'Use ONLY when the user explicitly asks you to read something aloud, asks for a voice reply, or asks for audio.',
      'Do not use it for ordinary text replies.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to speak, up to 2000 characters.',
        },
        speed: {
          type: 'number',
          minimum: 0.5,
          maximum: 2,
          description: 'Optional speaking speed override.',
        },
      },
      required: ['text'],
    },
  },
} as const

/** 当前设置下应该交给模型的媒体工具。 */
export function mediaToolDefinitions(settings: Settings): unknown[] {
  return [
    ...(isImageConfigured(settings.imageApi) ? [{ ...GENERATE_IMAGE_TOOL }] : []),
    ...(isSpeechConfigured(settings.speechApi) ? [{ ...SPEAK_TOOL }] : []),
  ]
}

export function isMediaToolName(name: string): boolean {
  return name === GENERATE_IMAGE_TOOL_NAME || name === SPEAK_TOOL_NAME
}

/** 一条待落库的媒体草稿；id / messageId / conversationId / createdAt 由 engine 补。 */
export interface MediaDraft {
  kind: 'image' | 'audio'
  mime: string
  dataUrl: string
  prompt?: string
  width?: number
  height?: number
  durationMs?: number
  alt?: string
}

export interface MediaToolContext {
  settings: Settings
  conversationId: string
  /** 当前消息里的图片附件 data URL（图生图用）。 */
  referenceImages: string[]
  signal?: AbortSignal
}

export interface MediaToolOutcome {
  resultText: string
  media: MediaDraft[]
}

function parseArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

function imageConfigOf(settings: Settings): ImageApiConfig {
  return settings.imageApi
}

function speechConfigOf(settings: Settings): SpeechApiConfig {
  return settings.speechApi
}

function errorText(error: unknown): string {
  if (error instanceof MediaApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

async function runGenerateImage(args: Record<string, unknown>, context: MediaToolContext): Promise<MediaToolOutcome> {
  const config = imageConfigOf(context.settings)
  if (!isImageConfigured(config)) {
    return { resultText: '生图 API 还没配置好。请让用户到「设置 → 生图与语音」里填生图 API 地址、Key 和模型。', media: [] }
  }
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (prompt === '') return { resultText: 'generate_image 缺少 prompt 参数。', media: [] }
  if (prompt.length > 4000) return { resultText: '生图提示词太长（最多 4000 字），请缩短。', media: [] }

  const reference = typeof args.reference === 'string' ? args.reference : 'none'
  if (reference === 'last_user_images' && context.referenceImages.length === 0) {
    return { resultText: '用户这条消息里没有可参考的图片；如果要生成新图，请把 reference 设为 none。', media: [] }
  }
  const referenceImages = reference === 'last_user_images' ? context.referenceImages : []
  const size = typeof args.size === 'string' && args.size.trim() !== '' ? args.size.trim() : config.defaultSize
  const count = clampInt(args.count, 1, 4, 1)

  try {
    const images = await generateImages(config, {
      prompt,
      size,
      count,
      quality: config.quality,
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
    }, context.signal)
    /*
     * 请求回来的时候用户可能已经按了停止。
     * 这时不能再把图当成「生成成功」：一旦返回 media，engine 会把它写进库，
     * 用户取消的那次生图就变成了永久残留（T-07）。
     */
    if (context.signal?.aborted === true) {
      return { resultText: '已停止：这次生图被取消，没有保存图片。', media: [] }
    }
    const media: MediaDraft[] = images.map((image) => ({
      kind: 'image',
      mime: image.mime,
      dataUrl: image.dataUrl,
      prompt,
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
      alt: mediaAltFromPrompt(prompt),
    }))
    const mode = referenceImages.length > 0 ? '参考图' : '文生图'
    return {
      resultText: `已生成 ${media.length} 张图片（${mode}，${size || '默认尺寸'}）。客户端已经显示在对话里，不要输出假图片链接。`,
      media,
    }
  } catch (error) {
    // 取消不是「失败」：说清楚是用户停的，别让模型去重试一次已经取消的生图。
    if (isMediaAbort(error)) return { resultText: '已停止：这次生图被取消。', media: [] }
    return { resultText: `生图失败：${errorText(error)}`, media: [] }
  }
}

async function runSpeak(args: Record<string, unknown>, context: MediaToolContext): Promise<MediaToolOutcome> {
  const config = speechConfigOf(context.settings)
  if (!isSpeechConfigured(config)) {
    return { resultText: '语音 API 还没配置好。请让用户到「设置 → 生图与语音」里填语音 API 地址、Key 和模型。', media: [] }
  }
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (text === '') return { resultText: 'speak 缺少 text 参数。', media: [] }
  if (text.length > 2000) return { resultText: '一次最多朗读 2000 字；请把内容拆成几段再调用。', media: [] }
  const speed = clampFloat(args.speed, 0.5, 2, config.speed)
  try {
    const audio = await synthesizeSpeech({ ...config, speed }, text, context.signal)
    // 同上：被停止的语音不要再落库（T-07）。
    if (context.signal?.aborted === true) {
      return { resultText: '已停止：这次语音生成被取消，没有保存音频。', media: [] }
    }
    return {
      resultText: `已生成语音（${text.length} 字，${config.voice || '默认音色'}）。客户端已显示播放器，需要用户自己点播放。`,
      media: [{
        kind: 'audio',
        mime: audio.mime,
        dataUrl: audio.dataUrl,
        prompt: text.slice(0, 2000),
        alt: mediaAltFromPrompt(text),
      }],
    }
  } catch (error) {
    if (isMediaAbort(error)) return { resultText: '已停止：这次语音生成被取消。', media: [] }
    return { resultText: `语音生成失败：${errorText(error)}`, media: [] }
  }
}

/**
 * 执行一个媒体工具。
 *
 * 注意：参数被截断（不是合法 JSON）的调用在 engine 里已经先被拦住，
 * 不会走到这里；这里只负责「参数合法」的调用。
 */
export async function runMediaTool(name: string, rawArgs: string, context: MediaToolContext): Promise<MediaToolOutcome> {
  const args = parseArgs(rawArgs)
  if (name === GENERATE_IMAGE_TOOL_NAME) return await runGenerateImage(args, context)
  if (name === SPEAK_TOOL_NAME) return await runSpeak(args, context)
  return { resultText: `未知的媒体工具：${name}`, media: [] }
}
