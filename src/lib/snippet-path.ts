/**
 * 「把代码块存进工坊」用的纯函数：语言 → 扩展名、预填不撞名的文件名。
 *
 * 单独放在 lib 里是为了能在 node 里直接测（组件是 .tsx，Node 跑不了）。
 */

/** 代码块语言 → 文件扩展名。认不出来的就存 .txt，至少不会错。 */
export function snippetExtension(lang: string): string {
  const value = lang.toLowerCase()
  if (value === 'html' || value === 'xml') return 'html'
  if (value === 'css') return 'css'
  if (value === 'js' || value === 'javascript' || value === 'ts' || value === 'typescript') return 'js'
  if (value === 'json') return 'json'
  if (value === 'md' || value === 'markdown') return 'md'
  if (value === 'py' || value === 'python') return 'py'
  return 'txt'
}

/**
 * 预填一个当前项目里不撞名的文件名：snippet.html / snippet-2.html …
 *
 * 撞名时不静默覆盖，也不加时间戳（那样又回到「认不出是什么」的老问题），
 * 而是顺延编号，用户看着也明白。
 */
export function suggestSnippetPath(ext: string, taken: readonly string[]): string {
  for (let index = 1; index < 200; index += 1) {
    const name = index === 1 ? `snippet.${ext}` : `snippet-${index}.${ext}`
    if (!taken.includes(name)) return name
  }
  return `snippet-${Date.now().toString(36)}.${ext}`
}
