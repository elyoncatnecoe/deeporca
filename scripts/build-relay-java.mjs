import { readFileSync, writeFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const SOURCE = 'src/lib/web-relay.ts'
const TARGET = 'android/app/src/main/java/com/elyoncat/deepsea/RelayScript.java'

const text = readFileSync(SOURCE, 'utf8')
const start = text.indexOf('function relayBootstrap(): void {')
const braceStart = text.indexOf('{', start)
let depth = 0
let end = -1
for (let i = braceStart; i < text.length; i += 1) {
  const ch = text[i]
  if (ch === '{') depth += 1
  else if (ch === '}') {
    depth -= 1
    if (depth === 0) { end = i + 1; break }
  }
}
const body = text.slice(start, end)
const js = transformSync(body, { loader: 'ts', target: 'es2019', format: 'esm', minify: false })
  .code.trim()
  .replace(/^export\s+/gm, '')
const source = ';(function(){' + js + ';relayBootstrap();})();'
try { new Function(source) } catch (e) { throw new Error('bad syntax: ' + e.message) }

const escaped = source.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')
const lines = [
  'package com.elyoncat.deepsea;',
  '',
  '/**',
  ' * \u4e2d\u7ee7\u811a\u672c\u7684 Java \u526f\u672c \u2014\u2014 \u7531 scripts/build-relay-java.mjs \u4ece',
  ' * src/lib/web-relay.ts \u751f\u6210\uff0c\u4e0d\u8981\u624b\u6539\u3002',
  ' */',
  'final class RelayScript {',
  '    static final String SOURCE = "' + escaped + '";',
  '',
  '    private RelayScript() {}',
  '}',
  '',
]
writeFileSync(TARGET, lines.join('\n'), 'utf8')
console.log('ok', lines.join('\n').length)
