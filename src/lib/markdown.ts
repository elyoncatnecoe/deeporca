import DOMPurify from 'dompurify'
import { Marked, Renderer } from 'marked'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const renderer = new Renderer()
renderer.code = ({ text, lang }) => {
  const language = (lang ?? '').trim().split(/\s+/)[0] ?? ''
  const safeLanguage = language === '' ? 'text' : language.replace(/[^a-zA-Z0-9_+-]/g, '')
  const encoded = encodeURIComponent(text)
  const runnable = safeLanguage === 'js' || safeLanguage === 'javascript' || safeLanguage === 'html'
  return [
    '<div class="code-card">',
    '<div class="code-head">',
    `<span class="code-lang">${escapeHtml(safeLanguage)}</span>`,
    '<span class="code-actions">',
    `<button type="button" data-code-action="copy" data-code="${encoded}">复制</button>`,
    runnable ? `<button type="button" data-code-action="run" data-code="${encoded}" data-lang="${safeLanguage}">运行</button>` : '',
    `<button type="button" data-code-action="save" data-code="${encoded}" data-lang="${safeLanguage}">存入工坊</button>`,
    '</span>',
    '</div>',
    `<pre><code class="hljs language-${safeLanguage}">${escapeHtml(text)}</code></pre>`,
    '</div>',
  ].join('')
}

const marked = new Marked({ gfm: true, breaks: true })
marked.use({ renderer })

/** Render assistant Markdown to sanitized HTML with code action buttons. */
export function renderMarkdown(text: string): string {
  if (text.trim() === '') return ''
  try {
    const html = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(html, {
      ADD_ATTR: ['data-code', 'data-code-action', 'data-lang', 'target', 'rel'],
      ADD_TAGS: ['button'],
    })
  } catch {
    return `<p>${escapeHtml(text)}</p>`
  }
}

export function decodeCode(encoded: string): string {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}
