# 工具链踩坑记录（Windows / 本仓库）

> 这份文档只记「在这台机器上怎么干活」，不记产品问题。
> 产品侧的已知问题、未做项、不确定项在 `NOTES.md`（目前只在 `wip/ui-feedback-1-legacy` 分支上）。
>
> 每条都写清 **症状 → 原因 → 做法**，能复制命令的直接贴。

---

## A. 改文件

### A1. 不要用 PowerShell 读写源码文件

**症状**：改完中文变乱码（`娣遍哺` 这种）；行号和真实文件对不上；文件被写坏后 TypeScript 报一堆莫名其妙的错。

**原因**：`Get-Content -Raw` + `Set-Content` / `[IO.File]::WriteAllText` 会按控制台代码页（GBK）解码 UTF-8，再按 GBK 写回。中文字符被拆成字节对，换行也可能被吃掉，于是「内容变了 + 行数变了」。

**做法**：

- 改源码一律用编辑器工具（edit / write），它们按 UTF-8 处理。
- 必须脚本化时用 Node 的 `fs.readFileSync(path,'utf8')` / `writeFileSync`，不要走 PowerShell 的字符串管道。
- 已经写坏了：`git checkout -- <file>` 重来，别试图「修乱码」。

**踩过的现场**：想用 PowerShell 做一次「把 `if (cond)` 改成 `if (false && cond)`」的变异测试，文件直接不可解析。

### A2. `edit` 工具会吃掉 BOM

**症状**：改完某个原本带 BOM 的文件，diff 里第一行整体变了。

**做法**：确认原文件是否有 BOM（`git show HEAD:path | Format-Hex | Select -First 1`），有的话改完用 `[IO.File]::WriteAllBytes` 补回 `EF BB BF`。

---

## B. 构建

### B1. worktree 必须建在仓库目录内

**症状**：worktree 建在仓库外（如 `F:\webs\apk-check`）时，`node --test`、`vite`、`cap` 全部 `MODULE_NOT_FOUND`。

**原因**：worktree 里没有 `node_modules`，只能靠 Node 向上逐级查找父目录的 `node_modules`。放到仓库外，这条链就断了。另外 `mklink /J` 在非 NTFS 盘上会失败，别指望用目录联接绕过。

**做法**：`git worktree add .wt-xxx -b branch <base>`，工作树一律叫 `.wt-*` 放在仓库根下。

### B2. worktree 里不要用 `npx`

**症状**：`npx vite build` 启动后进程空转，15 分钟只用了 5 秒 CPU，没有任何输出。

**原因**：`npx` 会先解析出父级的 `node_modules/.bin/vite`，但随后的子进程/环境继承在跨目录场景下会卡住（同样命令直接调 bin 只要 9 秒）。

**做法**：直接调仓库根下的 bin：

```powershell
node F:\webs\whale\apk\node_modules\vite\bin\vite.js build
node F:\webs\whale\apk\node_modules\typescript\bin\tsc --noEmit
node F:\webs\whale\apk\node_modules\@capacitor\cli\bin\capacitor sync android
```

### B3. `gradlew.bat` 的 `-P` 参数必须加引号

**症状**：

```
Task '.1.0' not found in root project 'android' and its subprojects.
```

**原因**：PowerShell 调用 `.bat` 时把 `-PappVersionName=0.1.0` 拆成了 `-PappVersionName=0` 和 `.1.0`，gradle 把后者当成任务名。

**做法**：

```powershell
.\gradlew.bat assembleDebug --no-daemon --console=plain "-PappVersionName=0.1.0" "-PappVersionCode=100"
```

（`scripts/build-android.mjs` 里用 `execSync` 走 cmd，所以脚本本身没这个问题 —— 只有手工敲 gradlew 时才会踩。）

### B4. `cap sync` 会改写 gradle 里的 node_modules 路径

**症状**：构建完 `git status` 里多出 `android/capacitor.settings.gradle` 和 `android/app/capacitor.build.gradle`，diff 是 `../node_modules/...` → `../../node_modules/...`。

**原因**：worktree 比仓库根深一层，`cap sync` 按实际解析到的 node_modules 位置重写了路径。

**做法**：**构建后还原，绝不提交**：

```powershell
git checkout -- android/capacitor.settings.gradle android/app/capacitor.build.gradle
```

同理，`scripts/build-relay-java.mjs` 会重新生成 `android/.../RelayScript.java`，内容通常一致（只是行尾差异），构建后也一并 `git checkout --`。

### B5. Android 构建的完整手工链路

脚本 `scripts/build-android.mjs --debug` 一次做完下面五步，但其中 `npx` 那两步在 worktree 里会挂（见 B2），所以手工跑更稳：

```powershell
cd <worktree>
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:JAVA_HOME='F:\webs\whale\apk\.toolchain\jdk21'
$env:ANDROID_HOME='F:\webs\whale\apk\.toolchain\android-sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME

node scripts/build-relay-java.mjs
node F:\webs\whale\apk\node_modules\vite\bin\vite.js build
node scripts/check-es-compat.mjs
node F:\webs\whale\apk\node_modules\@capacitor\cli\bin\capacitor sync android
cd android
.\gradlew.bat assembleDebug --no-daemon --console=plain "-PappVersionName=0.1.0" "-PappVersionCode=100"
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。gradle 冷启动约 2.5 分钟（330 个 task）。

**交付前校验包是真的**：直接读 APK 里的 bundle 字符串，别信文件名：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[System.IO.Compression.ZipFile]::OpenRead('path\to.apk')
$e=$zip.Entries | Where-Object { $_.FullName -like 'assets/public/assets/index-*.js' } | Select-Object -First 1
$sr=New-Object System.IO.StreamReader($e.Open()); $js=$sr.ReadToEnd()
$js.Contains('本次新增的某句文案')   # True 才算数
```

---

## C. 测试

### C1. `node --test` 跑 `.ts` 时，无扩展名的相对导入会失败

**症状**：`ERR_MODULE_NOT_FOUND: Cannot find module '.../src/lib/providers'`。

**原因**：仓库里大部分 `src/lib/*.ts` 用 bundler 风格的无扩展名导入，Vite 能解析，Node 的 ESM 解析器不能。

**做法**（两种，仓库里都有先例）：

1. **给导入加 `.ts` 后缀** —— 适合你正要改的那个文件。仓里已有 16 个文件这么写。
2. **`registerHooks` 补 `.ts`** —— 适合不想动源码：

```ts
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})
const { someFn } = await import('../src/lib/target.ts')   // 必须动态导入
```

**关键**：钩子注册之后必须用 **`await import()`**。静态 `import` 的模块解析发生在任何代码执行之前，钩子来不及生效 —— 这一点很容易看漏，表现为「钩子写了但照样 MODULE_NOT_FOUND」。

### C2. 断言大对象会把几十 MB 打进日志

**症状**：一条 `assert.deepEqual(outcome.media, [])` 失败时，终端刷出 25MB 的 base64。

**做法**：断言长度而不是内容：`assert.equal(outcome.media.length, 0, '...')`。

### C3. `stripComments` 在 CRLF 检出下失效

**症状**：注释里的字眼被当成代码，结构性断言误报。

**原因**：`core.autocrlf=true` 时工作区是 CRLF，`.*$` 匹配不到行尾的 `\r`，整行注释剥不掉。

**做法**：切行用 `split(/\r?\n/)`，不要 `split('\n')`。

---

## D. 推送

### D1. `git push` 到 github.com 会连接重置

**症状**：`fatal: unable to access 'https://github.com/...': Recv failure: Connection was reset`。但 `api.github.com` 是通的。

**做法**：走 GitHub Git Data API 重放提交（blobs → tree → commit → ref）。两个必须注意的点：

1. **提交信息要逐字节还原**。`git log --format=%B` 取到的 message 以 `\n` 结尾，任何 `trim()` 都会让 SHA 变掉。正确做法是 `git cat-file commit <sha>`，取第一个空行之后的**全部**内容。
2. **author / committer 的姓名、邮箱、时间一起带上**（`%an %ae %aI %cn %ce %cI`），否则 GitHub 用「现在」当提交时间，SHA 同样对不上。

做到这两点，远端 SHA 才和本地完全一致，不会出现「本地 79fa77f / 远端 f92fff0、内容相同但分叉」。

**分支不存在时** `PATCH /git/refs/heads/<b>` 返回 **422**（不是 404），要回退到 `POST /git/refs`。

### D2. 推送前先确认工作区

`git status --porcelain` 先看一遍。这个仓库的主工作区长期有上百个在途改动，`git add -A` 一次就能把别人的东西打包进去。

---

## E. 方法纪律（比工具坑更值钱）

### E1. 动手前先确认基线

**症状**：改了半天，发现改在一条有 141 个未提交改动、且代码比目标分支还旧的工作区上，只能全部撤回重做。

**做法**：

```powershell
git branch --show-current
git rev-parse --short HEAD
git status --porcelain | Measure-Object -Line
```

三条都对得上预期再动手。新功能/新修复一律 `git worktree add` 开独立工作树。

### E2. 每条修复都要做一次「变异验证」

**只跑绿不算测到**。把修复临时拆掉，确认对应用例真的变红：

- 拆掉 → 红了几项 → 恢复 → 全绿。
- 一个用例都红不了，说明它测的是别的（或者根本没测到这条路径）。

本轮实例：网页账号闸门去掉「退供应商」那一步，5 项红；去掉 `effectiveSettings` 的闸门，4 项红；去掉设置页过滤，1 项红。

**例外**：纯等价重构（不改变行为的清理）应当「前后都绿」，这也是证据 —— 说明它确实没改行为，而不是「看起来修好了」。

### E3. 改之前先验证前提

**症状**：照着补丁写完，代码看起来更严谨了，实际行为一模一样。

**实例**：`planUpsert` 的「bestCover 错配」—— 补丁要求拆成 `bestCoverMax` + `bestScore` 两个目标。但

```
jaccard     = 交集 / (|A| + |B| - 交集)
containment = 交集 / min(|A|, |B|)
```

分母恒有 `|A|+|B|-交集 ≥ min(|A|,|B|)`，所以 **jaccard 恒 ≤ containment**，`Math.max(score, cover)` 永远等于 `cover`，两个目标永远指向同一条记录 —— 原补丁是空操作。

**做法**：动手前先用具体数字/反例验一遍前提（写个 10 行脚本或一条不变量测试）。前提不成立时，先改设计，再改代码。

---

## 附：常用命令速查

| 目的 | 命令 |
|---|---|
| 类型检查 | `node <repo>/node_modules/typescript/bin/tsc --noEmit` |
| 全量测试 | `node --test "test/**/*.test.ts"` |
| 单文件测试 | `node --test test/xxx.test.ts` |
| 前端构建 | `node <repo>/node_modules/vite/bin/vite.js build` |
| 新工作树 | `git worktree add .wt-xxx -b branch <base-sha>` |
| 清理工作树 | `git worktree remove .wt-xxx --force` + `git worktree prune` |
