import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  Check,
  Database,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Globe,
  ImagePlus,
  KeyRound,
  Palette,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Waves,
} from 'lucide-react'
import { testConnection } from '../lib/deepseek'
import { appVersion, openExternal, openTextFile, openWebChat, saveTextFile } from '../lib/platform'
import { applyBackup, backupFileName, buildBackup, parseBackup } from '../lib/backup'
import { useAppStore } from '../lib/store'
import { avatarStore, fileToAvatar, type AvatarRole } from '../lib/avatars'
import { WEB_CHAT_MODEL, checkModelId, isWebChatModel, modelInProviderList, modelInfo } from '../lib/models'
import { resolveOutputCap } from '../lib/budget'
import { PROTOCOL_LABEL, currentProvider } from '../lib/providers'
import { visionOf, type VisionProvider } from '../lib/capability'
import type { Settings, ThinkingEffort } from '../lib/types'
import { webModeScript } from '../lib/web-mode'
import { diagnoseWebChat, loginWebChat } from '../lib/web-chat'
import { Avatar, currentAssistantAvatar } from './Avatar'
import { IconButton, ScreenHeader, Select, Switch, type SelectOption } from './ui'
import { confirmDialog } from './ConfirmDialog'

/*
 * 海底主题 / 画质在「布置」屏（`lib/look.ts` 的 SEA_THEMES / QUALITIES），
 * 界面色调 / 自定义配色 / 对话底图在首页右上角的「外观」面板（AppearancePanel.tsx）。
 * 这里只剩「填一次就不动」的连接、记忆与数据 —— 改外观不该先翻过半屏 Key。
 */

/**
 * 当前供应商的「模型目录」。
 *
 * 对齐 DeepSeek Harness：目录为空时**不再回落到内置模型表** —— 目录里有什么就是
 * 什么，一个都没有就一个都不显示（模型字段仍可手填，目录外 ID 照样能发）。
 * 以前这里回落到内置四个，导致「供应商页显示 0 个模型、设置页却能选四个」，
 * 用户没法判断目录到底配没配。
 */
function modelOptions(settings: Settings): string[] {
  const provider = settings.providers.find((item) => item.id === settings.providerId)
  // 网页账号模式只有它自己那一个模型。
  if (provider?.protocol === 'deepseek-web') return [WEB_CHAT_MODEL]
  return provider?.models ?? []
}

/** 当前供应商给模型存的展示信息（获取可用模型时带回来的名称/上下文）。 */
function currentProviderMeta(settings: Settings): Record<string, { name?: string; contextWindow?: number }> {
  const provider = settings.providers.find((item) => item.id === settings.providerId)
  return provider?.modelMeta ?? {}
}

/**
 * 某个模型该显示哪些能力标签。
 *
 * tags 来自 src/lib/models.ts；「看图」这一枚统一由 capability.ts 的 visionOf 决定，
 * 和模型弹层、附件闸门共用同一个函数 —— 一处判定，三处显示，从此不可能互相打架。
 * 以前这里读 modelInfo(id).vision（那份内置表看不见 provider.modelMeta），
 * 于是设置页说「不能看图」、弹层同一行却说「看图」。
 */
function modelTags(id: string, provider?: VisionProvider): string[] {
  const info = modelInfo(id)
  const tags = [...info.tags]
  if (visionOf(provider, id).sees && !tags.includes('看图')) tags.push('看图')
  // 网页账号模型单独再标一个「网页」，让用户一眼看出它不走 API。
  if (isWebChatModel(id) && !tags.includes('网页')) tags.push('网页')
  return tags
}

/** 普通 API 模型显示 hint；网页账号模型给一句它真正的限制。 */
function modelNote(id: string): string {
  if (isWebChatModel(id)) return '免 Key；支持图片附件，不支持工具调用'
  return modelInfo(id).hint
}

/**
 * 「模型」下拉的可选项。
 *
 * 除了 modelOptions 之外，原来还额外拼了一条「（当前）」占位项，用来兜住一种情况：
 * 模型的 id 不在列表里（用户手填了自定义模型名，或者换了供应商之后原来那个 id 掉了）。
 * 这段逻辑原样保留 —— 不是列表里的 model 也要能选中并显示出来，否则一进设置页就
 * 变成「没有可选项」。
 *
 * 用户反馈「模型列表那边仍然是白屏，而且只看到一排裸 id」，所以每一项都带上
 * hint（第二行小字）和 tags（右侧能力徽章），展开时就能看出每个模型能干什么。
 */
function modelSelectOptions(settings: Settings): SelectOption[] {
  const ids = modelOptions(settings)
  const meta = currentProviderMeta(settings)
  // 徽章按「这个供应商下的这个模型」判，见 modelTags。
  const provider = currentProvider(settings)
  const options: SelectOption[] = ids.map((id) => {
    const extra = meta[id]
    const name = extra?.name !== undefined && extra.name.trim() !== '' ? extra.name : ''
    const context = typeof extra?.contextWindow === 'number' && extra.contextWindow > 0
      ? `${Math.round(extra.contextWindow / 1000)}K 上下文`
      : ''
    return {
      value: id,
      label: id,
      // 「获取可用模型」带回来的显示名/上下文优先，没有就退回内置说明。
      hint: [name, context].filter((part) => part !== '').join(' · ') || modelNote(id),
      tags: modelTags(id, provider),
    }
  })
  if (settings.model !== '' && !ids.includes(settings.model)) {
    options.push({
      value: settings.model,
      label: `${settings.model}（当前）`,
      hint: ids.length === 0 ? '目录为空，仍会按这个名字发送' : '不在目录里，仍会按这个名字发送',
      tags: modelTags(settings.model, provider),
    })
  }
  return options
}

/**
 * 「摘要模型」下拉的可选项。
 *
 * 摘要请求走的是同一个供应商，所以选项跟着「模型目录」走；另外永远保留当前值，
 * 免得目录是空的时候这一项变成「没有可选项」，把已经存下来的设置显示没了。
 */
function memoryModelOptions(settings: Settings): SelectOption[] {
  const ids = modelOptions(settings)
  const current = settings.memoryModel
  const list = current !== '' && !ids.includes(current) ? [current, ...ids] : ids
  return list.map((model) => ({ value: model, label: model, hint: modelInfo(model).hint }))
}

/**
 * 「模型」字段下方的当前模型状态行：id + 能力标签 + 一句说明。
 * 用户原来只能看到一个裸 id，看不出这个模型能不能看图、是不是网页账号。
 *
 * providerModels 传进来时会额外提示「这个名字不在当前供应商的模型列表里」。
 * 只提示、不改写：手填的自定义模型名本来就不在列表里，自动改写正是
 * 「自定义模型名存不住」的元凶。
 */
function ModelStatusLine(props: {
  model: string
  providerModels?: readonly string[]
  meta?: { name?: string; contextWindow?: number }
  /** 「看图」徽章的判定上下文（modelMeta 挂在供应商上，不在这里就没法判）。 */
  provider?: VisionProvider
}) {
  const { model, providerModels, meta, provider } = props
  if (model.trim() === '') {
    return <p className="model-status"><span className="model-status-note">没有选择模型</span></p>
  }
  const tags = modelTags(model, provider)
  const listed = providerModels === undefined || modelInProviderList(providerModels, model)
  const name = meta?.name !== undefined && meta.name.trim() !== '' ? meta.name : ''
  const context = typeof meta?.contextWindow === 'number' && meta.contextWindow > 0
    ? `${Math.round(meta.contextWindow / 1000)}K 上下文`
    : ''
  const note = [name, context].filter((part) => part !== '').join(' · ') || modelNote(model)
  return (
    <>
      <p className="model-status">
        <code className="model-status-id">{model}</code>
        {tags.map((tag) => <span key={tag} className="model-tag">{tag}</span>)}
        <span className="model-status-note">{note}</span>
      </p>
      {!listed && (
        <p className="model-status">
          <span className="model-status-note">
            {(providerModels?.length ?? 0) === 0
              ? '当前供应商的模型目录是空的；仍会按这个名字原样发送。去「管理供应商 → 模型目录」点「获取可用模型」，或手动添加。'
              : '不在当前供应商的模型目录里；仍会按这个名字原样发送，报错就去「管理供应商」里补上。'}
          </span>
        </p>
      )}
    </>
  )
}

/** 当前供应商自己声明的模型列表；空数组表示它不限制模型名。 */
function currentProviderModels(settings: Settings): string[] {
  const provider = settings.providers.find((item) => item.id === settings.providerId)
  return provider === undefined ? [] : provider.models
}

const EFFORTS: Array<{ id: ThinkingEffort; name: string; hint: string }> = [
  { id: 'off', name: '关闭', hint: '直接回答' },
  { id: 'low', name: '低', hint: '轻量思考' },
  { id: 'high', name: '高', hint: '默认强度' },
  { id: 'max', name: '极高', hint: '难题 / 长链推理' },
]

export function SettingsScreen() {
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [draft, setDraft] = useState<Settings>(settings)
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [message, setMessage] = useState('')
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [importStatus, setImportStatus] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingRole = useRef<AvatarRole>('user')

  /**
   * 「单次最多输出」在请求里到底会变成多少。
   * 用预算模块同一个算法（正文预算 + 思考预留，模型目录说了才算顶），
   * 界面才可能说真话 —— 以前这里显示 4096、发出去的也是 4096，
   * 用户以为上限很大，实际思考一长正文就是空的。
   */
  const effectiveOutputCap = resolveOutputCap(draft, currentProvider(draft))

  const pickAvatar = (role: AvatarRole): void => {
    pendingRole.current = role
    fileInputRef.current?.click()
  }

  const onAvatarFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    try {
      const dataUrl = await fileToAvatar(file)
      await avatarStore.set(pendingRole.current, dataUrl)
      actions.showToast('头像已更新')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '这张图用不了')
    }
  }

  useEffect(() => {
    void appVersion().then(setVersion)
  }, [])

  const save = async (): Promise<void> => {
    // 供应商相关的字段（providers / apiKey / baseUrl / model）都在各自的 onChange 里即时写入，
    // 这里不能再把整份 draft 盖回去 —— draft 是渲染时的快照，会把刚改的值冲掉。
    const { providers: _providers, apiKey: _apiKey, baseUrl: _baseUrl, model: _model, ...rest } = draft
    await actions.setSettings(rest)
    setStatus('idle')
    actions.showToast('设置已保存')
  }

  const test = async (): Promise<void> => {
    setStatus('testing')
    setMessage('')
    try {
      await testConnection({ ...draft, apiKey: draft.apiKey.trim() })
      setStatus('ok')
      setMessage('连接成功')
    } catch (error) {
      setStatus('fail')
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openWeb = async (): Promise<void> => {
    try {
      // 网页版只加头像和宠物，不套皮肤——理由见 Home.tsx 的 openWeb。
      const mode = webModeScript({ avatar: draft.webAvatar, pet: draft.webPet })
      const target = await openWebChat('', mode)
      if (target === 'external') actions.showToast('安装版才能给网页加上头像和宠物')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '打不开网页版')
    }
  }

  const exportAll = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setImportStatus('')
    try {
      // 对话底图是压缩后的 dataURL（几百 KB），和头像同理只存本机：备份是给人看、
      // 能进 git 的纯 JSON，塞一张图进去会让它没法读。换设备重选一张就行。
      const { chatBackdrop: _backdrop, ...exportable } = draft
      const settingsSnapshot = { ...exportable, apiKey: '' } as unknown as Record<string, unknown>
      const payload = await buildBackup(version, settingsSnapshot)
      // 原生保存对话框可能被用户一直开着、或被系统挂起，导致这个 Promise 迟迟不返回。
      // 加个超时，避免 busy 卡死让整个设置页的按钮失效。
      const saved = await Promise.race([
        saveTextFile(backupFileName(), JSON.stringify(payload, null, 2), 'application/json'),
        new Promise<'timeout'>((resolve) => window.setTimeout(() => resolve('timeout'), 120_000)),
      ])
      if (saved === 'timeout') {
        setImportStatus('导出窗口没有响应，已恢复；数据没有丢失')
        return
      }
      if (saved) {
        setImportStatus(`已导出 ${payload.counts.conversations} 段对话、${payload.counts.messages} 条消息、${payload.counts.memories} 条记忆`)
        actions.showToast('备份已导出')
      } else {
        setImportStatus('已取消导出')
      }
    } catch (error) {
      setImportStatus(error instanceof Error ? `导出失败：${error.message}` : '导出失败')
    } finally {
      setBusy(false)
    }
  }

  const importBackup = async (mode: 'merge' | 'replace'): Promise<void> => {
    if (busy) return
    if (mode === 'replace') {
      const ok = await confirmDialog({
        title: '导入并覆盖？',
        message: '会先清空本机的全部对话、记忆和工坊文件，再写入备份。继续吗？',
        confirmText: '继续',
        danger: true,
      })
      if (!ok) return
    }
    setBusy(true)
    setImportStatus('')
    try {
      const text = await openTextFile('.json,application/json')
      if (text === null) {
        setImportStatus('没有选择文件')
        return
      }
      const parsed = parseBackup(text)
      if (!parsed.ok) {
        setImportStatus(`导入失败：${parsed.error}`)
        actions.showToast('这个文件读不出来')
        return
      }
      if (mode === 'replace') {
        await actions.clearAllChats()
        await actions.clearAllMemories()
      }
      const result = await applyBackup(parsed.data, { mode, applySettings: false })
      // 导入完要把内存里的列表刷新一遍，否则界面上看不到新数据。
      await actions.refreshConversations()
      await actions.refreshMemories()
      await actions.refreshWorkspace()
      const summary = `已导入 ${result.conversations} 段对话、${result.messages} 条消息、${result.memories} 条记忆、${result.files} 个文件`
      setImportStatus(parsed.warnings.length > 0 ? `${summary}（${parsed.warnings.join('；')}）` : summary)
      actions.showToast('导入完成')
    } catch (error) {
      setImportStatus(error instanceof Error ? `导入失败：${error.message}` : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  const clearChats = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: '清空所有对话？',
      message: '记忆不会跟着删。',
      confirmText: '清空',
      danger: true,
    })
    if (!ok) return
    await actions.clearAllChats()
    actions.showToast('对话已清空')
  }

  const clearMemories = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: '清空所有记忆？',
      message: '这个动作不能撤销。',
      confirmText: '清空',
      danger: true,
    })
    if (!ok) return
    await actions.clearAllMemories()
    actions.showToast('记忆已清空')
  }

  return (
    <div className="screen settings-screen">
      <div className="screen-panel">
        <ScreenHeader
          title="设置"
          subtitle="所有数据只在这台设备上"
          onBack={() => actions.setScreen('home')}
          actions={(
            <>
              {/*
                老用户会来设置页找「界面色调」—— 那块已经搬到外观面板了，
                这里留一个入口，免得他们以为功能没了。
              */}
              <button type="button" className="ghost-button" onClick={() => actions.setScreen('appearance')}>
                <Palette size={15} /> 外观
              </button>
              <button type="button" className="primary-button" onClick={() => void save()}><Check size={16} /> 保存</button>
            </>
          )}
        />

        <div className="screen-body settings-body">
          <section className="settings-card">
            <h2><KeyRound size={17} /> 模型与连接</h2>
            <p className="settings-hint">可以配多个供应商（官方 API 或中转站），聊天时用选中的那个。Key 只加密存在本机。</p>

            <label className="field">
              <span>供应商</span>
              <Select
                ariaLabel="供应商"
                value={draft.providerId}
                onChange={(value) => {
                  setDraft({ ...draft, providerId: value })
                  // 切换后把「随供应商走」的字段从 store 同步回草稿：
                  // 否则输入框还显示上一个供应商的 Key / 地址 / 模型，
                  // 用户照着改一下就会写进另一个供应商里。
                  void actions.setSettings({ providerId: value }).then(() => {
                    const next = useAppStore.getState().settings
                    setDraft((prev) => ({
                      ...prev,
                      providerId: next.providerId,
                      apiKey: next.apiKey,
                      baseUrl: next.baseUrl,
                      model: next.model,
                    }))
                  })
                }}
                options={draft.providers.map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                  hint: PROTOCOL_LABEL[provider.protocol],
                }))}
              />
            </label>

            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => actions.setScreen('providers')}>
                <Server size={15} /> 管理供应商（{draft.providers.length}）
              </button>
            </div>

            <label className="field">
              <span>API Key（当前供应商）</span>
              <div className="input-with-action">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={draft.apiKey}
                  onChange={(event) => {
                    const apiKey = event.target.value
                    setDraft({ ...draft, apiKey })
                    // 只按 id 合并这一个字段：以前用组件里的 providers 快照重建整个数组，
                    // 快照里没有刚输入的 key，紧接着改「API 地址」就会把 key 覆盖成空，
                    // 落库时算出空 key → 安全存储里的 key 被删掉（重启后 Key 就没了）。
                    void actions.updateProvider(draft.providerId, { apiKey })
                  }}
                  placeholder="sk-…"
                  autoComplete="off"
                  spellCheck={false}
                />
                <IconButton label={showKey ? '隐藏 Key' : '显示 Key'} onClick={() => setShowKey(!showKey)}>
                  {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                </IconButton>
              </div>
            </label>

            <div className="field-row">
              <label className="field">
                <span>模型</span>
                <Select
                  ariaLabel="模型"
                  value={draft.model}
                  onChange={(model) => {
                    setDraft({ ...draft, model })
                    void actions.setSettings({ model })
                  }}
                  options={modelSelectOptions(draft)}
                />
                <ModelStatusLine model={draft.model} providerModels={currentProviderModels(draft)} meta={currentProviderMeta(draft)[draft.model]} provider={currentProvider(draft)} />
              </label>
              <label className="field">
                <span>自定义模型名</span>
                <input
                  value={draft.model}
                  onChange={(event) => {
                    const model = event.target.value
                    setDraft({ ...draft, model })
                  }}
                  onBlur={(event) => {
                    // 只做「发得出去」级校验（空 / 含空白 / 超长），不限制字符集：
                    // gpt-4.1、claude-3-5-sonnet-20241022、deepseek-ai/DeepSeek-V3
                    // 都是合法模型名，用字符集正则会把它们全判死。
                    // 校验失败退回上一次保存的值，绝不把空串写进设置。
                    const checked = checkModelId(event.target.value)
                    if (!checked.ok) {
                      setDraft({ ...draft, model: settings.model })
                      actions.showToast(checked.reason ?? '模型名不合法')
                      return
                    }
                    if (checked.model !== draft.model) setDraft({ ...draft, model: checked.model })
                    if (checked.model !== settings.model) void actions.setSettings({ model: checked.model })
                  }}
                  placeholder="deepseek-chat"
                />
              </label>
            </div>

            <label className="field">
              <span>API 地址（当前供应商）</span>
              <input
                value={draft.baseUrl}
                onChange={(event) => {
                  const baseUrl = event.target.value
                  setDraft({ ...draft, baseUrl })
                  // 同 API Key：按 id 合并，别用快照重建整个供应商数组。
                  void actions.updateProvider(draft.providerId, { baseUrl })
                }}
                placeholder="https://api.deepseek.com"
              />
            </label>

            <label className="field">
              <span>思考强度</span>
              <Select
                ariaLabel="思考强度"
                value={draft.thinkingEffort}
                onChange={(value) => {
                  const effort = value as ThinkingEffort
                  setDraft({ ...draft, thinkingEffort: effort })
                  void actions.setSettings({ thinkingEffort: effort })
                }}
                options={EFFORTS.map((effort) => ({ value: effort.id, label: effort.name, hint: effort.hint }))}
              />
            </label>
            <p className="settings-hint">思考内容会实时显示在对话里，也可以随时点开回看。旧版 deepseek-reasoner 固定思考。</p>

            <Switch
              checked={draft.autoContinue !== false}
              onChange={(checked) => {
                setDraft({ ...draft, autoContinue: checked })
                void actions.setSettings({ autoContinue: checked })
              }}
              label="输出到上限时自动续写一次"
            />
            <p className="settings-hint">长网页 / 游戏容易写一半就顶到上限；开着会自动接着写（并成一条回复）。关掉后仍可在气泡上点「继续写」。</p>

            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => void test()} disabled={status === 'testing' || draft.apiKey.trim() === ''}>
                {status === 'testing' ? <RefreshCw size={15} className="spin" /> : <Sparkles size={15} />}
                测试连接
              </button>
              <button type="button" className="text-button" onClick={() => void openExternal('https://platform.deepseek.com/api_keys')}>
                <ExternalLink size={13} /> 获取 Key
              </button>
              {status === 'ok' && <span className="status-ok"><Check size={14} /> {message}</span>}
              {status === 'fail' && <span className="status-fail">{message}</span>}
            </div>

            <details className="advanced">
              <summary>高级参数</summary>
              <div className="field-row">
                <label className="field">
                  <span>温度 {draft.temperature.toFixed(1)}</span>
                  <input type="range" min={0} max={1.5} step={0.1} value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} />
                </label>
                <label className="field">
                  <span>
                    单次最多输出
                    {/* 直接告诉用户这轮实际会发出去的上限：正文预算 + 思考预留是同一个数。 */}
                    {draft.maxTokens === 0
                      ? '（自动）'
                      : ` ${draft.maxTokens} + 思考预留 ${effectiveOutputCap.body === 0 ? 0 : effectiveOutputCap.reserve}`}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={65536}
                    step={1024}
                    value={draft.maxTokens}
                    onChange={(event) => {
                      const raw = Number(event.target.value)
                      const next = Number.isFinite(raw) ? Math.max(0, Math.min(65536, Math.round(raw))) : 0
                      setDraft({ ...draft, maxTokens: next })
                    }}
                  />
                </label>
                <div className="inline-actions">
                  <button
                    type="button"
                    className={draft.maxTokens === 0 ? 'text-button' : 'ghost-button'}
                    onClick={() => setDraft({ ...draft, maxTokens: 0 })}
                  >
                    自动（不设上限）
                  </button>
                  <button
                    type="button"
                    className={draft.maxTokens === 8192 ? 'text-button' : 'ghost-button'}
                    onClick={() => setDraft({ ...draft, maxTokens: 8192 })}
                  >
                    8192
                  </button>
                  <button
                    type="button"
                    className={draft.maxTokens === 32768 ? 'text-button' : 'ghost-button'}
                    onClick={() => setDraft({ ...draft, maxTokens: 32768 })}
                  >
                    32768
                  </button>
                </div>
                <p className="settings-hint">
                  输出上限与思考预留是共享预算：推理模型的「思考」和「正文」用的是同一个 max_tokens，
                  所以这里填的是正文预算，实际发出去的是它加上思考预留（低 4096 / 高 8192 / 最高 16384）。
                  填 0 = 自动，干脆不发这个上限，由模型自己定。
                  设太小会出现「思考了很久、正文和工坊都是空的」——那正是把额度被思考吃光了。
                </p>
              </div>
              <label className="field">
                <span>上下文预算（tokens）</span>
                <input type="number" min={4000} max={64000} step={1000} value={draft.contextBudget} onChange={(event) => setDraft({ ...draft, contextBudget: Number(event.target.value) })} />              </label>
            </details>
          </section>

          <section className="settings-card">
            <h2><UserRound size={17} /> MCP 工具</h2>
            <p className="settings-hint">接外部 MCP 服务器，模型就能调用它们的工具（文件、数据库、搜索等）。</p>
            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => actions.setScreen('mcp')}>
                <Server size={15} /> 管理 MCP 服务器（{settings.mcpServers.length}）
              </button>
            </div>
          </section>

          <section className="settings-card">
            <h2><ImagePlus size={17} /> 生图与语音</h2>
            <p className="settings-hint">
              独立的生图 / TTS API，不占用聊天供应商的 Key。配好后模型可以在对话里调用
              <code>generate_image</code> 和 <code>speak</code>；只有你明确要求时才会触发。
            </p>
            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => actions.setScreen('media')}>
                <ImagePlus size={15} /> 管理生图与语音
              </button>
              <span className="settings-hint">
                生图：{settings.imageApi.enabled && settings.imageApi.apiKey.trim() !== '' ? '已配置' : '未配置'}
                {' · '}
                语音：{settings.speechApi.enabled && settings.speechApi.apiKey.trim() !== '' ? '已配置' : '未配置'}
              </span>
            </div>
          </section>

          <section className="settings-card">
            <h2><Database size={17} /> 记忆</h2>
            <div className="switch-row">
              <div>
                <strong>自动记忆</strong>
                <small>记住对话里稳定的事实，下次自动带上；关掉后不读也不写</small>
              </div>
              <Switch checked={draft.memoryEnabled} onChange={(checked) => {
                setDraft({ ...draft, memoryEnabled: checked })
                void actions.setSettings({ memoryEnabled: checked })
              }} label="自动记忆" />
            </div>
            <div className="switch-row">
              <div>
                <strong>自动压缩</strong>
                <small>聊得太长时，把前面的话折成一段摘要，省上下文</small>
              </div>
              <Switch checked={draft.autoCompress} onChange={(checked) => {
                setDraft({ ...draft, autoCompress: checked })
                void actions.setSettings({ autoCompress: checked })
              }} label="自动压缩" />
            </div>
            {!draft.autoCompress && (
              <p className="settings-hint">关了之后只能自己在对话里点「压缩」。</p>
            )}
            <div className="field-row">
              <label className="field">
                <span>常驻记忆预算（tokens）</span>
                <Select
                  ariaLabel="常驻记忆预算"
                  value={String(draft.memoryTokenBudget)}
                  onChange={(value) => {
                    const budget = Number(value)
                    setDraft({ ...draft, memoryTokenBudget: budget })
                    void actions.setSettings({ memoryTokenBudget: budget })
                  }}
                  options={[400, 800, 1200, 2000].map((value) => ({ value: String(value), label: String(value) }))}
                />
              </label>
              <label className="field">
                <span>摘要模型</span>
                <Select
                  ariaLabel="摘要模型"
                  value={draft.memoryModel}
                  onChange={(value) => {
                    // 这一项以前只改草稿，要等用户点「保存」才落库；离开设置页就丢了。
                    // 其余下拉都是即时保存，这里保持一致。
                    setDraft({ ...draft, memoryModel: value })
                    void actions.setSettings({ memoryModel: value })
                  }}
                  // 原来是 `${id} · ${hint}` 一行，这里拆成 label + hint 两行。
                  options={memoryModelOptions(draft)}
                />
              </label>
            </div>
            <p className="settings-hint">超预算时按重要度截断，记忆页会提示还有几条没带上。</p>
            <div className="switch-row">
              <div>
                <strong>最近对话回顾</strong>
                <small>新对话开始时带上最近几段的一句话摘要</small>
              </div>
              <Switch checked={draft.recentChats} onChange={(checked) => {
                setDraft({ ...draft, recentChats: checked })
                void actions.setSettings({ recentChats: checked })
              }} label="最近对话回顾" />
            </div>
            <div className="switch-row">
              <div>
                <strong>时间提醒</strong>
                <small>让助手知道现在几点、隔了多久</small>
              </div>
              <Switch checked={draft.timeReminder} onChange={(checked) => {
                setDraft({ ...draft, timeReminder: checked })
                void actions.setSettings({ timeReminder: checked })
              }} label="时间提醒" />
            </div>
          </section>

          <section className="settings-card">
            <h2><Waves size={17} /> 身体联动</h2>
            <div className="switch-row">
              <div>
                <strong>让模型住在虎鲸里</strong>
                <small>把心情、深度、速度写进系统提示词；模型也能用指令驱动身体</small>
              </div>
              <Switch checked={draft.embodiment} onChange={(checked) => {
                setDraft({ ...draft, embodiment: checked })
                void actions.setSettings({ embodiment: checked })
              }} label="身体联动" />
            </div>
            <p className="settings-hint">
              模型偶尔会输出 <code>&lt;body act="spin" mood="playful" say="看我的！" /&gt;</code> 这样的指令，
              深鲸会真的转一圈、冒泡或下潜。指令不会留在聊天气泡里。
            </p>
          </section>

          <section className="settings-card">
            <h2><Globe size={17} /> 网页版</h2>
            <p className="settings-hint">
              chat.deepseek.com 那边没有设置页，所以这些开关全在这里。
              我们只给它加头像；纸雕助手在「助手」页里单独开关，界面本身的浅色/深色交给站内设置，互不干扰。
            </p>
            <div className="switch-row">
              <div>
                <strong>网页版也带头像</strong>
                <small>把这两张头像贴到 chat.deepseek.com 的对话气泡上</small>
              </div>
              <Switch checked={draft.webAvatar} onChange={(checked) => {
                setDraft({ ...draft, webAvatar: checked })
                void actions.setSettings({ webAvatar: checked })
              }} label="网页版头像" />
            </div>
            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => void openWeb()}>
                <ExternalLink size={15} /> 打开网页版
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  void loginWebChat().then((result) => {
                    actions.showToast(result.ok ? '网页账号已连接，以后不用再登录' : result.message ?? '登录没有完成')
                  })
                }}
              >
                <Waves size={15} /> 登录网页账号
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  void diagnoseWebChat().then((result) => {
                    actions.showToast(result)
                  })
                }}
              >
                <RefreshCw size={15} /> 自检
              </button>
            </div>
            <p className="settings-hint">
              想在虎鲸界面直接用网页账号聊：在上面「模型」里选
              <code>{WEB_CHAT_MODEL}</code>，点上面的「登录网页账号」登录一次。
              登录态会记住，<strong>之后网页窗关不关都能聊</strong>（主进程直接调网页接口）。
              这个模式免 Key，支持图片附件（会先上传到网页账号，需要上面的登录态）；
              工具调用仍不支持，需要工具请切回 API 模型。
            </p>
          </section>

          <section className="settings-card">
            <h2><UserRound size={17} /> 头像</h2>
            <p className="settings-hint">
              默认是内置的两张：助手用 DeepSeek 的蓝鲸标，你用那只水母。网页版贴的也是这两张。
              开启「助手」时，助手页里那个助手自己的头像会覆盖这里的助手头像（网页端也一起覆盖）；
              关掉助手后才用这里设的。
              上传的图只存在本机，不进备份、也不会跟着请求发出去；换设备就没了，得重传。
            </p>
            <div className="avatar-row">
              <Avatar role="assistant" size={44} {...currentAssistantAvatar(draft)} />
              <div>
                <strong>助手</strong>
                <small>
                  {draft.assistantsEnabled
                    ? '当前由助手的头像覆盖；关掉助手后这里生效'
                    : '对话气泡左上角'}
                </small>
              </div>
              <div className="inline-actions">
                <button type="button" className="ghost-button" onClick={() => pickAvatar('assistant')}>换一张</button>
                <button type="button" className="ghost-button" onClick={() => void avatarStore.clear('assistant')}>用默认</button>
              </div>
            </div>
            <div className="avatar-row">
              <Avatar role="user" size={44} />
              <div>
                <strong>我</strong>
                <small>对话气泡右上角</small>
              </div>
              <div className="inline-actions">
                <button type="button" className="ghost-button" onClick={() => pickAvatar('user')}>换一张</button>
                <button type="button" className="ghost-button" onClick={() => void avatarStore.clear('user')}>用默认</button>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => void onAvatarFile(event)}
            />
          </section>

          <section className="settings-card">
            <h2><Database size={17} /> 数据与备份</h2>
            <p className="settings-hint">
              对话、消息、记忆、压缩摘要、工坊文件都能导出成一个 JSON 文件；换设备时导回来就能接着用。
              API Key 不在备份里，导入后要重新填一次。生成的图片/语音也不包含在备份里。
            </p>
            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => void exportAll()} disabled={busy}>
                <Download size={15} /> 导出备份
              </button>
              <button type="button" className="ghost-button" onClick={() => void importBackup('merge')} disabled={busy}>
                <Upload size={15} /> 导入并合并
              </button>
              <button type="button" className="ghost-button is-danger" onClick={() => void importBackup('replace')} disabled={busy}>
                <Upload size={15} /> 导入并覆盖
              </button>
            </div>
            <p className="settings-hint">
              「合并」只添加备份里有、本机没有的；「覆盖」会先清空本机全部对话与记忆，再写入备份。
            </p>
            {busy && <p className="settings-hint">正在处理…</p>}
            {importStatus !== '' && <p className="settings-hint">{importStatus}</p>}

            <div className="inline-actions">
              <button type="button" className="ghost-button is-danger" onClick={() => void clearChats()}><Trash2 size={14} /> 清空对话</button>
              <button type="button" className="ghost-button is-danger" onClick={() => void clearMemories()}><Trash2 size={14} /> 清空记忆</button>
            </div>
          </section>

          <section className="settings-card settings-about">
            <img src="./deepwhale.png" alt="" />
            <div>
              <h2>深鲸 {version}</h2>
              <p>个人非官方 DeepSeek 客户端。虎鲸形象来自 DeepSeek 品牌标识，仅作个人陪伴界面使用。</p>
              <p>API 请求从你的设备直连你填写的地址；没有中转服务器，也没有遥测。</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
