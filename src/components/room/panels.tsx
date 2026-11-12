import { useState, type ReactNode } from 'react'
import { Camera, Coins, Fish, Shapes, Shell, Waves } from 'lucide-react'
import { QUALITIES, SEA_THEMES } from '../../lib/look'
import type { StageApi } from '../../lib/stage-bridge'
import type { QualityId, ThemeId } from '../../lib/types'
import type { GameState } from '../../orca/app'
import type { PhotoRecord } from '../../orca/photo'
import { Switch } from '../ui'

function Hint(props: { children: ReactNode }) {
  return <p className="room-hint">{props.children}</p>
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="room-section">
      <h3>{props.title}</h3>
      {props.children}
    </section>
  )
}

/**
 * 投喂。
 *
 * 投喂是「模式」不是「一次点击」：按下只上膛，还要再点一下虎鲸 / 伙伴才真的
 * 丢食物。这个两段式是刻意的 —— 画布同时还要拖动镜头，一次误触就往缸里丢
 * token 比少一个快捷操作讨厌得多。
 */
export function FeedPanel(props: { game: GameState; api: StageApi }) {
  const { game, api } = props
  const armed = game.feedArmed
  // 用目标值而不是缓动值：growth 是渲染循环里缓动的实时量，事件只在计数变化
  // 那一刻触发，拿它显示会让数字停在旧值，直到下一次投喂才跳。
  const grown = Math.round((game.growthTarget - 1) * 100)
  return (
    <div className="room-panel">
      <button
        type="button"
        className={`room-cta ${armed ? 'is-active' : ''}`}
        onClick={() => api.setFeedArmed(!armed)}
      >
        <span className="room-cta__emoji"><Coins size={20} strokeWidth={1.8} aria-hidden="true" /></span>
        <span className="room-cta__text">
          <strong>{armed ? '正在投喂' : '投喂 token'}</strong>
          <small>{armed ? '点一下虎鲸、Clawd、Seal-GPT 或 Userlly' : '打开后，点它们才会丢食物'}</small>
        </span>
        {armed && <span className="room-cta__check">✓</span>}
      </button>

      <div className="room-stats">
        <div>
          <span>已吃</span>
          <strong>{game.feedCount}</strong>
          <small>枚</small>
        </div>
        <div>
          <span>体型</span>
          <strong>{game.growthTarget.toFixed(2)}</strong>
          <small>×</small>
        </div>
        <div>
          <span>这一轮</span>
          <strong>+{grown}</strong>
          <small>%</small>
        </div>
      </div>

      <button
        type="button"
        className="room-ghost"
        onClick={() => api.resetGrowth()}
        disabled={game.growthFeeds === 0}
      >
        ↩️ 复原体型
      </button>

      <Hint>
        吃得越多它越大，上限 1.55×。复原只把体型收回去，累计投喂数不清零。
      </Hint>
    </div>
  )
}

/**
 * 布置。
 *
 * 选一个装饰 → 点海底放下。手机上滚轮不存在，所以旋转做成两个按钮。
 */
export function DecorPanel(props: { game: GameState; api: StageApi }) {
  const { game, api } = props
  const [kinds] = useState(() => api.getDecorKinds())
  const [picked, setPicked] = useState<string | null>(null)
  const decorating = game.mode === 'decorating'

  const pick = (id: string): void => {
    setPicked(id)
    if (!decorating) api.setDecorMode(true)
    api.selectDecor(id)
  }

  return (
    <div className="room-panel">
      <div className="room-row">
        <button
          type="button"
          className={`room-cta room-cta--slim ${decorating ? 'is-active' : ''}`}
          onClick={() => api.setDecorMode(!decorating)}
        >
          <span className="room-cta__emoji"><Shapes size={20} strokeWidth={1.8} aria-hidden="true" /></span>
          <span className="room-cta__text">
            <strong>{decorating ? '布置中' : '开始布置'}</strong>
            <small>{decorating ? '点海底放置，右键删除' : '进缸里添置点东西'}</small>
          </span>
        </button>
      </div>

      <div className="room-chips">
        {kinds.map((kind) => (
          <button
            key={kind.id}
            type="button"
            className={`room-chip ${picked === kind.id ? 'is-active' : ''}`}
            onClick={() => pick(kind.id)}
          >
            {kind.name}
          </button>
        ))}
      </div>

      <div className="room-row">
        <button type="button" className="room-ghost room-ghost--square" onClick={() => api.rotateGhost(-0.4)} title="向左旋转">
          ↺
        </button>
        <button type="button" className="room-ghost room-ghost--square" onClick={() => api.rotateGhost(0.4)} title="向右旋转">
          ↻
        </button>
        <button type="button" className="room-ghost" onClick={() => api.resetDecor()} disabled={game.decorCount === 0}>
          ♻️ 清空（{game.decorCount}）
        </button>
      </div>

      <Hint>海底道具都生成在镜头净空之外，不会挡住虎鲸。</Hint>
    </div>
  )
}

/** 拍照 + 最近几张。相册本体在 PhotoAlbum 里，点开大图在 PhotoViewer 里。 */
export function PhotoPanel(props: {
  game: GameState
  photos: PhotoRecord[]
  api: StageApi
  onOpenAlbum: () => void
  /** 点某一张：直接开全屏查看器，参数是它在整个相册里的下标。 */
  onView: (index: number) => void
  onToast: (text: string) => void
  /** 照片落盘失败的原因（存不下了），来自相册 store；空就没提示。 */
  storageError?: string | null
}) {
  const { photos, api, onOpenAlbum, onView, onToast } = props
  const [busy, setBusy] = useState(false)
  /*
   * 「最近 4 张」取的是**尾部**：引擎按拍摄顺序 push，取前面 4 条会把最老的照片
   * 当成最新的摆在这儿。下标要换算回整个相册里的位置，否则点开的是另一张。
   */
  const recentOffset = Math.max(0, photos.length - 4)
  const recent = photos.slice(recentOffset)

  const shoot = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const record = await api.takePhoto()
      onToast(record === null ? '这张没拍成，再试一次' : `📷 ${record.label}`)
    } catch {
      onToast('拍照失败了')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="room-panel">
      <button type="button" className="room-cta" onClick={() => void shoot()} disabled={busy}>
        <span className="room-cta__emoji"><Camera size={20} strokeWidth={1.8} aria-hidden="true" /></span>
        <span className="room-cta__text">
          <strong>{busy ? '咔嚓…' : '拍一张'}</strong>
          <small>拍的是它当下在干什么，不会转过来看镜头</small>
        </span>
      </button>

      {props.storageError !== undefined && props.storageError !== null && props.storageError !== '' && (
        <p className="room-warn" role="alert">
          ⚠️ {props.storageError}
        </p>
      )}

      <div className="room-row room-row--between">
        <span className="room-label">相册（{photos.length}）</span>
        <button type="button" className="room-ghost" onClick={onOpenAlbum}>
          查看全部
        </button>
      </div>

      {recent.length > 0 && (
        <div className="room-thumbs">
          {recent.map((photo, i) => (
            <button
              key={photo.id}
              type="button"
              className="room-thumb"
              onClick={() => onView(recentOffset + i)}
              title="点开看大图 / 保存到相册"
            >
              <img src={photo.thumbURL === '' ? photo.dataURL : photo.thumbURL} alt={photo.label} />
            </button>
          ))}
        </div>
      )}

      <Hint>按构图 / 距离 / 朝向评出「贴贴特写 / 完美瞬间 / 背影远眺 / 日常抓拍」，最多存 8 张。点缩略图可以放大、存到相册。</Hint>
    </div>
  )
}

/** 三个小伙伴，各自独立、可以同时在场，但每个只有一只。 */
export function CompanionPanel(props: { game: GameState; api: StageApi }) {
  const { game, api } = props
  return (
    <div className="room-panel">
      <div className="room-toggle-row">
        <div className="room-toggle-text">
          <strong><Shell size={15} strokeWidth={1.8} aria-hidden="true" /> Clawd</strong>
          <small>方块小螃蟹，跟在左舷；点了会吱一声</small>
        </div>
        <Switch checked={game.companion} onChange={(on) => api.setCompanion(on)} label="召唤 Clawd" />
      </div>
      <div className="room-toggle-row">
        <div className="room-toggle-text">
          <strong><Fish size={15} strokeWidth={1.8} aria-hidden="true" /> Seal-GPT</strong>
          <small>背着 OpenAI 商标斑点的小海豹，跟在右舷</small>
        </div>
        <Switch checked={game.companionSeal} onChange={(on) => api.setSealCompanion(on)} label="召唤 Seal-GPT" />
      </div>
      <div className="room-toggle-row">
        <div className="room-toggle-text">
          <strong><Waves size={15} strokeWidth={1.8} aria-hidden="true" /> Userlly</strong>
          <small>代表你本人的水母，飘在虎鲸上方偏后；只鼓伞盖，不会说话</small>
        </div>
        <Switch checked={game.companionJelly} onChange={(on) => api.setJellyCompanion(on)} label="召唤 Userlly" />
      </div>
      <Hint>
        三只可以同时出场，跟着虎鲸 1 秒前的轨迹游。投喂模式下把 token 丢给谁，就只有谁吃得到。
      </Hint>
    </div>
  )
}

/**
 * 外观。
 *
 * 这里装的是「海底长什么样」：场景主题、虎鲸皮肤、辉光、画质。
 * App 界面自己的色调在设置里，两者已经解绑。
 */
export function LookPanel(props: {
  game: GameState
  api: StageApi
  aquariumTheme: ThemeId
  quality: QualityId
  onTheme: (theme: ThemeId) => void
  onQuality: (quality: QualityId) => void
}) {
  const { game, api, aquariumTheme, quality, onTheme, onQuality } = props
  return (
    <div className="room-panel room-panel--scroll">
      <Section title="海底主题">
        <div className="room-theme-grid">
          {SEA_THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`room-theme theme-${theme.id} ${aquariumTheme === theme.id ? 'is-active' : ''}`}
              onClick={() => onTheme(theme.id)}
            >
              <span>{theme.emoji}</span>
              <strong>{theme.name}</strong>
              <small>{theme.hint}</small>
            </button>
          ))}
        </div>
      </Section>

      <Section title="虎鲸皮肤">
        <div className="room-skins">
          {api.getSkins().map((skin) => (
            <button
              key={skin.id}
              type="button"
              className={`room-skin ${game.skin === skin.id ? 'is-active' : ''}`}
              onClick={() => api.setSkin(skin.id)}
              title={`切换到${skin.label}皮肤`}
            >
              <span style={{ background: `linear-gradient(135deg, ${skin.dark} 0 50%, ${skin.white} 50% 100%)` }} />
              <small>{skin.label}</small>
            </button>
          ))}
        </div>
      </Section>

      <Section title="动作速度">
        <div className="room-row room-row--slider">
          <input
            type="range"
            min={0.4}
            max={1.8}
            step={0.05}
            value={game.motionSpeed}
            aria-label="动作速度"
            onChange={(event) => api.setMotionSpeed(Number(event.target.value))}
          />
          <span className="room-value">{game.motionSpeed.toFixed(2)}×</span>
        </div>
        <Hint>
          身体摇摆、尾鳍、胸鳍和体波共用一个倍率。嫌抽搐就往左拉，觉得可爱就往右拉 ——
          只影响动作节奏，不影响喂食、拍照和成长。
        </Hint>
      </Section>

      <Section title="光效强度">
        <div className="room-row room-row--slider">
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={game.bloomStrength}
            aria-label="光效强度"
            onChange={(event) => api.setBloomStrength(Number(event.target.value))}
          />
          <span className="room-value">{game.bloomStrength.toFixed(2)}</span>
        </div>
      </Section>

      <Section title="画面质量">
        <div className="room-chips">
          {QUALITIES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`room-chip ${quality === item.id ? 'is-active' : ''}`}
              onClick={() => onQuality(item.id)}
            >
              {item.name}
            </button>
          ))}
        </div>
        <Hint>改画质会重建 3D 场景，画面会闪一下。</Hint>
      </Section>
    </div>
  )
}
