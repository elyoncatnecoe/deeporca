import { useEffect, useState } from 'react'
import { Modal, Select } from './ui'
import { useAppStore } from '../lib/store'
import { readWorkspaceFile, writeWorkspaceFile } from '../lib/workspace'
import { DEFAULT_WORKSPACE } from '../lib/types'
import { snippetExtension, suggestSnippetPath } from '../lib/snippet-path'
import { confirmDialog } from './ConfirmDialog'

/** 从聊天里带过来的一段代码：内容 + 语言标记。 */
export type SnippetDraft = { code: string; lang: string }

/**
 * 「把这段代码存进工坊」的确认面板。
 *
 * 以前点一下就直接写一个 snippet-<时间戳>.js，不问名字也不问项目，工坊很快就
 * 堆满认不出是什么的文件。现在先让用户确认文件名和目标项目，同名先问覆盖。
 */
export function SaveToWorkshopDialog(props: { draft: SnippetDraft | null; onClose: () => void }) {
  const settings = useAppStore((state) => state.settings)
  const files = useAppStore((state) => state.workspaceFiles)
  const actions = useAppStore((state) => state.actions)
  const [path, setPath] = useState('')
  const [workspaceId, setWorkspaceId] = useState(DEFAULT_WORKSPACE)
  const [busy, setBusy] = useState(false)

  // 每次打开都按「当前项目 + 这段代码的语言」重新预填。
  useEffect(() => {
    if (props.draft === null) return
    const ext = snippetExtension(props.draft.lang)
    setPath(suggestSnippetPath(ext, files.map((file) => file.path)))
    setWorkspaceId(settings.activeWorkspaceId || DEFAULT_WORKSPACE)
    setBusy(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.draft])

  const workspaces = settings.workspaces.length > 0
    ? settings.workspaces
    : [{ id: DEFAULT_WORKSPACE, name: '默认项目', createdAt: 0, updatedAt: 0 }]
  const target = workspaces.find((item) => item.id === workspaceId)
  const options = workspaces.map((item) => ({ value: item.id, label: item.name }))

  const save = async (): Promise<void> => {
    if (props.draft === null || busy) return
    const name = path.trim()
    if (name === '') {
      actions.showToast('文件名不能为空')
      return
    }
    setBusy(true)
    try {
      const existing = await readWorkspaceFile(name, workspaceId)
      if (existing !== undefined) {
        const ok = await confirmDialog({
          title: `覆盖 ${name}？`,
          message: `「${target?.name ?? '这个项目'}」里已经有同名文件，内容会被替换。`,
          confirmText: '覆盖',
          danger: true,
        })
        if (!ok) {
          setBusy(false)
          return
        }
      }
      await writeWorkspaceFile(name, props.draft.code, workspaceId)
      await actions.refreshWorkspace()
      const where = workspaceId === (settings.activeWorkspaceId || DEFAULT_WORKSPACE)
        ? ''
        : `（${target?.name ?? '另一个项目'}）`
      actions.showToast(`已存入 ${name}${where}`)
      props.onClose()
    } catch (error) {
      actions.showToast(error instanceof Error ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={props.draft !== null}
      onClose={() => { if (!busy) props.onClose() }}
      title="存入工坊"
      footer={(
        <>
          <button type="button" className="ghost-button" onClick={props.onClose} disabled={busy}>取消</button>
          <button type="button" className="primary-button" onClick={() => void save()} disabled={busy}>
            {busy ? '正在保存…' : '存入'}
          </button>
        </>
      )}
    >
      <label className="field">
        <span>文件名</span>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="snippet.html"
          autoFocus
        />
      </label>
      <label className="field">
        <span>存到项目</span>
        <Select value={workspaceId} onChange={setWorkspaceId} options={options} ariaLabel="存到项目" />
      </label>
      <p className="settings-hint">支持 .html / .css / .js / .md；同名文件会先问你。</p>
    </Modal>
  )
}
