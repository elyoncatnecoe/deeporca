import assistantSvg from '../assets/logo-deepseek.svg?raw'
import userSvg from '../assets/avatar-user.svg?raw'
import clawdSvg from '../assets/avatar-clawd.svg?raw'
import sealSvg from '../assets/avatar-seal.svg?raw'

/** 默认头像转成 data URI：气泡、设置页、注入网页的脚本都用同一份。 */
function toDataUri(svg: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

export const DEFAULT_AVATARS: Record<'user' | 'assistant', string> = {
  assistant: toDataUri(assistantSvg),
  user: toDataUri(userSvg),
}

/**
 * 内置助手头像（按 id 取），给预置的三个助手的 `avatarBuiltin` 用。
 *
 * 之前助手头像只能选 emoji，界面上就是一串表情符号，很糊；现在每个助手可以
 * 用一个内置 SVG，或者换成用户自己上传的 PNG（avatarKind = 'image'）。
 * 'deeporca' 直接用现有那枚 DeepSeek 蓝鲸标，保持和老版本一致。
 */
export const BUILTIN_ASSISTANT_AVATARS: Record<string, string> = {
  deeporca: toDataUri(assistantSvg),
  clawd: toDataUri(clawdSvg),
  sealgpt: toDataUri(sealSvg),
}

/** 解析一个助手该显示哪张头像：上传图 > 内置 SVG > emoji。 */
export function assistantAvatarSrc(input: {
  avatarKind?: 'builtin' | 'emoji' | 'image'
  avatarBuiltin?: string
  avatarImage?: string
  avatar?: string
}): string {
  if (input.avatarKind === 'image' && input.avatarImage !== undefined && input.avatarImage !== '') {
    return input.avatarImage
  }
  if (input.avatarKind === 'builtin' && input.avatarBuiltin !== undefined) {
    const hit = BUILTIN_ASSISTANT_AVATARS[input.avatarBuiltin]
    if (hit !== undefined) return hit
  }
  // emoji 或老数据：不是 http/data 开头就当文字渲染，返回空串让调用方走文字分支
  const avatar = input.avatar ?? ''
  if (avatar.startsWith('data:') || avatar.startsWith('http')) return avatar
  return ''
}
