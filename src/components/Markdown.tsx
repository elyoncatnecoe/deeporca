import { useEffect, useMemo, useRef } from 'react'
import hljs from 'highlight.js/lib/common'
import { decodeCode, renderMarkdown } from '../lib/markdown'
import { useAppStore } from '../lib/store'

export function Markdown(props: {
  text: string
  onRun?: (code: string, lang: string) => void
  onSave?: (code: string, lang: string) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const html = useMemo(() => renderMarkdown(props.text), [props.text])

  useEffect(() => {
    const root = ref.current
    if (root === null) return
    const blocks = root.querySelectorAll<HTMLElement>('pre code')
    for (const block of blocks) {
      if (block.dataset.highlighted === 'yes') continue
      try {
        hljs.highlightElement(block)
        block.dataset.highlighted = 'yes'
      } catch {
        /* unknown language: leave plain text */
      }
    }
  }, [html])

  const copy = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      useAppStore.getState().actions.showToast('已复制')
    } catch {
      const area = document.createElement('textarea')
      area.value = code
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
      useAppStore.getState().actions.showToast('已复制')
    }
  }

  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const button = target.closest<HTMLButtonElement>('[data-code-action]')
    if (button === null) return
    event.preventDefault()
    const code = decodeCode(button.dataset.code ?? '')
    const lang = button.dataset.lang ?? 'text'
    const action = button.dataset.codeAction
    if (action === 'copy') void copy(code)
    else if (action === 'run') props.onRun?.(code, lang)
    else if (action === 'save') props.onSave?.(code, lang)
  }

  if (props.text.trim() === '') return null
  return <div ref={ref} className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
