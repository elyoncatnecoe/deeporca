import { build } from 'esbuild'

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
}

await build({
  ...shared,
  entryPoints: ['electron/main.ts'],
  outfile: 'electron-dist/main.cjs',
})

await build({
  ...shared,
  entryPoints: ['electron/preload.ts'],
  outfile: 'electron-dist/preload.cjs',
})

// PoW 解算的 worker：必须单独成一个文件，主进程用 Worker 去加载它。
// 打进 main.cjs 里是没用的——worker 需要能被 new Worker(path) 直接打开。
await build({
  ...shared,
  entryPoints: ['electron/pow-worker.ts'],
  outfile: 'electron-dist/pow-worker.cjs',
})

console.log('electron main + preload + pow worker built')
