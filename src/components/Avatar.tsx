import { useSyncExternalStore } from 'react'
import { assistantAvatarSrc, DEFAULT_AVATARS } from '../lib/avatar-defaults'
import { avatarStore, type AvatarRole } from '../lib/avatars'
import { avatarSourceFor } from '../lib/avatar-pick'
import { findAssistant } from '../lib/assistant'
import type { Settings } from '../lib/types'

/**
 * 头像。三种来源按优先级：
 *  1. 用户全局上传图（avatarStore，role=user/assistant）
 *  2. 助手自己的头像（内置 SVG / 上传 PNG / emoji），由 avatarSrc/emoji 传入
 *  3. 内置默认（assistant = DeepSeek 蓝鲸标，user = 水母）
 *
 * 没有 src 且带 emoji 时退化成文字头像（老数据的 emoji 助手）。
 */
export function Avatar(props: {
  role: AvatarRole
  size?: number
  /*
   * 以前这里有个 `className?: string`，全仓 13 处调用**没有一处**传它 ——
   * 于是头像的类名被拼成 `className={className}`，CSS 守卫
   * （test/css-class-audit.test.ts）读不出静态类名，只能报「无法解析」。
   * 既然没人用，就把这个死参数去掉，类名改回字面量。
   */
  /** 助手头像的解析结果（图片或 data URI）。传了就不走全局 assistant 头像。 */
  avatarSrc?: string
  /** 助手头像如果是 emoji，则用它渲染一个文字头像。 */
  emoji?: string
}) {
  const custom = useSyncExternalStore(
    avatarStore.subscribe,
    () => avatarStore.get(props.role),
    () => null,
  )
  const size = props.size ?? 20

  // 助手自带 emoji 头像且没有可用的图片源：渲染文字头像。
  if (props.role === 'assistant' && (props.avatarSrc === undefined || props.avatarSrc === '') && props.emoji !== undefined && props.emoji !== '') {
    return (
      <span
        className="avatar avatar-emoji"
        style={{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.62) + 'px' }}
        data-role={props.role}
        data-custom="false"
        aria-hidden="true"
      >
        {props.emoji}
      </span>
    )
  }

  const src = props.avatarSrc !== undefined && props.avatarSrc !== ''
    ? props.avatarSrc
    : (custom ?? DEFAULT_AVATARS[props.role])
  return (
    <img
      className="avatar"
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ width: size + 'px', height: size + 'px' }}
      data-role={props.role}
      data-custom={custom === null ? 'false' : 'true'}
      draggable={false}
    />
  )
}

/** 从一个助手（或对话快照）算出 <Avatar> 需要的两个 props。 */
export function assistantAvatarProps(input: {
  avatarKind?: 'builtin' | 'emoji' | 'image'
  avatarBuiltin?: string
  avatarImage?: string
  avatar?: string
}): { avatarSrc: string; emoji: string } {
  const src = assistantAvatarSrc(input)
  return { avatarSrc: src, emoji: input.avatar ?? '' }
}

/**
 * 这一屏 / 这一页该用哪个「助手头像」。
 *
 * 助手开着 → 当前助手自己的头像（内置 SVG / 上传图 / emoji）；
 * 助手关掉 → 返回空，让调用方回落到设置里的全局头像（avatarStore）。
 *
 * 为什么要有这个函数：以前聊天气泡有的地方用助手头像、有的地方用设置头像，
 * 网页端则永远只用设置级 —— 用户看到的就是「两个头像在打架」。
 * 现在只有一个来源：开着助手，助手说了算。
 *
 * 注意 emoji：`avatarSrc` 会是空串（emoji 没有图片源）。App 里 Avatar 会渲染文字头像；
 * 网页注入脚本只会画 `<img>`，那边由调用方回落到设置头像（见 web-mode.ts）。
 */
export function currentAssistantAvatar(settings: Settings): { avatarSrc: string; emoji: string } {
  if (avatarSourceFor(settings) !== 'assistant') return { avatarSrc: '', emoji: '' }
  return assistantAvatarProps(findAssistant(settings, settings.assistantId))
}
