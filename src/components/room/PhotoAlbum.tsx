import type { PhotoRecord } from '../../orca/photo'
import { EmptyState, Modal } from '../ui'

/**
 * 相册。
 *
 * 照片本身已经是拍立得成品（边框、灰度、模糊都烤在 dataURL 里了），
 * 所以这里只需要摆出来 —— 不要在这里再套一层滤镜，那会和文件里的效果打架。
 *
 * 两个必须留在这里的理由：
 * - 网格用 `thumbURL`（220px），**不是** `dataURL`：8 张全尺寸 base64 进 DOM 是几 MB，
 *   低端机上打开相册就卡死，而缩略图本来就是为这一屏生成的。
 * - 每张图是个真按钮：点开全屏 PhotoViewer（翻页 / 保存到相册 / 分享 / 删除）。
 *   以前这里只有「删除」，照片点不开 —— 用户报的「拍照无法点开」就是这一条。
 */
export function PhotoAlbum(props: {
  open: boolean
  onClose: () => void
  photos: PhotoRecord[]
  onDelete: (id: string) => void
  onOpen: (index: number) => void
  /** 落盘失败时的提示（照片存不下了），由宿主从相册 store 拿过来。 */
  storageError?: string | null
}) {
  return (
    <Modal open={props.open} onClose={props.onClose} title={`相册（${props.photos.length}）`} wide>
      {props.storageError !== undefined && props.storageError !== '' && (
        <p className="album-warn" role="alert">
          ⚠️ {props.storageError}
        </p>
      )}
      {props.photos.length === 0 ? (
        <EmptyState icon={<span style={{ fontSize: 28 }}>📷</span>} title="还没有照片" body="回到布置屏，点「拍一张」试试。" />
      ) : (
        <div className="album-grid">
          {props.photos.map((photo, index) => (
            <figure key={photo.id} className={`album-item ${photo.blurry === true ? 'is-blurry' : ''}`}>
              {/* 缩略图本身是个按钮（点开大图）；删除按钮必须留在它外面 —— 按钮不能套按钮。 */}
              <button type="button" className="album-open" onClick={() => props.onOpen(index)} title="点开看大图">
                <img src={photo.thumbURL === '' ? photo.dataURL : photo.thumbURL} alt={photo.label} />
              </button>
              <figcaption>
                <strong>{photo.label}</strong>
                <small>{photo.dateLabel}</small>
                <button type="button" className="album-del" onClick={() => props.onDelete(photo.id)}>
                  删除
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </Modal>
  )
}
