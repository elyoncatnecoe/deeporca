# 批次 1 手动验收计划（Windows / Android）

> 对应任务：批次 1 补充修复（安全存储状态、模拟测试、路径与 IPC 回归）
> 编写：2026-11-12 · 状态：**待人工执行**
> 前置：自动化测试只能证明「代码逻辑对」，**不能替代真机验证**。本文件里的每一项都需要人工按步骤执行并记录结果。

---

## 0. 通用约定

| 记号 | 含义 |
|---|---|
| ✅ 预期 | 应该观察到的现象 |
| ❌ 失败判定 | 出现即视为该项不通过，需回滚并记录 |
| ♻️ 清理 | 必须执行的恢复动作（**漏掉会把开发机留在异常状态**） |

**凭证文件位置**

- Windows：`%APPDATA%\深鲸\secure.json`（Electron `app.getPath('userData')`）
- Android：`/data/data/com.elyoncat.deepsea/shared_prefs/deepsea_secure.xml`（需 root 或 debug 版 `run-as`）
- 网页登录态：`%APPDATA%\深鲸\deepseek-web-session.json`

**准备工作（两端都要）**

1. 先做一次完整备份：`_backup-manual-<YYYYMMDD-HHMMSS>/`（照项目惯例）。
2. 记录当前 `secure.json` 的哈希，后面用来证明「没被改动」：
   ```powershell
   Get-FileHash "$env:APPDATA\深鲸\secure.json" -Algorithm SHA256
   ```
3. 先正常配置一个可用的 API Key 并确认能对话 —— 后面要验证它不会被弄丢。

---

## 1. Windows（Electron）

### W-1 人为模拟 `safeStorage.isEncryptionAvailable()` 返回 false

> 现实里 Windows 的 DPAPI 几乎总是可用，所以只能人为注入失败。**这是一次临时改码，验证完必须还原。**

**前置条件**：已完成 §0 准备；`electron/main.ts` 干净（无未提交改动）。

**操作步骤**

1. 编辑 `electron/main.ts`，把 `safeStorageLike` 的第一行临时改成恒 false：
   ```ts
   const safeStorageLike: SafeStorageLike = {
     isEncryptionAvailable: () => false,   // ← 临时：模拟 DPAPI 不可用
     encryptString: (plainText) => safeStorage.encryptString(plainText),
     decryptString: (encrypted) => safeStorage.decryptString(encrypted),
   }
   ```
2. 重新构建主进程：`npm run build:main`
3. 启动应用：`npm start`（或 `npx electron .`）
4. 打开 DevTools（主窗口按 F12）看 Console。

**✅ 预期**

- 应用能正常启动、能进首页（**不能白屏、不能卡在开屏**）。
- Console 里能看到 `[deepseek-api]` 之外的、与安全存储相关的告警；没有未捕获异常。
- 此时若 `secure.json` 里**已有**密文，启动后应出现 §W-5 的提示（因为读也走同一个后端）。

**❌ 失败判定**

- 应用崩溃 / 白屏 / 卡在开屏 → 说明 read-error 路径把整个启动链拖死了（回归）。
- Console 出现 `SecureStoreUnavailableError` 未捕获堆栈 → 异常没被上层接住。

**♻️ 清理**：**先不要还原**，继续做 W-2 ~ W-5；全部做完再执行 W-6 的还原。

---

### W-2 确认 API Key 写入失败并抛出预期异常

**前置条件**：处于 W-1 的临时改码状态。

**操作步骤**

1. 进入设置 → 供应商 → 随便改一个字段（例如把 API Key 改成 `sk-manual-test-0001`）并保存。
2. 观察界面提示与 Console。

**✅ 预期**

- 出现 Toast：**「系统安全存储不可用（…），这次的 API Key 没有保存」**。
- Console 有 IPC rejection（`Error invoking remote method 'secure:set'` 或 `SecureStoreUnavailableError` 文案）。
- 应用不崩溃，仍可继续操作。

**❌ 失败判定**

- 提示「已保存」→ 说明失败被吞掉了。
- 没有任何提示 → 用户会以为存上了。
- 出现明文写入（见 W-3）。

---

### W-3 检查凭证文件里没有明文、也没有 Base64

**前置条件**：刚执行完 W-2。

**操作步骤**

```powershell
$f = "$env:APPDATA\深鲸\secure.json"
if (Test-Path $f) {
  Get-Content $f -Raw
  # 明文检查
  Select-String -Path $f -Pattern 'sk-manual-test-0001' -SimpleMatch
  # Base64 检查（Base64 不是加密）
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('sk-manual-test-0001'))
  Select-String -Path $f -Pattern $b64 -SimpleMatch
  # 降级格式检查
  Select-String -Path $f -Pattern 'raw:' -SimpleMatch
} else {
  "secure.json 不存在（这也是合格结果）"
}
```

**✅ 预期**

- 三种检查**全部无命中**：无明文、无 Base64、无 `raw:` 前缀。
- 文件不存在也算通过（加密不可用时本来就拒绝落盘）。

**❌ 失败判定**：任意一种命中 → 明文/伪加密落盘，**本批次核心目标失败**。

---

### W-4 验证原有密文没有被覆盖

**前置条件**：§0 已记录哈希；W-2 已触发一次失败的写入。

**操作步骤**

```powershell
Get-FileHash "$env:APPDATA\深鲸\secure.json" -Algorithm SHA256
```

**✅ 预期**

- 哈希与 §0 记录的**完全一致**（一个字节都没变）。
- 若 §0 时文件不存在，则现在也应仍不存在。

**❌ 失败判定**：哈希变化 → 失败的写入动了原文件。

---

### W-5 验证 UI 出现指定安全提示（read-error 场景）

> W-1 模拟的是「不可用」；`read-error` 需要「有密文但解不开」。做法：保留 W-1 的恒 false，
> 但确保 `secure.json` 里**已经有一份 `enc:` 密文**（§0 步骤 3 存过 Key 就有）。

**操作步骤**

1. 确认 `secure.json` 里存在 `"enc:..."`（`Get-Content` 看一眼）。
2. 保持 W-1 改码，重启应用。
3. 观察 Chat 顶部与 Toast。

**✅ 预期**

- Chat 顶部常驻提示条（`role="status"`）显示原文：
  **「安全存储读取失败，请勿重新输入Key，建议重启应用」**
- 同时弹出同文案的 Toast。
- 提示条**不出现**「去填 Key」这类链接（文案不含「API Key」）。
- 打开设置页，Key 输入框为空或显示未配置，但**不要**自动弹出「去填 Key」的引导。

**❌ 失败判定**

- 没有任何可见提示（只有 console.warn）→ 不满足「用户实际可见」。
- 出现「去填 Key」链接或自动跳设置页 → 违反「禁止触发重新输入流程」。
- 提示文案与原文有任何字差 → 不通过（逐字要求）。

**♻️ 清理**：确认 `secure.json` 里 `enc:` 密文**仍在**（W-4 的哈希法再查一次）。

---

### W-6 恢复正常环境，验证加密存储仍能工作

**前置条件**：W-2 ~ W-5 已完成并记录。

**操作步骤**

1. 还原 `electron/main.ts` 的临时改动：
   ```powershell
   # 从批次 1 的备份还原（路径按实际备份目录）
   Copy-Item "_backup-review-fix-b1-20261112-151000\electron\main.ts" "electron\main.ts" -Force
   ```
   > 注意：如果之后又做过其他改动，请只把 `isEncryptionAvailable` 那一行改回
   > `() => safeStorage.isEncryptionAvailable()`，不要整文件覆盖。
2. `npm run build:main`，重启应用。
3. 在设置里重新填 Key `sk-manual-test-0001` 并保存。
4. 完全退出应用，再启动。
5. 发一条消息确认能正常对话。

**✅ 预期**

- 保存时**无**任何安全存储报错。
- `secure.json` 里出现 `"enc:..."`（不是 `raw:`）。
- 重启后 Key 仍在（设置页可见）、能正常发消息。
- 顶部不再出现 W-5 的提示条。

**❌ 失败判定**：重启后 Key 丢失 / 变成明文 / 提示仍在。

**♻️ 清理**：`git status`（或对比备份）确认 `electron/main.ts` 与批次 1 版本一致。

---

### W-7 路径校验真机验证（`%2f` 是否原样到达 protocol.handle）

> 自动化测试只证明了 `resolveAppPath` 的逻辑正确；**Chromium 是否把 `%2f` 原样交给
> `protocol.handle` 必须在 Electron 里实测**，这是本批次唯一无法用单测覆盖的假设。

**操作步骤**

1. 正常启动应用，F12 打开 DevTools → Network 面板。
2. Console 里依次执行：
   ```js
   fetch('app://deepsea/index.html').then(r => console.log('legal', r.status))
   fetch('app://deepsea/%2e%2e%2fpackage.json').then(r => console.log('traversal1', r.status))
   fetch('app://deepsea/..%2fpackage.json').then(r => console.log('traversal2', r.status))
   fetch('app://evil/index.html').then(r => console.log('badhost', r.status))
   ```

**✅ 预期**

- `legal` → `200`
- `traversal1` / `traversal2` → `403`
- `badhost` → `403`

**❌ 失败判定**

- 任意 traversal 返回 `200` → 路径穿越仍成立，**必须回到 T-02 重新分析**。
- traversal 返回 `404` 而不是 `403` → 说明 `%2f` 被 Chromium 提前规范化/拒绝（此时利用面比分析更小），记录该现象即可，仍算通过（因为没读到文件）。
- `badhost` 返回 `200` → host 校验没生效。

**♻️ 清理**：无（只读请求）。

---

### W-8 导航与 IPC 信任边界真机验证

**操作步骤**

1. 主窗口 DevTools Console：
   ```js
   location.href = 'about:blank'            // 期望被 will-navigate 拦下
   location.href = 'https://example.com'    // 期望不导航，交给系统浏览器
   ```
2. 观察窗口是否变化、系统浏览器是否被拉起。
3. 在页面里尝试通过沙箱 iframe（运行代码 / 工坊预览）触发 `window.deepsea.secureGet()`，确认拿不到桥。

**✅ 预期**

- 主窗口**不会**变成 about:blank，也不会跳到 example.com（外部链接交给系统浏览器）。
- 沙箱 iframe 里 `window.deepsea` 为 `undefined`。

**❌ 失败判定**：主窗口被导航走；或沙箱 iframe 里能拿到 `window.deepsea`。

**♻️ 清理**：无。

---

## 2. Android

> 需要 **debug 版 APK**（`npm run build:android` 的 debug 变体）以便用 `adb` + Chrome `chrome://inspect` 调试 WebView。
> 正式版无法 inspect，不要用正式版做本验收。

### A-1 人为模拟 Keystore 插件 reject

**前置条件**：debug APK 已装、`chrome://inspect` 能连上 WebView。

**操作步骤**

1. 临时修改 `android/app/src/main/java/com/elyoncat/deepsea/DeepSeaSecurePlugin.java`，
   在 `get` 和 `set` 开头注入失败：
   ```java
   @PluginMethod
   public void get(PluginCall call) {
       call.reject("manual-test: keystore unavailable");   // ← 临时
       if (true) return;
       // ...原逻辑
   }
   ```
   `set` 同理。
2. `npm run cap:sync android && npm run build:android`，重新安装。
3. 启动应用，打开设置 → 供应商。

**✅ 预期**

- 应用正常启动，不崩。
- 若此前有 Key：顶部出现 W-5 同款提示（read-error）。

**❌ 失败判定**：启动崩溃（`ClassCastException` / 未捕获异常）、或白屏。

**♻️ 清理**：**先不要还原**，继续 A-2 ~ A-5。

---

### A-2 确认新凭证不会降级写入 localStorage

**前置条件**：A-1 状态。

**操作步骤**

1. 设置里把 API Key 改成 `sk-android-manual-0001` 并保存。
2. `chrome://inspect` → 选中应用 WebView → Console 执行：
   ```js
   localStorage.getItem('deepsea.apiKey')
   ```
3. 再看 Application → Local Storage 面板。

**✅ 预期**

- `localStorage.getItem('deepsea.apiKey')` 返回 **`null`**。
- 界面出现 Toast「系统安全存储不可用（…），这次的 API Key 没有保存」。

**❌ 失败判定**：localStorage 里出现明文 Key → **本批次核心目标失败**。

---

### A-3 验证旧 localStorage 凭证迁移失败后仍被保留

**前置条件**：A-1 状态（插件 reject）。

**操作步骤**

1. `chrome://inspect` → Console 里人为写入旧版明文：
   ```js
   localStorage.setItem('deepsea.apiKey', 'sk-legacy-plain-0001')
   ```
2. 完全杀掉进程并重启应用。
3. 重启后再看：
   ```js
   localStorage.getItem('deepsea.apiKey')
   ```

**✅ 预期**

- 返回 **`sk-legacy-plain-0001`**（迁移失败，旧值被保留，没有为了「干净」删掉）。
- 应用不崩。

**❌ 失败判定**

- 返回 `null` → 旧值被误删，老用户会丢 Key。
- 返回空串 → 同上。

**♻️ 清理**：记下这个值，A-4 要用。

---

### A-4 验证迁移成功后才删除旧值

**前置条件**：A-3 已留下 `sk-legacy-plain-0001`；现在**还原**插件（见 A-6 第 1 步）让 Keystore 恢复可用。

**操作步骤**

1. 还原 `DeepSeaSecurePlugin.java`，重新构建安装。
2. 启动应用（此时 localStorage 里仍有旧明文）。
3. 再看：
   ```js
   localStorage.getItem('deepsea.apiKey')          // 期望 null（已迁移并删除）
   ```
4. 设置页确认 Key 是否可用（应为 `sk-legacy-plain-0001`）。

**✅ 预期**

- localStorage 里**已清空**（`null`）。
- 设置页里 Key 是 `sk-legacy-plain-0001`（迁移成功，值没丢）。
- `shared_prefs/deepsea_secure.xml` 里出现 Base64 密文（需 `run-as` 或 root 查看）。

**❌ 失败判定**

- localStorage 里仍有旧明文 → 迁移后没删（明文残留）。
- Key 丢失 → 迁移把值弄丢了。

---

### A-5 检查 UI 安全提示

**前置条件**：A-1 状态（插件 reject）且**已有密文**。

**操作步骤**

1. 先用正常插件存一个 Key（确保 `deepsea_secure.xml` 有密文）。
2. 再改回 A-1 的 reject 版并安装。
3. 启动应用，观察 Chat 顶部与 Toast。

**✅ 预期**

- 顶部常驻提示：**「安全存储读取失败，请勿重新输入Key，建议重启应用」**（逐字一致）。
- 同文案 Toast。
- **不出现**「去填 Key」链接，不自动跳设置页。

**❌ 失败判定**：无可见提示 / 出现「去填 Key」引导 / 文案有字差。

---

### A-6 恢复正常 Keystore 并验证读写

**操作步骤**

1. 还原 `DeepSeaSecurePlugin.java`（从备份覆盖，或删掉那两行临时注入）。
2. `npm run cap:sync android && npm run build:android`，重新安装。
3. 设置里填 `sk-android-manual-0002` 并保存。
4. 完全杀掉应用，重启。
5. 发一条消息确认能对话。

**✅ 预期**

- 保存无报错；重启后 Key 仍在；能正常对话。
- 顶部不再有安全提示。
- localStorage 里**没有** `deepsea.apiKey`。

**❌ 失败判定**：Key 丢失 / 明文进 localStorage / 提示仍在。

**♻️ 清理**：确认 `DeepSeaSecurePlugin.java` 与批次 1 版本一致（`git diff` 或对比备份）。

---

## 3. 记录表（执行时填写）

| 项 | 结果（通过/失败） | 观察到的实际现象 | 备注 |
|---|---|---|---|
| W-1 模拟 DPAPI 不可用 | | | |
| W-2 写入失败有明确异常 | | | |
| W-3 文件无明文/无 Base64 | | | |
| W-4 原密文哈希未变 | | | |
| W-5 指定文案可见 | | | |
| W-6 恢复正常后可用 | | | |
| W-7 路径穿越真机拒绝 | | | |
| W-8 导航/IPC 边界 | | | |
| A-1 模拟 Keystore reject | | | |
| A-2 不降级写 localStorage | | | |
| A-3 迁移失败保留旧值 | | | |
| A-4 迁移成功才删旧值 | | | |
| A-5 Android 指定文案可见 | | | |
| A-6 恢复正常后可用 | | | |

---

## 4. 已知限制（与验收计划配套阅读）

1. **自动化测试是模拟测试**：`test/secure-storage-electron.test.ts` 用假的 `SafeStorageLike`，
   `test/android-secure.test.ts` 用假的插件 deps。它们证明的是**判断逻辑**，不是真机行为。
2. **`%2f` 行为未确认**：W-7 是唯一能回答「Chromium 是否原样传递编码分隔符」的手段。
3. **IPC frame 行为未确认**：`test/ipc-trust.test.ts` 只测 URL 判断 + 对 `main.ts` 的结构断言，
   「非可信 frame 真的拿不到 IPC」需要 W-8 第 3 步在真机确认。
4. **`web-relay.test.ts` 的那 1 项失败**：由沙箱阻止 esbuild spawn 子进程导致（EPERM），
   证据见交付说明；它不属于本批次改动范围，但也**没有**被证明为「与代码无关」，
   应视为**环境受限、未确认**，在能正常 spawn 的环境里重跑一次才能销案。
5. **纯浏览器预览**没有系统密钥存储，仍用 localStorage（设计取舍，README 已标注）。
