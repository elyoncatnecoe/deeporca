import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

function run(command) {
  console.log(`\n$ ${command}`)
  execSync(command, { stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
}

run('node scripts/patch-electron-builder.mjs')
run('npx vite build')
// 必须跑 ES 兼容检查：老 Android WebView / 旧内核缺 ES2022+ 内置方法会直接白屏，
// 而且是构建期不报错的静默失败。开发机上过一遍，别让发布脚本绕过它。
run('node scripts/check-es-compat.mjs')
run('node scripts/build-electron.mjs')
run('npx electron-builder --win nsis --x64')

if (!existsSync('dist-app')) {
  console.error('electron-builder produced no dist-app directory')
  process.exit(1)
}
console.log('\nEXE build finished. Look in dist-app/.')
