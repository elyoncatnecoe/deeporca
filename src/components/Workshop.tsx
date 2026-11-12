import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { Code2, Copy, Download, FilePlus2, FolderInput, FolderPlus, Pencil, Play, Plus, Redo2, Sparkles, Trash2, Undo2 } from 'lucide-react'
import { saveTextFile, onAppStateChange } from '../lib/platform'
import { useAppStore } from '../lib/store'
import { restoreSample } from '../lib/workshop-sample'
import { bundleWorkspaceHtml, deleteWorkspaceFile, MAX_FILE_CHARS, previewHtml, writeWorkspaceFile } from '../lib/workspace'
import { postSandboxHtml, sandboxUrl } from '../lib/sandbox'
import { DEFAULT_WORKSPACE } from '../lib/types'
import { EmptyState, IconButton, Modal, ScreenHeader, Select } from './ui'
import { confirmDialog } from './ConfirmDialog'

function templateFor(path: string): string {
  if (path.endsWith('.html')) {
    return '<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <title>小应用</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>你好，深海</h1>\n  <script src="script.js"></script>\n</body>\n</html>\n'
  }
  if (path.endsWith('.css')) return 'body {\n  margin: 0;\n  background: #04141d;\n  color: #e6f6f8;\n}\n'
  if (path.endsWith('.js')) return '// 在这里写代码\n'
  return '# 笔记\n'
}

/** 超过这个字符数就关掉高亮/括号匹配/换行：单行压缩代码会把 CodeMirror 拖死。 */
const BIG_DOC_CHARS = 100_000

function CodeEditor(props: {
  path: string
  /** 只作初始文档：编辑器自己管文档，之后 value 变了也不回灌（非受控）。 */
  value: string
  /** 文档变了只通知「脏了」，绝不把全文抬上来触发整树重渲染。 */
  onChange: () => void
  /** 粘贴会超上限时给一条明确提示。 */
  onOversize?: (message: string) => void
  /** 外层拿到的编辑器实例：工坊头部要用它做撤销/重做。 */
  viewRef?: MutableRefObject<EditorView | null>
  /** 撤销/重做**可用性**变化时才回调（比较前后布尔），别每次挪光标都抬升整树。 */
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const ownViewRef = useRef<EditorView | null>(null)
  const viewRef = props.viewRef ?? ownViewRef
  const changeRef = useRef(props.onChange)
  changeRef.current = props.onChange
  const oversizeRef = useRef(props.onOversize)
  oversizeRef.current = props.onOversize
  const historyRef = useRef(props.onHistoryChange)
  historyRef.current = props.onHistoryChange
  const historyAvailRef = useRef<{ undo: boolean; redo: boolean }>({ undo: false, redo: false })

  useEffect(() => {
    const element = host.current
    if (element === null) return
    // 大文档动态降配：lineWrapping / 语法高亮 / 括号匹配会同步扫整篇文档，
    // 压缩过的一行 20 万字符尤其病态。按初始长度决定是否装这些扩展。
    const big = props.value.length > BIG_DOC_CHARS
    const view = new EditorView({
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          ...(big ? [] : [highlightSpecialChars()]),
          history(),
          drawSelection(),
          dropCursor(),
          ...(big ? [] : [indentOnInput(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching()]),
          oneDark,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          ...(big ? [] : [EditorView.lineWrapping]),
          // 粘贴闸门：超限内容根本不让它进文档，否则之后每个键都要付整篇 O(n)。
          EditorView.domEventHandlers({
            paste: (event, editor) => {
              const text = event.clipboardData?.getData('text/plain') ?? ''
              if (text.length === 0) return false
              const selectedLength = editor.state.selection.main.to - editor.state.selection.main.from
              const resulting = editor.state.doc.length - selectedLength + text.length
              if (resulting > MAX_FILE_CHARS) {
                oversizeRef.current?.(`内容太大：粘贴后约 ${resulting} 字符，超过 ${MAX_FILE_CHARS} 字符上限，已阻止粘贴`)
                return true
              }
              return false
            },
          }),
          EditorView.updateListener.of((update) => {
            // 逐键热路径：只打脏标记，绝不 doc.toString() / 不把全文抬进 React state。
            if (update.docChanged) changeRef.current()
            if (update.docChanged || update.selectionSet) {
              const canUndo = undoDepth(update.state) > 0
              const canRedo = redoDepth(update.state) > 0
              const prev = historyAvailRef.current
              if (canUndo !== prev.undo || canRedo !== prev.redo) {
                historyAvailRef.current = { undo: canUndo, redo: canRedo }
                historyRef.current?.(canUndo, canRedo)
              }
            }
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { overflow: 'auto', fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' },
            '&.cm-focused': { outline: 'none' },
          }),
        ],
      }),
      parent: element,
    })
    viewRef.current = view
    // 新文档的历史栈是空的：把可用性复位，别沿用上一个文件的状态。
    historyAvailRef.current = { undo: false, redo: false }
    historyRef.current?.(false, false)
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 换路径 = 新建编辑器；之后 value 再变也不回灌，编辑器自己拥有文档。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path])

  return <div className="code-editor" ref={host} />
}

export function Workshop() {
  const files = useAppStore((state) => state.workspaceFiles)
  const previewVersion = useAppStore((state) => state.previewVersion)
  const settings = useAppStore((state) => state.settings)
  const actions = useAppStore((state) => state.actions)
  /** 当前打开的对话：决定「这段对话往哪个项目写文件」，和界面显示的项目是两回事。 */
  const activeConversation = useAppStore((state) => state.conversations.find((item) => item.id === state.activeId))
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  /** content 的 ref 镜像：effect / 定时器闭包里读最新初始文档，避免闭包过期。 */
  const contentRef = useRef('')
  contentRef.current = content
  const [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState('')
  /** 沙箱 iframe 的重挂计数：刷新时 +1，强制重新加载 sandbox.html。 */
  const [previewSeq, setPreviewSeq] = useState(0)
  /** 最新预览 HTML 的 ref 版：回到前台时判断要不要重挂（state 在闭包里会过期）。 */
  const previewRef = useRef('')
  /** 代码编辑器实例：头部撤销/重做按钮直接驱动 CodeMirror 自己的 history。 */
  const editorRef = useRef<EditorView | null>(null)
  /** 撤销/重做的可用状态：只在可用性真的变化时才更新，别每次挪光标都重渲染整树。 */
  const [historyState, setHistoryState] = useState<{ undo: boolean; redo: boolean }>({ undo: false, redo: false })
  /** 外部写入（助手/恢复范例）改了选中文件时，换 key 重挂非受控编辑器吃到新文档。 */
  const [editorKey, setEditorKey] = useState(0)
  const [entry, setEntry] = useState<string | null>(null)
  const [tab, setTab] = useState<'files' | 'code' | 'preview'>('code')
  const [newOpen, setNewOpen] = useState(false)
  const [newPath, setNewPath] = useState('page.html')
  const [renameOpen, setRenameOpen] = useState(false)
  const [renamePath, setRenamePath] = useState('')
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveTarget, setMoveTarget] = useState('')
  const [projectOpen, setProjectOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [manageOpen, setManageOpen] = useState(false)
  const [manageName, setManageName] = useState('')
  /** 复制项目 / 复制文件副本各自的弹窗与输入。 */
  const [copyProjectOpen, setCopyProjectOpen] = useState(false)
  const [copyProjectName, setCopyProjectName] = useState('')
  const [copyFileOpen, setCopyFileOpen] = useState(false)
  const [copyFilePath, setCopyFilePath] = useState('')
  const saveTimer = useRef<number | undefined>(undefined)
  const dirtyRef = useRef(false)
  const selectedRef = useRef<string | null>(null)

  dirtyRef.current = dirty
  selectedRef.current = selected

  const workspaces = settings.workspaces.length > 0
    ? settings.workspaces
    : [{ id: DEFAULT_WORKSPACE, name: '默认项目', createdAt: 0, updatedAt: 0 }]
  const activeWorkspaceId = settings.activeWorkspaceId || DEFAULT_WORKSPACE
  const currentWorkspace = workspaces.find((item) => item.id === activeWorkspaceId)
  const projectOptions = workspaces.map((item) => ({ value: item.id, label: item.name }))
  const otherProjects = workspaces.filter((item) => item.id !== activeWorkspaceId)
  /** 这段对话写入的项目；没打开对话时回落到界面当前项目。 */
  const conversationWorkspaceId = activeConversation?.workspaceId ?? activeWorkspaceId

  // 进工坊时拉一次文件：新装的默认项目要靠这次刷新种上范例。
  useEffect(() => {
    void actions.refreshWorkspace()
  }, [actions])

  useEffect(() => {
    if (files.length === 0) {
      setSelected(null)
      setContent('')
      contentRef.current = ''
      return
    }
    const current = selectedRef.current
    if (current === null || !files.some((file) => file.path === current)) {
      setSelected(files[0]?.path ?? null)
      setContent(files[0]?.content ?? '')
      contentRef.current = files[0]?.content ?? ''
      setDirty(false)
      return
    }
    if (!dirtyRef.current) {
      const file = files.find((item) => item.path === current)
      if (file !== undefined && file.content !== contentRef.current) {
        contentRef.current = file.content
        setContent(file.content)
        // 外部写入改了当前文件：换 key 重挂，非受控编辑器才能吃到新文档。
        setEditorKey((key) => key + 1)
      }
    }
    // Files are replaced wholesale when the assistant writes; only sync when clean.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files])

  useEffect(() => {
    if (selected === null) return
    const file = files.find((item) => item.path === selected)
    if (file !== undefined) {
      setContent(file.content)
      contentRef.current = file.content
      setDirty(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const reloadPreview = async (): Promise<void> => {
    try {
      const result = await previewHtml(activeWorkspaceId)
      previewRef.current = result.html
      setPreview(result.html)
      setEntry(result.entry)
      // 每次都换一个 key：沙箱页被 document.write 覆盖后监听器就没了，
      // 不重挂的话「刷新」按钮会变成哑的。
      setPreviewSeq((previous) => previous + 1)
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '预览失败')
    }
  }

  useEffect(() => {
    void reloadPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewVersion])

  /*
   * 回到前台：重挂预览。
   *
   * Android 把 App 放后台久了，WebView 可能丢弃 iframe 的文档（甚至整个渲染进程），
   * 回来时预览区就是一片白 —— 用户读到的是「工坊坏了」。这里相当于自动点一次
   * 「刷新」：重新生成 HTML 并换 key 重挂 iframe，onLoad 会把内容重新 post 进去。
   */
  useEffect(() => {
    return onAppStateChange((active) => {
      if (!active) return
      if (previewRef.current !== '') void reloadPreview()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function scheduleSave(): void {
    // 逐键只打脏标记（布尔值，React 在值不变时会跳过重渲染），绝不 setContent(全文)。
    setDirty(true)
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current)
    const path = selected
    const workspaceId = activeWorkspaceId
    // 捕获此刻的编辑器实例：600ms 后可能已经切了文件，别从 viewRef 取到别人的文档。
    const view = editorRef.current
    saveTimer.current = window.setTimeout(() => {
      if (path === null) return
      // 只在落盘这一刻取一次全文，逐键路径绝不碰 doc.toString()。
      const text = view?.state.doc.toString() ?? contentRef.current
      if (text.length > MAX_FILE_CHARS) {
        // 校验前移：超限时给明确提示，别让 writeWorkspaceFile 抛错后 dirty 永远卡在 true。
        actions.showToast(`文件太大（上限 ${MAX_FILE_CHARS} 字符），请删减后再保存`)
        setDirty(false)
        return
      }
      void writeWorkspaceFile(path, text, workspaceId)
        .then(() => setDirty(false))
        .catch((error: unknown) => actions.showToast(error instanceof Error ? error.message : '保存失败'))
    }, 600)
  }

  async function flushSave(): Promise<void> {
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = undefined
    }
    if (selected !== null && dirty) {
      // 只在落盘这一刻取一次全文（编辑器自己拥有文档）。
      const content = editorRef.current?.state.doc.toString() ?? contentRef.current
      if (content.length > MAX_FILE_CHARS) {
        actions.showToast(`文件太大（上限 ${MAX_FILE_CHARS} 字符），请删减后再保存`)
        setDirty(false)
        return
      }
      await writeWorkspaceFile(selected, content, activeWorkspaceId)
      setDirty(false)
    }
  }

  async function run(): Promise<void> {
    await flushSave()
    await actions.refreshWorkspace()
    setTab('preview')
  }

  async function exportHtml(): Promise<void> {
    await flushSave()
    // flushSave 只落盘、不刷新 files，这里把选中文件换成编辑器当前全文再打包。
    const currentDoc = editorRef.current?.state.doc.toString() ?? contentRef.current
    const { html } = bundleWorkspaceHtml(files.map((file) => (file.path === selected ? { ...file, content: currentDoc } : file)))
    await saveTextFile(`deepsea-app-${entry ?? 'index'}.html`.replace('.html.html', '.html'), html, 'text/html')
    actions.showToast('已导出单文件 HTML')
  }

  async function createFile(): Promise<void> {
    const path = newPath.trim()
    if (path === '') return
    if (files.some((file) => file.path === path)) {
      actions.showToast('同名文件已存在')
      return
    }
    await writeWorkspaceFile(path, templateFor(path), activeWorkspaceId)
    await actions.refreshWorkspace()
    setSelected(path)
    setNewOpen(false)
    setNewPath('page.html')
    actions.showToast(`已新建 ${path}`)
  }

  async function removeFile(): Promise<void> {
    if (selected === null) return
    // 有还没落盘的编辑就先扔掉：删掉的文件不该被定时器再写回来。
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = undefined
    }
    setDirty(false)
    const ok = await confirmDialog({
      title: `删除 ${selected}？`,
      message: '文件会从工坊里移除，无法撤销。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await deleteWorkspaceFile(selected, activeWorkspaceId)
    await actions.refreshWorkspace()
    setSelected(null)
    setContent('')
  }

  /** 切项目：先把没保存的内容落盘，避免写进切过去的那个项目。 */
  async function switchProject(id: string): Promise<void> {
    if (id === activeWorkspaceId) return
    await flushSave()
    await actions.setActiveWorkspace(id)
    setSelected(null)
    setContent('')
    previewRef.current = ''
    setPreview('')
    setEntry(null)
  }

  function openRename(): void {
    if (selected === null) return
    setRenamePath(selected)
    setRenameOpen(true)
  }

  async function renameFile(): Promise<void> {
    if (selected === null) return
    const next = renamePath.trim()
    if (next === '' || next === selected) {
      setRenameOpen(false)
      return
    }
    try {
      // 先把没保存的编辑写到旧路径，否则改名后定时器会把旧文件又写回来。
      await flushSave()
      await actions.renameWorkspaceFile(selected, next)
      setSelected(next)
      setRenameOpen(false)
      actions.showToast(`已重命名为 ${next}`)
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '重命名失败')
    }
  }

  function openMove(): void {
    if (selected === null || otherProjects.length === 0) return
    setMoveTarget(otherProjects[0]?.id ?? '')
    setMoveOpen(true)
  }

  async function moveFile(): Promise<void> {
    if (selected === null || moveTarget === '') {
      setMoveOpen(false)
      return
    }
    try {
      // 同理：先把编辑落盘再挪，避免旧项目里被定时器写回一份。
      await flushSave()
      await actions.moveWorkspaceFile(selected, moveTarget)
      const targetName = workspaces.find((item) => item.id === moveTarget)?.name ?? '目标项目'
      setSelected(null)
      setContent('')
      setMoveOpen(false)
      actions.showToast(`已移动到「${targetName}」`)
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '移动失败')
    }
  }

  async function createProject(): Promise<void> {
    try {
      await actions.createWorkspace(projectName)
      setProjectOpen(false)
      setProjectName('')
      setSelected(null)
      setContent('')
      actions.showToast('项目已创建')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '创建失败')
    }
  }

  /** 复制整个项目：新名字 + 全部文件，原项目不动。 */
  async function duplicateProject(): Promise<void> {
    try {
      await actions.duplicateWorkspace(copyProjectName)
      setCopyProjectOpen(false)
      setCopyProjectName('')
      setSelected(null)
      setContent('')
      actions.showToast('项目已复制')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '复制失败')
    }
  }

  /** 复制文件副本：目标路径必须是 ASCII（cleanPath 只放行 ASCII）。 */
  async function copyFile(): Promise<void> {
    if (selected === null) return
    try {
      // 先把没落盘的编辑写到原路径，副本才拿得到最新内容。
      await flushSave()
      await actions.copyWorkspaceFile(selected, copyFilePath.trim())
      setCopyFileOpen(false)
      setCopyFilePath('')
      actions.showToast('文件副本已创建')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '复制失败')
    }
  }

  async function renameProject(): Promise<void> {
    try {
      await actions.renameWorkspace(activeWorkspaceId, manageName)
      setManageOpen(false)
      actions.showToast('项目已改名')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '改名失败')
    }
  }

  async function deleteProject(): Promise<void> {
    const ok = await confirmDialog({
      title: `删除项目「${currentWorkspace?.name ?? ''}」？`,
      message: '这个项目里的所有文件会一起删掉，无法撤销。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await actions.deleteWorkspace(activeWorkspaceId)
      setManageOpen(false)
      setSelected(null)
      setContent('')
      actions.showToast('项目已删除')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '删除失败')
    }
  }

  /** 把预置范例写回来；用户删掉了也找得回。 */
  async function recoverSample(): Promise<void> {
    const ok = await confirmDialog({
      title: '恢复范例？',
      message: '同名的 index.html / app.js 会被覆盖。',
      confirmText: '恢复',
    })
    if (!ok) return
    try {
      await restoreSample(activeWorkspaceId)
      await actions.refreshWorkspace()
      setSelected('index.html')
      actions.showToast('范例已恢复')
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '恢复失败')
    }
  }

  return (
    <div className="screen workshop-screen">
      <div className="screen-panel workshop-panel">
        <ScreenHeader
          title="工坊"
          subtitle={entry !== null ? `预览 ${entry}` : '深鲸可以在这里直接写文件'}
          onBack={() => actions.setScreen('home')}
          actions={
            <>
              {/* 撤销/重做：CodeMirror 自己的 history，禁用态只在可用性变化时更新 */}
              <IconButton
                label="撤销"
                disabled={!historyState.undo}
                onClick={() => {
                  const view = editorRef.current
                  if (view === null) return
                  undo(view)
                  view.focus()
                }}
              >
                <Undo2 size={18} />
              </IconButton>
              <IconButton
                label="重做"
                disabled={!historyState.redo}
                onClick={() => {
                  const view = editorRef.current
                  if (view === null) return
                  redo(view)
                  view.focus()
                }}
              >
                <Redo2 size={18} />
              </IconButton>
              <IconButton label="新建文件" onClick={() => setNewOpen(true)}><FilePlus2 size={18} /></IconButton>
              <IconButton label="运行预览" onClick={() => void run()}><Play size={18} /></IconButton>
              <IconButton label="导出 HTML" onClick={() => void exportHtml()}><Download size={18} /></IconButton>
            </>
          }
        />

        <div className="workshop-tabs">
          <button type="button" className={tab === 'files' ? 'is-active' : ''} onClick={() => setTab('files')}>文件</button>
          <button type="button" className={tab === 'code' ? 'is-active' : ''} onClick={() => setTab('code')}>代码</button>
          <button type="button" className={tab === 'preview' ? 'is-active' : ''} onClick={() => setTab('preview')}>预览</button>
        </div>

        <div className={`workshop-grid tab-${tab}`}>
          <aside className="file-pane">
            <header>
              <Select
                value={activeWorkspaceId}
                onChange={(id) => void switchProject(id)}
                options={projectOptions}
                ariaLabel="工坊项目"
                className="workspace-select"
              />
              <button type="button" className="text-button" onClick={() => setNewOpen(true)}><Plus size={14} /> 新建</button>
            </header>
            {/* 对话写入目标：切上面的项目只改界面，这段对话往哪写由这里决定。 */}
            <div className="conversation-binding">
              <span>当前对话写入：{workspaces.find((item) => item.id === conversationWorkspaceId)?.name ?? '默认项目'}</span>
              <Select
                value={conversationWorkspaceId}
                onChange={(id) => void actions.setConversationWorkspace(id)}
                options={projectOptions}
                ariaLabel="当前对话写入的项目"
              />
              <p className="settings-hint">切换上面的项目只改界面；这段对话写进哪个项目由这里决定。老对话也能在这里重新绑到别的项目。</p>
            </div>
            <div className="file-list">
              {files.length === 0 && <p className="file-empty">还没有文件</p>}
              {files.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  className={`file-row ${file.path === selected ? 'is-active' : ''}`}
                  onClick={() => setSelected(file.path)}
                >
                  <Code2 size={14} />
                  <span>{file.path}</span>
                  <em>{file.content.length}</em>
                </button>
              ))}
            </div>
            <div className="project-actions">
              <button type="button" className="text-button" onClick={() => { setProjectName(''); setProjectOpen(true) }}>
                <FolderPlus size={14} /> 新建项目
              </button>
              <button type="button" className="text-button" onClick={() => { setCopyProjectName(''); setCopyProjectOpen(true) }}>
                <Copy size={14} /> 复制项目
              </button>
              <button type="button" className="text-button" onClick={() => { setManageName(currentWorkspace?.name ?? ''); setManageOpen(true) }}>
                <Pencil size={14} /> 项目设置
              </button>
            </div>
            <button type="button" className="text-button" onClick={() => void recoverSample()}>
              <Sparkles size={14} /> 恢复范例
            </button>
            {selected !== null && (
              <div className="file-actions">
                <button type="button" className="file-action" onClick={openRename}>
                  <Pencil size={14} /> 重命名
                </button>
                <button type="button" className="file-action" onClick={() => { setCopyFilePath(''); setCopyFileOpen(true) }}>
                  <Copy size={14} /> 复制文件副本
                </button>
                {otherProjects.length > 0 && (
                  <button type="button" className="file-action" onClick={openMove}>
                    <FolderInput size={14} /> 移动到…
                  </button>
                )}
                <button type="button" className="file-delete" onClick={() => void removeFile()}>
                  <Trash2 size={14} /> 删除 {selected}
                </button>
              </div>
            )}
          </aside>

          <section className="editor-pane">
            <header>
              <span>{selected ?? '未选择文件'}</span>
              {dirty && <em>未保存</em>}
            </header>
            {selected === null ? (
              <EmptyState
                icon={<Code2 size={26} />}
                title="工坊还是空的"
                body="让深鲸写一个页面，或新建一个文件开始。"
                action={
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => {
                      actions.setDraft('帮我做一个能直接玩的小网页，写进工坊。')
                      actions.setScreen('chat')
                    }}
                  >
                    让深鲸写一个
                  </button>
                }
              />
            ) : (
              <CodeEditor
                key={`${selected}:${editorKey}`}
                path={selected}
                value={content}
                onChange={scheduleSave}
                onOversize={(message) => actions.showToast(message)}
                viewRef={editorRef}
                onHistoryChange={(canUndo, canRedo) =>
                  setHistoryState((prev) => (prev.undo === canUndo && prev.redo === canRedo ? prev : { undo: canUndo, redo: canRedo }))
                }
              />
            )}
          </section>

          <section className="preview-pane">
            <header>
              <span>预览</span>
              <button type="button" className="text-button" onClick={() => void run()}>刷新</button>
            </header>
            {preview === '' ? (
              <div className="preview-empty">运行后在这里看效果</div>
            ) : (
              <iframe
                // key 变化会整块重挂：沙箱页收到 HTML 后会 document.write 覆盖自己，
                // 里面的监听器随之消失，所以每次刷新都必须重新加载一次沙箱页。
                key={previewSeq}
                title="小应用预览"
                className="preview-frame"
                // 不给 allow-same-origin：预览是不透明源，读不到 App 的数据。
                sandbox="allow-scripts allow-forms allow-modals allow-popups"
                src={sandboxUrl()}
                onLoad={(event) => {
                  // 沙箱页自己的脚本已经跑完，这时候把 HTML 送进去最稳。
                  postSandboxHtml(event.currentTarget, preview)
                }}
              />
            )}
          </section>
        </div>
      </div>

      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="新建文件"
        footer={
          <>
            <button type="button" className="ghost-button" onClick={() => setNewOpen(false)}>取消</button>
            <button type="button" className="primary-button" onClick={() => void createFile()}>创建</button>
          </>
        }
      >
        <label className="field">
          <span>路径</span>
          <input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="page.html" />
        </label>
        <p className="settings-hint">支持 .html / .css / .js / .md；页面入口用 index.html。</p>
      </Modal>

      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="重命名文件"
        footer={(
          <>
            <button type="button" className="ghost-button" onClick={() => setRenameOpen(false)}>取消</button>
            <button type="button" className="primary-button" onClick={() => void renameFile()}>保存</button>
          </>
        )}
      >
        <label className="field">
          <span>新路径</span>
          <input
            value={renamePath}
            onChange={(event) => setRenamePath(event.target.value)}
            placeholder="index.html"
            autoFocus
          />
        </label>
        <p className="settings-hint">改的是文件在项目里的路径；同名文件已存在时会拒绝，不会覆盖。</p>
      </Modal>

      <Modal
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        title="移动到项目"
        footer={(
          <>
            <button type="button" className="ghost-button" onClick={() => setMoveOpen(false)}>取消</button>
            <button type="button" className="primary-button" onClick={() => void moveFile()}>移动</button>
          </>
        )}
      >
        <label className="field">
          <span>目标项目</span>
          <Select
            value={moveTarget}
            onChange={setMoveTarget}
            options={otherProjects.map((item) => ({ value: item.id, label: item.name }))}
            ariaLabel="目标项目"
          />
        </label>
        <p className="settings-hint">移动后，原项目里这份文件会被移除；目标项目已有同名文件时会拒绝。</p>
      </Modal>

      <Modal
        open={projectOpen}
        onClose={() => setProjectOpen(false)}
        title="新建项目"
        footer={(
          <>
            <button type="button" className="ghost-button" onClick={() => setProjectOpen(false)}>取消</button>
            <button type="button" className="primary-button" onClick={() => void createProject()}>创建</button>
          </>
        )}
      >
        <label className="field">
          <span>项目名</span>
          <input
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            placeholder="例如：个人主页"
            autoFocus
          />
        </label>
        <p className="settings-hint">不同项目的文件互相隔离；对话会写进它所属的项目。</p>
      </Modal>

      <Modal
        open={copyProjectOpen}
        onClose={() => setCopyProjectOpen(false)}
        title="复制项目"
        footer={(
          <>
            <button type="button" className="ghost-button" onClick={() => setCopyProjectOpen(false)}>取消</button>
            <button type="button" className="primary-button" onClick={() => void duplicateProject()}>复制</button>
          </>
        )}
      >
        <label className="field">
          <span>新项目名</span>
          <input
            value={copyProjectName}
            onChange={(event) => setCopyProjectName(event.target.value)}
            placeholder="例如：首页备份"
            autoFocus
          />
        </label>
        <p className="settings-hint">会把当前项目的全部文件复制一份到新项目，原项目保持不变。</p>
      </Modal>

      <Modal
        open={copyFileOpen}
        onClose={() => setCopyFileOpen(false)}
        title="复制文件副本"
        footer={(
          <>
            <button type="button" className="ghost-button" onClick={() => setCopyFileOpen(false)}>取消</button>
            <button type="button" className="primary-button" onClick={() => void copyFile()}>复制</button>
          </>
        )}
      >
        <label className="field">
          <span>副本路径</span>
          <input
            value={copyFilePath}
            onChange={(event) => setCopyFilePath(event.target.value)}
            placeholder="index.copy.html"
            autoFocus
          />
        </label>
        <p className="settings-hint">路径只能用英文/数字/点/横线/下划线；原文件会保留，同名副本会被拒绝。</p>
      </Modal>

      <Modal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        title="项目设置"
        footer={(
          <>
            <button type="button" className="ghost-button" onClick={() => setManageOpen(false)}>关闭</button>
            <button type="button" className="primary-button" onClick={() => void renameProject()}>保存名字</button>
          </>
        )}
      >
        <label className="field">
          <span>项目名</span>
          <input
            value={manageName}
            onChange={(event) => setManageName(event.target.value)}
            placeholder="项目名"
            autoFocus
          />
        </label>
        <p className="settings-hint">删除项目会把它里面的文件一起删掉，无法撤销。</p>
        <button
          type="button"
          className="file-delete"
          onClick={() => void deleteProject()}
          disabled={workspaces.length <= 1}
        >
          <Trash2 size={14} /> 删除这个项目
        </button>
        {workspaces.length <= 1 && <p className="settings-hint">至少要保留一个项目。</p>}
      </Modal>
    </div>
  )
}
