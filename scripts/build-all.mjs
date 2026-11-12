import { execSync } from 'node:child_process'

function run(command) {
  console.log(`\n$ ${command}`)
  execSync(command, { stdio: 'inherit' })
}

run('node scripts/build-exe.mjs')
run('node scripts/build-android.mjs')
console.log('\nBoth artifacts are in dist-app/ and dist-apk/.')
