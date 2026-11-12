import { useState } from 'react'
import { ArrowRight, Check, Eye, EyeOff, Globe2, KeyRound, Loader2, Sparkles } from 'lucide-react'
import { testConnection } from '../lib/deepseek'
import { useAppStore } from '../lib/store'
import { Switch } from './ui'

type Mode = 'web' | 'api' | null

export function Onboarding() {
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  const [step, setStep] = useState(0)
  const [mode, setMode] = useState<Mode>(null)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [name, setName] = useState(settings.assistants[0]?.name || 'DeepOrca')
  const [memory, setMemory] = useState(true)
  const [testing, setTesting] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [testMessage, setTestMessage] = useState('')

  const finish = async (withKey: boolean): Promise<void> => {
    // key 现在属于「当前供应商」，必须写进 providers[].apiKey，只写 settings.apiKey 会丢。
    const apiKey = withKey ? key.trim() : settings.apiKey
    const providers = settings.providers.map((provider) =>
      provider.id === settings.providerId ? { ...provider, apiKey } : provider,
    )
    // 名字归第一个助手所有（不再有单独的 orcaName）。留空 = 跳过，
    // 保持助手的默认名，别把空白存成名字。
    const trimmed = name.trim()
    const assistants = trimmed === ''
      ? settings.assistants
      : settings.assistants.map((assistant, index) => (
        index === 0 ? { ...assistant, name: trimmed.slice(0, 24), updatedAt: Date.now() } : assistant
      ))
    await actions.setSettings({
      onboardingDone: true,
      apiKey,
      providers,
      assistants,
      memoryEnabled: memory,
    })
    actions.setScreen('home')
    actions.showToast(withKey ? '欢迎来到深海' : '网页版在底部「网页」里')
  }

  const test = async (): Promise<void> => {
    if (key.trim() === '') return
    setTesting(true)
    setTestStatus('idle')
    try {
      // 把试用的 key 临时塞进当前供应商，否则 testConnection 会去读供应商里的空 key。
      const providers = settings.providers.map((provider) =>
        provider.id === settings.providerId ? { ...provider, apiKey: key.trim() } : provider,
      )
      await testConnection({ ...settings, apiKey: key.trim(), providers })
      setTestStatus('ok')
      setTestMessage('连接成功')
    } catch (error) {
      setTestStatus('fail')
      setTestMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-aurora" />
      <div className="onboarding-card">
        <img src="./deepwhale.png" alt="" className="onboarding-logo" />

        {step === 0 && (
          <div className="onboarding-step">
            <span className="onboarding-eyebrow"><Sparkles size={14} /> 深鲸 · DeepSea</span>
            <h1>把 AI 养在一片海里。</h1>
            <p className="onboarding-lead">
              一只会记住你的虎鲸。可以聊天、写小网页，也会在你忙的时候安静地游。
            </p>
            <ul className="onboarding-points">
              <li><Check size={15} /> 沉浸式聊天，对话是海面上的玻璃</li>
              <li><Check size={15} /> 长期记忆，只存在你自己的设备里</li>
              <li><Check size={15} /> 写代码 / 预览 / 导出，一个小工坊</li>
            </ul>
            <button type="button" className="onboarding-primary" onClick={() => setStep(1)}>
              开始下潜 <ArrowRight size={17} />
            </button>
            <p className="onboarding-fine">个人非官方客户端 · 不收集任何数据</p>
          </div>
        )}

        {step === 1 && (
          <div className="onboarding-step">
            <span className="onboarding-eyebrow">选择怎么开始</span>
            <h2>先决定用哪种方式聊天</h2>
            <div className="mode-cards">
              <button
                type="button"
                className={`mode-card ${mode === 'web' ? 'is-active' : ''}`}
                onClick={() => setMode('web')}
              >
                <Globe2 size={22} />
                <strong>网页版 · 不用 Key</strong>
                <p>打开官方 chat.deepseek.com，用你的账号登录。适合先试试。</p>
                <small>没有记忆和工坊</small>
              </button>
              <button
                type="button"
                className={`mode-card ${mode === 'api' ? 'is-active' : ''}`}
                onClick={() => setMode('api')}
              >
                <KeyRound size={22} />
                <strong>API 模式 · 完整体验</strong>
                <p>填自己的 DeepSeek API Key。有记忆、工坊、虎鲸反应。</p>
                <small>Key 只加密保存在本机</small>
              </button>
            </div>
            <div className="onboarding-actions">
              <button type="button" className="ghost-button" onClick={() => setStep(0)}>上一步</button>
              <button
                type="button"
                className="onboarding-primary"
                disabled={mode === null}
                onClick={() => {
                  if (mode === 'web') void finish(false)
                  else setStep(2)
                }}
              >
                继续 <ArrowRight size={17} />
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-step">
            <span className="onboarding-eyebrow">最后一步</span>
            <h2>把 Key 交给助手</h2>
            <p className="onboarding-lead">去 platform.deepseek.com 创建一个 Key。它只会留在这台设备上。</p>
            <label className="field">
              <span>API Key</span>
              <div className="input-with-action">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value)
                    setTestStatus('idle')
                  }}
                  placeholder="sk-…"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="icon-button" aria-label="显示或隐藏" onClick={() => setShowKey(!showKey)}>
                  {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>
            <div className="onboarding-inline">
              <button type="button" className="ghost-button" onClick={() => void test()} disabled={testing || key.trim() === ''}>
                {testing ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} 测试连接
              </button>
              {testStatus === 'ok' && <span className="status-ok"><Check size={14} /> {testMessage}</span>}
              {testStatus === 'fail' && <span className="status-fail">{testMessage}</span>}
            </div>
            <label className="field">
              <span>给虎鲸起个名字</span>
              <input value={name} maxLength={24} onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="switch-row">
              <div>
                <strong>开启长期记忆</strong>
                <small>从对话里记住关于你的事，随时可删</small>
              </div>
              <Switch checked={memory} onChange={setMemory} label="长期记忆" />
            </div>
            <div className="onboarding-actions">
              <button type="button" className="ghost-button" onClick={() => setStep(1)}>上一步</button>
              <button type="button" className="onboarding-primary" onClick={() => void finish(true)}>
                {key.trim() === '' ? '先跳过' : '进入深海'} <ArrowRight size={17} />
              </button>
            </div>
            <p className="onboarding-fine">这是非官方客户端。Key 只用于你自己发起的 API 请求。</p>
          </div>
        )}
      </div>
    </div>
  )
}
