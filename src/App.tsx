import { useEffect } from 'react'
import { prepareNativeShell } from './lib/platform'
import { avatarStore } from './lib/avatars'
import { startReminderPolling } from './lib/reminders'
import { useAppStore } from './lib/store'
import { Chat } from './components/Chat'
import { HistoryDrawer } from './components/HistoryDrawer'
import { NewChatSheet } from './components/NewChatSheet'
import { Home } from './components/Home'
import { MemoryScreen } from './components/Memory'
import { Onboarding } from './components/Onboarding'
import { SettingsScreen } from './components/Settings'
import { AppearanceScreen, appearanceStyle } from './components/AppearancePanel'
import { AssistantsScreen } from './components/Assistants'
import { CalendarScreen } from './components/CalendarScreen'
import { ProvidersScreen } from './components/Providers'
import { McpScreen } from './components/Mcp'
import { MediaScreen } from './components/Media'
import { Splash } from './components/Splash'
import { Stage } from './components/Stage'
import { Toast } from './components/Toast'
import { ApprovalGate } from './components/ApprovalGate'
import { Workshop } from './components/Workshop'
import { SelectionCopyBar } from './components/SelectionCopyBar'
import { ConfirmHost } from './components/ConfirmDialog'
import { RoomScreen } from './components/room/RoomScreen'
import { ZenDot } from './components/ZenDot'

export default function App() {
  const ready = useAppStore((state) => state.ready)
  const bootError = useAppStore((state) => state.bootError)
  const screen = useAppStore((state) => state.screen)
  const historyOpen = useAppStore((state) => state.historyOpen)
  const newChatOpen = useAppStore((state) => state.newChatOpen)
  const appTone = useAppStore((state) => state.settings.appTone)
  const customAccent = useAppStore((state) => state.settings.customAccent)
  const customBubble = useAppStore((state) => state.settings.customBubble)
  const quality = useAppStore((state) => state.settings.quality)
  const zen = useAppStore((state) => state.zen)

  useEffect(() => {
    useAppStore
      .getState()
      .actions.boot()
      .catch((error: unknown) => {
        // boot() 内部已经分阶段兜过底；能走到这里说明连兜底都抛了。
        // 无论如何都要放开界面 —— 不能让用户对着开屏画面一直等。
        useAppStore.getState().actions.failBoot(error instanceof Error ? error.message : String(error))
      })
    void prepareNativeShell()
    void avatarStore.hydrate()
    // 便签到点提醒：常驻轮询，任意界面都能弹（引用计数，重复调用安全）。
    const stopReminders = startReminderPolling()
    return stopReminders
  }, [])

  if (!ready) return <Splash />

  return (
    /*
     * data-tone 只给 App 界面用，data-screen / data-zen 是布局钩子：
     * - data-tone：三套配色（深海 / 雾霭 / 暖阳），和 3D 海底主题已经解绑，
     *   换海底不会顺手把界面也换掉。
     * - data-screen：手机端在「布置」屏要把对话面板藏起来（屏幕放不下）。
     * - data-zen：欣赏模式，整层 .ui 一起隐藏，只留角落那个圆点。
     *
     * style：用户自定义的强调色/气泡色以内联 CSS 变量盖在 .app 上。内联声明
     * 优先于 `.app[data-tone='…']`，所以「自定义」能压过预设；两个颜色都是
     * null 时这里返回 undefined，等于什么都不写，界面原样跟 data-tone 走。
     *
     * Stage 用 quality 做 key：画质是构造参数，改了只能重建整个 3D 场景。
     * RoomScreen 跟着一起重建，否则它会握着一个已经 dispose 的旧 bridge。
     */
    <div
      className="app"
      data-tone={appTone}
      data-screen={screen}
      data-zen={zen ? 'true' : 'false'}
      style={appearanceStyle(customAccent, customBubble)}
    >
      {screen !== 'onboarding' && <Stage key={quality} />}
      {bootError !== '' && (
        <div className="boot-error" role="alert">
          <span>{bootError}。界面能用的部分先照常给；实在不行请重启一次。</span>
          <button type="button" onClick={() => useAppStore.getState().actions.clearBootError()}>
            知道了
          </button>
        </div>
      )}
      <div className="ui" data-deepsea-ui>
        {screen === 'home' && <Home />}
        {/*
          桌面端进「布置」屏对话还在：那边屏幕够宽，海底在左、对话在右。
          手机端由 CSS 把 .chat-screen 藏掉（见 styles.css 的 data-screen 规则）。
        */}
        {(screen === 'chat' || screen === 'room') && <Chat />}
        {screen === 'room' && <RoomScreen key={quality} />}
        {screen === 'memory' && <MemoryScreen />}
        {screen === 'workshop' && <Workshop />}
        {screen === 'settings' && <SettingsScreen />}
        {screen === 'appearance' && <AppearanceScreen />}
        {screen === 'assistants' && <AssistantsScreen />}
        {screen === 'calendar' && <CalendarScreen />}
        {screen === 'providers' && <ProvidersScreen />}
        {screen === 'mcp' && <McpScreen />}
        {screen === 'media' && <MediaScreen />}
        {screen === 'onboarding' && <Onboarding />}
      </div>
      {historyOpen && <HistoryDrawer />}
      {/* 新建对话弹层挂在 App 层：Chat 顶部和历史抽屉的「+」共用同一个（UI 反馈 #2）。 */}
      <NewChatSheet
        open={newChatOpen}
        onClose={() => useAppStore.getState().actions.setNewChatOpen(false)}
      />
      <ApprovalGate />
      <Toast />
      {/*
        这条自绘工具条现在是「复制/剪切/粘贴/全选」的唯一入口：
        主界面 WebView 把系统文本选择工具条压掉了（某些 ROM 上它会渲染成整块白屏），
        见 android/.../DeepSeaWebView.java。桌面端也保留，右键/选中时同样可用。
      */}
      <SelectionCopyBar />
      <ConfirmHost />
      {/* 欣赏模式唯一的出口，必须留在 .ui 外面才不会被一起藏掉。 */}
      <ZenDot />
    </div>
  )
}
