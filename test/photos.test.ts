import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_PHOTOS,
  PHOTO_META_KEY,
  PHOTO_STORAGE_KEY,
  base64ToBytes,
  getPhotosStoreSnapshot,
  hydratePhotos,
  isStorageQuotaError,
  onPhotosStoreChange,
  parseLegacyPhotoRecords,
  parsePhotoMetas,
  persistAlbum,
  photoBytesIndex,
  photoBytesOf,
  photoFileName,
  photoMetaOf,
  photoMetasOf,
  readAlbum,
  readAlbumMeta,
  resetPhotosStore,
  splitDataUrl,
  stalePhotoIds,
  withPhotoBytes,
  type PhotoBytes,
  type PhotoDeps,
} from '../src/lib/photo-store.ts'
import type { PhotoRecord } from '../src/orca/photo.ts'

/**
 * 回归测试 C4 / C6：拍完照，照片到底存到哪去了。
 *
 * 原来的写法是 localStorage 塞全尺寸 dataURL + 空 catch：配额一超就静默丢整个相册，
 * 用户看到的就是「拍照存不下来 / 重启就没了」。现在大图进 IndexedDB，
 * localStorage 只留元数据 + 缩略图，写失败必须能被界面看到。
 *
 * photo-store.ts 是纯逻辑 + 注入端口，所以下面这些是**真断言**（跑假端口），不是文本匹配；
 * 只有接线部分（photo.ts / db.ts / postfx.ts）用源码文本，因为那几个文件在 node 下导不进来。
 */

function record(id: string, bytes = 'data:image/jpeg;base64,AAA'): PhotoRecord {
  return {
    id,
    dataURL: bytes,
    thumbURL: 'data:image/jpeg;base64,TV' + id,
    quality: 'perfect',
    theme: 'iceberg',
    label: '完美瞬间',
    dateLabel: '11月3日 12:00',
    timestamp: 1_700_000_000_000 + Number(id.replace(/\D/g, '') || 0),
    blurry: undefined,
  }
}

/** 假端口：kv 是一个 Map，rows 是另一个 Map，失败开关留着给「写不进库」那两条用例。 */
interface Fake extends PhotoDeps {
  values: Map<string, string>
  rowsMap: Map<string, PhotoBytes>
  failPut: boolean
  failKv: boolean
  removed: string[]
}

function quotaError(): Error {
  const error = new Error('exceeded the quota') as Error & { name: string; code: number }
  error.name = 'QuotaExceededError'
  error.code = 22
  return error
}

function fakeDeps(initialKv: Record<string, string> = {}): Fake {
  const values = new Map(Object.entries(initialKv))
  const rowsMap = new Map<string, PhotoBytes>()
  const fake: Fake = {
    values,
    rowsMap,
    failPut: false,
    failKv: false,
    removed: [],
    kv: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (fake.failKv) throw quotaError()
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      },
    },
    rows: {
      list: async () => Array.from(rowsMap.values()),
      put: async (list) => {
        if (fake.failPut) throw quotaError()
        for (const row of list) rowsMap.set(row.id, row)
      },
      remove: async (ids) => {
        for (const id of ids) rowsMap.delete(id)
        fake.removed.push(...ids)
      },
    },
  }
  return fake
}

/* ------------------------------------------------------------ 元数据 / 字节 */

test('元数据不含大图，缩略图留着（配额就是这么省下来的）', () => {
  const meta = photoMetaOf(record('a')) as unknown as Record<string, unknown>
  assert.equal(meta.dataURL, undefined, '大图不该出现在元数据里')
  assert.equal(meta.id, 'a')
  assert.ok(String(meta.thumbURL).startsWith('data:image/jpeg;base64,'), '缩略图要留在 localStorage，首屏才不用等异步')
})

test('相册上限截尾，留下的是最新的那几张', () => {
  const many = Array.from({ length: MAX_PHOTOS + 3 }, (_, i) => record('p' + i))
  const metas = photoMetasOf(many)
  assert.equal(metas.length, MAX_PHOTOS)
  assert.equal(metas[0]?.id, 'p3')
  assert.equal(metas[metas.length - 1]?.id, 'p10')
})

test('解析元数据：坏 JSON / 非数组一律 null（不能当成空相册）', () => {
  assert.equal(parsePhotoMetas('not json'), null)
  assert.equal(parsePhotoMetas('{}'), null)
  assert.equal(parsePhotoMetas(null), null)
  assert.deepEqual(parsePhotoMetas('[]'), [])
  const one = parsePhotoMetas(JSON.stringify([{ id: 'x' }, 3, null, { id: '' }]))
  assert.equal(one?.length, 1, '缺 id / 非对象的条目要被丢掉')
  assert.equal(one?.[0]?.quality, 'daily', 'quality 非法要退回 daily')
  assert.equal(one?.[0]?.theme, 'iceberg', 'theme 非法要退回默认')
})

test('解析旧键：没有缩略图就退回大图，没有大图就整条丢掉', () => {
  const legacy = parseLegacyPhotoRecords(
    JSON.stringify([
      { id: 'keep', dataURL: 'data:image/jpeg;base64,AAA' },
      { id: 'broken', thumbURL: 'data:image/jpeg;base64,BBB' },
      { id: 'empty', dataURL: '' },
    ]),
  )
  assert.deepEqual(legacy?.map((item) => item.id), ['keep'], '只有带大图的条目算照片')
  assert.equal(legacy?.[0]?.thumbURL, 'data:image/jpeg;base64,AAA', '老数据没缩略图时用大图顶着')
  assert.equal(parseLegacyPhotoRecords('nope'), null)
})

test('只有真带字节的记录才写库：空 dataURL 不能覆盖已有的大图', () => {
  const rows = photoBytesOf([record('a'), { ...record('b'), dataURL: '' }])
  assert.deepEqual(rows.map((row) => row.id), ['a'])
  assert.equal(rows[0]?.dataURL, 'data:image/jpeg;base64,AAA')
})

test('水合是把字节补进记录：不改入参、不多出条目', () => {
  const stub = { ...record('a'), dataURL: '' }
  const merged = withPhotoBytes([stub, { ...record('b'), dataURL: '' }], new Map([['a', 'BIG']]))
  assert.equal(merged.length, 2)
  assert.equal(merged[0]?.dataURL, 'BIG')
  assert.equal(merged[1]?.dataURL, '', '库里没有就是没有，不能编')
  assert.equal(stub.dataURL, '', '入参不能被原地改（React 要的是新引用）')
  assert.equal(photoBytesIndex(merged).size, 1)
})

test('相册里删掉的照片，库里的行要跟着清', () => {
  assert.deepEqual(stalePhotoIds(['a', 'b', 'c'], [record('a'), record('c')]), ['b'])
  assert.deepEqual(stalePhotoIds([], [record('a')]), [])
})

test('配额错误判定：名字和 code 都认', () => {
  assert.equal(isStorageQuotaError(quotaError()), true)
  assert.equal(isStorageQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED', code: 1014 }), true)
  assert.equal(isStorageQuotaError(new Error('boom')), false)
  assert.equal(isStorageQuotaError(null), false)
})

/* ------------------------------------------------------------------- 迁移 */

test('首启迁移：旧键里的字节先进库并校验，然后才删旧键', async () => {
  resetPhotosStore()
  const fake = fakeDeps({
    [PHOTO_STORAGE_KEY]: JSON.stringify([record('a'), record('b', 'data:image/jpeg;base64,BBB')]),
  })
  await hydratePhotos(fake)
  assert.equal(fake.rowsMap.get('a')?.dataURL, 'data:image/jpeg;base64,AAA', '大图要落进 IndexedDB')
  assert.equal(fake.values.has(PHOTO_STORAGE_KEY), false, '校验通过之后旧键必须删掉')
  assert.equal(fake.values.has(PHOTO_META_KEY), true, '旧键都删了，新键必须已经在')
  const metas = parsePhotoMetas(fake.values.get(PHOTO_META_KEY) ?? null)
  assert.deepEqual(metas?.map((meta) => meta.id), ['a', 'b'])
  const snapshot = getPhotosStoreSnapshot()
  assert.equal(snapshot.hydrated, true)
  assert.deepEqual(snapshot.photos.map((photo) => photo.dataURL), ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'])
})

test('迁移写不进库时旧键必须留着（宁可重复迁移，不能迁一半把照片删了）', async () => {
  resetPhotosStore()
  const fake = fakeDeps({ [PHOTO_STORAGE_KEY]: JSON.stringify([record('a')]) })
  fake.failPut = true
  await hydratePhotos(fake)
  assert.equal(fake.values.has(PHOTO_STORAGE_KEY), true, '没校验成功就不能删旧键')
  assert.equal(fake.values.has(PHOTO_META_KEY), false, '旧键还在的时候不该先落新键')
  assert.ok(getPhotosStoreSnapshot().error !== null, '迁移失败要让界面看得见')
})

test('迁移只搬还在相册里的字节，不用旧列表覆盖新元数据', async () => {
  resetPhotosStore()
  // 上一次迁移中途失败：新键已经存在（b 被删了、c 是新拍的），旧键还躺着 a/b。
  const fake = fakeDeps({
    [PHOTO_META_KEY]: JSON.stringify([photoMetaOf(record('a')), photoMetaOf({ ...record('c'), dataURL: '' })]),
    [PHOTO_STORAGE_KEY]: JSON.stringify([record('a'), record('b')]),
  })
  await hydratePhotos(fake)
  const metas = parsePhotoMetas(fake.values.get(PHOTO_META_KEY) ?? null)
  assert.deepEqual(metas?.map((meta) => meta.id), ['a', 'c'], '被删掉的 b 不能靠旧键复活')
  assert.equal(fake.rowsMap.has('b'), false, '已经不在相册里的字节不该被搬进库')
  assert.equal(fake.rowsMap.get('a')?.dataURL, 'data:image/jpeg;base64,AAA')
})

/* ------------------------------------------------------------- store 行为 */

test('persistAlbum：元数据进 kv、大图进库、相册里没了的行被删掉', async () => {
  resetPhotosStore()
  const fake = fakeDeps({})
  const first = await persistAlbum([record('a'), record('b')], fake)
  assert.equal(first.ok, true)
  assert.equal(fake.rowsMap.has('a'), true)
  assert.equal(getPhotosStoreSnapshot().error, null)
  // 用户删掉 b：库里那一行必须跟着走
  const second = await persistAlbum([record('a')], fake)
  assert.equal(second.ok, true)
  assert.deepEqual(fake.removed, ['b'])
  assert.equal(fake.rowsMap.has('b'), false)
})

test('persistAlbum 失败不再静默：返回结果 + 记进快照 + 通知订阅者', async () => {
  resetPhotosStore()
  const fake = fakeDeps({})
  await persistAlbum([record('a')], fake)
  let notified = 0
  const off = onPhotosStoreChange(() => {
    notified += 1
  })
  fake.failPut = true
  const result = await persistAlbum([record('a'), record('b')], fake)
  off()
  assert.equal(result.ok, false)
  assert.ok(result.error !== undefined && result.error.includes('存不下'), '要给界面一句能懂的话')
  assert.equal(getPhotosStoreSnapshot().error, result.error)
  assert.ok(notified > 0, '界面靠这个订阅刷新提示，不通知就等于没说')
})

test('读相册：库里的大图和元数据按 id 对上', async () => {
  const fake = fakeDeps({})
  fake.values.set(PHOTO_META_KEY, JSON.stringify([photoMetaOf(record('a'))]))
  await fake.rows.put([{ id: 'a', dataURL: 'BIG-A', savedAt: 1 }])
  const photos = await readAlbum(fake)
  assert.deepEqual(photos.map((photo) => [photo.id, photo.dataURL]), [['a', 'BIG-A']])
})

test('同步读元数据：新键优先，没有新键才回退旧键（升级后不会空相册）', () => {
  const fake = fakeDeps({ [PHOTO_STORAGE_KEY]: JSON.stringify([record('a')]) })
  assert.deepEqual(readAlbumMeta(fake.kv).map((photo) => photo.id), ['a'], '旧格式整条能用，直接当初始值')
  fake.values.set(PHOTO_META_KEY, JSON.stringify([photoMetaOf(record('b'))]))
  assert.deepEqual(readAlbumMeta(fake.kv).map((photo) => photo.id), ['b'], '迁过之后只认新键')
  assert.equal(readAlbumMeta(fake.kv)[0]?.dataURL, '', '新格式里大图不在 localStorage')
})

/* ------------------------------------------------------ data URL / 文件名 */

test('splitDataUrl 各分支', () => {
  assert.deepEqual(splitDataUrl('data:image/jpeg;base64,QQ=='), { mime: 'image/jpeg', base64: 'QQ==', ext: 'jpg' })
  assert.equal(splitDataUrl('data:image/png;base64,QUI=')?.ext, 'png')
  assert.equal(splitDataUrl('data:image/webp;base64,QUJD')?.ext, 'webp')
  assert.equal(splitDataUrl('data:image/jpeg,xxx'), null, '没写 ;base64 不能当图片解')
  assert.equal(splitDataUrl('data:image/jpeg;base64,'), null, '空 body 不是图')
  assert.equal(splitDataUrl('no-comma-here'), null)
  assert.equal(splitDataUrl(''), null)
  assert.equal(splitDataUrl('QQ=='), null, '连逗号都没有：认不出来历就别当图片写盘')
  assert.equal(splitDataUrl('whatever,QQ==')?.base64, 'QQ==', '前缀不是 data: 时按 JPEG 兜一下')
})

test('base64 解码出来的字节和 Buffer 一致（高位字节不能被打散）', () => {
  const cases = [
    '',
    'QQ==',
    'QUI=',
    'QUJDRA==',
    'QUJDREVG',
    Buffer.from([0, 1, 2, 250, 255, 128]).toString('base64'),
    Buffer.from('深鲸 \u{1F433}').toString('base64'),
  ]
  for (const src of cases) {
    assert.deepEqual(Array.from(base64ToBytes(src)), Array.from(new Uint8Array(Buffer.from(src, 'base64'))), 'src=' + src)
  }
})

test('文件名带日期，时间无效也拿 id 兜底', () => {
  const name = photoFileName({ id: 'x', timestamp: new Date(2026, 10, 3, 9, 5, 7).getTime() })
  assert.match(name, /^深鲸-20261103-090507\.jpg$/)
  assert.equal(photoFileName({ id: 'ididididid', timestamp: Number.NaN }, 'png'), 'deepsea-idididid.png')
})

/* ------------------------------------------------------------------- 接线 */

const PHOTO = readFileSync('src/orca/photo.ts', 'utf8')
const POSTFX = readFileSync('src/orca/scene/postfx.ts', 'utf8')
const DB = readFileSync('src/lib/db.ts', 'utf8')
const CAPTURE = POSTFX.slice(POSTFX.indexOf('capture:'))

test('C6：死掉的小红书容器相册整段删干净了（声明都不留）', () => {
  // 文件末尾那段解释性注释里还写着这些名字，所以只能按「声明」匹配，不能按包含匹配。
  assert.ok(!/function createPhotoGallery/.test(PHOTO), 'createPhotoGallery 还在')
  assert.ok(!/interface PhotoGallery\b/.test(PHOTO), 'PhotoGallery 类型还在')
  assert.ok(!/function savePhotoToAlbum/.test(PHOTO), 'savePhotoToAlbum 还在')
  assert.ok(!/interface MiniToolAlbum/.test(PHOTO), 'MiniToolAlbum 接口还在')
  assert.ok(!/saveImageToPhotosAlbum\s*\(/.test(PHOTO), '还在调容器那个存图接口')
  assert.ok(!/window as unknown as \{ xhs/.test(PHOTO), 'window.xhs 取值还在')
  assert.ok(PHOTO.includes('createPhotoFlash'), '闪光是活的（app.ts 在用），不能一起删了')
})

test('C4：引擎的同步读 / 写都转到 photo-store，不再自己碰 localStorage', () => {
  assert.ok(PHOTO.includes("from '../lib/photo-store'"), 'photo.ts 没接上 photo-store')
  assert.ok(PHOTO.includes('export function loadPhotos(): PhotoRecord[]'), 'loadPhotos 的同步签名要保住（app.ts 不能改）')
  assert.ok(PHOTO.includes('return persistAlbum(photos, photoDeps)'), 'persistPhotos 还在直接写 localStorage')
  assert.ok(PHOTO.includes('hydratePhotos(photoDeps)'), '没人催水合，大图永远补不上')
  assert.ok(PHOTO.includes('MAX_PHOTOS'), 'app.ts 从 ./photo 取 MAX_PHOTOS，这条 re-export 不能断')
  assert.ok(!/localStorage\.setItem\(PHOTO_STORAGE_KEY/.test(PHOTO), '还在往旧键里写整份相册')
  assert.ok(PHOTO.includes('onPhotosStoreChange'), '宿主侧订阅口没暴露')
})

test('C4：IndexedDB 升到 v5，photos / media / notes / wakeSchedules 并存', () => {
  assert.ok(DB.includes('const DB_VERSION = 5'), 'DB_VERSION 没升到 5')
  assert.ok(DB.includes("createObjectStore('photos'"), '没建 photos 表')
  assert.ok(DB.includes('if (oldVersion < 3)'), 'photos 升级分支没写：老库装上后拿不到这张表')
  assert.ok(DB.includes("createObjectStore('media'"), '没建 media 表（对话生图/语音）')
  assert.ok(DB.includes('if (oldVersion < 4)'), 'media 升级分支没写：老库装上升不到 v4')
  // v5：日历便签与主动唤醒排期，只加表不动老表。
  assert.ok(DB.includes("createObjectStore('notes'"), '没建 notes 表（日历便签）')
  assert.ok(DB.includes("createObjectStore('wakeSchedules'"), '没建 wakeSchedules 表（主动唤醒）')
  assert.ok(DB.includes('if (oldVersion < 5)'), 'v5 升级分支没写：老库装上升不到 v5')
  assert.ok(DB.includes('export async function putPhotoRows'), '没暴露写入')
  assert.ok(DB.includes('export async function listPhotoRows'), '没暴露回读（迁移校验靠它）')
  assert.ok(DB.includes('export async function deletePhotoRows'), '没暴露删除（清孤儿行靠它）')
})

test('C5：回读的是 composer.render() 之后的 buffer（调色后的那一帧）', () => {
  const renderAt = CAPTURE.indexOf('composer.render()')
  const bufferAt = CAPTURE.indexOf('composer.readBuffer')
  assert.ok(renderAt > 0 && bufferAt > 0, 'capture 结构变了，这个断言要人工复核')
  assert.ok(bufferAt > renderAt, '又在 render() 之前取引用：拍出来的会是调色之前的淡画面')
})
