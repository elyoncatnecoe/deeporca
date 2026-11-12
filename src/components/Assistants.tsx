import { useRef, useState } from 'react'
import { Check, Copy, ImagePlus, Plus, Sparkles, Trash2, UserRound } from 'lucide-react'
import { useAppStore } from '../lib/store'
import { BUILTIN_MODELS } from '../lib/models'
import { DEFAULT_WEB_PET_PROMPT, type Assistant, type AssistantAvatarKind, type ThinkingEffort } from '../lib/types'
import { BUILTIN_ASSISTANT_AVATARS } from '../lib/avatar-defaults'
import { fileToAvatar } from '../lib/avatars'
import { writeClipboardText } from '../lib/platform'
import { Avatar, assistantAvatarProps } from './Avatar'
import { IconButton, ListTextarea, ScreenHeader, Select, Switch } from './ui'
import { confirmDialog } from './ConfirmDialog'
import '../styles-assistants.css'

const EFFORTS: { id: ThinkingEffort | ''; label: string }[] = [
  { id: '', label: '跟随全局' },
  { id: 'off', label: '关闭' },
  { id: 'low', label: '低' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最大' },
]

/** 内置头像三选一。key 对应 avatar-defaults.ts 里 BUILTIN_ASSISTANT_AVATARS。 */
const BUILTIN_OPTIONS: { key: string; label: string }[] = [
  { key: 'deeporca', label: 'DeepOrca' },
  { key: 'clawd', label: 'Clawd' },
  { key: 'sealgpt', label: 'Seal-GPT' },
]

const AVATAR_MODES: { id: AssistantAvatarKind; label: string }[] = [
  { id: 'builtin', label: '内置' },
  { id: 'emoji', label: 'emoji' },
  { id: 'image', label: '上传' },
]

export function AssistantsScreen() {
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [editingId, setEditingId] = useState<string | null>(null)
  // 上传按钮背后挂一个隐藏的 file input，点按钮时用 ref 触发系统选图。
  const fileRef = useRef<HTMLInputElement>(null)

  const current = settings.assistants.find((item) => item.id === settings.assistantId) ?? settings.assistants[0]
  const editing = settings.assistants.find((item) => item.id === editingId) ?? null
  const enabled = settings.assistantsEnabled

  const update = (patch: Partial<Assistant>): void => {
    if (editing === null || editing === undefined) return
    void actions.updateAssistant(editing.id, patch)
  }

  /** 读一张本地图 → 居中裁方 + 压成 dataURL，写进助手自己的 avatarImage。 */
  const pickAvatarFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    try {
      const dataUrl = await fileToAvatar(file)
      update({ avatarKind: 'image', avatarImage: dataUrl })
      actions.showToast('头像已更新')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '这张图用不了')
    }
  }

  /** 新建助手：store 里建出来只带 emoji 老字段，这里顺手给它一个内置头像。 */
  const createAssistant = async (): Promise<void> => {
    const id = await actions.addAssistant()
    await actions.updateAssistant(id, { avatarKind: 'builtin', avatarBuiltin: 'deeporca' })
    setEditingId(id)
  }

  const editingKind: AssistantAvatarKind = editing?.avatarKind ?? 'emoji'

  return (
    <div className="screen settings-screen assistants-screen">
      <div className="screen-panel">
        <ScreenHeader
          title="助手"
          subtitle="每个助手一套人格与头像；新对话开始时把当前这个固定下来"
          onBack={() => actions.setScreen('home')}
          actions={(
            <button type="button" className="primary-button" disabled={!enabled} onClick={() => void createAssistant()}>
              <Plus size={16} /> 新建
            </button>
          )}
        />

        <div className="screen-body assistants-body">
          {/* 总开关。关掉不是清空配置，只是让对话回到「纯净模式」，
              所以这里保持开关本身可点，只把下面所有内容整体置灰。 */}
          <section className="settings-card asst-switch-card">
            <div className="switch-row">
              <div>
                <strong>助手人格</strong>
                <small>
                  {enabled
                    ? '开：对话会带上选中的助手人格，并按它的设置读记忆、回顾最近对话'
                    : '关：纯净对话，只用通用设定，不注入人设'}
                </small>
              </div>
              <Switch
                checked={enabled}
                onChange={(next) => void actions.setAssistantsEnabled(next)}
                label="助手总开关"
              />
            </div>
            {!enabled && (
              <p className="settings-hint">
                关掉 = 纯净对话：不注入人设、不读记忆。下面的助手配置都还留着，随时能再打开。
              </p>
            )}
          </section>

          {/* 网页版纸雕助手：只跟网页版有关，和「助手人格」开关互不影响，所以放在面板外面。 */}
          <section className="settings-card">
            <h2><Sparkles size={17} /> 网页版纸雕助手</h2>
            <div className="switch-row">
              <div>
                <strong>网页版显示纸雕</strong>
                <small>只在 chat.deepseek.com 出现；App 内已不再显示纸雕</small>
              </div>
              <Switch
                checked={settings.webPet}
                onChange={(next) => void actions.setSettings({ webPet: next })}
                label="网页版纸雕"
              />
            </div>
            <label className="field">
              <span>默认提示词（纸雕右键 / 复制按钮给出的文本）</span>
              <textarea
                rows={4}
                value={settings.webPetPrompt}
                placeholder="例如：你是我的中文写作助手，先给结论再给步骤。"
                onChange={(event) => void actions.setSettings({ webPetPrompt: event.target.value })}
              />
            </label>
            <div className="inline-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  void writeClipboardText(settings.webPetPrompt).then((ok) => {
                    actions.showToast(ok ? '默认提示词已复制' : '复制失败，请手动选中')
                  })
                }}
              >
                <Copy size={15} /> 复制默认提示词
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => void actions.setSettings({ webPetPrompt: DEFAULT_WEB_PET_PROMPT })}
              >
                恢复默认
              </button>
            </div>
            <p className="settings-hint">
              手机上纸雕没有右键，用这里的「复制默认提示词」；桌面上右键（或手机长按）纸雕也有同一项。
            </p>
          </section>

          {/* 关掉总开关时，这块统一灰掉且点不动；配置本身不丢。 */}
          <div className="assistant-panel" data-disabled={enabled ? undefined : 'true'} aria-disabled={!enabled}>
            <section className="settings-card">
              <h2><UserRound size={17} /> 我的助手</h2>
              <div className="assistant-cards">
                {settings.assistants.map((item) => {
                  const isCurrent = item.id === current?.id
                  const avatarProps = assistantAvatarProps(item)
                  return (
                    <article key={item.id} className="assistant-card" data-active={isCurrent ? 'true' : undefined}>
                      <div className="assistant-card-head">
                        <Avatar role="assistant" size={44} {...avatarProps} />
                        <div className="assistant-card-body">
                          <strong>
                            <span className="assistant-card-name">{item.name}</span>
                            {isCurrent && <span className="assistant-current"><Check size={12} /> 在用</span>}
                          </strong>
                          <small>
                            {item.model.trim() === '' ? '跟随全局模型' : item.model}
                            {item.systemPrompt.trim() === '' ? ' · 内置人设' : ' · 自定义人设'}
                          </small>
                        </div>
                      </div>
                      <div className="assistant-card-actions">
                        {!isCurrent && (
                          <button type="button" className="text-button" onClick={() => void actions.selectAssistant(item.id)}>切换</button>
                        )}
                        <button type="button" className="text-button" onClick={() => setEditingId(item.id)}>编辑</button>
                        {settings.assistants.length > 1 && (
                          <button
                            type="button"
                            className="text-button is-danger"
                            aria-label={`删除助手 ${item.name}`}
                            onClick={async () => {
                              const ok = await confirmDialog({
                                title: `删掉助手「${item.name}」？`,
                                message: '已经开始的对话不受影响。',
                                confirmText: '删除',
                                danger: true,
                              })
                              if (!ok) return
                              if (editingId === item.id) setEditingId(null)
                              void actions.removeAssistant(item.id)
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>

            {editing !== null && editing !== undefined && (
              <section className="settings-card">
                <h2>
                  <Avatar role="assistant" size={20} {...assistantAvatarProps(editing)} />
                  编辑「{editing.name}」
                </h2>

                <div className="field-row">
                  <label className="field">
                    <span>名字</span>
                    <input
                      type="text"
                      value={editing.name}
                      maxLength={32}
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  </label>
                </div>

                {/* 头像三态：内置 SVG / emoji / 上传 PNG。上传图存本机，不进备份。 */}
                <div className="field">
                  <span>头像</span>
                  <div className="avatar-mode-tabs" role="tablist" aria-label="头像来源">
                    {AVATAR_MODES.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        role="tab"
                        aria-selected={editingKind === mode.id}
                        data-active={editingKind === mode.id ? 'true' : undefined}
                        onClick={() => update({ avatarKind: mode.id })}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>

                  {editingKind === 'builtin' && (
                    <div className="builtin-avatar-grid">
                      {BUILTIN_OPTIONS.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          data-active={editing.avatarBuiltin === option.key ? 'true' : undefined}
                          onClick={() => update({ avatarKind: 'builtin', avatarBuiltin: option.key })}
                        >
                          <img src={BUILTIN_ASSISTANT_AVATARS[option.key]} alt="" />
                          <span>{option.label}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {editingKind === 'emoji' && (
                    <div className="emoji-avatar-row">
                      <Avatar role="assistant" size={44} avatarSrc="" emoji={editing.avatar} />
                      <input
                        type="text"
                        value={editing.avatar}
                        maxLength={4}
                        placeholder="🐋"
                        aria-label="emoji 头像"
                        onChange={(event) => update({ avatarKind: 'emoji', avatar: event.target.value })}
                      />
                      <small>填一个表情符号就行（次要选项）</small>
                    </div>
                  )}

                  {editingKind === 'image' && (
                    <div className="upload-avatar-row">
                      <Avatar role="assistant" size={44} {...assistantAvatarProps(editing)} />
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        hidden
                        onChange={(event) => {
                          const input = event.currentTarget
                          void pickAvatarFile(input.files?.[0]).finally(() => { input.value = '' })
                        }}
                      />
                      <button type="button" className="text-button" onClick={() => fileRef.current?.click()}>
                        <ImagePlus size={14} /> {editing.avatarImage !== undefined && editing.avatarImage !== '' ? '换一张' : '选择图片'}
                      </button>
                      {editing.avatarImage !== undefined && editing.avatarImage !== '' && (
                        <button type="button" className="text-button is-danger" onClick={() => update({ avatarImage: '' })}>
                          清除
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <label className="field">
                  <span>人设（留空用内置人设）</span>
                  <textarea
                    rows={6}
                    value={editing.systemPrompt}
                    placeholder="你是……。你喜欢……。你说话……。"
                    onChange={(event) => update({ systemPrompt: event.target.value })}
                  />
                </label>
                <p className="settings-hint">
                  留空用内置人设。这里只替换人设那一段；工具用法、语言习惯、记忆规则这些共用部分会照常追加在后面。
                </p>

                <div className="field-row">
                  <label className="field">
                    <span>模型</span>
                    <Select
                      ariaLabel="模型"
                      value={editing.model}
                      onChange={(value) => update({ model: value })}
                      // 原来一行的 modelLabel(id) 就是 `${id} · ${hint}`，拆成 label + hint。
                      options={[
                        { value: '', label: '跟随全局' },
                        ...BUILTIN_MODELS.map((model) => ({
                          value: model.id,
                          label: model.id,
                          hint: model.hint,
                        })),
                      ]}
                    />
                  </label>
                  <label className="field">
                    <span>思考强度</span>
                    <Select
                      ariaLabel="思考强度"
                      value={editing.thinkingEffort}
                      onChange={(value) => update({ thinkingEffort: value as ThinkingEffort | '' })}
                      options={EFFORTS.map((effort) => ({ value: effort.id, label: effort.label }))}
                    />
                  </label>
                </div>

                <label className="field">
                  <span>温度 {editing.temperature < 0 ? '跟随全局' : editing.temperature.toFixed(1)}</span>
                  <input
                    type="range"
                    min={-1}
                    max={1.5}
                    step={0.1}
                    value={editing.temperature}
                    onChange={(event) => update({ temperature: Number(event.target.value) })}
                  />
                </label>

                <div className="switch-row">
                  <div>
                    <strong>最近对话回顾</strong>
                    <small>跟随全局：{settings.recentChats ? '开' : '关'}</small>
                  </div>
                  <Select
                    ariaLabel="最近对话回顾"
                    className="select-compact"
                    value={editing.recentChats === null ? 'inherit' : editing.recentChats ? 'on' : 'off'}
                    onChange={(value) => {
                      update({ recentChats: value === 'inherit' ? null : value === 'on' })
                    }}
                    options={[
                      { value: 'inherit', label: '跟随全局' },
                      { value: 'on', label: '开' },
                      { value: 'off', label: '关' },
                    ]}
                  />
                </div>

                <div className="switch-row">
                  <div>
                    <strong>时间提醒</strong>
                    <small>跟随全局：{settings.timeReminder ? '开' : '关'}</small>
                  </div>
                  <Select
                    ariaLabel="时间提醒"
                    className="select-compact"
                    value={editing.timeReminder === null ? 'inherit' : editing.timeReminder ? 'on' : 'off'}
                    onChange={(value) => {
                      update({ timeReminder: value === 'inherit' ? null : value === 'on' })
                    }}
                    options={[
                      { value: 'inherit', label: '跟随全局' },
                      { value: 'on', label: '开' },
                      { value: 'off', label: '关' },
                    ]}
                  />
                </div>

                <div className="switch-row">
                  <div>
                    <strong>长期记忆</strong>
                    <small>
                      跟随全局：{settings.memoryEnabled ? '开' : '关'}
                      {editing.memoryEnabled === false ? '（这个助手不读记忆，但仍会写）' : ''}
                    </small>
                  </div>
                  <Select
                    ariaLabel="长期记忆"
                    className="select-compact"
                    value={editing.memoryEnabled === null ? 'inherit' : editing.memoryEnabled ? 'on' : 'off'}
                    onChange={(value) => {
                      update({ memoryEnabled: value === 'inherit' ? null : value === 'on' })
                    }}
                    options={[
                      { value: 'inherit', label: '跟随全局' },
                      { value: 'on', label: '读' },
                      { value: 'off', label: '不读' },
                    ]}
                  />
                </div>

                <label className="field">
                  <span>消息模板（可选，<code>{'{{ message }}'}</code> 会被替换成你说的话）</span>
                  <input
                    type="text"
                    value={editing.messageTemplate}
                    placeholder="比如：请用一句话回答：{{ message }}"
                    onChange={(event) => update({ messageTemplate: event.target.value })}
                  />
                </label>

                <div className="field">
                  <span>预置消息（新对话一开始就摆在那儿，每条一行）</span>
                  <ListTextarea
                    rows={3}
                    placeholder="你好，我是这个助手。"
                    resetKey={editing.id}
                    value={editing.presetMessages.join('\n')}
                    onText={(text) => update({
                      presetMessages: text.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
                    })}
                  />
                </div>

                <div className="field">
                  <span>快捷消息（输入框上方一点就填）</span>
                  <div className="quick-editor">
                    {editing.quickMessages.map((quick, index) => (
                      <div key={quick.id} className="quick-editor-row">
                        <input
                          type="text"
                          value={quick.title}
                          placeholder="标题"
                          onChange={(event) => {
                            const next = [...editing.quickMessages]
                            next[index] = { ...quick, title: event.target.value }
                            update({ quickMessages: next })
                          }}
                        />
                        <input
                          type="text"
                          value={quick.content}
                          placeholder="内容"
                          onChange={(event) => {
                            const next = [...editing.quickMessages]
                            next[index] = { ...quick, content: event.target.value }
                            update({ quickMessages: next })
                          }}
                        />
                        <button
                          type="button"
                          className="text-button is-danger"
                          onClick={() => update({ quickMessages: editing.quickMessages.filter((item) => item.id !== quick.id) })}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => update({
                        quickMessages: [
                          ...editing.quickMessages,
                          { id: `qm_${Date.now().toString(36)}`, title: '', content: '' },
                        ],
                      })}
                    >
                      <Plus size={13} /> 加一条
                    </button>
                  </div>
                </div>

                <div className="field">
                  <span>正则替换（只影响显示，不改存下来的原文）</span>
                  <div className="quick-editor">
                    {editing.regexes.map((rule, index) => (
                      <div key={rule.id} className="regex-editor-row">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={(event) => {
                            const next = [...editing.regexes]
                            next[index] = { ...rule, enabled: event.target.checked }
                            update({ regexes: next })
                          }}
                        />
                        <input
                          type="text"
                          value={rule.find}
                          placeholder="查找（正则）"
                          onChange={(event) => {
                            const next = [...editing.regexes]
                            next[index] = { ...rule, find: event.target.value }
                            update({ regexes: next })
                          }}
                        />
                        <input
                          type="text"
                          value={rule.replace}
                          placeholder="替换成"
                          onChange={(event) => {
                            const next = [...editing.regexes]
                            next[index] = { ...rule, replace: event.target.value }
                            update({ regexes: next })
                          }}
                        />
                        <button
                          type="button"
                          className="text-button is-danger"
                          onClick={() => update({ regexes: editing.regexes.filter((item) => item.id !== rule.id) })}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => update({
                        regexes: [
                          ...editing.regexes,
                          { id: `rx_${Date.now().toString(36)}`, name: '', enabled: true, find: '', replace: '' },
                        ],
                      })}
                    >
                      <Plus size={13} /> 加一条
                    </button>
                  </div>
                </div>

                <div className="inline-actions">
                  <IconButton label="收起" onClick={() => setEditingId(null)}>
                    <Check size={16} />
                  </IconButton>
                  <span className="settings-hint">改完即时保存；已有对话用的是它们开始时的快照。</span>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
