import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * electron-builder 26.15.3 assumes @electron/get exposes
 * ElectronDownloadCacheMode, but its dependency range resolves 3.0.0, which
 * does not. NSIS/portable targets then throw while resolving the cache mode.
 * Replace every enum read with 0 (read/write) in the installed copies.
 */
const root = process.cwd()
const candidates = [join(root, 'node_modules', 'app-builder-lib', 'out', 'util', 'electronGet.js')]
const pnpm = join(root, 'node_modules', '.pnpm')
if (existsSync(pnpm)) {
  for (const entry of readdirSync(pnpm)) {
    if (!entry.startsWith('app-builder-lib@')) continue
    candidates.push(join(pnpm, entry, 'node_modules', 'app-builder-lib', 'out', 'util', 'electronGet.js'))
  }
}

let patched = 0
for (const file of candidates) {
  if (!existsSync(file)) continue
  const source = readFileSync(file, 'utf8')
  if (source.includes('deepsea-patched')) continue
  const next = source
    .replace(/get_1\.ElectronDownloadCacheMode\.\w+/g, '0')
    .replace('function resolveCacheMode() {', '/* deepsea-patched */\nfunction resolveCacheMode() {')
  if (next !== source) {
    writeFileSync(file, next)
    patched += 1
    console.log(`patched ${file}`)
  }
}
console.log(`electron-builder patch: ${patched} file(s)`)
