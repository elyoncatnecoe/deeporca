import { getDueNotes, markNoteReminded } from './notes'
import { isAndroid } from './platform'
import { useAppStore } from './store'
import type { Note } from './types'

/**
 * 前台到点提醒。
 *
 * 为什么是「前台轮询」而不是系统闹钟：
 * - 这个 App 的常态是用户开着它（手机端 WebView / 桌面端窗口），30 秒查一次已经够用，
 *   而且实现足够简单，不依赖任何后台常驻进程；
 * - 真正的后台定时（App 被杀也能响）需要 WorkManager/AlarmManager 原生开发，超出本次范围。
 *   系统通知只是在「App 正开着」这个前提下顺手发一条，让用户切到后台时也能看到横幅。
 *
 * 轮询的唯一真理来源是 notes.ts 的 getDueNotes：dueAt 已到 + 未完成 + 没 notifiedAt。
 * 提醒过一次（markNoteReminded）之后就写库，所以即使轮询重复跑也不会重复弹。
 */

const POLL_MS = 30_000
/** 与 CalendarScreen 约定的刷新事件名：到点提醒后让界面重新拉一次（重复便签的 dueAt 被推走了）。 */
export const NOTES_FIRED_EVENT = 'deepsea:notes-fired'

let timer: ReturnType<typeof setInterval> | undefined
let subscriberCount = 0
let checking = false
/** 本次会话里是否已经问过通知权限：只问一次，被拒后不再反复骚扰。 */
let permissionAsked = false

/**
 * 请求/确认系统通知权限。
 *
 * Web / Electron 直接返回 false（静默降级，不抛错）：浏览器里没有 Capacitor 插件，
 * 硬调会报「not implemented」，那只是噪音，不是失败。
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isAndroid) return false
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    const current = await LocalNotifications.checkPermissions()
    if (current.display === 'granted') return true
    if (permissionAsked) return false
    permissionAsked = true
    const asked = await LocalNotifications.requestPermissions()
    return asked.display === 'granted'
  } catch {
    // 插件缺失 / 系统拒绝 / 被 ROM 拦，都当作「没有系统通知」，绝不往上抛。
    return false
  }
}

/** 便签 id 是字符串，而 Android 通知 id 必须是 32 位整数：做一个稳定的哈希。 */
function notificationId(noteId: string): number {
  let hash = 0
  for (let index = 0; index < noteId.length; index += 1) {
    hash = (hash * 31 + noteId.charCodeAt(index)) | 0
  }
  // 转成正数，并避开 0（个别 ROM 对 id=0 的默认通道行为怪异）。
  return Math.abs(hash) === 0 ? 1 : Math.abs(hash)
}

/**
 * 发一条系统通知。返回是否真的发出去了。
 * 任何一步（权限、建通道、排期）失败都吞掉返回 false —— 应用内 toast 才是主路径。
 */
export async function showSystemNotification(note: Note): Promise<boolean> {
  if (!isAndroid) return false
  try {
    const granted = await ensureNotificationPermission()
    if (!granted) return false
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    await LocalNotifications.createChannel({
      id: 'deepsea-reminders',
      name: '日历提醒',
      description: '便签到点提醒',
      importance: 4,
      visibility: 1,
    })
    await LocalNotifications.schedule({
      notifications: [{
        id: notificationId(note.id),
        title: `⏰ ${note.title || '便签提醒'}`,
        body: note.body.trim() === '' ? '到点啦' : note.body.slice(0, 200),
        channelId: 'deepsea-reminders',
        // 排到 1 秒后（而不是过去时间）：插件对过去时间的行为在不同版本上不一致，
        // 排未来最稳，反正用户感知上就是「立刻弹」。
        schedule: { at: new Date(Date.now() + 1000), allowWhileIdle: true },
      }],
    })
    return true
  } catch {
    return false
  }
}

/** 应用内提示：走 store 的 toast，顺手广播一个事件让日历屏刷新列表。 */
function announce(note: Note): void {
  try {
    useAppStore.getState().actions.showToast(`⏰ ${note.title || '便签到点了'}`)
  } catch {
    /* store 还没就绪也不影响提醒本身 */
  }
  try {
    window.dispatchEvent(new CustomEvent<Note>(NOTES_FIRED_EVENT, { detail: note }))
  } catch {
    /* 非浏览器环境没有 window，忽略 */
  }
}

/**
 * 跑一次到期检查，返回这一轮触发的便签（供测试/手动触发使用）。
 * 用 checking 做重入保护：一轮还没写完库时别再起一轮，否则同一条会弹两次。
 */
export async function runReminderCheck(now = Date.now()): Promise<Note[]> {
  if (checking) return []
  checking = true
  try {
    const due = await getDueNotes(now)
    if (due.length === 0) return []
    const notify = useAppStore.getState().settings.proactiveWake.notify
    const fired: Note[] = []
    for (const note of due) {
      // 先记「提醒过」再弹：写库失败时宁可少弹一次，也不要每 30 秒重复弹。
      const updated = await markNoteReminded(note, now)
      fired.push(updated ?? note)
      announce(note)
      if (notify) void showSystemNotification(note)
    }
    return fired
  } catch (error) {
    console.warn('[reminders] 到期检查失败', error)
    return []
  } finally {
    checking = false
  }
}

/**
 * 开始前台轮询。返回停止函数。
 *
 * 用引用计数：多个界面/入口都可以调用它，只要还有人在用就继续跑，
 * 最后一个停掉时才真正清掉 interval —— 避免「A 界面卸载顺手把 B 的提醒也停了」。
 */
export function startReminderPolling(): () => void {
  subscriberCount += 1
  if (timer === undefined) {
    // 启动时立刻查一次：用户刚打开 App 就有到点的便签，不该等满 30 秒。
    void runReminderCheck()
    timer = setInterval(() => {
      void runReminderCheck()
    }, POLL_MS)
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    subscriberCount = Math.max(0, subscriberCount - 1)
    if (subscriberCount === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}
