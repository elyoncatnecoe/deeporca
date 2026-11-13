import { useEffect, useState } from 'react'
import { Check, Plus, Server, Trash2, Waves } from 'lucide-react'
import { useAppStore } from '../lib/store'
import { PROTOCOLS, PROTOCOL_LABEL, chatEndpoint } from '../lib/providers'
import { WEB_CHAT_MODEL } from '../lib/models'
import { webChatModelVisible } from '../lib/web-gate'
import type { Provider, ProviderProtocol } from '../lib/types'
import { IconButton, ListTextarea, ScreenHeader, Select, headerLines, parseHeaderLines } from './ui'
import { ModelCatalog } from './ModelCatalog'

/** 「一行一个」的模型 id：空行与首尾空白丢掉。 */
function parseModelLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

export function ProvidersScreen() {
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 批量编辑是否展开；默认收起（模型目录才是主入口）。 */
  const [batchOpen, setBatchOpen] = useState(false)

  // 换一个供应商编辑时把批量编辑收起来：草稿属于上一个供应商。
  useEffect(() => {
    setBatchOpen(false)
  }, [editingId])

  const editing = settings.providers.find((item) => item.id === editingId) ?? null

  const update = (patch: Partial<Provider>): void => {
    if (editing === null) return
    const providers = settings.providers.map((item) =>
      item.id === editing.id ? { ...item, ...patch } : item,
    )
    void actions.setSettings({ providers })
  }

  const add = (): void => {
    const id = `provider_${Date.now().toString(36)}`
    const provider: Provider = {
      id,
      name: '新供应商',
      protocol: 'openai',
      baseUrl: 'https://',
      apiKey: '',
      models: [],
      headers: {},
      enabled: true,
    }
    // 新建后直接切到它，省得用户再去点一次「切换」。
    void actions.setSettings({ providers: [...settings.providers, provider], providerId: id })
    setEditingId(id)
  }

  /** 一键建一个「网页账号」供应商：不填 Key，用网页窗的登录态。 */
  const addWebChat = (): void => {
    const existing = settings.providers.find((item) => item.protocol === 'deepseek-web')
    if (existing !== undefined) {
      void actions.setSettings({ providerId: existing.id })
      actions.showToast('已经有一个网页账号供应商，已切过去')
      return
    }
    const id = `provider_web_${Date.now().toString(36)}`
    const provider: Provider = {
      id,
      name: '网页账号（免 Key）',
      protocol: 'deepseek-web',
      baseUrl: 'https://chat.deepseek.com',
      apiKey: '',
      models: [WEB_CHAT_MODEL],
      headers: {},
      enabled: true,
    }
    void actions.setSettings({ providers: [...settings.providers, provider], providerId: id })
    actions.showToast('已建好；记得去设置里把网页窗叫出来登录一次')
  }

  const isWeb = editing?.protocol === 'deepseek-web'

  const remove = (id: string): void => {
    if (settings.providers.length <= 1) {
      actions.showToast('至少留一个供应商')
      return
    }
    const providers = settings.providers.filter((item) => item.id !== id)
    const providerId = settings.providerId === id ? (providers[0] as Provider).id : settings.providerId
    void actions.setSettings({ providers, providerId })
    if (editingId === id) setEditingId(null)
  }

  return (
    <div className="screen settings-screen">
      <div className="screen-panel">
        <ScreenHeader
          title="供应商"
          subtitle="官方 API 或中转站；聊天时用选中的那个"
          onBack={() => actions.setScreen('settings')}
          actions={(
            <div className="inline-actions">
              {/*
                网页账号供应商的入口跟着「纸雕虎鲸」开关走（见 lib/web-gate.ts）。
                只藏对话页的模型选项、留着这个按钮的话，用户照样能在设置里手动建出
                网页账号供应商 —— 等于没藏干净。
              */}
              {webChatModelVisible(settings) && (
                <button type="button" className="ghost-button" onClick={addWebChat}>
                  <Waves size={16} /> 网页账号
                </button>
              )}
              <button type="button" className="primary-button" onClick={add}>
                <Plus size={16} /> 新建
              </button>
            </div>
          )}
        />

        <div className="screen-body settings-body">
          <section className="settings-card">
            <h2><Server size={17} /> 全部供应商</h2>
            <div className="assistant-list">
              {settings.providers.map((provider) => (
                <div key={provider.id} className="assistant-row" data-active={provider.id === settings.providerId ? 'true' : undefined}>
                  <span className="assistant-avatar"><Server size={17} /></span>
                  <div className="assistant-meta">
                    <strong>{provider.name}</strong>
                    <small>
                      {PROTOCOL_LABEL[provider.protocol]} · {provider.baseUrl || '未填地址'}
                      {provider.models.length > 0 ? ` · ${provider.models.length} 个模型` : ' · 沿用内置模型表'}
                    </small>
                  </div>
                  <div className="assistant-row-actions">
                    {provider.id === settings.providerId ? (
                      <span className="assistant-current"><Check size={14} /> 在用</span>
                    ) : (
                      <button type="button" className="text-button" onClick={() => void actions.setSettings({ providerId: provider.id })}>切换</button>
                    )}
                    <button type="button" className="text-button" onClick={() => setEditingId(provider.id)}>编辑</button>
                    {settings.providers.length > 1 && (
                      <button type="button" className="text-button is-danger" onClick={() => remove(provider.id)}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {editing !== null && (
            <section className="settings-card">
              <h2><Server size={17} /> 编辑「{editing.name}」</h2>

              <div className="field-row">
                <label className="field">
                  <span>名字</span>
                  <input type="text" value={editing.name} maxLength={32} onChange={(event) => update({ name: event.target.value })} />
                </label>
                <label className="field">
                  <span>协议</span>
                  <Select
                    ariaLabel="协议"
                    value={editing.protocol}
                    onChange={(value) => update({ protocol: value as ProviderProtocol })}
                    // 原来是 `${item.name} · ${item.hint}` 一行，拆成 label + hint 两行显示。
                    options={PROTOCOLS.map((item) => ({ value: item.id, label: item.name, hint: item.hint }))}
                  />
                </label>
              </div>

              {isWeb ? (
                <p className="settings-hint">
                  这个供应商不需要 Key 和地址：消息会交给 App 里那个已登录的
                  chat.deepseek.com 网页窗去发，回话再读回来。
                  在「设置 → 网页版」里可以把网页窗叫出来登录一次。
                  它不支持工具调用；图片附件在网页账号登录态下可用（会先上传到网页账号）。
                </p>
              ) : (
                <>
                  <label className="field">
                    <span>API 地址</span>
                    <input
                      type="text"
                      value={editing.baseUrl}
                      placeholder="https://api.deepseek.com"
                      onChange={(event) => update({ baseUrl: event.target.value })}
                    />
                  </label>
                  <p className="settings-hint">
                    实际请求地址：<code>{chatEndpoint(editing)}</code>
                  </p>

                  <label className="field">
                    <span>API Key</span>
                    <input
                      type="password"
                      value={editing.apiKey}
                      placeholder="sk-…"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => update({ apiKey: event.target.value })}
                    />
                  </label>

                  {/* 模型目录自己带标题栏，这里不再加 field 的标签，只用 field 的间距与输入框样式。 */}
                  <div className="field">
                    <ModelCatalog
                      provider={editing}
                      currentModel={settings.model}
                      onChange={update}
                    />
                  </div>

                  {batchOpen ? (
                    <div className="field">
                      <span>批量编辑模型（一行一个；留空沿用内置模型表）</span>
                      {/*
                        只在展开时挂载：收起再打开会重新读一次当前目录，草稿不会留旧的。
                        展开期间 resetKey 不变，于是行尾那个回车不会被吞掉（P1-15）。
                      */}
                      <ListTextarea
                        rows={4}
                        placeholder={'deepseek-chat\ndeepseek-reasoner'}
                        resetKey={editing.id}
                        value={editing.models.join('\n')}
                        onText={(text) => update({ models: parseModelLines(text) })}
                      />
                      <div className="inline-actions">
                        <button type="button" className="text-button" onClick={() => setBatchOpen(false)}>收起</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="text-button" onClick={() => setBatchOpen(true)}>
                      批量编辑（一行一个）
                    </button>
                  )}

                  <div className="field">
                    <span>额外请求头（一行一个，形如 <code>Key: Value</code>）</span>
                    <ListTextarea
                      rows={3}
                      placeholder={'HTTP-Referer: https://example.com\nX-Title: DeepSea'}
                      resetKey={editing.id}
                      value={headerLines(editing.headers)}
                      onText={(text) => update({ headers: parseHeaderLines(text) })}
                    />
                  </div>
                </>
              )}

              <div className="inline-actions">
                <IconButton label="收起" onClick={() => setEditingId(null)}>
                  <Check size={16} />
                </IconButton>
                <span className="settings-hint">改完即时保存。切到某个供应商后，聊天用它的地址与 Key。</span>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}