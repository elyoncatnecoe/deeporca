# 深鲸 / DeepSea — 修复任务清单

> 生成：2026-11-12 · 方式：**只读静态源码审查** · 工作目录：`F:\webs\whale\apk`
> 目的：整理成可直接交给执行者（DeepSeek / 其他编码 Agent）**按批次局部修补**的任务清单。
> 原则：**不重构、不重写模块**。所有补丁都是一处到几处的守卫/条件/字段修正，每批独立可回滚。

---

## 0. 怎么读这份清单

### 0.1 状态标记

| 标记 | 含义 |
|---|---|
| `【已知未修】` | 项目根目录 `BUG-REVIEW.md` 或 `docs/REVIEW-20261103.md` **已经记录**，本轮复核确认仍未修复 |
| `【本轮新增】` | 本轮审查首次定位，历史清单未记录 |
| `【已修复】` | 历史清单有记录，但源码中已存在修复代码（通常带 `BUG-REVIEW Pn-x` 注释），**不要再列为任务** |
| `【需验证】` | 静态链路成立，但触发时机/网关行为需真机或运行时复现 |

严重度：`S` 高 / `M` 中 / `L` 低。

### 0.2 与既有文档的关系（重要）

项目已有两份审查文档，本清单**不是**它们的重复：

- **`BUG-REVIEW.md`**（根目录，175 行）：历史三路审查汇总，含 74 条 P2 明细。其中**部分已修**——源码里有 23 处 `BUG-REVIEW P0-x/P1-x` 修复注释（如 `db.ts:191` 的 P1-30、`main.ts:130/474` 的 P0-3、`engine.ts:71/269` 的 P0-2）。**列任务前先确认状态，别把已修项重做一遍。**
- **`docs/REVIEW-20261103.md`**（424 行）：图片/工坊/拍照三个实测 bug 的根因链，已修复并备份到 `_backup-bugfix3-20261103-123006`。

**关于 GPT 那份「第一轮静态审查」**：其 4 条发现中，**3 条在 `BUG-REVIEW.md` 里早已写明且更详细**：

| GPT 的发现 | `BUG-REVIEW.md` 对应 | 差异 |
|---|---|---|
| ① 网页 Token 明文 | `:144` 「deepseek-api.ts:82-103 网页 token（比 apiKey 更值钱）明文落盘、forget 写空串不删文件」 | 历史项已包含「forget 写空串」这个细节 |
| ② API Key 降级 | `:144` 「main.ts:84-89 safeStorage 不可用降级 base64 明文无提示」 | 一致 |
| ③ `startsWith` 路径校验 | `:143` 「缺分隔符边界（.. 编码可放行 dist-app 兄弟目录）+ decodeURIComponent 裸 % 未捕获 + 目录 readFileSync EISDIR」 | 历史项更完整，还多一条 EISDIR |
| ④ `about:blank` 信任例外 | 未记录 | **GPT 那 4 条里唯一的历史未记录项**，但性质是「代码与注释意图不符」，非确认漏洞 |

所以那轮审查的实际价值是**复核与补充**，不是「发现新问题」。执行时不要把它当成全新漏洞列表。

### 0.3 边界声明

- 全程**只读**：未构建、未运行、未执行测试套件、未在 Windows / Android 真机验证。
- 静态可确认 ≠ 已复现漏洞。第 8 节单列所有需运行时验证的项。
- 行号基于本轮本地源码快照；改动前请重新 `read` 目标文件确认。
- 建议每批改动前仿照项目惯例做一次备份目录（`_backup-<topic>-<timestamp>`）。

### 0.4 复核意见补正（2026-11-12，已并入方案）

外部复核提出六条修正，均已采纳，执行时**以本节为准**（与下文任务描述冲突处，本节优先）：

| # | 复核意见 | 落地方式 |
|---|---|---|
| 1 | **T-01**：旧版 `raw:` 数据需要迁移方案，不能直接让旧用户的 Key 失效 | 已实施：`decrypt()` 保留 `raw:` 只读兼容，`secure:get` 读到即就地升级为 `enc:`；Android 侧旧 `localStorage` 明文改为「读到就搬进 Keystore，搬不动则保留原值」，不删用户凭证。**只拒绝「新写入降级」，不拒绝「旧数据读取」。** |
| 2 | **T-05/T-06**：不能只在写入前加 abort 判断，还要保证被中断的工具调用不留下不完整的对话协议 | 顺序调整：**T-04（孤儿 `tool_calls` 置空）必须先于 T-05/T-06 落地**。只加守卫会让「工具没执行完」变成新的孤儿 `tool_calls`，反而更容易触发 400。守卫与协议收尾必须成对提交。 |
| 3 | **T-08**：`activeAbort` 归属判断要覆盖**所有入口和所有 finally** | 下文 T-08 已补完整清单：5 个入口（`sendMessage` / `sendGroupMessage` / `regenerate` / `editAndResend` / `continueTurn`）× 对应 finally，逐一改 `if (activeAbort === myAbort)`，并统一清 `turnNodeId`。**漏一个就会旧任务清掉新任务状态。** |
| 4 | **T-33**：不建议直接换无限制 `newCachedThreadPool()`，应有并发上限 | 改为有界池：`new ThreadPoolExecutor(0, 4, 60s, SynchronousQueue)`，或「1 条非流 + 3 条流」的固定分配。上限 4 足够覆盖「一条流 + 测连接 + 列模型 + 一次媒体下载」，又不会在请求堆积时失控。 |
| 5 | **T-38**：解密失败不一定代表密钥永久损坏，需区分失效与暂时异常，避免误删凭证 | 只在**明确的不可恢复错误**（如 `KeyPermanentlyInvalidatedException`、密文长度非法）时清密文并返回 `null`；其余异常（`UserNotAuthenticatedException`、`KeyStoreException` 等）保留密文、向上抛，让 UI 提示「暂时读不出」。**任何情况下都不在解密失败时写明文。** |
| 6 | **T-34**：HTTP 明文属兼容性与安全性的取舍，不能为了两端一致就全局放开 | 保留 `usesCleartextTraffic="false"` 与 HTTPS 默认策略。只做两件事：① `readSpec` 对 `http://` 给出明确中文提示（说明是安全策略拒绝，不是网络故障）；② 若要支持内网端点，走 `network_security_config.xml` **按用户明确配置的域名**放行，绝不全局开 `cleartextTrafficPermitted`。 |

**执行纪律（复核要求，已写入第 11 节）**：每批必须提交「修改文件清单 + 修改前后差异 + 测试结果 + 未解决问题」四项，禁止一次性执行 40 项。

---

## 1. 结论摘要

| 批次 | 主题 | 任务数 | 最高优先级 | 建议顺序 |
|---|---|---|---|---|
| 1 | 凭证存储与 IPC 信任边界 | 3 | S | 先做（安全边界） |
| 2 | 取消语义收口 | 6 | **S，最高价值** | 紧接批次 1 |
| 3 | 请求/解析/记忆正确性 | 8 | S | 批次 2 之后 |
| 4 | 健壮性与上限 | 5 | M | 可与批次 3 并行 |
| 5 | 3D 生命周期（orca / Stage） | 10 | S（显存/音频泄漏） | 最后 |
| 6 | Android 多端一致性 | 8 | S（并发/明文端点） | 最后 |

**合计 40 条任务**（T-01 ~ T-40）。批次 5、6 的结论推翻了主控初判——见第 6 节开头的「判断修正」；这说明「`dispose()` 调用列表齐全」不等于「资源真的释放」，执行时请以逐段审查结论为准。

**一句话根因**：`AbortSignal` 只被送到了传输层（`net.ts` / Electron / Android 都正确接了），**没有贯穿到写入层**。批次 2 的 6 条任务不是 6 个 bug，是同一条断链上的 6 个断点：

```
net.ts:142-149 toBridgeRequest 丢 signal
  → 原生 netRequest 无法取消
  → media-tools.ts:196-198 把 abort 吞成普通失败文本
  → media-api.ts:979 isMediaAbort 零调用
  → engine.ts:1181 落库前无检查
  → engine.ts:885 工具循环无检查
  → engine.ts:926-972 收尾无条件执行
```

---

## 2. 批次 1 · 凭证存储与 IPC 信任边界

> **状态：T-01 / T-02 / T-03 已于 2026-11-12 实施完毕。** 修改文件清单、差异要点、测试结果见第 12 节。

### T-01 · 凭证存储 fail-closed（三端收口）`【已知未修】` `S` `✅已实施`

- **位置**：`electron/main.ts:97-112`（encrypt/decrypt）、`src/lib/platform.ts:49-90`（secureGet/Set/Remove）、`electron/deepseek-api.ts:73-105`（loadSession/saveSession/forgetWebSession）
- **现状**：
  - `main.ts:101` 在 `safeStorage.isEncryptionAvailable()` 为假时返回 `raw:` + Base64；`decrypt()` 还会透明解开 `raw:`，降级**永久不回退**。
  - `platform.ts:69-71` Android 插件抛错时静默改写 `localStorage.setItem('deepsea.apiKey', value)`；`get/remove` 同模式。
  - `deepseek-api.ts:88` 用普通 `writeFileSync` 把 `WebSession.token` 写进 `deepseek-web-session.json`，**该文件没导入 `safeStorage`**（`main.ts:1` 导入了，能力现成）。
  - `deepseek-api.ts:98-105` 的 `forgetWebSession()` 是写 `''` 截断而非 `unlink`，且 `catch` 吞掉写失败 → 内存已清但磁盘旧 token 仍在，下次 `loadSession()` 会把它**读回来**，登出不生效。
  - `README.md:116,129` 宣称「Windows DPAPI / Android Keystore，不写日志、不导出」，与降级路径不完全一致。
- **补丁（已按复核意见 1 调整）**：
  1. `encrypt()` 去掉 `raw:` 写入分支，不可用即抛 `SecureStoreUnavailableError`；**但 `decrypt()` 保留 `raw:` 只读兼容**，`secure:get` 读到旧值就地升级为 `enc:`（不失效老用户）。
  2. `platform.ts` 新增 `SecureStorageError`：Android 写入失败**抛错**而非落明文；旧 `localStorage` 明文改为一次性迁移（搬进 Keystore 成功才删，失败保留原值）。
  3. `deepseek-api.ts` 的 save/load 接 `safeStorage`（`sealed: true` 存密文，旧明文格式读到即升级）；加密不可用时**拒绝持久化**、只留内存。
  4. `forgetWebSession()` 改 `unlinkSync`，`ENOENT` 静默，其它错误退化为截断，两者都失败才告警。
  5. `store.setSettings` 捕获 `SecureStorageError` → toast「这次的 API Key 没有保存」。
  6. 同步更新 `README.md:116,129` 措辞。
- **验证**：模拟 `safeStorage` 不可用 / Android 插件 `reject`，确认没有任何明文文件产生；登出后确认文件不存在且重启读不回 token。
- **备注**：Android 侧 `DeepSeaSecurePlugin.java:39-55` 确实用了 AndroidKeyStore AES-256-GCM，happy path 没问题；是 `:98-100` 的 `call.reject` 触发了 TS 的降级 catch。另外 `remove():103-107` 只清 SharedPreferences、不删 keystore alias，属残留但非明文泄漏，低优先。

### T-02 · `app://` 协议路径校验 `【已知未修】` `S` `✅已实施`

- **位置**：`electron/main.ts:66-78`（registerAppProtocol），关键行 `:69` decode、`:71` normalize、`:72` startsWith、`:74` readFileSync
- **触发链**（已逐段核实）：WHATWG URL 会折叠字面 `..` 和 `%2e%2e`，但**分隔符被编码**时 `..` 留在同一 segment 内不被折叠：
  ```
  app://deepsea/%2e%2e%2fdist-other/secret.txt
    → url.pathname = /%2e%2e%2fdist-other/secret.txt
    → decodeURIComponent → /../dist-other/secret.txt
    → join(root, …) → normalize → <root 同级>/dist-other/secret.txt
    → startsWith(root) 通过（兄弟目录名以 dist 开头）→ readFileSync 读出
  ```
- **附带问题**：`decodeURIComponent` 裸 `%` 会抛异常且无 try/catch；`readFileSync` 命中目录会 EISDIR；`protocol.handle('app')` **完全不校验 host**，而 `isTrustedFrameUrl():141` 只认 `app://deepsea`。
- **补丁**：
  1. `decodeURIComponent` 包 try/catch，失败直接 403。
  2. 用 `const rel = relative(root, target); if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return 403` 取代 `startsWith`。仅改成 `startsWith(root + sep)` 在 Windows 上仍不稳。
  3. 校验 `url.hostname === 'deepsea'`（否则 403）。
  4. `existsSync` 后加 `statSync(target).isFile()` 判断，目录返回 404。
- **验证**：已用独立脚本实证（见第 12 节）：同一批 URL 下旧 `startsWith` 对两条穿越路径返回 `true`，新 `relative` 返回 `false`，合法路径均保持 `true`。`%2f` 是否原样到达 `protocol.handle` 仍需 Electron 真机确认。

### T-03 · 拆分「导航信任」与「IPC 信任」`【本轮新增】` `M` `✅已实施`

- **位置**：`electron/main.ts:136-148`（isTrustedFrameUrl）、`:151-156`（isTrustedSender）、`:476-484`（will-navigate / will-redirect）
- **现状**：`isTrustedFrameUrl` 无条件 `if (raw === 'about:blank' || raw === 'about:srcdoc') return true`。子框架拿不到 IPC 靠的是 `:154` 的 `frame.parent !== null`，不是白名单——注释（`:137`）声称的例外与实际守卫位置不符。顶层 `about:blank` 会通过信任检查。
- **更确实的后果**：`will-navigate`（`:476-480`）与 `will-redirect`（`:481-484`）**复用同一函数**，因此注释里「主窗口不许导航走」的保护**显式放行**了导航到 `about:blank` / `about:srcdoc`。这与 IPC 能否被滥用无关，是确凿的白名单放宽。
- **补丁（已实施）**：拆成两个函数——`isTrustedIpcSenderUrl()` 只认 `app://deepsea`（+ `DEEPSEA_DEV_URL` origin），不含 `about:*`；`isAllowedMainWindowNavigation()` 复用前者。`isTrustedSender` 用前者，`will-navigate` / `will-redirect` 用后者。`frame.parent !== null` 的排除保留。
- **验证**：Electron 真机确认顶层 `about:blank` 时 preload 桥是否仍注入、以及能否被外部内容触发；**在此之前不要把这条写成「可利用漏洞」**。

---

## 3. 批次 2 · 取消语义收口（最高价值，建议第一个做）

### T-04 · 停止在 tool_calls 流式中途 → 下一轮 400 `【本轮新增】` `S`

- **位置**：`src/lib/engine.ts:796`（toolCalls 落库）、`:802`（status）、`:871`（break）
- **链路**（已逐段核实）：
  1. `deepseek.ts:369-380` `finish(true)` 仍调用 `finalizeTools`，半截草稿只要带 name 就产出非空 `toolCalls`；
  2. `engine.ts:796` 仍把 `toolCalls` 写进消息，`:802` 只标 `status:'aborted'`；
  3. `:871` **在工具循环（`:885`）之前 break** → 没有配对的 `role:'tool'` 消息；
  4. `prompt.ts:150` 只过滤 `status === 'error'`，`'aborted'` 保留；`:167-168` 照样把 `tool_calls` 塞进请求；`:221-225` 只丢孤儿 **tool 消息**，不丢带孤儿 `tool_calls` 的 assistant。
- **后果**：下一轮请求带 `assistant.tool_calls` 却无对应工具响应 → API 400，**用户下一次发言发不出去**。
- **补丁（一行）**：`toolCalls: result.aborted ? undefined : (result.toolCalls.length > 0 ? result.toolCalls : undefined)`。或为每个未执行 call 补占位 tool 消息以保持配对。
- **验证**：在模型吐 tool_calls 参数时按停止，再发一条消息看是否 400。

### T-05 · 写入层补 abort 守卫 `【本轮新增】` `S`

> **执行顺序约束（复核意见 2）**：必须先完成 **T-04**（`result.aborted` 时把 `toolCalls` 置空），再做本条。
> 只加 abort 守卫、不做协议收尾，会把「工具执行到一半被停」变成新的孤儿 `tool_calls`——守卫本身反而更容易制造 400。**两条必须成对提交。**

- **位置**（全文件 grep 确认只有 10 处 abort 判断：322 / 434 / 445 / 736 / 802 / 871 / 942 / 1260 / 1330）：
  - `engine.ts:634` `while` 顶部
  - `engine.ts:885` 工具循环首行
  - `engine.ts:1191` `putMedia(record)` 前、`:1210` `appendMessage(message)` 前（`runTool` 内）
  - `engine.ts:1181` 媒体落库条件
- **补丁**：上述每处加 `if (signal.aborted) break` / `return`。`:871` 之前已有判断，但 `:855-869` 的 `addUsage` 写在 break **之前**，仍会写用量表。
- **备注**：`:942` 的自动续写**已有** `&& !signal.aborted` 守卫，不要重复加。

### T-06 · break 之后的收尾包进 abort 守卫 `【已知未修·部分】` `S`

> **与 T-04/T-05 同批提交**：收尾里会写 `bumpConversation` / 记忆 / 摘要 / 用量，任何一处漏守卫都会让「停止」变成「停止后仍然记账」。协议侧（T-04）不修好之前，本条单独上线价值有限。

- **位置**：`engine.ts:926-972`
- **现状**：`bumpConversation` / `refreshConversations` / `detectRepeatedMemories` / `maybeCompress` 全部无条件执行，且是 `void` 无句柄；`finally`（`:355-361`）已把 `activeAbort = null`。`BUG-REVIEW.md:114` 已记录「void promise 无 catch」。
- **补丁**：整段包 `if (!signal.aborted) { … }`；三个 `void` 任务入口加守卫并补 `.catch(() => undefined)`；`addUsage` 从 `:855` 移到守卫内。
- **备注**：`maybeCompress` 会发起一次压缩用的网络请求（`compress.ts:144`），停止后仍计费/仍写 `putSummary`。

### T-07 · 媒体生成的取消打通 `【本轮新增】` `S`

- **位置**：`src/lib/media-tools.ts:196-198`、`src/lib/media-api.ts:979`、`src/lib/net.ts:142-149`
- **现状**：`toBridgeRequest` 只映射 url/method/headers/body/timeoutMs，**丢掉 signal** → 原生 `netRequest`/`netRequestBinary` 无法取消；`media-tools` 把 abort 吞成普通失败文本；`isMediaAbort` **全仓零调用**；浏览器 fetch 分支仅在飞行中有效。
- **补丁**：
  1. `media-tools` 的 `runGenerateImage` / `runSpeak` 成功返回前加 `if (context.signal?.aborted) return { resultText: '已停止', media: [] }`。
  2. catch 里用 `isMediaAbort(error)` 返回「已停止」并让 engine 早停工具循环。
  3. `engine.ts:1181` 条件加 `&& !signal.aborted`。
  4. `extract.ts` 在 `upsertMemoryCandidates` 前复查 `isAborted(request.signal)`（`:131` 注释声称当前请求会被 signal 打断，原生通道不成立）。
- **不做**：原生非流请求要真取消需新增 abort IPC，属后续迭代，**本次不重构**。

### T-08 · 全局状态归属判断 `【本轮新增】` `M`

- **位置**：`engine.ts:45-51`（activeAbort / busy / turnNodeId）、`:224`（busy 检查）、`:260`（busy 置位）、`:355-361` 等全部 finally
- **现状**：`:224` 检查 `busy` 到 `:260` 置位之间夹着 `runLocalCommand`(233)、`webChatReady`(249)、`loginWebChat`(251) 等真实 await → 双击能开出两轮；两轮各自 `new AbortController()` 覆盖全局 `activeAbort`，先启动那轮失去 abort 句柄；所有 finally **无条件**清空全局状态，旧轮收尾会把新轮的 controller 清成 null，使新轮不可停止。`engine.ts:1239` 注释已承认「全局只有一个 activeAbort」。
- **补丁（已按复核意见 3 展开为完整清单）**：
  - **入口（5 个，全部要 `const myAbort = new AbortController()` + 立即占住 `busy`）**：
    1. `sendMessage`（`:222`，检查 `:224`、置位 `:260`）
    2. `sendGroupMessage`（finally 在 `:461-466`）
    3. `regenerate`（`~:1239` 附近）
    4. `editAndResend`（`~:1298-1303` 附近）
    5. `continueTurn`（finally 在 `:1011-1016`）
  - **finally（5 处，全部改为归属判断）**：`:355-361`、`:464-465`、`:1014-1015`、`:1265-1266`、`:1335-1336`
    → `if (activeAbort === myAbort) { activeAbort = null; busy = false; turnNodeId = null }`
  - **`turnNodeId`**：当前 `sendGroupMessage:461-466` 与 `continueTurn:1011-1016` **漏清**，必须补上，否则下一轮消息会挂到上一轮的节点。
  - **`busy` 置位**：提到 `:224` 检查通过后立即执行，`:233`/`:238`/`:248` 的早退分支统一复位。
  - **验收口径**：5 个入口 × 5 个 finally 全部对齐，任意一个漏改都会出现「旧任务清掉新任务状态」，这是本条唯一的失败模式。
- **备注**：累积文本 / 当前消息 id / 轮次计数**全是局部变量**，跨轮覆盖未发现，不要误改。

### T-09 · 本地指令与离线回复纳入取消 `【本轮新增】` `M`

- **位置**：`engine.ts:93-144`（runLocalCommand）、`:154-195`（runOfflineReply）、`:66-73`（stopSending）
- **现状**：`runLocalCommand:101` 设 `busy = true` 但**从不设 `activeAbort`** → `stopSending` 走 `:72` 直接 `resetSendingState()`，`:139` 仍会 `appendMessage(reply)`；离线回复同理。另外 `stopSending` 的兜底分支在整轮网络期间 `activeAbort` 恒非 null，**永远不可达**，注释自称要修的 P0-2 挂起场景没被覆盖（`BUG-REVIEW.md:35` P0-2）。
- **补丁**：两个函数内用模块级「本轮已停止」标记，在 `:139`/`:186` 写入前判断，或让它们也创建并检查 AbortController；`stopSending` 在 `abort()` 后加一个「超时未收尾」兜底。

---

## 4. 批次 3 · 请求 / 解析 / 记忆正确性

### T-10 · SSE 末尾事件未 flush；200 非 SSE 整包无兜底 `【已知未修】` `S` `✅已实施`

- **位置**：`deepseek.ts:383-398`（consume 只在空行处分事件）、`:448-450`（netStream 后直接 return，buffer 丢弃）、`:465`（finish(false)）
- **对照**：`media-api.ts:860` 有 flush、`:863-871` 有非 SSE JSON 兜底；`BUG-REVIEW.md:113` 已记录「SSE 收尾帧不解析」。
- **后果**：最后一个事件（常见 usage / 末段 content / finish_reason）静默丢失；网关忽略 `stream:true` 回完整 JSON 时整轮空白且无报错。
- **补丁**：netStream 之后、`return` 之前，若 `!sawErrorStatus && buffer.trim() !== ''` 调一次 `consume('\n\n')`；再对 `content === ''` 且 buffer 解析不出 chunk 的情况用 `parseCompleteContent(protocol, JSON.parse(response.text))` 兜一次正文。

### T-11 · 400 兼容退避无效 `【本轮新增】` `S` `✅已实施`

- **位置**：`deepseek.ts:229-261`（buildBody）、`:424`（payload 构造）、`:455`（3 次上限）、`:472-486`（退避分支）
- **核实要点**（比表面现象更深一层）：`body` 由 `buildOpenAiBody({ includeUsage: true })`（`:229-240`）构造，**本身就带 `stream_options`**。`:472-475` 只把外层 `includeUsage` 置 false，而 `:424` 的 `{ ...body, messages, ...(includeUsage ? … : {}) }` 展开时**旧字段仍在** → 重试仍发送 `stream_options`。另外 `:483-486` 无条件 `changed = true`；非 openai 协议 `:425` 的 payload 直接用 `body`、不随 `messages` 重建，所以 `stripReasoning(messages)` 改了也没用。
- **后果**：同一 400 最多重复 3 次整段请求（放大），兼容网关永久不可用。
- **补丁**：`stream_options` 分支加 `delete body.stream_options`；`reasoning_content` 分支仅当 `messages.some(m => m.reasoning_content !== undefined)` 才 strip 并置 `changed`；非 openai 时 `body = buildBody(sentLimit)` 重建。

### T-12 · OpenRouter 语音 SSE 只按 `\n\n` 切 `【本轮新增】` `S` `✅已实施`

- **位置**：`media-api.ts:834`（`raw.indexOf('\n\n')`）、`:860`（收尾只补 `\n\n`）；对照 `deepseek.ts:386` 正确用了 `/\r?\n\r?\n/`
- **后果**：CRLF 分隔的网关全程找不到边界，收尾把所有 `data:` 行 join 成一个 payload → JSON.parse 失败 → 502「语音模型没有返回音频」。`test/media-tools.test.ts:232-233` 只覆盖 `\n\n`。
- **补丁（一行）**：边界改 `/\r?\n\r?\n/.exec(raw)`，或把入 raw 的 `\r\n` 归一为 `\n`。补一条 CRLF 测试。

### T-13 · `planUpsert` 的 bestCover 错配 `【核实结论：不是 bug】` `M` `✅已核实并清理（等价重构）`

- **位置**：`memory-core.ts:186-212`；`BUG-REVIEW.md:138` 已记录「并列阈值时 cover 与 best 不同步」
- **原判断**：`best` 按 `Math.max(score, cover)` 选（`:202`），但 `bestCover` 只记**被选中那条**的 cover（`:204`），`:208` 却用 `bestCover >= 0.88` 判 update。库中同时有 A（cover=0.95、jaccard=0.2）与 B（cover=0.1、jaccard=0.96）时 B 胜出，高包含度的 A 被忽略。
- **核实结论（批次 3 开工前复核）**：**这个错配不可能发生，原补丁是空操作。**
  - `jaccard = 交集 / (|A| + |B| - 交集)`，`containment = 交集 / min(|A|, |B|)`。
  - 因为 `|A| + |B| - 交集 ≥ min(|A|, |B|)`，分母更大 ⇒ **jaccard 恒 ≤ containment**。
  - 所以 `Math.max(score, cover)` 永远等于 `cover`，`bestScore` 与 `bestCover` 恒等，
    `score` 从头到尾没影响过任何判定 —— 「用 Jaccard 认矛盾」这条线从未生效。
  - 原文举的「A cover=0.95 / B jaccard=0.96 且 cover=0.1」在几何上不成立：
    jaccard 高的两条，包含度必然也高（`jaccard ≤ containment`）。
  - 结论：**没有按原补丁拆 `bestCoverMax` + `bestScore`** —— 拆了也永远指向同一条记录，
    只会让代码看起来像修好了。
- **实际处理**：把实现写清楚（删掉恒等的 `bestScore` 与死掉的 `jaccard` 计算，判定统一用
  包含度：≥0.88 更新 / ≥0.35 疑似矛盾 / 其余新增），**行为逐字节不变**。
  验证方式是**前后都绿**（换回旧实现跑同样用例也全绿），并在 `memory-core.test.ts`
  加了一条不变量用例守着 `jaccard ≤ containment` —— 前提要是变了，它会先红。
- **仍未解决的真实问题**（留给后续评估，不属于本条）：`CONFLICT_THRESHOLD` 现在按包含度判
  「话题撞车」，短句被长句覆盖到 0.35 以上就算疑似矛盾；如果希望按 Jaccard 判，
  得先接受 jaccard 天然比包含度低一档，阈值要重新标定。

### T-14 · 媒体先写库、消息后写库 → 孤儿媒体 `【本轮新增】` `M` `✅已实施`

- **位置**：`engine.ts:1180-1210`（`:1191` putMedia、`:1210` appendMessage）
- **后果**：`appendMessage` 抛错或 `putMedia` 循环中途抛错（`:1194` catch 只改文案），media 表里留下 `messageId` 指向不存在消息的记录，字节永久残留。
- **补丁**：`:1183-1193` 的 putMedia 循环包 try/catch，失败时 `await deleteMediaByMessage(messageId)` 回滚——**`db.ts:602` 已有现成函数**。或先 append 占位消息再写媒体。

### T-15 · 33ms debounce timer 泄漏 / 跨轮污染 live `【本轮新增】` `M` `✅已由 PR #4 修复（提交 35aea1a）`

- **位置**：`engine.ts:647-659`（schedule 挂 timer）、`:724`（flush 只在成功返回后调用）、`:667-728`（streamOnce 无 try/finally）
- **后果**：网络中断 / SSE error / 400 退避耗尽 → `streamChat` 抛错 → `:724` 不执行，33ms 后残留 `flush()` 仍 `updateLive(...)`；若新一轮已 `startLive`（`store.ts:634-643` 无条件覆盖），旧轮半截正文写进新轮占位气泡。`bodyMind.drainEvents()` 也被跳过。
- **补丁**：`streamOnce` 的 `await streamChat(...)` 包 try/finally，finally 中清 `timer` / `pendingFlush`。

### T-16 · dedupePayloads 用 b64 前 80 字判重 `【本轮新增】` `L` `✅已实施`

- **位置**：`media-api.ts:182` `` key = `b64:${payload.b64.slice(0, 80)}` ``
- **后果**：一次返回多张同格式/同尺寸图（PNG 头前 80 字符相同）时真图被误当重复丢掉，`count>1` 少图。
- **补丁（一行）**：key 用完整 b64，或「长度 + 前80 + 后80」。

### T-17 · 工具跨轮重放无去重 `【本轮新增】` `L` `⏸本轮暂缓（放到批次 3 之后单独评估）`

- **位置**：`engine.ts:885-896`（批次 3 基线里是 `:998-1029`）
- **现状**：逐个执行 `result.toolCalls`，不比对 `call.id` 或 `(name, arguments)` 与之前轮次；`MAX_TOOL_ITERATIONS = 10`（`:43`）只是总轮数闸。
- **补丁**：`runAssistantTurn` 内加 `const seen = new Set<string>()`，循环里命中即跳过并回一条「已执行过」的 tool 结果消息（**保持配对**，否则又造一个 T-04）。
  - **实施要求（写死在这里，免得下次又发明一套）**：跳过分支必须**复制现有 abort 占位消息的处理方式**
    （批次 3 基线 `engine.ts:1004-1018`：拼一条 `role: 'tool'` 消息、`appendMessage` 落库、
    `history = [...history, skipped]` 再 `continue`），不要另写一套消息写入逻辑。
  - 还要和 `result.truncatedToolCallIds`（半截参数不执行）区分开：两个 `continue` 分支文案不同，别混。
- **备注**：单次流内重复执行**未发现**——工具只在流结束后执行一次，`protocols.ts:56-60` 按 Map index 定稿去重。
- **为什么本轮暂缓**：不只是收益低（只有「模型跨轮重复调用同一工具」才命中）。它与 T-14 共用
  `engine.ts`，还会触发 `sending-state.test.ts:104` 的源码正则与 `agent-loop.test.ts:47` 的切片断言；
  在取消语义（T-04/T-05/T-08）刚收口的时候动这里，等于把风险叠在同一处。
  **建议**：等 T-14 落地并跑完全量、确认无回归之后，再单独评估；没有实际复现或明确收益就跳过。

---

## 5. 批次 4 · 健壮性与上限

### T-18 · 浏览器 fetch 通道永无超时 `【本轮新增】` `M`

- **位置**：`deepseek.ts:426-433`、`:733-740`、`:815-820`（均未传 `timeoutMs`）；`net.ts:577-582`（只有 `options.timeoutMs !== undefined` 才建 timer）
- **现状**：`deepseek.ts` 全文 grep 不到 `timeoutMs`；Electron/Android 才有 120s 默认（`main.ts:245-251`、`DeepSeaHttpPlugin.java:51`）。纯浏览器预览挂死连接会永久挂起（含 `completeJson` 的记忆抽取）。另 `net.ts:457-463` / `:548-554` 在 `streamId === ''` 时 abort 是 no-op，拿到 id 后不复查。
- **补丁**：三个调用点补 `timeoutMs: 120000`；`streamViaBridge`/`streamViaPlugin` 拿到 id 后补 `if (options.signal?.aborted) abort()`。

### T-19 · 体积上限函数零调用 `【本轮新增】` `M` `✅已实施`

- **位置**：`media-store.ts:12-14,67-72`（`MAX_IMAGE_BYTES` / `MAX_AUDIO_BYTES` / `mediaWithinLimit`）、`media-api.ts:489-494`（参考图只判能否 parse）、`engine.ts:1191`
- **核实**：`grep` 全仓 `src/` —— `mediaWithinLimit` **只有定义处、零调用**（仅 `test/media-tools.test.ts:7` 引用同模块的 `estimateDataUrlBytes`）；`isMediaAbort`（`media-api.ts:979`）同样零调用。
- **后果**：>16MB 图 / >12MB 语音照样转 data URL 落 IndexedDB；任意多张超大参考图可构造任意大 JSON 请求体（还会经 IPC 再复制一次）。
- **补丁**：`media-tools` 生成 drafts 后 `filter(d => mediaWithinLimit(d.kind, d.dataUrl))`，超限回「图片太大」；`generateImages` 里对 `cleanReferences` 加张数(≤4)与总字节上限。
- **实施记录**：
  - `media-tools.ts`：生图/语音落库前各加一道 `mediaWithinLimit`；全被拦时回「太大/太长，没有保存」。
  - `media-api.ts`：参考图改为「张数 ≤4 + 单张 ≤16MB + 总量 ≤16MB」；**只因为太大**才一张不剩时抛
    「参考图太大」，不偷偷不带图去生成（本来就不是 data URL 的照旧静默忽略）。
  - 原「核实」里那句「`isMediaAbort` 同样零调用」**已过期**：PR #4 的 T-07 已经把它接上了
    （`media-tools.ts` 的生图/语音 catch）。

### T-20 · base64 大文件峰值复制 4~6 份 `【本轮新增】` `M` `✅已实施（与 T-19 同一提交）`

- **位置**：`net.ts:297-304`（bytesToBase64）、`media-api.ts:513-540` / `:875-881`、`media-store.ts:31-33`、`media-api.ts:289`（JSON.stringify body）
- **后果**：16MB 图峰值约 60~100MB 常驻字符串，WebView/IDB 有 OOM 与配额风险；原生通道还要跨进程序列化一次。
- **补丁（不重构）**：返回前用 `mediaWithinLimit` 拦一道；`bytesToBase64` 用数组一次 join 代替 `binary +=`；TTS 流结束后把 `raw`/`audioData` 置空。改 Blob 才真降数量，属重构，**本次不做**。

### T-21 · 记忆总量与 touch 竞态 `【本轮新增】` `M`

- **位置**：`memory-core.ts:196`（pending 不参与竞争）、`memory.ts:90-159` / `:274-303`、`db.ts:461-467`、`:602`
- **三个问题**：
  1. 库总量无上限（history 10 / tags 8 / 会话 5 次 / 去重 map 64 只限单次，不限库）；`import/extract.ts:185-187` 候选数组无上限。
  2. `pending` 不参与相似度竞争 → 相似冲突可无限堆积。
  3. `memory.ts:303` 的 `void touch(selection.active)` 在 `:279` 用 `putMemory({ ...memory, lastUsedAt })` 写**整条旧记录**；若 `listMemories()`(`:296`) 之后、touch 之前用户删除该条（`store.ts:783-786` 硬删除），陈旧副本会被重新插入 → 删除后召回又出现。
- **补丁**：`upsertMemoryCandidates` 入口 `candidates.slice(0, 20)` 并在 `putMemory` 前按「非置顶+最旧」裁到固定条数；让 pending 也参与一次 jaccard 去重；`touch` 内 put 前重新 `listMemories()` 按 id 取当前记录、取不到就跳过，并把 `void` 改 `await` 收窄窗口。
- **备注**：删除后**本地 prompt 注入**仍取到已删条目——**未发现**（硬删除 + 每次全表重读 + `memoryVisibleTo` 过滤 + 删除后刷新）。只有 touch 竞态与网页远端残留两个例外。

### T-22 · 错误响应体解析与展示不一致 `【本轮新增】` `L`

- **位置**：`deepseek.ts:466,497`（直接用原始 `outcome.errorText`）、`:101-108`（`errorDetailText` 流式路径零调用）、`media-api.ts:46`（支持 `{"error":"msg"}`）
- **补丁**：保留 raw 做 `includes` 退避匹配，抛错前统一 `new ApiError(status, errorDetailText(outcome.errorText))`；给 `errorDetailText` 补 `typeof parsed.error === 'string'` 分支。
- **附带**：`media-api.ts:979` 的 `isMediaAbort` 接进 `media-tools.ts:151-155` 的 catch；`net.ts:168-181` 抛的 `NetError` 绕过 `friendlyMediaError`，需统一；`:912-913` 的 `parsed.data.audio` 与 `:604` 的 pcm `atob` 包 try/catch 抛 `MediaApiError(502)`。

---

## 6. 批次 5 · 3D 生命周期（orca / Stage）

> **判断修正（重要）**：本轮主控初判曾写「`dispose()` 覆盖完整、3D 生命周期健康」。逐段审查后**该判断被推翻**——当时只看了 `app.ts:2761-2784` 调用了哪些子系统的 `dispose()`，没有深究这些 `dispose()` 内部是否真的释放。**调用列表齐全 ≠ 资源释放完整**。以下为修正后的结论，执行时以本节为准。

### 主控初判中确实成立的部分（保留）

- **动画循环守卫**：`app.ts:2473-2503` 有 `if (this.disposed) return`（`:2481`）、`renderPaused` 丢弃 `clock.getDelta()`（`:2483-2487`）、hidden 降频（`:2489-2491`）、`cancelAnimationFrame` 由 `stopLoop`（`:2758`）持有；**`dt` 已 clamp** `Math.min(rawDt, 0.05)`（`:2499`）。rAF 正确 cancel、无并行 loop —— 未发现。
- **ResizeObserver / AppStateChange 订阅**：`app.ts:1294-1299` 与 `:2770` 配对；`Stage.tsx:141-153` 直接 `return onAppStateChange(...)`，`platform.ts:322-327` 取消函数完整 —— 未发现泄漏。
- **WebGL contextlost 事件本身**：`Stage.tsx:114-122` 有监听 + `preventDefault` + `setRebuildKey` 重建，`:147-150` 有 `isContextLost()` 兜底。事件处理存在；缺口在下面的 T-32（孤儿上下文）。
- **无上限数组**：`trail` 由 `:2637` shift 限长约 40 条、`feedItems` 由 `MAX_TOKENS=6`、`photos` 由 `MAX_PHOTOS`、`glyphs` 固定 24 槽池 —— 未发现无 cap 的自动累积。
- **共享资源误释放**：`catalog.ts:37` 的模块级 `glowTexture` 无任何 dispose 调用（正确）；`feed.ts:137-138/280-284` 每 token 自建 —— 未发现误 dispose。

### 确认有问题（按严重程度）

#### T-23 · 虎鲸整模型没有 dispose `【本轮新增】` `S` `【静态】`

- **位置**：`app.ts:680` `buildOrcaModel()`；`src/orca/orca/orcaMesh.ts` **全文 0 处 `dispose`**（已 grep 确认），`OrcaModel` 接口（`:27-54`）无 dispose；`app.ts:2761-2784` 未调用任何 orca 释放。
- **后果**：每次销毁/重建泄漏 bodyGeo、尾/背/胸鳍/眼/描边壳的几何与材质，以及 `orcaMesh.ts:296` 的 `new THREE.DataTexture(...)`。触发点：Stage 卸载、`App.tsx:79 <Stage key={quality}>` 换画质、onboarding 退出、`Stage.tsx:120` rebuildKey 重建。
- **补丁**：给 `OrcaModel` 加 `dispose()`，用 Set 去重遍历 `group` 的 geometry/material 并 dispose + `mrTex.dispose()`；`app.ts:2780` 附近加 `this.orca.dispose()`。

#### T-24 · postfx 只 `composer.dispose()`，pass 内部 renderTarget 全泄漏 `【本轮新增】` `S` `【静态】`

- **位置**：`src/orca/scene/postfx.ts:254-256` `dispose: () => { composer.dispose() }`。
- **核实**：`node_modules/three/examples/jsm/postprocessing/EffectComposer.js:235-242` 的 `dispose()` 只释放 `renderTarget1/2` 与 `copyPass`，**不遍历 passes**。因此 `UnrealBloomPass` 的 10 个 renderTargetsHorizontal/Vertical、renderTargetBright、separableBlurMaterials、compositeMaterial、materialCopy、basic、fsQuad，以及 `ShaderPass` 的 grade material/fsQuad 全部不释放。
- **后果**：每次重建泄漏一整套全屏 renderTarget（手机单个数 MB），显存增长最快。
- **补丁（两行）**：`postfx.ts` 的 `PostFX` 接口（`:124-127`）本就持有 `bloom` / `grade` 引用，`dispose` 里补 `bloom?.dispose()`、`grade?.dispose()`。注意 composer 自己的两个 target 确实释放了，漏的是 pass 内部。

#### T-25 · window 监听未清理，dispose 后背景音乐「复活」 `【本轮新增】` `S` `【静态】`

- **位置**：`app.ts:695/698`（canvas pointerenter/leave）、`:699` `window.addEventListener('click', ...)`（匿名、非 once）、`:752-753` unlock 的 pointerdown/keydown（`{once:true}`）；`dispose():2767-2769` 只移除 onKeyDown / onContainerResize / visibilitychange。
- **链路**（已逐段核实）：`audio.ts:295-300` 的 `dispose()` 置 `ctx = null`；`audio.ts:57-72` 的 `ensure()` 发现 `!ctx` 就 **新建 AudioContext**；`app.ts:748` unlock 里 `if (this.save.music) this.audio.setMusicEnabled(true)` → `audio.ts:269-279` `startMusic()` 用 `window.setTimeout(loop, ...)` 起循环。而 `audio.dispose()` 已跑完、再无人 `clearTimeout`。
- **后果**：(a) 已 dispose 的整个 app 实例被 window 闭包强引用无法 GC；(b) 每重建一次多一个 click 监听，之后点击打在死实例上；(c) **水族馆销毁后背景音乐常驻** + 音频上下文/定时器残留。
- **补丁**：把 click / unlock 回调提成实例字段，`dispose` 里 `removeEventListener`；unlock 内先判 `this.disposed` 早退。

#### T-26 · 后台不 pause，隐藏帧仍全量渲染 `【本轮新增】` `M` `【静态+真机】`

- **位置**：`Stage.tsx:141-142` `if (!active) return`（inactive 侧完全不调 `app.pause()`）；`app.ts:2489-2491` 只靠 `document.hidden` 降频，但降频后**仍走完整帧并 `composer.render()`(`:2755`)**，间隔 250/500/1000ms（`quality.ts:59/76/93`）。
- **静态可确认**：不会主动暂停、隐藏帧仍全量渲染。**真机待验证**：某些 Android ROM 不置 `document.hidden` 时后台 60fps 持续跑 GPU。
- **补丁（两行）**：`if (!active) { appRef.current?.pause(); return }`；循环里 `if (hidden) { this.clock.getDelta(); return }`。

#### T-27 · 装饰 / ghost 资源从不释放 `【本轮新增】` `M` `【静态】`

- **位置**：`app.ts:2033-2046` applyDecorPlacements 只 remove 不 dispose；`:2070-2076` clearGhost 只 `scene.remove`；`:2163` removeDecorAtPointer 只 remove；`:2052-2067` selectDecor 每次 `mesh.material.clone()`。
- **后果**：每次切换装饰种类/放置/删除/清空泄漏一份 clone 材质 + 一组几何；卸载时整棵 `decorGroup` 不释放。
- **补丁**：抽 `disposeDecorGroup(group)` 用 Set 去重遍历，在上述四处与 `dispose()` 调用。**注意**：`catalog.ts:37` 的共享 `glowTexture` 恰恰**不要** dispose。

#### T-28 · rebuildKey 重建后宿主 api 仍是死实例 `【本轮新增】` `M` `【静态】`

- **位置**：`Stage.tsx:25/120/136` contextlost → `setRebuildKey`；`App.tsx:95 <RoomScreen key={quality}>` key 不变、`useGameState.ts:42-61` 的 `useEffect([])` 不重跑；`RoomScreen.tsx:47` `const api = stageBridge.current` 陈旧。`app.ts:2765` 已 `changeListeners.clear()`，且 app 公开方法无 `disposed` 守卫（全文仅 `:2481/:2762` 用到）。
- **后果**：重建后布置屏状态/照片不再更新，`setRoomMode/deletePhoto/setCompanion` 作用在死实例上；`Stage.tsx:159-164` 的 `[screen]` effect 不依赖 `rebuildKey`，若重建发生在 memory/workshop 屏，3D 会在遮挡层下全速渲染。
- **补丁**：Stage 重建时派发事件让 `useGameState` 重新 sync，或把 `rebuildKey` 暴露给宿主；`[screen]` effect 依赖里加 `rebuildKey`。

#### T-29 · 构造抛异常的早退分支无清理 `【本轮新增】` `M` `【静态】`

- **位置**：`Stage.tsx:123-126` catch 只 `setFailed(true)`；但 `app.ts:640` canvas 已 append、`:699` window click 已注册、`:613-626` 内联样式已写入，之后才可能抛错（如 `:674/675`）。此时 `app` 仍为 null，cleanup 的 `app?.dispose()`(`:131`) 不执行。
- **补丁**：catch 里 `host.querySelector('canvas')?.remove()` 并复位内联样式。

#### T-30 · takePhoto 异步链无 disposed 守卫 `【本轮新增】` `M` `【静态】`

- **位置**：`app.ts:2204-2290`，`:2218` / `:2232` 两处 `await this.delay(...)`；恢复后仍 `this.postfx.capture(...)`(`:2236`) → `postfx.ts:218 composer.render()` 打在已 dispose 的 renderer 上，随后 `:2256` persistPhotos 写存储，异常被 `:2277` 吞成「拍照失败」。
- **补丁**：两处 await 后各加 `if (this.disposed) return null`，capture 前再判一次。

#### T-31 · fish.ts 漏 `InstancedMesh.dispose()` `【本轮新增】` `L` `【静态】`

- **位置**：`fish.ts:80-85`（每次 setTheme remove 旧 school.mesh 并 new，只 dispose 材质）、`:168-173`（dispose 同样只材质 + `fishGeo.dispose()`）。three 靠 `InstancedMesh.dispose()` 释放 instanceMatrix/instanceColor 的 GL buffer；对比 `bubbles.ts:173-174`、`terrain.ts:313` 都调了。
- **补丁**：两处循环各加一行 `school.mesh.dispose()`。

#### T-32 · 无 `forceContextLoss`、无 `webglcontextrestored` 处理 `【本轮新增】` `L` `【静态+真机】`

- **位置**：`src` 全量 0 处 `webglcontextrestored` / `forceContextLoss`；`app.ts:2774` `renderer.dispose()` 只移除 three 自己的监听、清缓存，不释放 GL 上下文。
- **风险**：`Stage.tsx:117-121` 的 onLost 与 three 内部都 `preventDefault()`（请求浏览器恢复），旧 canvas 又被 `:2782` remove 成脱离文档节点 → 可能留下「已恢复但无人使用」的孤儿上下文。
- **补丁**：`dispose` 里 `renderer.dispose()` 后补 `renderer.forceContextLoss()`（判 `isContextLost` 避免二次），或 onLost 不 preventDefault 直接重建。
- **真机待验证**：是否累积到 Android WebView 上下文上限并导致新 renderer 立刻丢失。

### 低优先记录（批次 5）

- `app.ts:2761-2784` 未调 `this.controls.dispose()`；但 three@0.147 的 OrbitControls 监听全挂 `domElement`，`domElement.remove()`(`:2782`) 后随之回收 → **未发现实质泄漏**，仅清理不完整，建议补一行。
- 重复 dispose：`jellyfish.ts:629` / `clawd.ts:180-188` 的 `createOutlineShell` 复用同一 geometry，group.traverse 会 dispose 两次；three 的 dispose 是派发事件，第二次近似 no-op → 未发现功能问题。`terrain.ts:307-317` 用 Set 去重。
- HMR 重载 `styles.ts` 模块会再注入一份相同 CSS（视觉无影响，需运行时验证）。
- 每帧分配量小：`OrcaBubble.tsx:70` 每帧 `headPosition()` + `getBoundingClientRect()`；`app.ts:2379` 每帧新建 givers 数组；`:1828` 每帧 `[...feedItems]` 拷贝。`bubbles.ts:117-121`、`fish.ts:30` 已用复用 scratch。

---

## 7. 批次 6 · Android 多端一致性

> 本节为 12 个 Java 插件 + manifest / gradle / TS 契约的逐段审查结论。以下文件均位于 `android/app/src/main/java/com/elyoncat/deepsea/`，简称：`Http`=DeepSeaHttpPlugin.java、`Secure`=DeepSeaSecurePlugin.java、`WebChat`=DeepSeaWebChatPlugin.java、`Activity`=WebChatActivity.java、`Api`=WebApiClient.java、`Gallery`=DeepSeaGalleryPlugin.java。

### 确认「健康」的项（勿误改）

- **契约字段名两端对齐**：Android `streamStart` 返回 `streamId`(Http:191-192) ↔ `net.ts:72-74/558`；Electron 返回 `id`(`main.ts:699`) ↔ `net.ts:467-470`；四个事件名 `httpStatus/httpChunk/httpEnd/httpError` 及字段与 `net.ts:76-108` 完全一致 —— 未发现错配。
- **status 先于 chunk**：Http:368-372 在读循环(385)之前单独发 httpStatus；Electron `main.ts:665` 同理。Http:187-195 甚至明确「resolve 必须先于 execute，否则首批 chunk 会丢」，比 Electron 侧考虑更细。
- **非 2xx 读 body**：Http:337-347 `getErrorStream()` 处理 ≥400；`:249-293` 非流与二进制都读错误体，二进制仅在 json/text mime 附 text（与 `main.ts:603-605` 一致）。
- **流必有终点、abort 能中断**：Http:400-406 必发 httpEnd，catch 407-411 必发 httpError，finally 断开连并 `STREAMS.remove`；abort 置 volatile 标记 + `disconnect()`，读循环每块复查 —— **未发现「Promise 永久挂起」的插件侧漏洞**。
- **`@PluginMethod` 主体基本都有 reject**：Http 的 request/requestBinary/streamStart（`:111-195`）与 `:510-516` 的统一 resolve/reject 辅助（reject 走 `runOnMain`）。
- **WebView 未显式开启危险设置**：全仓无 `addJavascriptInterface` / `setAllowFileAccess*` 调用；`Activity:116` 显式 `MIXED_CONTENT_NEVER_ALLOW`；`AndroidManifest.xml:10` `usesCleartextTraffic="false"`、`:31` WebChatActivity `exported="false"`、`:5` `allowBackup="false"`（避免备份恢复造成 Keystore 密文错配，这点是对的）。
- **scoped storage 路径正确**：`Gallery:124-156` 用 MediaStore.Images + RELATIVE_PATH + IS_PENDING（API29+ 免权限），`:158-179` 公共目录分支由 Manifest `WRITE_EXTERNAL_STORAGE maxSdkVersion=28` 兜底；`platform.ts:178-185/264-271` 写 `Directory.Cache` 再 Share（不传 encoding，避免把 base64 当文本）。

### 确认有问题（按严重程度）

#### T-33 · 单线程 `HTTP_POOL` 串行化全部请求 `【本轮新增】` `S` `【静态】`

- **位置**：`Http:67` `Executors.newSingleThreadExecutor()`；`:120`（request）、`:151`（requestBinary）、`:194`（streamStart）**共用它**。注释 `:60-67` 自承「代价是长流会一直占着它」。
- **触发与后果**：任意一次 `netStream`（`deepseek.ts:426`）进行中，再发测连接 / 列模型 / TTS 下载 / 第二次 `streamStart` → 工作线程被 `reader.read()` 独占，后续任务全部排队；第二条流已 resolve 出 streamId 却不吐任何事件，看起来「卡死」。Electron `main.ts:546/583/629` 各自独立 fetch，**可并发** —— 这是 Windows/Android 最大的能力差。
- **补丁（已按复核意见 4 改为有界池）**：**不要**直接用 `newCachedThreadPool()`（无上限，请求堆积时线程数失控）。改为：
  ```java
  // 1 条给非流请求（保持原有「简单可预期」），3 条给流：
  // 覆盖「一条流 + 测连接 + 列模型 + 一次媒体下载」的并发，又不会无限膨胀。
  private static final ExecutorService STREAM_POOL =
      new ThreadPoolExecutor(3, 3, 60L, TimeUnit.SECONDS, new LinkedBlockingQueue<>());
  ```
  或单个 `new ThreadPoolExecutor(0, 4, 60L, TimeUnit.SECONDS, new SynchronousQueue<>())`。
  `STREAMS` / `abortTask` / `runStream` 逻辑都不用动。
- **验收口径**：一条 SSE 流进行中时，`request` / `requestBinary` / 第二条 `streamStart` 都能正常返回，不再排队到流结束。
- **备注**：`Api:56` 的 WebApiClient 也是单线程池，同一类问题；但那条路径是网页账号专用，改动可一并评估。

#### T-34 · Android 拒绝 `http://` 明文端点，Electron 允许 `【本轮新增】` `S` `【静态+真机】`

- **位置**：`AndroidManifest.xml:10` `usesCleartextTraffic="false"`，且全仓无 `network_security_config` 覆盖（已 glob 确认）；对照 `main.ts:218` 显式放行 `http:` 与 `https:`。
- **后果**：用户填自建/局域网端点 `http://192.168.x.x:8000/v1` 时，Android 9+/targetSdk 35 的 NetworkSecurityPolicy 对 HttpURLConnection 同样生效 → 明文被拒，界面只报「连不上」；Windows 正常。**自建中转站是常见场景，不是小众**。
- **补丁（已按复核意见 6 收紧：保留 HTTPS 默认，不全局放开）**：
  1. **保留** `usesCleartextTraffic="false"`。不要为了「两端一致」打开全局明文——那是拿安全性换一致性，方向反了。
  2. `Http:226-229` `readSpec` 解析后对 `http://` 给出明确中文提示，例如「出于安全策略，安卓端不支持明文 http 端点，请改用 https 或配置内网白名单」，让用户知道这是策略拒绝而不是网络故障。
  3. 若确需支持自建内网端点：新增 `res/xml/network_security_config.xml`，**只对用户明确配置的域名**开 `cleartextTrafficPermitted="true"`，在 manifest 用 `android:networkSecurityConfig` 引用。**绝不写 `<base-config cleartextTrafficPermitted="true">`。**
- **验收口径**：默认配置下 `http://` 端点给出可理解的提示（不是「连不上」）；未配置白名单时任何明文请求仍被拒。

#### T-35 · 超时语义不等价：读空闲 vs 总时长硬截止 `【本轮新增】` `M` `【静态】`

- **位置**：`Http:299-300` 仅 `setConnectTimeout` / `setReadTimeout(spec.timeoutMs)`；Electron `main.ts:551-554/647-650` 用 `setTimeout(() => controller.abort(), timeoutMs)`。`deepseek.ts:426` 未传 timeoutMs，两端都落默认 120000。
- **后果**：① 持续吐字的 SSE 流 Android **永不超时**，Electron 120s 到点必掐断并发 `type:'error'`；② 慢速滴水的非流响应 Android 可远超 timeoutMs。
- **补丁**：`runStream`(Http:351) 记 `deadline = now + spec.timeoutMs`，在 `:385` 读循环里检查，超时 `emitError(task, "请求超时（…ms）")`（`net.ts:171` 已能识别 `/timeout|超时/`）。

#### T-36 · 请求头 / URL 校验不对齐 Electron `【本轮新增】` `M` `【静态】`

- **位置**：`Http:305-313` 原样 `setRequestProperty(name, String.valueOf(raw))`；`Http:225-229` `readSpec` 只判空。对照 `main.ts:218`（protocol 白名单）、`:230-235`（header 值必须是 string + 丢弃 `cookie`/`cookie2`）。
- **核实**：`Http:296-297` 的 `(HttpURLConnection)` 强转能隐式挡掉 `file:`/`ftp:`（ClassCastException → reject），所以**不构成文件读取**；但 Cookie 头会被送到第三方端点，非字符串 header 值被强转。
- **评估**：两端都无 host 白名单 → 任意 http(s) 主机可请求，属「支持任意 OpenAI 兼容端点」的**共同设计取舍**；差距主要在参数校验层，不是 Android 单方面缺来源校验（`isTrustedSender` 与 Capacitor 导航限制都只防导航走，都挡不住主页面内 XSS）。
- **补丁**：`Http:306-313` 循环里跳过 cookie/cookie2 + 只接受 String；`readSpec` 用 `new URL(spec.url)` 校验 protocol。同时 `net.ts` 渲染层本身无协议校验（grep 无命中），建议一并补。

#### T-37 · `WebChat.launch` 无 try/catch，初始 URL 不校验 `【本轮新增】` `M` `【静态+真机】`

- **位置**：`WebChat:26-38` 整段无 try/catch、`startActivity` 抛异常即桥无响应，且无条件 `call.resolve()`；`Activity:55-56/187` 把 Intent 的 `url` 直接 `webView.loadUrl(startUrl)`；`Activity:200-211` `handleUrl` 只校验 host、不校验 scheme，且只作用于后续导航。对照 `main.ts:409` 固定 `loadURL('https://chat.deepseek.com/')` + `main.ts:114-121` 显式要求 https。
- **后果**：任意 JS 调 `DeepSeaWebChat.launch({url:...})` 可把任意页面加载进开了 JS/DOM storage/第三方 Cookie 的 WebView 并注入 RelayScript。`platform.ts:147` 正常路径硬编码 chat.deepseek.com，所以属**潜在面**，非已可利用漏洞；`startActivity` 异常时 Promise 永不 settle 是确定的。
- **补丁**：`launch` 包 try/catch → `call.reject`；Activity onCreate 对 startUrl 复用同一白名单并补 https 判断后再 loadUrl。`exported="false"` 已挡住外部 App 直接启动。

#### T-38 · Keystore 损坏不自愈，且回退明文落盘 `【已知未修·关联 T-01】` `M` `【静态+真机】`

- **位置**：`Secure:39-55`（别名不存在/损坏时直接 generateKey）、`:66-78`（解密失败只 `call.reject("Could not decrypt the stored key")`，**不清损坏密文**）；`platform.ts:55-57/69-71` 的 catch 回退 localStorage 明文。
- **核实**：`Secure:76-78` 确认只 reject 不清理；`platform.ts:70` 确认写明文。
- **后果**：清 App 数据 / 换锁屏 / 系统升级导致密钥失效后，旧密文永远解不开，每次 get 都 reject；一旦 `secureSet` 走 catch，API Key 以明文写入 WebView localStorage。
- **补丁（已按复核意见 5 区分错误类型，避免误删凭证）**：
  1. **只在明确的不可恢复错误时清密文**：`KeyPermanentlyInvalidatedException`（换锁屏/生物识别变更导致密钥永久失效）、密文长度非法（`combined.length <= IV_BYTES`）、Base64 解不开。
     处理：`prefs().edit().remove(KEY).apply()` + 删 KeyStore alias，然后 `resolve({value: null})`（走「未配置」，不要 reject）。
  2. **其余异常保留密文、向上抛**：`UserNotAuthenticatedException`（设备未解锁）、`KeyStoreException`、`ProviderException` 等可能是暂时性的 —— `call.reject(...)`，让 TS 层提示「暂时读不出，请稍后重试」，**不要清、不要写明文**。
  3. `platform.ts` 的 `secureGet` 在收到 reject 时**不要**降级读明文（当前实现已改为只做旧版迁移，不再回退）。
- **验收口径**：模拟密钥失效 → 返回「未配置」且密文被清；模拟暂时性异常 → 密文仍在、下次可恢复；两种情况都不产生明文。
- **备注**：网页登录 token 两端都明文落盘（`Api:118-119` SharedPreferences / `deepseek-api.ts:88`），是共同缺陷，已在 T-01 覆盖，非 Android 独有。

#### T-39 · `WebApiClient` 静态 aborted 被排队任务清零 + Android 网页账号无看门狗 `【本轮新增】` `M` `【静态+真机】`

- **位置**：`Api:67` `static volatile boolean aborted`、`:72-82` abortCurrent、`:209`/`:320` 每个 POOL 任务一开工就 `aborted=false`；`web-chat.ts:552-597` `sendViaAndroidHttp` 无超时（对照 `web-chat.ts:320-322` Electron 侧有 `REPLY_TIMEOUT_MS` watchdog）；`abort.ts:45-47` `raceAbort` 在无 signal 时直接返回原 Promise。
- **后果**：① 用户在上一条请求还排队未开始时按「停止」，取消标记被后续任务抹掉，请求照常发出；② Java 回调迟迟不来时渲染层「正在思考」可挂很久。
- **补丁**：`aborted` 换成按轮次的对象 / AtomicLong；`sendViaAndroidHttp` 补 180s setTimeout watchdog（照抄 `sendViaHttp` 写法）。

#### T-40 · P2 组合（局部小改，可合并一批） `【本轮新增】` `L` `【静态】`

| 子项 | 位置 | 补丁 |
|---|---|---|
| resolve/reject 线程约定自相矛盾 | `Http:507-513` 全部 `runOnMain`；`WebChat:91-102/117-127` 回调来自工作线程却直接 `call.resolve` | 两个回调统一 post 回主线程 |
| WebView 回调类 PluginMethod 缺超时兜底 | `WebChat:59-67`(webApiCapture)、`:144-166`(send/state)；WebView 销毁/整页重载时 ValueCallback 可能不触发 | 各加主线程 `Handler.postDelayed` 兜底 `call.resolve({ok:false,...})`，回调里 removeCallbacks |
| Activity / 插件销毁清理不完整 | `Activity:270-278` 未清 `fileCallback`；`Relay:22` 静态 webView 非 volatile；`Http:539-544` 只 abort STREAMS、静态 `HTTP_POOL` 从不 shutdown | onDestroy 补 `fileCallback.onReceiveValue(null)`；webView 加 volatile；shutdown 或改 cached pool（T-33 一并解决） |
| FileProvider 暴露面过宽 | `res/xml/file_paths.xml:3` `<external-path path="." />` 把整个外部存储根挂出去 | 改 `path="Pictures/"` 或只保留 cache-path |
| 少数 @PluginMethod 缺 try/catch | `WebChat:26-38/70-74/137-140/168-172`、`Secure:60/103-107`、`Gallery:60-65/133/150`、`Http:190-195` | 各包一层 try/catch → `call.reject` |

### 多端一致性总结

**设计取舍（有注释，无正确性问题，勿当 bug 修）**
- 网页账号模式 Android 不回流式增量、整段一次性返回（`web-chat.ts:543-551` 明确注释）；Electron 有 `webchat:delta`（`main.ts:886-905`）。
- Android 用独立 Activity + 静态 Relay 跨 Activity 遥控；Electron 用隐藏 BrowserWindow + executeJavaScript。
- 安全存储：Electron safeStorage vs Android Keystore AES/GCM —— 机制等价。
- 保存图片 / 打开文本文件 / keepAwake：三端各有实现，`platform.ts:196-209/345-372/467-470` 已说明。
- Electron `webchat:open` 把 css/js 截到 200k，`Android launch` 不截断 —— 低风险差异。

**应修的能力差（对应上面任务）**：并发 HTTP（T-33）、明文 http 端点（T-34）、流总时长超时（T-35）、头/URL 校验（T-36）、初始 URL 校验（T-37）、Keystore 自愈（T-38）、网页账号 watchdog（T-39）。
**功能缺口**：Android 未提供 `webApiDiagnose`（`global.d.ts:69`；`web-chat.ts:605-607` 直接返回「不支持自检」）与 `webApiLogin` —— 自我诊断 / 一步登录不可用。

---

## 8. 需运行时 / 真机验证（勿写成已复现漏洞）

| # | 事项 | 关联任务 |
|---|---|---|
| 1 | `%2f` 是否原样到达 Electron `protocol.handle` | T-02 |
| 2 | 顶层 `about:blank` 时 preload 桥是否仍注入、能否被外部内容触发 | T-03 |
| 3 | 网关是否发 CRLF SSE / 忽略 `stream:true` 回整包 JSON / 只把类型放 `event:` / 给 `[DONE]` 加尾随空格 | T-10、T-12 |
| 4 | 400 退避 3 次 + 生图 400 重发是否产生 2~3 次计费 / 多条服务端消息 | T-11、T-22 |
| 5 | 停止恰好落在 tool_calls 流式中途的时序复现 | T-04 |
| 6 | 双击 / 生成中切对话 / 错误后 33ms 内立刻重发的竞态时序 | T-08、T-15 |
| 7 | `touch` 竞态在真实 IndexedDB 事务时序下能否复现；网页账号模式下删除记忆后远端线程是否真引用旧事实（对应 `web-relay.ts:381-386` / `deepseek-api.ts:643-644`，见第 10 节） | T-21 |
| 8 | 超大参考图 JSON 是否触发 Electron IPC / Android 桥的序列化上限 | T-19、T-20 |
| 9 | `bestCover` 错配、dedupe 前 80 字符碰撞在真实语料 / 同尺寸 PNG 上的频率 | T-13、T-16 |
| 10 | `protocols.ts:49` `current.name += part.name`：哪些 provider 在每个 tool_calls 分片重复下发 `function.name`（会拼成 `write_filewrite_file`，白耗一轮） | 低优先排队 |
| 11 | Android ROM 进后台时是否置 `document.hidden`（决定 T-26 是「降频」还是「60fps 全速」） | T-26 |
| 12 | WebView 是否真派发 `webglcontextlost`；native `appStateChange` 与 `visibilitychange` 是否在同一前台事件各触发一次导致两次 rebuildKey | T-28、T-32 |
| 13 | `preventDefault` 后旧上下文在脱离文档的 canvas 上被恢复，是否累积到 WebView 上下文上限 | T-32 |
| 14 | HMR 重载时旧 OrcaAquariumApp 实例是否未被 dispose 而留下第二个 rAF loop；上述泄漏的显存增长曲线 | T-23~T-25 |
| 15 | T-34 的明文拒绝文案与机型差异；是否所有 ROM 都对 HttpURLConnection 执行 cleartext 策略 | T-34 |
| 16 | T-37 中主 WebView 默认导航白名单强度、`launch` 任意 url 能否真被页面内 JS 触达 | T-37 |
| 17 | Keystore 别名失效的确切触发场景（清数据/换锁屏/OS 升级）及 `get` 抛出的异常类型 | T-38 |
| 18 | `disconnect()` 能否立刻唤醒已被缓冲的 read；Android `SocketTimeoutException` 文案是否含 `timeout`/`超时`（可能不含 → `net.ts:171` 误判成 'network'）；`HttpURLConnection` 不跟随跨协议重定向 vs Electron `redirect:'follow'` | T-33、T-35、T-40 |
| 19 | `Http:476-481` maybeGzip 与 HttpURLConnection 透明 gzip 的交互（是否二次解压乱码）；自定义 method（PROPFIND/PATCH）在 Android okhttp 的支持差异 | T-40 |
| 20 | 工作线程直接 `call.resolve`（`WebChat:91-102`）在当前 Capacitor 版本是否真丢包；`evaluateJavascript` 在 WebView 销毁/重载时回调是否真丢失 | T-40 |

---

## 9. 明确「未发现」的项（避免重复排查）

- **死循环**：`engine.ts` 工具循环 ≤10 轮（`:43/:634`）、自动续写递归 ≤1 层（`:941`）、长度重试 ≤2（`:736`）、400 退避 ≤3（`deepseek.ts:455`）。畸形/空 `toolCalls` 只占一轮。GPT 猜测的死循环不存在。
- **单次流内工具重复执行**：工具只在流结束后执行一次，`onDelta` 无 `onToolCall`；`protocols.ts:56-60` 按 Map index 定稿去重；`streamOnce` 重发会清空累加器。
- **累积文本 / 消息 id / 轮次计数跨轮覆盖**：全是 `runAssistantTurn` 局部变量，共享可变状态只有全局 `busy` / `activeAbort` / `turnNodeId` 与 store 的 `live`。
- **SSE 半个多字节字符被劈开 / 半个 JSON 误 parse**：三端都按字符流式解码（`net.ts:598-609`、`main.ts:668-678`、`DeepSeaHttpPlugin.java:379-391`），`deepseek.ts:384-389` 又用 buffer 累积到空行才解析。唯一相关缺陷是尾包不 flush（T-10）。
- **错误响应体被喂进 SSE 解析器**：`deepseek.ts:435-441` 置 `sawErrorStatus` 后 onChunk 直接 return，status 事件保证先于 chunk。
- **重试造成重复助手消息**：每次 `runOnce` 都 `resetStream`，只有一次 `finish()`；`engine.ts:667-677` 长度重试也重置累加器，只落一条 assistant。
- **删除记忆后本地 prompt 注入仍取到已删条目**：硬删除 + 每次全表重读 + `memoryVisibleTo` 过滤 + 删除后刷新（例外见 T-21 与第 10 节的网页账号远端残留）。
- **畸形 JSON / 提取失败写入脏记忆**：`deepseek.ts:767-779` 解析失败直接 throw；`extract.ts:116-187` 逐层校验；`memory.ts:93-105` 再过 admit/normalize/sanitize，没有 raw 直接写库路径。
- **各生图/语音协议漏检 HTTP 错误状态**：`media-api.ts:293/340/382/449/683/720/750/787/861/904` 都有 `status >= 400`。
- **base64 被当 UTF-8 文本解码破坏**：`net.ts:264-290` 专走 arrayBuffer/base64，只有 json/text 错误体才 `textOfBytes`。
- **DOMPurify / 代码沙箱**：`markdown.ts:41-44` + 自定义 renderer 的 `escapeHtml`（`:13-30`）；`CodeRunModal.tsx:121/145` 与 `Workshop.tsx:686` 均无 `allow-same-origin`；`CodeRunModal.tsx:89-100` 还校验了 `event.source !== current.contentWindow`。`BUG-REVIEW.md:160-161` 也判定这块干净。
- **IndexedDB 删除对话的级联清理**：`db.ts:182-200` 在一个事务里清 `conversations/messages/summaries/search/media`，注释写明是修过的 P1-30 —— **历史项已修复，不要再列任务**。边界是 `files/notes/photos/usage` 未级联，语义上是否该清需确认，不能断言是 bug。
- **orca 动画循环 / 订阅 / 数组上限**：rAF 正确 cancel、无并行 loop、`dt` 有 clamp、ResizeObserver 与 AppStateChange 订阅都有配对清理、`trail`/`feedItems`/`photos`/`glyphs` 都有 cap —— 未发现泄漏（详见第 6 节「保留」部分）。**但「`dispose()` 调用列表齐全」不等于资源真的释放**，见 T-23/T-24/T-25。
- **Android 插件契约与 WebView 基础面**：字段名与事件名两端对齐、status 先于 chunk、非 2xx 读 body、流必有终点、abort 能中断、无 `addJavascriptInterface` / `setAllowFileAccess*`、mixed content 禁用、`exported="false"`、`allowBackup="false"`、scoped storage 路径正确 —— 均判定干净（详见第 7 节）。**但单线程池与 cleartext 策略是两个实打实的能力差**，见 T-33/T-34。

> **修正本轮早先的两处判断**：
> 1. 初轮曾说「DOMPurify 未见明显问题」。实际上 `BUG-REVIEW.md:128` 已记录「markdown.ts:41-44 放行 `target` 且无链接拦截——与 P0-3 同源，导航/钓鱼面」。DOMPurify 的 XSS 防护没问题，但 **`ADD_ATTR: ['target']` 配合无链接拦截是已知隐患**，应与 T-03 的导航白名单一起看。
> 2. 初轮曾说「3D 生命周期健康、`dispose()` 覆盖完整」。逐段审查**推翻**了这一判断：只核了 `app.ts:2761-2784` 调用了哪些 `dispose()`，没核它们内部是否真释放。实际是虎鲸整模型 0 处 dispose、`postfx.dispose()` 不遍历 passes、window 监听未清理导致背景音乐复活。已在第 6 节开头登记并全部改为 T-23~T-32。

---

## 10. 低优先排队（不阻塞主线）

- `engine.ts:438-444` 群聊间隔定时器的 abort 监听器正常路径不 `removeEventListener`（只有真的 abort 靠 once 移除）。
- `deepseek.ts:393` / `media-api.ts:820` `[DONE]` 尾随空白不识别（`.trim()` 一行）。
- `deepseek.ts:390-394` `event:` 行被整体丢弃；若某供应商只把类型放 `event:` 而 data 无 type → 空回复（需运行时确认）。
- `media-api.ts:209` 下载与生成的超时口径不一致；`:912-913` 200 JSON 的 `data.audio` 未校验 base64。
- `memory.ts:247` 重复检测先 `slice(0,200)` 再准入，可能写入拦腰截断的事实。
- `deepseek.ts:384` / `media-api.ts:832` 非 SSE 长行导致 buffer 无界，建议 1MB 上限 + 完整 JSON 兜底。
- `deepseek.ts:341-348` OpenAI 兼容分支字段兜底窄（`delta.reasoning`、content 数组、`choices[].message` 不认）。
- `web-relay.ts:381-386` + `deepseek-api.ts:643-644`：网页账号模式删除记忆后远端线程仍看得到（context 变化只是追加一条消息，`deepseek.ts:505-511` 注释明确「网页会话只能追加」）。建议删除时同步发一条「以下事实作废」的纠正消息。
- `engine.ts:940-958` 自动续写与 `lengthRetries` 多层重试叠加（最坏 ≈20 次迭代 / ~90 次 HTTP），有界但无单一总闸门；`activeLimit` 抬高后沿用到后续轮次。
- `protocols.ts:49` `current.name += part.name` 拼接问题（见第 8 节 #10）。

---

## 11. 给执行者的约束

1. **先备份**：项目惯例是 `_backup-<topic>-<YYYYMMDD-HHMMSS>`（参考已有 8 个备份目录）。
2. **逐批提交，每批独立可回滚**；批次 1、2 优先，批次 3/4 可并行，批次 5/6 最后。
3. **不要重构**：所有任务都是守卫、条件、字段、一两个函数的局部改动；`engine.ts` 的状态隔离骨架是对的，动结构只会引入新风险。
4. **改前重读文件**：行号基于 2026-11-12 快照，项目迭代快（`_backup-*` 目录里同名文件行号已不同）。
5. **区分静态结论与推测**：第 8 节的项必须标注「待验证」，不要把推测写成已复现漏洞。
6. **不要重做已修项**：第 9 节列出的、以及源码里带 `BUG-REVIEW Pn-x` 修复注释的位置。
7. **纯 Web 预览版**没有安全存储是设计取舍，标注安全级别即可，不要试图在浏览器里造加密。
8. **每批必须交四项**（复核要求，硬性）：**修改文件清单 + 修改前后差异 + 测试结果 + 未解决问题**。四项不齐不算完成，不接受「一次性改完 40 项」的提交。
9. **测试环境注意**：本机沙箱会拦截 `child_process.spawn` 的管道 stdio，`npm test` 会大面积报 `spawn EPERM`。这是环境限制，不是测试失败。用 `node --experimental-test-isolation=none --test "test/**/*.test.ts"` 可绕开（已知仍有 1 项 `web-relay.test.ts` 因 esbuild 需要 spawn 而失败，同属环境限制）。

---

## 12. 批次 1 执行记录（2026-11-12）

### 12.1 备份

```
_backup-review-fix-b1-20261112-151000/
├── electron/main.ts
├── electron/deepseek-api.ts
├── src/lib/platform.ts
├── src/lib/settings.ts
├── src/lib/store.ts
└── REVIEW-FIX-TASKS.md
```

回滚：把上述文件按原路径覆盖回去即可（本次改动**全部**落在这 6 个文件 + `README.md`）。

### 12.2 修改文件清单

| 文件 | 改动性质 | 对应任务 |
|---|---|---|
| `electron/main.ts` | `encrypt()` 去掉明文降级并抛错；`decrypt()` 保留 `raw:` 只读兼容；`secure:get` 就地升级旧值；`registerAppProtocol` 换 `relative()` + host 校验 + decode try/catch + 目录判定；信任判断拆成 `isTrustedIpcSenderUrl` / `isAllowedMainWindowNavigation` | T-01、T-02、T-03 |
| `electron/deepseek-api.ts` | 引入 `safeStorage`/`unlinkSync`；新增 `StoredSession`（`sealed` 标记）、`sealToken`/`unsealToken`/`writeSessionFile`；`loadSession` 兼容旧明文并升级；`forgetWebSession` 改 `unlink` | T-01 |
| `src/lib/platform.ts` | 新增 `SecureStorageError`；`secureSet` 不再落明文、改为抛错；`secureGet` 增加旧明文一次性迁移；`secureRemove` 调整顺序 | T-01 |
| `src/lib/settings.ts` | `loadSettings` 对安全存储读取失败降级为「本次无 Key」，避免整个设置回退成默认值 | T-01 健壮性 |
| `src/lib/store.ts` | `setSettings` 捕获 `SecureStorageError` 并 toast 提示「这次的 API Key 没有保存」 | T-01 |
| `README.md` | 安全说明与数据表补「加密不可用时不降级明文」 | T-01 |
| `REVIEW-FIX-TASKS.md` | 并入复核意见 1–6、补执行顺序约束与验收口径 | 全部 |

**差异统计**（`git diff --no-index` 对比备份，逐文件）：

| 文件 | 增 | 删 |
|---|---|---|
| `electron/main.ts` | +94 | −23 |
| `electron/deepseek-api.ts` | +91 | −12 |
| `src/lib/platform.ts` | +66 | −13 |
| `src/lib/settings.ts` | +9 | −1 |
| `src/lib/store.ts` | +13 | −1 |
| `README.md` | +3 | −2 |
| **合计** | **+276** | **−52** |

> 编码提醒：`README.md` 原本是 UTF-8 **带 BOM**，编辑过程中 BOM 被去掉过一次，已恢复并核对（现在 diff 只剩那 2 处内容改动）。另外 5 个源文件原本无 BOM，无需处理。

### 12.3 差异要点（行为层面）

**T-01 凭证存储**
- 改动前：`safeStorage` 不可用 → 写 `raw:<base64>`；Android 插件失败 → 写 `localStorage` 明文；网页 token → `writeFileSync` 明文。
- 改动后：三条路径**都不再产生明文**。`encrypt()` 抛 `SecureStoreUnavailableError`；`platform.secureSet` 抛 `SecureStorageError` 并由 store 提示用户；`deepseek-web-session.json` 只写 `enc:` 密文，加密不可用时**根本不写文件**（只留内存）。
- **旧数据不失效**（复核意见 1）：`raw:` 仍可读，读到即升级为 `enc:`；Android 旧 `localStorage` 明文读到即搬进 Keystore，搬不动则保留原值不删。

**T-02 路径校验** —— 已实证（见 12.4）。

**T-03 信任拆分**
- 改动前：`isTrustedFrameUrl` 无条件放行 `about:blank`/`about:srcdoc`，且 `will-navigate` 与 IPC 共用它。
- 改动后：IPC 用 `isTrustedIpcSenderUrl`（只认 `app://deepsea` + dev origin，**不含 `about:*`**）；导航用 `isAllowedMainWindowNavigation`（同上）；`frame.parent !== null` 的子框架排除保留。

### 12.4 测试结果

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ **通过，0 错误** |
| `node --experimental-test-isolation=none --test "test/**/*.test.ts"` | **423 项：416 通过 / 6 跳过 / 1 失败** |
| 唯一失败项 | `test/web-relay.test.ts`「生成的中继脚本能被 new Function 解析」—— 原因是 `esbuild` 需要 `spawn` 子进程，被本机沙箱以 `EPERM` 拦截。**与本次改动无关**（该测试不触碰任何被改文件）。 |
| `npm test`（默认多进程模式） | ❌ 全量 `spawn EPERM`，纯环境限制，非代码失败 |

**路径穿越实证**（独立脚本，同一批 URL 分别跑旧/新判断）：

```
app://deepsea/index.html                     decoded=/index.html
  old(startsWith)=true   new(relative)=true      ← 合法路径不受影响
app://deepsea/assets/app.js                  decoded=/assets/app.js
  old(startsWith)=true   new(relative)=true      ← 合法路径不受影响
app://deepsea/%2e%2e%2fdist-other/secret.txt decoded=/../dist-other/secret.txt
  old(startsWith)=true   new(relative)=false     ← 修复前可穿越，修复后被拒
app://deepsea/..%2fdist-other/secret.txt      decoded=/../dist-other/secret.txt
  old(startsWith)=true   new(relative)=false     ← 同上
```

这同时证实了此前的分析：URL 解析器**不会**折叠 `..%2f`（`..` 未构成完整 segment），所以 `decodeURIComponent` 之后才会出现真实 `..`。

### 12.5 未解决问题 / 未验证项

1. **未在真机运行**：Electron 未启动、Android 未构建。`safeStorage` 不可用路径、Android 插件 `reject` 路径均为**代码层确认，未做运行时验证**。
2. **`%2f` 是否原样到达 `protocol.handle`** 仍未在 Electron 中确认（静态链路 + 独立脚本已证逻辑正确，但 Chromium 是否规范化该编码需真机）。若 Chromium 提前拒绝，则 T-02 的利用面比分析更小；若原样传递，则修复已生效。
3. **顶层 `about:blank` 的 preload 桥行为**未验证（T-03 只收紧了白名单，未证明原路径可被利用）。
4. **`SecureStorageError` 的用户提示只覆盖 `setSettings`**。其他调用 `secureSet` 的路径（如未来新增）需同样处理；当前 `settings.ts` 的 `persistSettings` 是唯一写入点，已覆盖。
5. **`loadSettings` 现在把「安全存储读取失败」降级为「本次无 Key」**，只打 `console.warn`，用户看不到「Key 暂时读不出」的提示 —— 他会以为 Key 丢了然后重新输入，覆盖掉可能还能恢复的密文。建议后续加一个「安全存储异常」状态位并接到设置页（未纳入本批，因为要动 UI）。
6. **「加密不可用导致网页登录态不持久化」没有用户可见提示**，只有主进程 `console.warn`。用户下次启动需重新登录，但不会知道原因。建议后续在登录成功回调里补一条 notice（改动涉及 `webapi:login` 返回值形状，未纳入本批）。
7. **`DeepSeaSecurePlugin.java` 本批未改**。T-38 的「区分密钥失效与暂时异常」是 Android 原生改动，属批次 6；当前 TS 侧只保证「读不出时不落明文」，未保证「不清可恢复的密文」——因为清理逻辑本来就在 Java 里，本批没有触碰。
8. **README 之外的文档未同步**：`docs/` 下若有提及安全存储的段落未逐一核对。
9. **批次 2 的 T-04 必须与 T-05/T-06 同批**（复核意见 2），单独做任何一条都会引入新风险 —— 这是下一批的首要约束。

---

## 13. 批次 1 补充修复（2026-11-12 第二轮）

复核指出 12.5 的第 4、5 项（用户看不到安全存储异常）必须当轮修掉，并要求补模拟测试与手动验收计划。本轮的落地结果：

### 13.1 新增 `secureStorageStatus` 三态

- 新增 `src/lib/secure-types.ts`：`'available' | 'unavailable' | 'read-error'` + 用户文案常量。
- 新增 `src/lib/secure-credentials.ts`：**凭证写入闸门（vault）**。它把「读失败」和「没配置」分开，并保证：
  - `read-error` 下空 blob（只改普通设置）→ 静默跳过；
  - `read-error` 下非空 blob（想写新 Key）→ 抛错拒绝，**绝不覆盖**；
  - 任何失败路径都不改动已知密文，也不删。
- `src/lib/settings.ts`：`loadSettings` / `persistSettings` 全部改走 vault；新增 `getSecureStorageStatus()`、`loadCredentialBlob()`、`persistCredentialBlob()`。
- `src/lib/store.ts`：`boot()` 检测到 `read-error` 时同时写常驻 notice + toast，文案逐字为
  **「安全存储读取失败，请勿重新输入Key，建议重启应用」**（刻意不含「API Key」，避免触发 Chat 里的「去填 Key」链接）。

### 13.2 为了可测而做的三处抽取（均为纯逻辑，不改行为）

| 新模块 | 从哪抽出来 | 为什么 |
|---|---|---|
| `electron/secure-store.ts` | `main.ts` 的 encrypt/decrypt/读写文件 | `main.ts` 直接 import electron，node 测不了；抽出来后 `secure:get/set` 的全部逻辑可测 |
| `electron/app-protocol-path.ts` | `main.ts` 的 `registerAppProtocol` 主体 | 路径判断要能对每种编码变体做回归 |
| `electron/trust.ts` | `main.ts` 的 URL 信任判断 | 同上；frame 级守卫仍留在 `main.ts`（Electron 类型只在那层可用） |
| `src/lib/android-secure.ts` | `platform.ts` 的 Android 分支 | 迁移/降级规则要能注入假插件测试 |

`platform.ts` 现在只负责注入真实依赖（Capacitor 插件、localStorage、IPC 桥）。

### 13.3 接口变更（会影响调用方，务必知悉）

- `secure:get` 的返回值从 `string | null` 改为 `{ value, status }`。
  涉及 `electron/main.ts`、`electron/preload.ts`、`src/lib/global.d.ts`、`src/lib/platform.ts`。
- `platform.secureGet()` 改名 `platform.secureRead()`（返回带状态）。
- `settings.ts` 不再直接调用 `secureSet` / `secureRemove`（有源码断言守着，见 C9）。

### 13.4 新增测试

| 文件 | 覆盖 |
|---|---|
| `test/secure-storage-electron.test.ts` | 9 项：不可用抛错、不产生文件、原密文不变、文件无明文/无 Base64、正常读写、旧 `raw:` 迁移、解密失败不改文件、「没配置 vs 读失败」可区分 |
| `test/android-secure.test.ts` | 12 项：写入失败抛错、无明文通道、迁移失败保留旧值、迁移成功才删、读失败不伪装未配置、插件未注册→unavailable、成功路径、删除、异常分类、文案逐字 |
| `test/settings-secure-status.test.ts` | 10 项：三态读取、read-error 后改普通设置/重新加载/写新 Key、**失败路径遍历不破坏密文**、available 不回归、settings 不得绕过 vault、文案逐字 |
| `test/app-protocol-path.test.ts` | 10 项：合法路径、`%2e%2e%2f`、混合编码、双重编码、字面 `..`、非法百分号、错误 host、畸形 URL、目录/文件边界 |
| `test/ipc-trust.test.ts` | 11 项：合法 URL、外部站点、`about:blank`、`about:srcdoc`、可疑协议、伪造 URL、dev origin、导航白名单、**结构断言**（frame 守卫仍在、无 about 后门、两个函数没被合并） |

**合计新增 52 项**，全部通过。

### 13.5 本轮结果

- `npx tsc --noEmit`：0 错误。
- 全量测试：**475 项 / 468 通过 / 1 失败 / 6 跳过**。
- 唯一失败项 `web-relay.test.ts`「生成的中继脚本能被 new Function 解析」：esbuild 需要 spawn 子进程，被沙箱 EPERM 拦截。**证据**：单独 `node -e "require('esbuild').transformSync('const a=1')"` 同样报 `EPERM / spawn EPERM`；该文件另 3 项不依赖 esbuild 的测试全部通过；该测试读取的 `src/lib/web-relay.ts` 本轮未改动。**结论标记为「环境受限、未确认」**，需在可 spawn 的环境重跑才能销案。

### 13.6 手动验收

见 `docs/BATCH1-MANUAL-TEST-PLAN.md`（Windows 8 项 / Android 6 项，每项含前置、步骤、预期、失败判定、清理）。**自动化测试是模拟测试，不等于真机验证。**

---

## 14. 批次 2 执行记录（T-04 ~ T-09）

> 解冻依据：批次 1 全量测试已回到 0 失败（esbuild `spawn EPERM` 随沙箱策略放开而消失），
> 且 `tsc --noEmit` 0 错误。批次 2 只改 `src/lib/engine.ts` / `src/lib/media-tools.ts`，
> 不碰批次 1 的凭证与 IPC 代码。

### 14.1 T-04 停止时丢掉半截 tool_calls `✅已实施`

- 在构造 assistant 消息前算出 `usableToolCalls`：`result.aborted` 或 `toolCalls` 为空时为 `undefined`。
- 消息里的 `toolCalls` 与 `workspaceName` 标签都改用这个变量。
- **为什么是「丢掉」而不是「补占位」**：停止语义就是「这一轮不算数」；半截调用连参数都不完整，
  执行它比丢掉更危险。丢弃后不存在 `assistant.tool_calls`，也就不存在配对问题。

### 14.2 T-05 写入层 abort 守卫 `✅已实施`

- `while (iteration < MAX_TOOL_ITERATIONS)` 顶部加 `if (signal.aborted) break`。
- 工具循环内：停止后**为每条未执行的 call 落一条 `role:'tool'` 的占位消息**
  （「已停止，这个工具没有执行。」）并继续循环。
  > 这里刻意不用 `break`：这条 assistant 的 `tool_calls` 已经写进库了，
  > 少一条配对响应，下一轮就是 400 —— 正是 T-04 要消灭的那个失败模式。
- `runTool` 里媒体落库条件改为 `mediaDrafts.length > 0 && !signal.aborted`
  （消息本身照旧落，保持配对；字节不再留在库里）。

### 14.3 T-06 break 之后的收尾包守卫 `✅已实施`

- 循环结束后加 `if (signal.aborted) return { spoke: … }`，跳过
  `bumpConversation` / `refreshConversations` / `detectRepeatedMemories` / `maybeCompress`。
  > `maybeCompress` 会真发一次网络请求，停止后再花一次钱说不过去。
- `addUsage` 整块包进 `if (!signal.aborted)`。
- `detectRepeatedMemories(...).then(...)` 补 `.catch(() => undefined)`。

### 14.4 T-07 媒体生成的取消 `✅已实施（原生非流请求的真取消仍留待后续）`

- `runGenerateImage` / `runSpeak` 在请求返回后复查 `context.signal?.aborted`，
  已取消则返回「已停止…」且 `media: []`（不落库、不让模型以为成功）。
- 两个 `catch` 用 `isMediaAbort(error)` 区分「取消」与「失败」——`isMediaAbort` 此前全仓零调用。
- `engine` 侧媒体落库条件已由 T-05 覆盖。
- **未做**：原生 `netRequest` 通道传 `signal` 需要新增 abort IPC，按原计划留到后续迭代。

### 14.5 T-08 全局状态归属判断 `✅已实施`

新增 `beginTurn()` / `endTurn(turn)` 两个模块级函数：

- `beginTurn()`：`busy` 已被占用就返回 `null`，否则**同步**置位 `busy` 并建本轮专属
  `AbortController`（检查与置位之间没有 await，双击开不出两轮）。
- `endTurn(turn)`：`activeAbort !== turn.abort` 时直接返回，只复位「自己还是当前轮」的那份。

五个入口全部改为 `beginTurn()` 占位 + `endTurn(turn)` 复位：
`sendMessage`、`sendGroupMessage`、`continueTurn`、`regenerateAtMessage`、`editAndResend`。
`sendMessage` 的四个早退分支（本地指令、离线回复、登录失败 ×2）也补了 `endTurn`。
`sendGroupMessage` / `continueTurn` 原先漏清的 `turnNodeId` 一并补上。

### 14.6 T-09 本地指令 / 离线回复纳入取消 `✅已实施`

- 两个函数改为接收 `signal`，并在写回复前判断 `if (signal.aborted) return true`。
- 去掉它们自带的 `busy = true` / `finally busy = false`：`busy` 现在由 `sendMessage` 的
  `beginTurn` 统一持有，否则本地路径一结束就把调用方那份提前放掉。
- `runOfflineReply` 的 `try/finally` 随之拆掉（不再需要）。

### 14.7 T-15 debounce timer 泄漏 `✅已实施`

`streamChat(...)` 的 promise 上挂 `.finally()`：清 `timer`、复位 `pendingFlush`、
调 `bodyMind.drainEvents()`。成功 / 抛错 / 被 abort 三条路都会经过它。

> 以前只有「正常返回」那条路会走到 `flush()`，网络中断 / SSE error / 400 退避耗尽时
> 定时器留在那儿，33ms 后照样 `updateLive()` —— 若新一轮已经 `startLive()`，
> 上一轮半截正文就写进新一轮的占位气泡。

### 14.8 测试

| 文件 | 变化 |
|---|---|
| `test/batch2-cancel.test.ts` | **新增 13 项**，逐条守着 T-04 ~ T-09 与 T-15 的结构不变量 |
| `test/sending-state.test.ts` | 两条断言改为适配 `beginTurn`/`endTurn` 设计；`stripComments` 改为 CRLF 安全（Windows 检出下 `.*$` 匹配不到 `\r`，整行注释剥不掉） |
| `test/data-consistency.test.ts` | P1-3 改为断言「`beginTurn()` 在第一个 await 之前、且 finally 用 `endTurn(turn)`」 |

**本轮结果**：`tsc --noEmit` 0 错误；全量 **545 项 / 539 通过 / 0 失败 / 6 跳过**；
`vite build` 成功。

### 14.9 还没验证的（重要）

以上全部是**源码结构断言 + 类型检查 + 打包**，不是行为验证。真机上必须人工确认：

1. 模型正在吐 tool_calls 参数时点停止 → 再发一条消息，**不应出现 400**；
2. 停止后立刻再发一条 → 上一轮不该把新一轮的状态清掉（停止键仍然可用）；
3. 停止后等 1 秒 → 不应该出现「幽灵半截气泡」；新一轮气泡里不应混进上一轮的字；
4. 停止后看用量/摘要：不应新增记账；
5. 生图/语音进行中点停止 → 不应出现「已生成」卡片，媒体表里不该留字节。

---

## 15. 批次 3 执行记录（T-10 ~ T-20）

### 15.0 基线

| 项 | 值 |
|---|---|
| 基线 SHA | `1cde1dd`（`fix/orca-bubble-copy` 的 HEAD） |
| 开发分支 | `fix/batch3-parser` |
| 开工前复核 | `git rev-parse fix/orca-bubble-copy` = `1cde1ddfb1f41dba2ebeb17c82faf7e4c7dfa886`，与预检报告一致，没有漂移 |
| 落地前的绿线 | `tsc --noEmit` 0 错误；全量 **525 项 / 519 通过 / 0 失败 / 6 跳过** |

> 没有在 `wip/ui-feedback-1-legacy` 上直接改：那个工作区的 `engine.ts` 还是 PR #4 之前的版本
> （`git diff fix/orca-bubble-copy -- src/lib/engine.ts` 能看到 `turnGate`/`runSend` 被换回 `let busy`）。

### 15.1 分组与提交

| 组 | 条目 | 提交 |
|---|---|---|
| A | T-10 + T-11 | `fix(deepseek): SSE 尾包 flush + 400 退避真的剥字段` |
| B | T-12 + T-16 | `fix(media): 语音 SSE 容忍 CRLF 边界 + 多图判重不再误杀` |
| C | T-19 + T-20 | `fix(media): 体积上限真正接线` |
| D | T-14（T-17 暂缓） | `fix(engine): 媒体写入失败/消息落库失败时回滚` |
| — | T-13（核实后清理） | `refactor(memory): planUpsert 的「两条判定线」其实是一条` |

### 15.2 T-10 SSE 尾包 + 非 SSE 兜底 `✅已实施`

- 收流后补一次 `consume('\n\n')`（`done` 为真时跳过），把没有空行结尾的最后一个事件收进来。
- `sawPayload` 标记「这一轮到底解析出过事件没有」，据此区分「网关按 SSE 说话但正文确实为空」
  与「网关压根没按 SSE 回」。后者再按整包 JSON 兜一次正文（`parseCompleteContent`），
  解析出正文就当一次增量交给界面。
- 与 media-api.ts 的既有写法对齐（那边一直有 flush + 非 SSE 兜底）。

### 15.3 T-11 400 退避 `✅已实施`

- `stream_options` 分支补 `delete body.stream_options`（原来只关 `includeUsage` 开关，
  `{...body}` 展开时字段仍在，同一个 400 会重试满三次整段请求）。
- `reasoning_content` 分支改为「真的剥掉了才算 changed」。
- **没有**加原补丁里的「非 OpenAI 时 `body = buildBody(sentLimit)` 重建」：协议层的
  `toAnthropicMessages` / `toGoogleContents` 是从 text/images/tool_calls 重新拼消息的，
  本来就不带 `reasoning_content`，重建等于没改。代码里留了注释说明，真要支持得改协议层。

### 15.4 T-12 CRLF 边界 `✅已实施`

`raw.indexOf('\n\n')` → `/\r?\n\r?\n/.exec(raw)`，与 `deepseek.ts` 的 SSE 解析一致。
注意单事件 + CRLF 靠收尾 flush 侥幸能过，真正炸的是**一个 chunk 里多个 CRLF 事件**，
测试按这个形状写。

### 15.5 T-13 bestCover 错配 `✅已核实：不是 bug`

见上方 T-13 条目。一句话：`jaccard` 恒 ≤ `containment`，所以 `Math.max(score, cover)` 永远
等于 `cover`，`bestScore` 与 `bestCover` 恒等，原补丁是空操作。本次只做等价清理。

### 15.6 T-14 孤儿媒体 `✅已实施`

两处失败路径都回滚（`db.ts:602` 的 `deleteMediaByMessage`）：
`putMedia` 循环中途抛错、`appendMessage` 最终失败。没有采用「先 append 占位消息再写媒体」——
它与「引用必须先能查到」的渲染顺序冲突，也会破坏 T-05 的停止语义。

### 15.7 T-16 b64 前 80 字判重 `✅已实施`

判重键改「长度 + 头 80 + 尾 80」，兼顾区分度与内存（不拿完整 base64 当 key）。

### 15.8 T-19 / T-20 体积上限 `✅已实施`

见上方 T-19 的实施记录；`bytesToBase64` 改数组 join，TTS 解析完释放 `raw` / `audioData`。

### 15.9 T-17 工具跨轮重放去重 `⏸本轮暂缓`

理由与实施要求写在 T-17 条目里。**不进本分支。**

### 15.10 测试

| 文件 | 变化 |
|---|---|
| `test/stream-parser.test.ts` | **新增 6 项**，真 `streamChat` + 真 `net.ts` 传输层，只 stub `globalThis.fetch` |
| `test/media-tools.test.ts` | **新增 6 项**（T-12 / T-16 / T-19 ×4） |
| `test/media-rollback.test.ts` | **新增 4 项**（T-14 源码结构断言，engine 依赖 IndexedDB 跑不起来） |
| `test/memory-core.test.ts` | **新增 1 项**（T-13 的 `jaccard ≤ containment` 不变量） |

**验证方式**：每条用例都做过「回滚实现 → 变红 → 恢复 → 变绿」。
唯一的例外是 T-13：它是等价重构，**前后都绿**（换回旧实现跑同样用例也全绿）。

**本轮结果**：`tsc --noEmit` 0 错误；全量 **542 项 / 536 通过 / 0 失败 / 6 跳过**；`vite build` 通过。

### 15.11 还没验证的（重要）

以上全部是**自动化测试 + 类型检查 + 打包**，不是真机行为验证。真机上需要确认：

1. 用**末尾不带空行**的网关（或抓包确认）聊一轮长回复 → 最后一段正文与用量都在，不丢字；
2. 换一个忽略 `stream:true`、直接回整包 JSON 的中转站 → 能正常出字，不再是空白气泡；
3. 换一个只认老字段的中转站（会 400 提 `stream_options`）→ 第二次请求能成功，
   日志里不该看到同一个 400 重试三次；
4. OpenRouter 语音（若网关回 CRLF）→ 能正常出播放器，不再是「语音模型没有返回音频」；
5. 一次要 4 张图 → 4 张都回来，不是 1 张；
6. 生图/语音期间杀掉进程或断网 → 重新打开后媒体表里没有孤儿记录（这条只能靠日志/开发者工具看）。

### 15.12 本分支没做的

T-17（暂缓）、T-18（浏览器通道超时）、T-21 ~ T-40。T-18 仍是 `deepseek.ts` 三个调用点
各补一个 `timeoutMs: 120000` 就能落地的小改动，随时可以单开一个提交。

