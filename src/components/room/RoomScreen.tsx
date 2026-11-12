import { useEffect, useState } from 'react'
import { Camera, Coins, Eye, Palette, Shapes, Users, Waves, type LucideIcon } from 'lucide-react'
import { useAppStore } from '../../lib/store'
import { stageBridge } from '../../lib/stage-bridge'
import type { QualityId, ThemeId } from '../../lib/types'
import { IconButton, ScreenHeader } from '../ui'
import { CompanionPanel, DecorPanel, FeedPanel, LookPanel, PhotoPanel } from './panels'
import { PhotoAlbum } from './PhotoAlbum'
import { PhotoViewer } from './PhotoViewer'
import { useGameState } from './useGameState'

type TabId = 'feed' | 'decor' | 'photo' | 'companion' | 'look'

/*
 * 标签用 lucide 图标而不是 emoji。
 *
 * 🪙(U+1FA99, Emoji 13) / 🪸(U+1FAB8, Emoji 14) 在老 Android WebView 的
 * 系统字体里没有字形，真机上就是「部分标签图标空白」。SVG 不依赖系统 emoji
 * 字体，currentColor 还能跟着选中态变色。
 */
const TABS: Array<{ id: TabId; Icon: LucideIcon; label: string }> = [
  { id: 'feed', Icon: Coins, label: '投喂' },
  { id: 'decor', Icon: Shapes, label: '布置' },
  { id: 'photo', Icon: Camera, label: '拍照' },
  { id: 'companion', Icon: Users, label: '伙伴' },
  { id: 'look', Icon: Palette, label: '外观' },
]

/**
 * 「布置」屏。
 *
 * 和设置屏一样是一个独立整屏，但**内容不是卡片列表**：背后就是那口缸，
 * 控件是一层浮在画布上的玻璃面板。理由是这里的每件事都要能点到水里的东西
 * —— 投喂要点虎鲸、布置要点海底。任何盖住画面的不透明布局都会让交互失效。
 *
 * 浮层只在两种时候收起成一条窄栏：投喂上膛、布置模式。因为这两种状态下
 * 玩家要频繁点画布，面板挡住的每一像素都是损失。
 */
export function RoomScreen() {
  const { game, photos, photosError } = useGameState()
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [tab, setTab] = useState<TabId>('feed')
  const [albumOpen, setAlbumOpen] = useState(false)
  /** 打开的全屏查看器（下标）。null = 没开。 */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const api = stageBridge.current

  /*
   * 照片存不下时必须说一声：以前 persistPhotos 的 catch 是空的，配额写满也一声不吭，
   * 用户的感受就是「拍完照没了」。失败原因从 photo-store 的快照里来（见 useGameState）。
   * 同一句话连着失败只会 toast 一次（字符串没变，effect 不会重跑）—— 界面里那条
   * 常驻提示在相册和拍照面板上，不会因此看不出来。
   */
  useEffect(() => {
    if (photosError !== null) actions.showToast(photosError)
  }, [photosError, actions])

  useEffect(() => {
    const current = stageBridge.current
    current?.setRoomMode(true)
    // 离开必须收掉投喂 / 布置模式：否则回到聊天页点画布还会往缸里丢 token。
    return () => {
      current?.setRoomMode(false)
    }
  }, [])

  const compact = game !== null && (game.feedArmed || game.mode === 'decorating')
  const aquariumTheme = settings.aquariumTheme as ThemeId
  const quality = settings.quality as QualityId

  /**
   * 删一张照片，并把查看器的下标收正。
   * 列表短了一条之后原来的下标可能指到范围外：往前挪一格，删光了就直接关窗。
   */
  const deletePhoto = (id: string): void => {
    api?.deletePhoto(id)
    const remaining = Math.max(0, photos.length - 1)
    if (remaining === 0) {
      setViewerIndex(null)
      return
    }
    if (viewerIndex !== null && viewerIndex >= remaining) setViewerIndex(remaining - 1)
  }

  const panel = (() => {
    if (api === null || game === null) return null
    if (tab === 'feed') return <FeedPanel game={game} api={api} />
    if (tab === 'decor') return <DecorPanel game={game} api={api} />
    if (tab === 'photo') {
      return (
        <PhotoPanel
          game={game}
          photos={photos}
          api={api}
          onOpenAlbum={() => setAlbumOpen(true)}
          onView={setViewerIndex}
          onToast={(text) => actions.showToast(text)}
          storageError={photosError}
        />
      )
    }
    if (tab === 'companion') return <CompanionPanel game={game} api={api} />
    return (
      <LookPanel
        game={game}
        api={api}
        aquariumTheme={aquariumTheme}
        quality={quality}
        onTheme={(theme) => void actions.setSettings({ aquariumTheme: theme })}
        onQuality={(next) => void actions.setSettings({ quality: next })}
      />
    )
  })()

  return (
    <div className="room-screen">
      <ScreenHeader
        title="布置"
        subtitle={game === null ? '3D 海还没起来' : '喂它、布置它、给它拍照'}
        onBack={() => actions.setScreen('home')}
        actions={
          <IconButton label="欣赏模式：隐藏所有菜单" onClick={() => actions.setZen(true)}>
            <Eye size={18} />
          </IconButton>
        }
      />

      {api === null || game === null ? (
        <div className="room-fallback">
          <Waves size={22} />
          <strong>这台设备画不出 3D 海</strong>
          <span>聊天、记忆和工坊照常可用，布置功能需要 WebGL。</span>
        </div>
      ) : compact ? (
        <div className="room-dock room-dock--compact">
          {game.feedArmed ? (
            <>
              <span className="room-compact-text">投喂中 · 点一下虎鲸、Clawd、Seal-GPT 或 Userlly</span>
              <button type="button" className="room-ghost" onClick={() => api.setFeedArmed(false)}>
                取消
              </button>
            </>
          ) : (
            <>
              <span className="room-compact-text">布置中 · 选装饰，点海底放下</span>
              <button type="button" className="room-ghost" onClick={() => api.setDecorMode(false)}>
                完成
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="room-dock">
          <nav className="room-tabs" aria-label="布置功能">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`room-tab ${tab === item.id ? 'is-active' : ''}`}
                aria-pressed={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                <item.Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="room-body">{panel}</div>
        </div>
      )}

      <PhotoAlbum
        open={albumOpen}
        onClose={() => setAlbumOpen(false)}
        photos={photos}
        onDelete={deletePhoto}
        onOpen={(index) => setViewerIndex(index)}
        storageError={photosError}
      />

      {/*
        全屏查看器挂在相册之外：从「最近几张」也能直接点开，那时候相册并没有打开。
        它自己 portal 到 .app 并压在 .modal-backdrop 之上，所以位置不用管。
      */}
      {viewerIndex !== null && (
        <PhotoViewer
          photos={photos}
          index={viewerIndex}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onDelete={deletePhoto}
        />
      )}
    </div>
  )
}
