import { Armchair, Brain, CalendarDays, Code2, Globe2, MessageCircle, Palette, Settings, Sparkles, Users } from 'lucide-react'
import { findAssistant } from '../lib/assistant'
import { openWebChat } from '../lib/platform'
import { useAppStore } from '../lib/store'
import { hasApiKey } from '../lib/providers'
import { webModeScript } from '../lib/web-mode'
import { IconButton } from './ui'

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return '还没睡呀'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function Home() {
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  /**
   * 名字只认「第一优先级助手」。
   *
   * 这里原本有自己的 `settings.orcaName`，和助手名字重复，用户改了一边另一边
   * 不跟着动。现在没有第二个名字了：首页显示的就是当前助手叫什么。
   */
  const name = findAssistant(settings, undefined).name

  const openChat = (prompt?: string): void => {
    if (prompt !== undefined) actions.setDraft(prompt)
    if (useAppStore.getState().activeId === null) {
      actions.setScreen('chat')
      return
    }
    actions.setScreen('chat')
  }

  /**
   * 打开网页版：只注入头像和宠物，不注入皮肤。
   *
   * 皮肤那套是靠 !important 覆盖 chat.deepseek.com 的哈希类名实现的，覆盖
   * 不可能穷尽；站内主题一翻深色，没覆盖到的元素就会露出原生深色（比如
   * 对话行的黑色渐变条），来回切还会互相打架。站点自己的浅色/深色本来就
   * 好看，交还给它，我们只做加法：头像、纸雕、纸鲸。
   */
  const openWeb = async (): Promise<void> => {
    try {
      const target = await openWebChat(
        '',
        webModeScript({ avatar: settings.webAvatar, pet: settings.webPet }),
      )
      if (target === 'external') actions.showToast('安装版才能给网页加上头像和宠物')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '网页版打不开')
    }
  }

  const hasKey = hasApiKey(settings)

  return (
    <div className="home-screen">
      <header className="home-top">
        <div className="brand">
          <img src="./deepwhale.png" alt="" className="brand-icon" />
          <div>
            <strong>深鲸</strong>
            <span>{name === '深鲸' ? 'DeepSea' : name}</span>
          </div>
        </div>
        <div className="home-top-actions">
          {/*
            助手入口。右上角原本是「新对话」，和对话页头部的新对话键重复；
            现在这里专门管「谁在跟你说话」：开关、三张助手卡、切换、头像。
          */}
          <IconButton
            label={settings.assistantsEnabled ? `助手：${name}` : '助手：未开启'}
            onClick={() => actions.setScreen('assistants')}
            data-active={settings.assistantsEnabled ? 'true' : undefined}
          >
            <Users size={18} />
          </IconButton>
          {/*
            日历便签入口。原来的「历史对话」和对话页头部的历史键重复，
            历史改由对话页承担；这里换成日历/提醒/便签。
          */}
          <IconButton label="日历便签：记录、提醒" onClick={() => actions.setScreen('calendar')}>
            <CalendarDays size={18} />
          </IconButton>
          {/*
            「布置」入口。挨着外观是刻意的：外观改的是 App 长什么样，
            布置改的是海里长什么样 —— 两个「改外观」的地方放在一起。
          */}
          <IconButton label="布置：喂它、布置海底、拍照" onClick={() => actions.setScreen('room')}>
            <Armchair size={18} />
          </IconButton>
          {/*
            原来是「设置」齿轮，和底部导航的「设置」重复了。
            这里改成调色盘，专门管「看起来怎么样」（配色 / 底图 / 界面色调），
            点开是外观面板而不是设置页；连接、数据这些还是走底部那个设置。
          */}
          <IconButton label="外观：配色、底图、界面色调" onClick={() => actions.setScreen('appearance')}>
            <Palette size={18} />
          </IconButton>
        </div>
      </header>

      <div className="home-hero">
        <div className="home-hello">
          <span className="home-eyebrow">
            <Sparkles size={14} />
            {greeting()}
          </span>
          <h1>我是{name}。</h1>
          <p>
            {hasKey
              ? '这片海会记住你，也会陪你写点东西。'
              : '还没接上 API。可以先用网页版聊，随时回来填 Key。'}
          </p>
        </div>

        {!hasKey && (
          <button type="button" className="connect-banner" onClick={() => actions.setScreen('settings')}>
            <span className="connect-dot" />
            <span>
              <strong>未连接 API</strong>
              <small>网页版免 Key；填 Key 后解锁记忆和工坊</small>
            </span>
            <span className="connect-cta">去连接</span>
          </button>
        )}

        <div className="home-quick">
          <button type="button" onClick={() => openChat('帮我写一个能直接玩的小网页游戏，先问我想玩什么。')}>
            <Code2 size={16} />
            写个小应用
          </button>
          <button type="button" onClick={() => openChat('记住：我喜欢……（我接下来会补充）')}>
            <Brain size={16} />
            让它记住
          </button>
          <button type="button" onClick={() => void openWeb()}>
            <Globe2 size={16} />
            网页版
          </button>
        </div>

        <button type="button" className="talk-button" onClick={() => openChat()}>
          <MessageCircle size={20} />
          <span>和{name}说点什么</span>
          <kbd>Enter</kbd>
        </button>
      </div>

      <nav className="home-dock" aria-label="主导航">
        <button type="button" className="dock-item dock-talk" onClick={() => openChat()}>
          <MessageCircle size={20} />
          <span>对话</span>
        </button>
        <button type="button" className="dock-item" onClick={() => actions.setScreen('memory')}>
          <Brain size={20} />
          <span>记忆</span>
        </button>
        <button type="button" className="dock-item" onClick={() => actions.setScreen('workshop')}>
          <Code2 size={20} />
          <span>工坊</span>
        </button>
        <button type="button" className="dock-item" onClick={() => void openWeb()}>
          <Globe2 size={20} />
          <span>网页</span>
        </button>
        <button type="button" className="dock-item" onClick={() => actions.setScreen('settings')}>
          <Settings size={20} />
          <span>设置</span>
        </button>
      </nav>
    </div>
  )
}
