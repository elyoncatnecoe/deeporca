import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useAppStore } from '../lib/store'
import { checkModelId } from '../lib/models'
import { visionOf, visionSourceLabel } from '../lib/capability'
import {
  fetchProviderModels,
  mergeCatalogModels,
  modelMetaText,
  removeCatalogModel,
  type DiscoveredModel,
  type ModelMeta,
} from '../lib/model-catalog'
import type { Provider } from '../lib/types'
import { ModelPicker } from './ModelPicker'

/** 目录为空时的说明。必须说清「不填也能用」，否则用户会以为这个供应商废了。 */
const EMPTY_TEXT = '模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。'

/**
 * 改一个模型的「看图」覆写，返回可以直接交给 onChange / patchProvider 的那一小块 patch。
 *
 * 三态而不是开关：undefined = 跟随判定（内置表 / 模型名 / 乐观放行），
 * true / false = 用户拍板。写成 `modelMeta[id].vision` 而不是往 models 数组里加东西，
 * 是因为那个字段本来就是能力位，而且 patchProvider 按 id 合并、不会碰兄弟字段。
 * 「自动」要把键删掉而不是写 undefined —— 留 undefined 会让这条元信息永远是空对象，
 * 落库时虽然会被 normalize 掉，但内存里的判断（`'vision' in entry`）会一直骗人。
 */
function withVisionOverride(provider: Provider, id: string, next: boolean | undefined): Partial<Provider> {
  const meta: Record<string, ModelMeta> = { ...(provider.modelMeta ?? {}) }
  const entry: Record<string, unknown> = { ...(meta[id] ?? {}) }
  if (next === undefined) delete entry.vision
  else entry.vision = next
  if (Object.keys(entry).length > 0) meta[id] = entry as ModelMeta
  else delete meta[id]
  return { modelMeta: Object.keys(meta).length > 0 ? meta : undefined }
}

/** 三态开关的按钮文字。 */
function visionButtonLabel(override: boolean | undefined): string {
  if (override === true) return '看图'
  if (override === false) return '不看图'
  return '自动'
}

/**
 * 供应商编辑面板里的「模型目录」。
 *
 * 以前这里是一个「一行一个」的文本框：接一个中转站要先翻它的文档、把模型名一个个
 * 抄进来，抄错一个字符就 404。现在改成目录 + 一键拉取，拉回来勾一下就行；
 * 手填入口保留（有些中转站根本不提供 /models），两条路都能走。
 */
export function ModelCatalog(props: {
  provider: Provider
  /** 聊天页当前选中的模型 id：用来把那一行点亮。 */
  currentModel: string
  onChange: (patch: Partial<Provider>) => void
}) {
  const actions = useAppStore((state) => state.actions)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  /**
   * 在途请求。除了用来取消，还兼任「这次结果还作不作数」的令牌：
   * 请求回来时 abortRef 已经换人或清空，就说明用户切走了，结果直接丢掉 ——
   * 否则慢请求会把上一个供应商的模型列表塞进当前供应商。
   */
  const abortRef = useRef<AbortController | null>(null)
  const providerId = props.provider.id

  // 编辑对象换了（点了另一个供应商的「编辑」）：上一次的临时状态全部作废。
  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setFetching(false)
    setError(null)
    setDiscovered([])
    setPickerOpen(false)
    setAdding(false)
    setDraft('')
  }, [providerId])

  // 卸载时断开在途请求，别让一条已经没人要的请求继续占着网络。
  useEffect(() => () => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const models = props.provider.models
  const isWeb = props.provider.protocol === 'deepseek-web'
  const missingBaseUrl = props.provider.baseUrl.trim() === ''
  // 网页账号不填 Key，别拿这条规则去挡它（挡了用户也找不到原因）。
  const missingKey = !isWeb && props.provider.apiKey.trim() === ''
  const disabledTitle = missingBaseUrl
    ? '请先填写 API 地址，再获取。'
    : missingKey ? '请先填 API Key' : undefined

  const startFetch = async (): Promise<void> => {
    if (fetching) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setFetching(true)
    const result = await fetchProviderModels(props.provider, { signal: controller.signal })
    // 已经换了供应商 / 又点了一次 / 组件卸载：这次结果作废。
    if (abortRef.current !== controller) return
    abortRef.current = null
    setFetching(false)
    if (!result.ok) {
      setError(result.reason)
      return
    }
    setDiscovered(result.models)
    setPickerOpen(true)
  }

  const addFromPicker = (ids: string[]): void => {
    // 只认这一批真的拉回来的模型，别的 id 一律忽略（防御 UI 状态错位）。
    const found = discovered.filter((model) => ids.includes(model.id))
    if (found.length > 0) props.onChange(mergeCatalogModels(props.provider, found))
    setPickerOpen(false)
    setDiscovered([])
  }

  const confirmAdd = (): void => {
    const checked = checkModelId(draft)
    if (!checked.ok) {
      actions.showToast(checked.reason ?? '这个模型名不能用')
      return
    }
    if (models.includes(checked.model)) {
      actions.showToast('这个模型已经在目录里了')
      return
    }
    props.onChange({ models: [...models, checked.model] })
    setDraft('')
    setAdding(false)
  }

  const cancelAdd = (): void => {
    setDraft('')
    setAdding(false)
  }

  const removeModel = (id: string): void => {
    props.onChange(removeCatalogModel(props.provider, id))
  }

  /** 自动 → 强制看图 → 强制不看图 → 自动。三态轮着点，一次点一下一档。 */
  const cycleVision = (id: string): void => {
    const current = props.provider.modelMeta?.[id]?.vision
    const next = current === undefined ? true : current === true ? false : undefined
    props.onChange(withVisionOverride(props.provider, id, next))
  }

  return (
    <div className="model-catalog">
      <div className="model-catalog-head">
        <span>模型目录</span>
        <button
          type="button"
          className="text-button model-catalog-action"
          onClick={() => void startFetch()}
          disabled={fetching || missingBaseUrl || missingKey}
          title={disabledTitle}
        >
          {fetching ? '正在询问提供商…' : '获取可用模型'}
        </button>
      </div>

      {models.length === 0
        ? <p className="model-catalog-empty">{EMPTY_TEXT}</p>
        : (
          <div className="model-catalog-list">
            {models.map((id) => {
              const override = props.provider.modelMeta?.[id]?.vision
              // 判定和聊天页的闸门同一个函数：这一行写的「自动」到底自动成什么，
              // 悬停就能看到，不用再猜。
              const verdict = visionOf(props.provider, id)
              return (
                <div key={id} className={`model-catalog-row ${id === props.currentModel ? 'is-on' : ''}`}>
                  <span className="model-catalog-id">{id}</span>
                  <span className="model-catalog-meta">{modelMetaText(props.provider.modelMeta?.[id])}</span>
                  <button
                    type="button"
                    className="text-button model-catalog-vision"
                    title={`看图：${visionButtonLabel(override)}（当前判定：${verdict.sees ? '会' : '不会'}，依据：${visionSourceLabel(verdict.source)}）。点按切换 自动 / 看图 / 不看图。`}
                    onClick={() => cycleVision(id)}
                  >
                    {visionButtonLabel(override)}
                  </button>
                  <button
                    type="button"
                    className="text-button is-danger model-catalog-remove"
                    title={`从目录里删掉 ${id}`}
                    onClick={() => removeModel(id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        )}

      {error !== null && <p className="model-catalog-error">{error}</p>}

      {adding
        ? (
          <div className="field">
            <span>添加模型</span>
            <div className="input-with-action">
              <input
                value={draft}
                placeholder="模型 id，例如 gpt-4.1"
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    confirmAdd()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelAdd()
                  }
                }}
              />
              <button type="button" className="text-button" onClick={confirmAdd}>确认</button>
              <button type="button" className="text-button" onClick={cancelAdd}>取消</button>
            </div>
          </div>
        )
        : (
          <button type="button" className="text-button model-catalog-add" onClick={() => setAdding(true)}>
            ＋ 添加模型
          </button>
        )}

      <ModelPicker
        open={pickerOpen}
        models={discovered}
        existing={models}
        onClose={() => {
          setPickerOpen(false)
          setDiscovered([])
        }}
        onConfirm={addFromPicker}
      />
    </div>
  )
}