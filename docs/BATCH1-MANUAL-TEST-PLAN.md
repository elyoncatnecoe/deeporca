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

### W-1 人为模拟 `safeStorage.decryptString()` 抛异常（读取失败）

> 现实里 Windows 的 DPAPI 几乎总是可用，所以只能人为注入失败。**这是一次临时改码，验证完必须还原。**
>
> 这里刻意模拟的是 **`decryptString()` 抛异常**，而不是 `isEncryptionAvailable()` 返回 false：
> 后者只表示「这台机器不能加密」，前者才代表「盘上有一份密文，但现在解不开」——
> 那正是 `read-error` 要处理、也最容易把用户凭证毁掉的场景。
>
> 「加密不可用」是另一个独立场景，见 W-2b。

**前置条件**：已完成 §0 准备（`secure.json` 里**已有** `enc:` 密文）；`electron/main.ts` 干净。

**操作步骤**

1. 编辑 `electron/main.ts`，把 `safeStorageLike` 的 `decryptString` 临时改成抛异常：
   ```ts
   const safeStorageLike: SafeStorageLike = {
     isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
     encryptString: (plainText) => safeStorage.encryptString(plainText),
     decryptString: () => { throw new Error('manual-test: decryptString failed') },  // ← 临时
   }
   ```
2. 重新构建主进程：`npm run build:main`
3. 启动应用：`npm start`（或 `npx electron .`）
4. 打开 DevTools（主窗口按 F12）看 Console。

**✅ 预期**

- 应用能正常启动、能进首页（**不能白屏、不能卡在开屏**）。
- Console 有安全存储相关的告警；没有未捕获异常堆栈。
- 进入 `read-error`：界面出现 W-5 指定的提示文案。
- **`secure.json` 内容一个字节都没变**（用 §0 记下的 SHA256 复核）。

**❌ 失败判定**

- 应用崩溃 / 白屏 / 卡在开屏 → read-error 路径把启动链拖死了（回归）。
- Console 出现未捕获的 `Error: manual-test: decryptString failed` 堆栈 → 异常没被上层接住。
- `secure.json` 被清空、被改写，或变成 `{}` → **直接判失败**（这是本批次的核心红线）。

**♻️ 清理**：**先不要还原**，继续做 W-2 / W-5；全部做完再执行 W-6 的还原。

---

### W-2 确认 API Key 写入失败并抛出预期异常

**前置条件**：处于 W-1 的临时改码状态。

**操作步骤**

1. 进入设置 → 供应商 → 随便改一个字段（例如把 API Key 改成 `sk-manual-test-0001`）并保存。
2. 观察界面提示与 Console。

**✅ 预期**

- 出现 Toast：**「安全存储读取失败，请勿重新输入Key，建议重启应用」**
  （read-error 下写入被拒绝，提示的是读取失败原文，而不是「已保存」）。
- Console 有 IPC rejection（`Error invoking remote method 'secure:set'`）。
- 应用不崩溃，仍可继续操作。
- 设置页里的 Key 输入框**保持原样**（store 已回滚），不会显示成「已清空」。

**❌ 失败判定**

- 提示「已保存」→ 说明失败被吞掉了。
- 没有任何提示 → 用户会以为存上了。
- Key 输入框被清空 → UI 状态与磁盘不一致（回滚失效）。
- 出现明文写入（见 W-3）。

---

### W-2b 单独验证「加密不可用」（`isEncryptionAvailable() === false`）

> 与 W-1 是**两种不同故障**，必须分开验证，不能混为一谈。

**操作步骤**

1. 还原 W-1 的改动，改成只让 `isEncryptionAvailable` 返回 false：
   ```ts
   const safeStorageLike: SafeStorageLike = {
     isEncryptionAvailable: () => false,   // ← 临时：模拟 DPAPI 后端缺失
     encryptString: (plainText) => safeStorage.encryptString(plainText),
     decryptString: (encrypted) => safeStorage.decryptString(encrypted),
   }
   ```
2. `npm run build:main`，重启应用，进入设置改 Key 并保存。

**✅ 预期**

- Toast：**「系统安全存储不可用（…），这次的 API Key 没有保存」**（注意与 W-2 的文案不同）。
- 若原本没有 `secure.json`，此时**不应**产生文件。
- 若原本已有密文：因为无法解密，状态是 `read-error`，提示走 W-5 文案。

**❌ 失败判定**：提示「已保存」/ 产生明文文件 / 应用崩溃。

**♻️ 清理**：做完后进入 W-6 统一还原。

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

### W-5 验证 UI 出现指定安全提示（`read-error`）

> **两种 `read-error` 必须分别验证，不能混为一谈：**
> - **W-5a 解密失败**：文件读得到、JSON 正常，但 `decryptString()` 解不开；
> - **W-5b 文件读取/结构异常**：文件在，但读不动（权限/IO）或 JSON 损坏 / 结构不合法。
>
> 两者最终都进入 `read-error`、显示同一句文案，但**触发路径不同**；W-5b 还必须验证
> 「原文件不被覆盖」—— 这条以前会被 `readSecureStoreFile` 吞成 `{}` 而失效。

#### W-5a 解密失败

**前置条件**：`secure.json` 里存在 `"enc:..."` 密文；处于 W-1 的临时改码状态（`decryptString` 抛错）。

**操作步骤**

1. `Get-Content "$env:APPDATA\深鲸\secure.json" -Raw` 确认有 `enc:`。
2. 启动应用。
3. 观察 Chat 顶部与 Toast。

**✅ 预期**

- Chat 顶部常驻提示条（`role="status"`）显示原文：
  **「安全存储读取失败，请勿重新输入Key，建议重启应用」**
- 同时弹出同文案 Toast。
- 提示条**不出现**「去填 Key」链接（文案不含「API Key」）。
- `secure.json` 的内容与哈希**均未变化**。

**❌ 失败判定**

- 没有任何可见提示（只有 console.warn）→ 不满足「用户实际可见」。
- 出现「去填 Key」链接或自动跳设置页 → 违反「禁止触发重新输入流程」。
- 提示文案与原文有任何字差 → 不通过（逐字要求）。
- 文件被改写 → 判失败。

#### W-5b 文件读取 / 结构异常（必须单独做一遍）

**前置条件**：**还原** W-1 的改动（`decryptString` 恢复正常）；`secure.json` 已备份。

**操作步骤**

1. 备份并故意损坏文件：
   ```powershell
   $f = "$env:APPDATA\深鲸\secure.json"
   Copy-Item $f "$f.bak" -Force
   Set-Content -Path $f -Value "{ broken json" -NoNewline -Encoding UTF8
   Get-FileHash $f -Algorithm SHA256
   ```
2. 启动应用，观察提示与 Console。
3. 再测一次「读不动」：把文件设为只读并独占打开（或用 ACL 去掉当前用户读权限），重启应用。
4. 记录提示后，检查文件内容与哈希。

**✅ 预期**

- 同样显示 **「安全存储读取失败，请勿重新输入Key，建议重启应用」**。
- Console 里能看到 `SecureStoreReadError` 相关告警（不是被吞成空存储）。
- **文件内容保持为 `{ broken json`，一个字节都没变**（`Get-FileHash` 对比）。
- 此时保存任何设置，都不会把这份损坏文件覆盖成 `{}`。

**❌ 失败判定**

- 应用把损坏文件当成「没有配置」→ 保存设置时把文件覆盖成 `{}` → **直接判失败**。
- 没有可见提示。
- 应用崩溃。

**♻️ 清理**：

```powershell
Move-Item "$env:APPDATA\深鲸\secure.json.bak" "$env:APPDATA\深鲸\secure.json" -Force
```

（或直接删除损坏文件，再按 W-6 重新填一次 Key。）

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
   **把 `get` 和 `set` 的整个方法体替换掉**（不是插在开头）：
   ```java
   @PluginMethod
   public void get(PluginCall call) {
       call.reject("manual-test: keystore unavailable");   // ← 临时
       return;
   }
   ```
   `set` 同理（把 `get` 换成 `set`）。

   > **为什么必须整段替换**：Java 的可达性规则里，`return` 之后的语句是不可达代码，
   > `javac` 会直接报 `unreachable statement` 编译失败。把原逻辑留在 `return` 后面
   > （或用 `if (true) return;` 再补一句）都不是可靠写法 —— 先把原方法体整段注释或删掉，
   > 只保留 `call.reject(...); return;`，才能保证编译通过。
2. 编译验证（**必须先编译再装机**）：
   ```powershell
   cd android
   .\gradlew.bat :app:compileDebugJavaWithJavac
   ```
   只有编译通过才继续下一步；编译失败说明注入写法有问题，不要靠「文本看着对」蒙混过去。
3. `npm run cap:sync android && npm run build:android`，重新安装。
4. 启动应用，打开设置 → 供应商。

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
| W-1 模拟 `decryptString()` 抛异常 | | | |
| W-2 写入失败有明确异常 | | | |
| W-2b 模拟「加密不可用」 | | | |
| W-3 文件无明文/无 Base64 | | | |
| W-4 原密文哈希未变 | | | |
| W-5a 解密失败的指定文案 | | | |
| W-5b 文件损坏/读不动：提示 + 不覆盖 | | | |
| W-6 恢复正常后可用 | | | |
| W-7 路径穿越真机拒绝 | | | |
| W-8 导航/IPC 边界 | | | |
| A-1 模拟 Keystore reject（先编译） | | | |
| A-2 不降级写 localStorage | | | |
| A-3 迁移失败保留旧值 | | | |
| A-4 迁移成功才删旧值 | | | |
| A-5 Android 指定文案可见 | | | |
| A-6 恢复正常后可用 | | | |

---

## 4. 已知限制（与验收计划配套阅读）

1. **自动化测试是模拟测试**：`test/secure-storage-electron.test.ts` 用假的 `SafeStorageLike`，
   `test/android-secure.test.ts` 用假的插件 deps，`test/web-session.test.ts` 用假的文件与 safeStorage。
   它们证明的是**判断逻辑**，不是真机行为。
2. **Android Java 编译验证在本环境未执行**：编写本计划时所在机器上没有 JDK（`java`/`javac` 均不在 PATH）、
   没有 `ANDROID_HOME`、没有 `android/local.properties`、也没有 gradle 依赖缓存，
   因此 A-1 的注入代码**没有经过真实 `javac` 编译**，只能标为**未验证**。
   执行者必须在有 Android SDK 的机器上先跑
   `cd android && .\gradlew.bat :app:compileDebugJavaWithJavac`，通过后再装机。
3. **`%2f` 行为未确认**：W-7 是唯一能回答「Chromium 是否原样传递编码分隔符」的手段。
4. **IPC frame 行为未确认**：`test/ipc-trust.test.ts` 只测 URL 判断 + 对 `main.ts` 的结构断言，
   「非可信 frame 真的拿不到 IPC」需要 W-8 第 3 步在真机确认。
5. **`web-relay.test.ts` 的那 1 项失败**：由沙箱阻止 esbuild spawn 子进程导致（EPERM），
   证据见交付说明；它不属于本批次改动范围，但也**没有**被证明为「与代码无关」，
   应视为**环境受限、未确认**，在能正常 spawn 的环境里重跑一次才能销案。
6. **纯浏览器预览**没有系统密钥存储，仍用 localStorage（设计取舍，README 已标注）。
7. **网页登录态「迁移失败」的主动提示有限**：目前只在「自检」与「登录/采集」的返回值里明确告知，
   启动时不会主动弹 Toast（需要改 UI，未纳入本批次）。
