/** Cheap, conservative token estimate for mixed Chinese/English text. */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code > 0x2e80) tokens += 0.72
    else if (/\s/.test(char)) tokens += 0.1
    else tokens += 0.26
  }
  return Math.ceil(tokens)
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k`
}
