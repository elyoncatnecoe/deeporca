import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Share2, Wrench, X } from 'lucide-react'
import { listMediaByMessage } from '../lib/db'
import { saveImage, shareImage } from '../lib/platform'
import { useAppStore } from '../lib/store'
import type { ChatMessage, MediaRecord } from '../lib/types'

function extensionOf(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('svg')) return 'svg'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg') || mime.includes('opus')) return 'ogg'
  return 'mp3'
}

function imageFileName(record: MediaRecord): string {
  return `deepsea-image-${record.id.slice(-8)}.${extensionOf(record.mime)}`
}

/**
 * 生成图/语音的全屏查看器。
 *
 * 只服务对话里的媒体消息，不碰布置屏相册；保存复用 platform.saveImage 的三端实现。
 */
function MediaViewer(props: {
  record: MediaRecord
  onClose: () => void
}) {
  const actions = useAppStore((state) => state.actions)
  const [busy, setBusy] = useState<'' | 'save' | 'share'>('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  const onSave = async (): Promise<void> => {
    if (busy !== '') return
    setBusy('save')
    try {
      const result = await saveImage(imageFileName(props.record), props.record.dataUrl)
      if (result === 'gallery') actions.showToast('已存到相册：Pictures/深鲸')
      else if (result === 'shared') actions.showToast('存储不可用，已改走系统分享')
      else if (result === 'downloaded') actions.showToast('已保存为图片文件')
      else actions.showToast('保存失败，这张没能写出去')
    } finally {
      setBusy('')
    }
  }

  const onShare = async (): Promise<void> => {
    if (busy !== '') return
    setBusy('share')
    try {
      const result = await shareImage(imageFileName(props.record), props.record.dataUrl)
      if (result === 'shared') actions.showToast('已唤起系统分享')
      else if (result === 'saved') actions.showToast('这台设备没有分享面板，已存成文件')
      else actions.showToast('分享失败，可以改用保存')
    } finally {
      setBusy('')
    }
  }

  return createPortal(
    <div
      className="media-viewer"
      data-deepsea-ui
      role="dialog"
      aria-modal="true"
      aria-label="查看生成图片"
      onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <button type="button" className="media-viewer__close" onClick={props.onClose} aria-label="关闭">
        <X size={20} />
      </button>
      <figure className="media-viewer__stage">
        <img src={props.record.dataUrl} alt={props.record.alt ?? '生成图片'} draggable={false} />
        <figcaption>
          {props.record.prompt !== undefined && props.record.prompt !== '' ? props.record.prompt : '生成图片'}
        </figcaption>
      </figure>
      <div className="media-viewer__bar">
        <button type="button" className="media-viewer__btn" onClick={() => void onSave()} disabled={busy !== ''}>
          <Download size={16} /> {busy === 'save' ? '保存中…' : '保存'}
        </button>
        <button type="button" className="media-viewer__btn" onClick={() => void onShare()} disabled={busy !== ''}>
          <Share2 size={16} /> 分享
        </button>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body,
  )
}

/**
 * 工具结果里的生成媒体卡片。
 *
 * 图片直接显示缩略图（不用展开），音频显示播放器；原始工具结果收进 details。
 * 音频不自动播放 —— 用户明确要求“手动点”，自动播放还容易被系统策略拦。
 */
export function MediaToolCard({ message }: { message: ChatMessage }) {
  const [records, setRecords] = useState<MediaRecord[] | null>(null)
  const [viewing, setViewing] = useState<MediaRecord | null>(null)

  useEffect(() => {
    let alive = true
    if (message.media === undefined || message.media.length === 0) {
      setRecords([])
      return
    }
    void listMediaByMessage(message.id).then((rows) => {
      if (!alive) return
      // 只保留消息里还声明着的引用，防止旧孤儿行混进来。
      const allowed = new Set(message.media?.map((ref) => ref.id) ?? [])
      setRecords(rows.filter((row) => allowed.has(row.id)))
    }).catch(() => {
      if (alive) setRecords([])
    })
    return () => {
      alive = false
    }
  }, [message.id, message.media])

  const refs = message.media ?? []
  const images = (records ?? []).filter((record) => record.kind === 'image')
  const audios = (records ?? []).filter((record) => record.kind === 'audio')
  const missing = records !== null ? refs.length - records.length : 0

  return (
    <div className="tool-media">
      <div className="tool-media__head">
        <Wrench size={14} />
        <span>{message.toolName ?? '媒体工具'}</span>
        <span className="tool-media__hint">{images.length > 0 ? `${images.length} 张图片` : audios.length > 0 ? `${audios.length} 段语音` : '生成结果'}</span>
      </div>

      {records === null && refs.length > 0 && <div className="tool-media__loading">正在读取生成结果…</div>}
      {images.length > 0 && (
        <div className="tool-media__grid">
          {images.map((record) => (
            <button
              key={record.id}
              type="button"
              className="tool-media__image"
              onClick={() => setViewing(record)}
              aria-label={record.alt ?? '查看生成图片'}
            >
              <img src={record.dataUrl} alt={record.alt ?? '生成图片'} loading="lazy" draggable={false} />
            </button>
          ))}
        </div>
      )}
      {audios.length > 0 && (
        <div className="tool-media__audio-list">
          {audios.map((record) => (
            <div key={record.id} className="tool-media__audio">
              <audio controls preload="metadata" src={record.dataUrl} aria-label={record.alt ?? '生成的语音'} />
            </div>
          ))}
        </div>
      )}
      {missing > 0 && <div className="tool-media__missing">有 {missing} 个生成结果已不在本机（可能已被清理或来自旧备份）。</div>}

      <details className="tool-media__raw">
        <summary>查看工具结果</summary>
        <pre>{message.content}</pre>
      </details>

      {viewing !== null && <MediaViewer record={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}
