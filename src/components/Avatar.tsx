import { useSyncExternalStore } from 'react'
import { assistantAvatarSrc, DEFAULT_AVATARS } from '../lib/avatar-defaults'
import { avatarStore, type AvatarRole } from '../lib/avatars'

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
