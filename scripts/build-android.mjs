import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const debug = process.argv.includes('--debug')

// 版本号单一来源：package.json。Android 侧用 gradle -P 传进去，
// 免得 versionName/versionCode 和 APK 文件名三处各写一份、迟早漂移。
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(pkg.version ?? '0.0.0')
const [vMajor = 0, vMinor = 0, vPatch = 0] = version.split('.').map((n) => Number.parseInt(n, 10) || 0)
const versionCode = vMajor * 10000 + vMinor * 100 + vPatch

// 默认用仓库内的 .toolchain；也可用 JAVA_HOME / ANDROID_HOME 指向自己的安装。
const jdk = process.env.JAVA_HOME || join(root, '.toolchain', 'jdk21')
const sdk = process.env.ANDROID_HOME || join(root, '.toolchain', 'android-sdk')
const env = { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }
delete env.ELECTRON_RUN_AS_NODE

if (!existsSync(join(jdk, 'bin', 'java.exe'))) {
  console.error(`JDK not found at ${jdk}. Set JAVA_HOME or install the toolchain.`)
  process.exit(1)
}
if (!existsSync(join(sdk, 'platforms', 'android-35'))) {
  console.error(`Android SDK 35 not found at ${sdk}. Set ANDROID_HOME or install the platform.`)
  process.exit(1)
}

function run(command, cwd = root) {
  console.log(`\n$ ${command}`)
  execSync(command, { stdio: 'inherit', cwd, env })
}

// 网页账号的中继脚本要从 src/lib/web-relay.ts 生成 Java 常量，必须先跑。
run('node scripts/build-relay-java.mjs')
run('npx vite build')
// 老 Android WebView 是 ES 兼容问题最致命的端（白屏且构建期不报错），必须过检查。
run('node scripts/check-es-compat.mjs')
run('npx cap sync android')
run(`gradlew.bat ${debug ? 'assembleDebug' : 'assembleRelease'} --no-daemon --console=plain -PappVersionName=${version} -PappVersionCode=${versionCode}`, join(root, 'android'))

const folder = debug ? 'debug' : 'release'
const apkDir = join(root, 'android', 'app', 'build', 'outputs', 'apk', folder)
if (!existsSync(apkDir)) {
  console.error(`APK output missing: ${apkDir}`)
  process.exit(1)
}
const apk = readdirSync(apkDir).find((name) => name.endsWith('.apk'))
if (apk === undefined) {
  console.error(`No APK in ${apkDir}`)
  process.exit(1)
}
mkdirSync(join(root, 'dist-apk'), { recursive: true })
const target = join(root, 'dist-apk', debug ? 'DeepSea-debug.apk' : `DeepSea-${version}.apk`)
copyFileSync(join(apkDir, apk), target)
console.log(`\nAPK: ${target}`)
