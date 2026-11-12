import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { photoFileName } from '../../lib/photo-store'
import { saveImage, shareImage } from '../../lib/platform'
import { useAppStore } from '../../lib/store'
import type { PhotoRecord } from '../../orca/photo'

type Busy = '' | 'save' | 'share'

/**
 * 全屏照片查看器（lightbox）。
 *
 * 为什么要它：移植到 React 外壳时只搬了相册**列表**，没搬大图查看和保存按钮 ——
 * 于是 APK 里既点不开照片，也存不下照片（游戏自带那份 DOM 相册 + window.xhs 存图
 * 是零调用点的死代码，见 docs/REVIEW-20261103.md §三）。
 *
 * 层级：portal 到 .app（和 ui.tsx 的 Modal 同一套理由 —— 带 backdrop-filter 的祖先
 * 会把 fixed 后代的包含块抢走），z-index 120 压过 .modal-backdrop 的 100，
 * 但仍在 .toast(200) 之下：保存结果那条提示必须看得见。
 * 根节点带 data-deepsea-ui：引擎的 keydown 会跳过这个子树，否则在查看器里按空格
 * 又拍一张新照片。
 */
export function PhotoViewer(props: {
  photos: PhotoRecord[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
  onDelete: (id: string) => void
}) {
  const actions = useAppStore((state) => state.actions)
  const [busy, setBusy] = useState<Busy>('')
  const total = props.photos.length
  // 外面删照片会让列表变短，这里只做钳制，不负责通知父组件关闭（那是 RoomScreen 的事）。
  const clamped = total === 0 ? -1 : Math.min(Math.max(props.index, 0), total - 1)
  const photo = clamped < 0 ? undefined : props.photos[clamped]

  useEffect(() => {
    if (photo === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        props.onClose()
        return
      }
      if (total > 1 && event.key === 'ArrowLeft') {
        props.onIndex((clamped - 1 + total) % total)
        return
      }
      if (total > 1 && event.key === 'ArrowRight') {
        props.onIndex((clamped + 1) % total)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [photo, clamped, total, props])

  if (photo === undefined) return null

  const step = (delta: number): void => {
    props.onIndex((clamped + delta + total) % total)
  }

  /* 存到系统相册 / 本地文件。结果必须照实说：以前那种「静默失败」就是这次的病根。 */
  const onSave = async (): Promise<void> => {
    if (busy !== '' || photo === undefined) return
    if (photo.dataURL === '') {
      actions.showToast('这张的原图还没读上来，稍等一下再存')
      return
    }
    setBusy('save')
    try {
      const result = await saveImage(photoFileName(photo, 'jpg'), photo.dataURL)
      if (result === 'gallery') actions.showToast('已存到相册：Pictures/深鲸')
      else if (result === 'shared') actions.showToast('存储不可用，已改走系统分享，请在面板里保存')
      else if (result === 'downloaded') actions.showToast('已保存为图片文件')
      else actions.showToast('保存失败，这张没能写出去')
    } finally {
      setBusy('')
    }
  }

  const onShare = async (): Promise<void> => {
    if (busy !== '' || photo === undefined) return
    if (photo.dataURL === '') {
      actions.showToast('这张的原图还没读上来，稍等一下再分享')
      return
    }
    setBusy('share')
    try {
      const result = await shareImage(photoFileName(photo, 'jpg'), photo.dataURL)
      if (result === 'shared') actions.showToast('已唤起系统分享')
      else if (result === 'saved') actions.showToast('这台设备没有分享面板，已存成文件')
      else actions.showToast('分享失败，可以改用「保存到相册」')
    } finally {
      setBusy('')
    }
  }

  return createPortal(
    <div
      className="photo-viewer"
      data-deepsea-ui
      role="dialog"
      aria-modal="true"
      aria-label="照片查看"
      onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <button type="button" className="photo-viewer__close" onClick={props.onClose} aria-label="关闭">
        ×
      </button>

      {total > 1 && (
        <button type="button" className="photo-viewer__nav photo-viewer__nav--prev" onClick={() => step(-1)} aria-label="上一张">
          ‹
        </button>
      )}

      <figure className="photo-viewer__stage">
        {/* 大图还没从 IndexedDB 水合上来时先拿缩略图顶着，至少不是一张破图。 */}
        <img src={photo.dataURL === '' ? photo.thumbURL : photo.dataURL} alt={photo.label} draggable={false} />
        <figcaption className="photo-viewer__caption">
          <strong>{photo.label}</strong>
          <span>{photo.dateLabel}</span>
          {total > 1 && (
            <span className="photo-viewer__count">
              {clamped + 1} / {total}
            </span>
          )}
          {photo.dataURL === '' && <span className="photo-viewer__loading">原图读取中…</span>}
        </figcaption>
      </figure>

      {total > 1 && (
        <button type="button" className="photo-viewer__nav photo-viewer__nav--next" onClick={() => step(1)} aria-label="下一张">
          ›
        </button>
      )}

      <div className="photo-viewer__bar">
        <button type="button" className="photo-viewer__btn" onClick={() => void onSave()} disabled={busy !== ''}>
          {busy === 'save' ? <span className="photo-viewer__spin" aria-hidden="true" /> : <span aria-hidden="true">⬇</span>}
          {busy === 'save' ? '保存中…' : '保存到相册'}
        </button>
        <button type="button" className="photo-viewer__btn" onClick={() => void onShare()} disabled={busy !== ''}>
          {busy === 'share' ? <span className="photo-viewer__spin" aria-hidden="true" /> : <span aria-hidden="true">⇪</span>}
          分享
        </button>
        <button
          type="button"
          className="photo-viewer__btn photo-viewer__btn--danger"
          onClick={() => props.onDelete(photo.id)}
          disabled={busy !== ''}
        >
          删除
        </button>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body,
  )
}
