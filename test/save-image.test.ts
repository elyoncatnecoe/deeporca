import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { base64ToBytes, splitDataUrl, photoFileName } from '../src/lib/photo-store.ts'

/**
 * 回归测试 C1 / C2 / C3：拍照之后能点开、能存出去。
 *
 * base64 抽取那部分是**真断言**（photo-store 是纯模块）；剩下的是接线，
 * 全部按源码文本核对（沿用 workshop-projects.test.ts 的写法）—— 因为
 * platform.ts 引 Capacitor、PhotoViewer 引 React/Canvas，在 node 里跑不起来。
 * 这些断言刻意写成「结构 / 顺序」而不是整段字符串，改动一点点不至于全红。
 */

const PLATFORM = readFileSync('src/lib/platform.ts', 'utf8')
const VIEWER = readFileSync('src/components/room/PhotoViewer.tsx', 'utf8')
const ALBUM = readFileSync('src/components/room/PhotoAlbum.tsx', 'utf8')
const ROOM = readFileSync('src/components/room/RoomScreen.tsx', 'utf8')
const PANELS = readFileSync('src/components/room/panels.tsx', 'utf8')
const MAIN = readFileSync('electron/main.ts', 'utf8')
const PRELOAD = readFileSync('electron/preload.ts', 'utf8')
const GLOBALS = readFileSync('src/lib/global.d.ts', 'utf8')
const STYLES = readFileSync('src/styles.css', 'utf8')
const JAVA = readFileSync('android/app/src/main/java/com/elyoncat/deepsea/DeepSeaGalleryPlugin.java', 'utf8')
const ACTIVITY = readFileSync('android/app/src/main/java/com/elyoncat/deepsea/MainActivity.java', 'utf8')
const MANIFEST = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8')
const SAVE_IMAGE = PLATFORM.slice(PLATFORM.indexOf('export async function saveImage'))
const ELECTRON_SAVE_IMAGE = MAIN.slice(MAIN.indexOf("trustedHandle('file:saveImage'"), MAIN.indexOf("trustedHandle('file:open'"))

/* ---------------------------------------------------- base64 抽取（真断言） */

test('抽出来的是纯 base64 + mime + 扩展名', () => {
  const parts = splitDataUrl('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQAAAA')
  assert.equal(parts?.mime, 'image/jpeg')
  assert.equal(parts?.ext, 'jpg')
  assert.ok(parts && !parts.base64.startsWith('data:'), 'base64 里不能还留着前缀')
  assert.equal(parts?.base64, '/9j/4AAQSkZJRgABAQAAAQAAAA')
})

test('解出来的字节就是原图的头（FFD8 起、FFD9 止）', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('deepsea'), Buffer.from([0xff, 0xd9])]).toString('base64')
  const bytes = base64ToBytes(splitDataUrl('data:image/jpeg;base64,' + jpeg)!.base64)
  assert.equal(bytes[0], 0xff)
  assert.equal(bytes[1], 0xd8)
  assert.equal(bytes[bytes.length - 1], 0xd9)
  assert.equal(bytes.length, 4 + 7 + 2, '长度不对就是把高位字节打散了')
})

test('文件名用照片自己的时间，扩展名跟 mime 走', () => {
  const name = photoFileName({ id: 'a', timestamp: new Date(2026, 10, 3, 14, 5, 0).getTime() }, splitDataUrl('data:image/png;base64,AA')!.ext)
  assert.equal(name, '深鲸-20261103-140500.png')
})

/* ------------------------------------------------- C3：三端保存的接线与顺序 */

test('Android：先走原生相册，失败才退到缓存 + 分享（顺序不能反）', () => {
  assert.ok(PLATFORM.includes("registerPlugin<GalleryPlugin>('DeepSeaGallery')"), '没注册原生相册插件')
  const galleryAt = SAVE_IMAGE.indexOf('Gallery.saveImage')
  const shareAt = SAVE_IMAGE.indexOf('shareImageFile(')
  assert.ok(galleryAt > 0, 'saveImage 里没调原生相册')
  assert.ok(shareAt > galleryAt, '分享兜底排在了原生保存前面，等于永远不进相册')
  // 兜底那条：缓存目录 + 不传 encoding（缺省就是按 base64 解）+ Share 吃 file: URI
  const fallback = PLATFORM.slice(PLATFORM.indexOf('async function shareImageFile'))
  assert.ok(fallback.includes('Directory.Cache'), '兜底没写进缓存目录（FileProvider 覆盖不到就分享不出去）')
  assert.ok(!fallback.includes('Encoding.UTF8'), '图片分支带了 Encoding.UTF8：会把 base64 当文本写出去')
  assert.ok(fallback.includes('Share.share') && fallback.includes('result.uri'), '没把落盘得到的 file: URI 交给分享面板')
})

test('Electron：走新的二进制 IPC，不碰 utf8 那条 file:save', () => {
  assert.ok(SAVE_IMAGE.includes('native.saveImageFile'), '没走二进制 IPC')
  assert.ok(SAVE_IMAGE.includes('parts.base64'), '递给 IPC 的该是剥了前缀的 base64')
  assert.ok(ELECTRON_SAVE_IMAGE.includes("Buffer.from(base64, 'base64')"), '主进程没把 base64 还原成字节')
  assert.ok(!ELECTRON_SAVE_IMAGE.includes("writeFileSync(result.filePath, base64, 'utf8')"), '还在用 utf8 写图片')
  assert.ok(PRELOAD.includes("ipcRenderer.invoke('file:saveImage'"), 'preload 没暴露这条通道')
  assert.ok(GLOBALS.includes('saveImageFile'), 'global.d.ts 没声明这条桥（平台侧就调不到）')
})

test('浏览器：解码成字节再包 Blob，不是文本 blob', () => {
  const download = PLATFORM.slice(PLATFORM.indexOf('function downloadImage'))
  assert.ok(download.includes('base64ToBytes'), '没解码')
  assert.ok(download.includes('new Blob(') && download.includes('type: mime'), 'Blob 没带 mime')
  assert.ok(download.includes('revokeObjectURL'), 'blob URL 没回收')
})

test('结果四种都要有，界面才有话可说', () => {
  for (const kind of ['gallery', 'shared', 'downloaded', 'failed']) {
    assert.ok(SAVE_IMAGE.includes(`'${kind}'`), 'saveImage 少一种结果：' + kind)
  }
  // 查看器把 gallery / shared / downloaded 分别配了文案，剩下的（failed）走兜底那句：
  // 不能有一句结果落到「什么都不说」，那正是这次的病根。
  assert.ok(VIEWER.includes("'gallery'") && VIEWER.includes("'shared'") && VIEWER.includes("'downloaded'"), '查看器没给每种结果配文案')
  assert.ok(VIEWER.includes('保存失败'), '查看器没有失败兜底的那句话')
})

/* ----------------------------------------------------------- C1：能点开、能存 */

test('相册网格用缩略图，条目是真按钮，点开查看器', () => {
  const grid = ALBUM.slice(ALBUM.indexOf('album-grid'), ALBUM.indexOf('</figure>'))
  assert.ok(grid.includes('photo.thumbURL'), '网格还在用全尺寸 dataURL（8 张几 MB 的 base64 进 DOM）')
  assert.ok(grid.includes('<button type="button" className="album-open"'), '缩略图不是真按钮，点不开')
  assert.ok(grid.includes('props.onOpen(index)'), '按钮没把下标传给查看器')
  // 按钮不能套按钮：内层会被浏览器抹掉（HTML 规范如此），所以「删除」必须在 figcaption 里。
  const open = grid.slice(grid.indexOf('className="album-open"'), grid.indexOf('</button>'))
  assert.ok(!open.includes('<button'), 'album-open 里面又套了一个 button')
  assert.ok(ALBUM.slice(ALBUM.indexOf('</button>')).includes('album-del'), '删除按钮跑到了缩略图按钮之前')
})

test('查看器：翻页 / 保存 / 分享 / 删除 / 保存中 / toast 都在', () => {
  assert.ok(VIEWER.includes('createPortal'), '没 portal 到 .app，会被带 backdrop-filter 的祖先裁掉')
  assert.ok(VIEWER.includes("document.querySelector('.app')"), 'portal 目标不是 .app')
  assert.ok(VIEWER.includes('data-deepsea-ui'), '没标 data-deepsea-ui：在查看器里按空格会又拍一张')
  for (const key of ['Escape', 'ArrowLeft', 'ArrowRight']) {
    assert.ok(VIEWER.includes(`'${key}'`), '键盘少了 ' + key)
  }
  for (const label of ['保存到相册', '分享', '删除']) {
    assert.ok(VIEWER.includes(label), '查看器少了按钮：' + label)
  }
  assert.ok(VIEWER.includes('photo-viewer__spin'), '保存中没有转圈')
  assert.ok(VIEWER.includes('actions.showToast'), '结果没走宿主 toast')
  assert.ok(VIEWER.includes('saveImage(') && VIEWER.includes('shareImage('), '没接平台侧的保存/分享')
})

test('查看器压在相册弹窗之上、toast 之下', () => {
  const viewer = STYLES.slice(STYLES.indexOf('.photo-viewer {'))
  const z = /z-index:\s*(\d+)/.exec(viewer)
  assert.ok(z !== null, '.photo-viewer 没写 z-index')
  const value = Number(z?.[1])
  assert.ok(value > 100, '必须高于 .modal-backdrop(100)，否则从相册点开会被盖住')
  assert.ok(value < 200, '必须低于 .toast(200)，否则「已保存到相册」那条结果看不见')
})

test('布置屏：点最近几张直接开查看器；存不下了要说出来', () => {
  assert.ok(PANELS.includes('onView(recentOffset + i)'), '缩略图没带下标开查看器')
  assert.ok(PANELS.includes('photos.slice(recentOffset)'), '「最近几张」还在取最老的那几张')
  assert.ok(PANELS.includes('room-warn'), '照片存不下了，拍照面板上没有提示')
  assert.ok(ROOM.includes('PhotoViewer'), '布置屏没接查看器')
  assert.ok(ROOM.includes('useState<number | null>(null)'), '没有查看器下标状态')
  assert.ok(ROOM.includes('photosError !== null'), '落盘失败没转成提示')
  assert.ok(ROOM.includes('setViewerIndex(null)'), '删完最后一张没关掉查看器')
})

/* ------------------------------------------------------ C2：原生相册插件 */

test('原生插件：29+ 走 MediaStore 插入，失败回滚', () => {
  assert.ok(JAVA.includes('@CapacitorPlugin(name = "DeepSeaGallery"') || JAVA.includes('name = "DeepSeaGallery"'), '插件名不对，JS 侧 registerPlugin 会找不到')
  assert.ok(JAVA.includes('Build.VERSION_CODES.Q'), '没分版本')
  assert.ok(JAVA.includes('MediaStore.Images.Media.EXTERNAL_CONTENT_URI'), '没走 MediaStore 插入')
  assert.ok(JAVA.includes('MediaStore.Images.Media.RELATIVE_PATH'), '没写 RELATIVE_PATH（相册目录）')
  assert.ok(JAVA.includes('Environment.DIRECTORY_PICTURES'), 'RELATIVE_PATH 不是 Pictures 下')
  assert.ok(JAVA.includes('openOutputStream'), '没通过 OutputStream 写')
  assert.ok(/resolver\.delete\(uri\)/.test(JAVA), '写失败没回滚：相册里会留一张打不开的 0 字节照片')
})

test('原生插件：23-28 才申请权限，拒绝要给一句明确的话', () => {
  assert.ok(JAVA.includes('@Permission'), '没声明权限别名，requestPermissionForAlias 找不到目标')
  assert.ok(JAVA.includes('WRITE_EXTERNAL_STORAGE'), '没申请 WRITE_EXTERNAL_STORAGE')
  assert.ok(JAVA.includes('requestPermissionForAlias'), '没走 Capacitor 的运行时申请')
  assert.ok(JAVA.includes('@PermissionCallback'), '没有授权结果回调')
  assert.ok(JAVA.includes('MediaScannerConnection.scanFile'), '写完没通知系统，图库里看不到这张')
  assert.ok(/call\.reject\("没有存储权限/.test(JAVA), '被拒绝时 reject 的文案不够明确，JS 侧没法退到分享')
})

test('注册与清单：插件挂上 MainActivity，权限只到 API 28', () => {
  assert.ok(ACTIVITY.includes('registerPlugin(DeepSeaGalleryPlugin.class)'), 'MainActivity 没注册插件')
  assert.ok(MANIFEST.includes('android.permission.WRITE_EXTERNAL_STORAGE'), '清单没声明存储权限')
  assert.ok(MANIFEST.includes('maxSdkVersion="28"'), 'maxSdkVersion=28 没写：29+ 会白要一次权限')
  assert.ok(!MANIFEST.includes('android:name="android.permission.READ_MEDIA_IMAGES"'), '不需要读相册，别多要权限')
})
