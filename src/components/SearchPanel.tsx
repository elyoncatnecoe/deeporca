import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { searchMessages, type SearchDoc } from '../lib/db'
import { snippetAround } from '../lib/search'
import { IconButton } from './ui'

/**
 * 会话内全文搜索面板。
 * IndexedDB 没有 FTS5，走的是自建的倒排索引（见 lib/search.ts）。
 * 点结果直接跳到那条消息；跳完保留面板，方便连着看几处。
 */
export function SearchPanel(props: {
  conversationId: string | null
  onClose: () => void
  onJump: (messageId: string) => void
}) {
  const { conversationId, onClose, onJump } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchDoc[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 输入防抖：每 200ms 才查一次，避免每敲一个字打一次索引。
  useEffect(() => {
    if (conversationId === null || query.trim() === '') {
      setResults([])
      return
    }
    let alive = true
    setBusy(true)
    const timer = window.setTimeout(() => {
      void searchMessages(conversationId, query, 50)
        .then((hits) => {
          if (alive) setResults(hits)
        })
        .catch((error) => console.warn('[search] failed', error))
        .finally(() => {
          if (alive) setBusy(false)
        })
    }, 200)
    return () => {
      alive = false
      window.clearTimeout(timer)
      window.clearTimeout(timer)
    }
  }, [conversationId, query])

  return (
    <div className="search-panel">
      <div className="search-head">
        <Search size={15} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="搜索这段对话…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'Enter' && results.length > 0) {
              const first = results[0]
              if (first !== undefined) onJump(first.id)
            }
          }}
        />
        {busy && <span className="search-busy">查…</span>}
        <IconButton label="关闭搜索" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </div>

      {query.trim() !== '' && results.length === 0 && !busy && (
        <p className="search-empty">没找到。换个词试试？</p>
      )}

      {results.length > 0 && (
        <ul className="search-list">
          {results.map((doc) => (
            <li key={doc.id}>
              <button type="button" className="search-hit" onClick={() => onJump(doc.id)}>
                <span className="search-hit-role">{doc.role === 'user' ? '你' : '助手'}</span>
                <span className="search-hit-text">{snippetAround(doc.text, query)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}