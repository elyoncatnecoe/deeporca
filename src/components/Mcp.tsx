import { useEffect, useState } from 'react'
import { Check, Plus, RefreshCw, Server, Trash2, Zap } from 'lucide-react'
import { useAppStore } from '../lib/store'
import { connectServer, disconnectServer, getMcpState, subscribeMcp, type McpState } from '../lib/mcp-registry'
import type { McpServerConfig } from '../lib/types'
import { IconButton, ListTextarea, ScreenHeader, Select, headerLines, parseHeaderLines } from './ui'

export function McpScreen() {
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [states, setStates] = useState<McpState[]>([])

  // 连接状态在注册表里，订阅它才能实时看到「连接中/已连/失败」。
  useEffect(() => {
    const sync = (): void => {
      setStates([...settings.mcpServers.map((config) => getMcpState(config.id) ?? { config, session: null, error: null, connecting: false })])
    }
    sync()
    return subscribeMcp(sync)
  }, [settings.mcpServers])

  const editing = settings.mcpServers.find((item) => item.id === editingId) ?? null

  const update = (patch: Partial<McpServerConfig>): void => {
    if (editing === null) return
    const mcpServers = settings.mcpServers.map((item) =>
      item.id === editing.id ? { ...item, ...patch } : item,
    )
    void actions.setSettings({ mcpServers })
  }

  const add = (): void => {
    const id = `mcp_${Date.now().toString(36)}`
    const config: McpServerConfig = {
      id,
      name: '新服务器',
      transport: 'streamable_http',
      url: '',
      headers: {},
      command: '',
      args: [],
      enabled: true,
      // 新接的服务器默认每次调用都确认，确认信任后再放宽。
      defaultPolicy: 'always',
      toolPolicies: {},
    }
    void actions.setSettings({ mcpServers: [...settings.mcpServers, config] })
    setEditingId(id)
  }

  const remove = (id: string): void => {
    disconnectServer(id)
    void actions.setSettings({ mcpServers: settings.mcpServers.filter((item) => item.id !== id) })
    if (editingId === id) setEditingId(null)
  }

  const stateOf = (id: string): McpState | undefined => states.find((item) => item.config.id === id)

  return (
    <div className="screen settings-screen">
      <div className="screen-panel">
        <ScreenHeader
          title="MCP 工具"
          subtitle="接外部 MCP 服务器，模型就能调用它们的工具"
          onBack={() => actions.setScreen('settings')}
          actions={(
            <button type="button" className="primary-button" onClick={add}>
              <Plus size={16} /> 添加
            </button>
          )}
        />

        <div className="screen-body settings-body">
          <section className="settings-card">
            <h2><Server size={17} /> 全部服务器</h2>
            {settings.mcpServers.length === 0 && (
              <p className="settings-hint">还没有配置。点右上角「添加」，填一个 MCP 服务器的地址试试。</p>
            )}
            <div className="assistant-list">
              {settings.mcpServers.map((config) => {
                const state = stateOf(config.id)
                const status = state?.connecting === true
                  ? '连接中…'
                  : state?.session !== null && state?.session !== undefined
                    ? `已连接 · ${state.session.tools.length} 个工具`
                    : state?.error !== null && state?.error !== undefined
                      ? `失败：${state.error}`
                      : '未连接'
                return (
                  <div key={config.id} className="assistant-row" data-active={config.id === editingId ? 'true' : undefined}>
                    <span className="assistant-avatar"><Server size={17} /></span>
                    <div className="assistant-meta">
                      <strong>{config.name}{config.enabled ? '' : '（已停用）'}</strong>
                      <small>
                        {config.transport === 'sse' ? 'SSE' : config.transport === 'stdio' ? '本地命令' : 'Streamable HTTP'}
                        {' · '}
                        {config.transport === 'stdio'
                          ? `${config.command || '未填命令'}${config.args.length > 0 ? ` ${config.args.join(' ')}` : ''}`
                          : (config.url || '未填地址')}
                      </small>
                      <small>{status}</small>
                    </div>
                    <div className="assistant-row-actions">
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => void connectServer({ ...config, enabled: true }).then(() => undefined)}
                      >
                        <RefreshCw size={13} /> 重连
                      </button>
                      <button type="button" className="text-button" onClick={() => setEditingId(config.id)}>编辑</button>
                      <button type="button" className="text-button is-danger" onClick={() => remove(config.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                )
              })}
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
                  <span>传输方式</span>
                  <Select
                    ariaLabel="传输方式"
                    value={editing.transport}
                    onChange={(value) => {
                      update({ transport: value === 'sse' ? 'sse' : value === 'stdio' ? 'stdio' : 'streamable_http' })
                    }}
                    options={[
                      { value: 'streamable_http', label: 'Streamable HTTP（新标准）' },
                      { value: 'sse', label: 'SSE（兼容旧服务器）' },
                      { value: 'stdio', label: '本地命令（stdio，仅桌面版）' },
                    ]}
                  />
                </label>
              </div>

              {editing.transport === 'stdio' ? (
                <>
                  <label className="field">
                    <span>启动命令</span>
                    <input
                      type="text"
                      value={editing.command}
                      placeholder="npx 或 C:\path\to\server.exe"
                      onChange={(event) => update({ command: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>参数（一行一个）</span>
                    <ListTextarea
                      rows={3}
                      placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\Docs'}
                      resetKey={editing.id}
                      value={editing.args.join('\n')}
                      onText={(text) => update({
                        args: text.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
                      })}
                    />
                  </label>
                  <p className="settings-hint">
                    桌面版会在后台启动这个程序，通过标准输入输出和它通信。改完会自动重启它。
                  </p>
                </>
              ) : (
                <label className="field">
                  <span>服务器地址</span>
                  <input
                    type="text"
                    value={editing.url}
                    placeholder="https://example.com/mcp"
                    onChange={(event) => update({ url: event.target.value })}
                  />
                </label>
              )}

              <div className="field">
                <span>额外请求头（一行一个，形如 <code>Authorization: Bearer xxx</code>）</span>
                <ListTextarea
                  rows={3}
                  placeholder={'Authorization: Bearer your-token'}
                  resetKey={editing.id}
                  value={headerLines(editing.headers)}
                  onText={(text) => update({ headers: parseHeaderLines(text) })}
                />
              </div>

              <div className="switch-row">
                <div>
                  <strong>启用这个服务器</strong>
                  <small>停用后它的工具不会出现在对话里</small>
                </div>
                <button
                  type="button"
                  className={`chip ${editing.enabled ? 'is-active' : ''}`}
                  onClick={() => update({ enabled: !editing.enabled })}
                >
                  {editing.enabled ? <Check size={13} /> : null} {editing.enabled ? '已启用' : '已停用'}
                </button>
              </div>

              <label className="field">
                <span>调用前的确认</span>
                <Select
                  ariaLabel="调用前的确认"
                  value={editing.defaultPolicy}
                  onChange={(value) => update({ defaultPolicy: value === 'never' ? 'never' : 'always' })}
                  options={[
                    { value: 'always', label: '每次调用都问我（推荐）' },
                    { value: 'never', label: '不用问，直接执行' },
                  ]}
                />
              </label>
              <p className="settings-hint">
                不确定就先保持「每次问我」。下面可以按工具单独放宽。
              </p>

              <McpToolPolicyList config={editing} onUpdate={update} />

              <div className="inline-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void connectServer({ ...editing, enabled: true }).then((state) => {
                    actions.showToast(state.session !== null ? `已连接，${state.session.tools.length} 个工具` : `连接失败：${state.error ?? '未知'}`)
                  })}
                >
                  <Zap size={14} /> 测试连接
                </button>
                <IconButton label="收起" onClick={() => setEditingId(null)}>
                  <Check size={16} />
                </IconButton>
                <span className="settings-hint">改完即时保存，会自动重连。</span>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
/**
 * 逐工具的确认策略。工具列表来自当前连接；没连上时只显示已经配置过的名字，
 * 这样断线状态也能调整策略。
 */
function McpToolPolicyList(props: {
  config: McpServerConfig
  onUpdate: (patch: Partial<McpServerConfig>) => void
}) {
  const { config, onUpdate } = props
  const state = getMcpState(config.id)
  const connected = (state?.session?.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
  }))
  const configured = Object.keys(config.toolPolicies)
  const names = [...new Set([...connected.map((tool) => tool.name), ...configured])].sort()

  if (names.length === 0) {
    return (
      <p className="settings-hint">还没有连上服务器，连上之后这里会列出它提供的工具。</p>
    )
  }

  const policyOf = (name: string): 'inherit' | 'always' | 'never' => config.toolPolicies[name] ?? 'inherit'

  return (
    <div className="field">
      <span>按工具单独设置（「跟默认」就是上面那个选项）</span>
      <div className="mcp-tool-list">
        {names.map((name) => {
          const info = connected.find((tool) => tool.name === name)
          return (
            <div key={name} className="mcp-tool-row">
              <div className="mcp-tool-meta">
                <strong>{name}</strong>
                {info?.description !== undefined && info.description !== '' && <small>{info.description.slice(0, 80)}</small>}
              </div>
              <Select
                ariaLabel={`${name} 的确认策略`}
                value={policyOf(name)}
                onChange={(value) => {
                  const next = { ...config.toolPolicies }
                  if (value === 'inherit') delete next[name]
                  else next[name] = value === 'never' ? 'never' : 'always'
                  onUpdate({ toolPolicies: next })
                }}
                options={[
                  { value: 'inherit', label: '跟默认' },
                  { value: 'always', label: '要确认' },
                  { value: 'never', label: '不确认' },
                ]}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
