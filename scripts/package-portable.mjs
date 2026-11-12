import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const unpacked = join(root, 'dist-app', 'win-unpacked')
const zip = join(root, 'dist-app', 'DeepSea-0.1.0-win64.zip')

if (!existsSync(join(unpacked, '深鲸.exe'))) {
  console.error('win-unpacked/深鲸.exe is missing; run the EXE build first')
  process.exit(1)
}
mkdirSync(join(root, 'dist-app'), { recursive: true })
console.log(`zipping ${unpacked} -> ${zip}`)
execFileSync('powershell.exe', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${join(unpacked, '*')}' -DestinationPath '${zip}' -Force`,
], { stdio: 'inherit' })
console.log(`portable zip: ${zip}`)
