import { useEffect, useMemo, useState } from 'react'
import { Modal, Switch } from './ui'
import { modelMetaText, type DiscoveredModel } from '../lib/model-catalog'

/**
 * 「选择要添加的模型」弹窗。
 *
 * 为什么要这一层：一次拉回来可能有几十上百个模型（embedding / tts 也在里面），
 * 全塞进目录会把聊天页的模型选择器撑爆。所以先摊开让用户勾，确认后只把勾中的
 * 追加进目录 —— **只追加**，不覆盖也不删除已有条目（用户手填的 id 不能丢）。
 */
export function ModelPicker(props: {
  open: boolean
  title?: string
  models: DiscoveredModel[]
  /** 目录里已有的 id：默认不勾选、行置灰，避免重复添加。 */
  existing: string[]
  onClose: () => void
  onConfirm: (ids: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])

  // 每次重新打开都从「一个都没勾」开始：上次勾了却没确认的项不该留到下一次。
  useEffect(() => {
    if (!props.open) return
    setQuery('')
    setSelected([])
  }, [props.open])

  const existing = useMemo(() => new Set(props.existing), [props.existing])
  const keyword = query.trim().toLowerCase()
  // 搜索按 id 和显示名都过一遍，忽略大小写（模型 id 大小写混排的很多）。
  const filtered = useMemo(
    () => props.models.filter((model) => keyword === ''
      || model.id.toLowerCase().includes(keyword)
      || (model.name ?? '').toLowerCase().includes(keyword)),
    [props.models, keyword],
  )
  const selectable = filtered.filter((model) => !existing.has(model.id))
  const selectedSet = useMemo(() => new Set(selected), [selected])

  const toggle = (id: string): void => {
    if (existing.has(id)) return
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  // 全选 / 取消全选只作用于「当前搜索出来、且目录里还没有」的那些；
  // 全选做的是并集，免得把用户在别的关键词下已经勾好的项清掉。
  const selectAll = (): void => setSelected((prev) => {
    const next = [...prev]
    for (const model of selectable) {
      if (!next.includes(model.id)) next.push(model.id)
    }
    return next
  })
  const clearAll = (): void => {
    const ids = new Set(selectable.map((model) => model.id))
    setSelected((prev) => prev.filter((id) => !ids.has(id)))
  }

  const confirm = (): void => {
    const ids = selected.filter((id) => !existing.has(id))
    if (ids.length === 0) return
    props.onConfirm(ids)
  }

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title ?? '选择要添加的模型'}
      wide
      footer={(
        <div className="model-picker-footer">
          <button type="button" className="ghost-button" onClick={props.onClose}>取消</button>
          <button type="button" className="primary-button" onClick={confirm} disabled={selected.length === 0}>
            添加所选{selected.length > 0 ? `（${selected.length}）` : ''}
          </button>
        </div>
      )}
    >
      <div className="model-picker">
        <input
          className="model-picker-search"
          value={query}
          placeholder="搜索模型 id 或名字"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="model-picker-toolbar">
          <button type="button" className="text-button" onClick={selectAll} disabled={selectable.length === 0}>全选</button>
          <button type="button" className="text-button" onClick={clearAll} disabled={selected.length === 0}>取消全选</button>
          <small>已选 {selected.length} 个 / 共 {props.models.length} 个</small>
        </div>

        <div className="model-picker-list">
          {filtered.length === 0 && <p className="settings-hint">没有匹配的模型。</p>}
          {filtered.map((model) => {
            const isExisting = existing.has(model.id)
            const meta = modelMetaText(model)
            return (
              <div
                key={model.id}
                className={`model-picker-row ${isExisting ? 'is-disabled' : ''}`}
                onClick={() => toggle(model.id)}
              >
                <span>
                  <strong>{model.id}</strong>
                  {meta !== '' && <small>{meta}</small>}
                </span>
                {isExisting
                  ? <small>已在目录里</small>
                  : (
                    // Switch 自己就会响应点击，别让它冒泡到行上再切换一次（那样等于没点）。
                    <span onClick={(event) => event.stopPropagation()}>
                      <Switch checked={selectedSet.has(model.id)} onChange={() => toggle(model.id)} label={model.id} />
                    </span>
                  )}
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}