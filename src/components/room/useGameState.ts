import { useEffect, useState } from 'react'
import { stageBridge } from '../../lib/stage-bridge'
import type { GameState } from '../../orca/app'
import {
  getPhotosStoreSnapshot,
  onPhotosStoreChange,
  photoBytesIndex,
  requestPhotosHydration,
  withPhotoBytes,
  type PhotoRecord,
} from '../../orca/photo'

export interface GameSnapshot {
  /** null = 3D 还没起来（没有 WebGL，或者 Stage 还在挂载）。 */
  game: GameState | null
  /**
   * 相册。顺序以引擎那份为准（它才是「现在有哪些照片」的权威），
   * 大图字节从相册 store 按 id 补进来 —— 引擎的 getPhotos() 是同步的，
   * 刚从 IndexedDB 之外读不到大图；而 store 里被删掉的那张又不能让它自己冒回来，
   * 所以是「补字节」，不是「两份列表合并」。
   */
  photos: PhotoRecord[]
  /** 照片落盘失败的原因（配额满 / IndexedDB 不可用）。null = 正常。 */
  photosError: string | null
}

/**
 * 订阅水族馆状态。
 *
 * 引擎是命令式的、活在 React 之外的；这个 hook 是唯一的读出口。
 * 引擎每次真正改了状态（投喂、召唤伙伴、拍照……）都会回调一次，
 * 所以这里不需要轮询，也不该在渲染循环里 setState。
 *
 * 相册另外还有一条异步通路（photo-store）：首启迁移 + IndexedDB 水合完成后会通知一次。
 * 只订阅引擎的 onChange 会漏掉它 —— 那样大图要等用户随便动一下才显示出来。
 */
export function useGameState(): GameSnapshot {
  const [game, setGame] = useState<GameState | null>(null)
  const [photos, setPhotos] = useState<PhotoRecord[]>([])
  const [photosError, setPhotosError] = useState<string | null>(null)

  useEffect(() => {
    const api = stageBridge.current
    // Stage 的 effect 先于本组件跑，正常情况下这里一定有值；
    // 真的没有就是这台设备拿不到 WebGL，调用方要显示降级界面。
    if (api === null) return
    const sync = (): void => {
      const store = getPhotosStoreSnapshot()
      setGame(api.getGameState())
      setPhotos(withPhotoBytes(api.getPhotos(), photoBytesIndex(store.photos)))
      setPhotosError(store.error)
    }
    sync()
    void requestPhotosHydration().then(sync)
    const offEngine = api.onChange(sync)
    const offStore = onPhotosStoreChange(sync)
    return () => {
      offEngine()
      offStore()
    }
  }, [])

  return { game, photos, photosError }
}
