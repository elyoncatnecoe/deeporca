# 界面底色全量重构清单（浅色 / 暖色适配）

> 目标：三套色调（深海=深、雾霭=冷白浅、暖阳=奶油暖白）切换时，**整个 App 的底色、面板、文字、线条、高光、输入框、代码块、弹层、系统栏、选中手柄**都跟着走，且不牺牲可读性与美观。
>
> 现状判断：上一版只把「三层深色面」抽成了 `--surface-rgb / --surface-2-rgb / --deep-rgb`，属于打地基。**全站仍有大量写死值没有接入**，所以用户会看到「底色变了、但输入框还是深的、字还是浅的」。这是预期内的半成品状态，不是终点。

---

## 0. 结论先行（两个问题的根因）

### 0.1 底色切换不全面
全站颜色分散在 4 个 CSS 文件 + TSX 内联样式 + 原生资源里，上一版只覆盖了其中一小类。实测统计（`src/*.css`）：

| 类别 | 数量 | 状态 |
|---|---|---|
| 品牌青线 `rgba(127,227,212,α)` | **100 处** | ❌ 未 token，浅色底上发灰发闷 |
| 深色面 literal（各种深蓝黑） | **约 45 种三元组 / 80+ 处** | ⚠️ 只接入了 3 种，剩下 40+ 种没接 |
| 白色高光 `rgba(255,255,255,α)` | **15 处** | ❌ 浅色底上等于消失 |
| 写死深色 hex（代码块 `#071820`、`#04211f`、`#061c26` …） | 10+ | ❌ |
| 浅色文字 hex（行内代码 `#bdf6ec`、`#cfe9f2`…） | 6+ | ❌ 浅色底上不可读 |
| CodeMirror 编辑器 | 整套 `@codemirror/theme-one-dark` | ❌ 恒暗 |
| 原生系统栏 / 对话框 / 手柄 | styles.xml 固定 `#04141d` | ❌ 恒深 |

**典型漏网点**（用户已肉眼看到的那类）：
- `.composer { background: rgba(7, 27, 37, 0.82) }`（输入区）—— `7,27,37` 不在已接入的三层里。
- `.drawer-digest-input { background: rgba(8, 27, 39, 0.5) }`
- `.code-card { background: #071820 }`、`.markdown code:not(pre) { color: #bdf6ec }`
- `.field input` 虽用了 `--surface-2-rgb`，但 alpha 0.65 叠在浅底上偏灰，需要单独的输入框 token。
- 状态栏 / 导航栏在 styles.xml 里写死 `#04141d`，浅色主题下顶部/底部仍是深色条。

### 0.2 选中手柄白底（每次都有）
根因：**WebView 内容里的选择手柄由 Chromium 自己绘制**（`HandleView` + 框架/WebView 自带 drawable），并不走我们主题里的 `android:textSelectHandle*` —— 那几个属性只对 **TextView** 生效。所以我们把 `ds_handle.xml` 换成青色竖线，对 WebView 内的手柄**大概率无效**，白底照旧。这也解释了「光标（输入插入符）可能变了、但选中手柄白底没变」。

> 这一条不能靠「再调一个属性」碰运气，必须用**可控的实现**（见第 5 节，推荐网页自绘手柄）。

---

## 1. 令牌体系（先立标准，再逐个替换）

原则：**任何颜色都不许在组件里写死**，只允许两种写法：`var(--token)` 或 `rgba(var(--xxx-rgb), α)`。

### 1.1 现有令牌（保留）
`--bg --bg-2 --surface-rgb --surface-2-rgb --deep-rgb --glass --glass-strong --line --line-strong --text --dim --faint --accent --accent-2 --aqua --danger --shadow --bubble-user-*`

### 1.2 需要新增的令牌

| 新令牌 | 用途 | deep（现状） | iceberg（冷白） | tropical（暖白） |
|---|---|---|---|---|
| `--line-rgb` | 品牌青线（100 处 `127,227,212`） | `127, 227, 212` | `58, 120, 132`（深青，浅底可见） | `170, 96, 58` |
| `--sheen-rgb` | 白色高光/内描边（15 处） | `255, 255, 255` | `15, 35, 45`（深色低 α） | `60, 30, 15` |
| `--field-rgb` | 输入框/文本域底 | `7, 27, 37` | `255, 255, 255` | `255, 255, 255` |
| `--field-border` | 输入框边框 | `--line` | `rgba(18,51,61,.22)` | `rgba(58,31,20,.22)` |
| `--code-bg` | 代码块底 | `#071820` | `#f4f8fa`（或刻意保留深色，见 4.3） | `#faf3ec` |
| `--code-ink` | 代码块正文 | `#cfe9f2` | `#17323a` | `#3a2418` |
| `--code-inline-bg` | 行内 code 底 | `rgba(127,227,212,.1)` | `rgba(58,120,132,.12)` | `rgba(170,96,58,.12)` |
| `--code-inline-ink` | 行内 code 字 | `#bdf6ec` | `#1f5960` | `#7a3f1f` |
| `--chip-bg` / `--chip-ink` | 小徽章/chip | 半透明青 | 浅底深字 | 浅底深字 |
| `--overlay-rgb` | 弹层遮罩 | `2, 10, 15` | `20, 35, 45` | `40, 25, 15` |
| `--scrollbar` | 滚动条 | `rgba(147,183,192,.3)` | `rgba(18,51,61,.3)` | `rgba(58,31,20,.3)` |
| `--danger / --success / --warn`（语义，需各给浅色版） | 状态色 | 现有 | 加深一档保证对比 | 加深一档 |

> 建议改为统一 `--xxx-rgb` 三元组 + 每处保留 α，这样一处改、全站跟着变，且不用逐条改 alpha。

### 1.3 仍需归并的「深色面」literal（40+ 种，必须全部替换）
目前只剩 3 种接入了 token，以下**全部还要处理**（`rgba(r,g,b,α)` 的 rgb 部分）：

```
7,27,37   5,28,37   2,9,13   11,28,44   6,26,35   2,8,12   8,27,39
14,60,80  11,26,40  8,22,38  35,48,92   1,8,12   5,25,35   24,58,72
9,33,44   8,30,41   43,54,96  70,25,25   9,30,41  18,58,70  48,25,21
122,48,24 262?...
```
（说明：`58,28,14 / 58,26,18 / 14,47,58` 是气泡墨色，语义上是 `--bubble-user-ink*`，应走气泡令牌而非面令牌；`0,0,0` 是阴影，保留；`147,183,192` 应走 `--dim`。）

**验收命令（改完必须为 0 命中）**：
```bash
grep -nE 'rgba\((7, ?27, ?37|5, ?28, ?37|2, ?9, ?13|11, ?28, ?44|6, ?26, ?35|8, ?27, ?39|14, ?60, ?80|11, ?26, ?40|8, ?22, ?38|35, ?48, ?92|24, ?58, ?72|9, ?33, ?44|8, ?30, ?41|43, ?54, ?96|70, ?25, ?25|9, ?30, ?41|18, ?58, ?70|48, ?25, ?21|1, ?8, ?12|2, ?8, ?12|5, ?25, ?35|122, ?48, ?24)' src/*.css
```

---

## 2. Web 端全量清单（按区块，逐条表格）

> 每行格式：**位置** → 现状 → 目标令牌。行号以当前 `styles.css` 为准，实施时以 selector 为准。

### 2.1 页面骨架
| 位置 | 现状 | 目标 |
|---|---|---|
| `body` (L124) | `background: var(--bg)`（已改，但 body 用的是 :root 值） | 保留兜底；真正底色在 `.app` |
| `.app` (L150) | `background: var(--bg); color: var(--text)` | ✅ 已改 |
| `.stage-wrap` (L162) | 渐变已用 `--bg-2/--bg` | ✅ 已改 |
| `.stage-wrap::after` (L175) | 蒙层用 `--deep-rgb` | ✅ 但需确认浅色下蒙层方向（浅底应「压亮」而非「压暗」） |
| `.stage-fallback` (L~230) | 写死 `#082530→#04141d` 渐变 + `rgba(21,91,108,.55)` | 改 `--bg-2/--bg` |
| `.screen` / `.screen-panel` | `--glass-strong` | ✅ 跟 token（但需测浅色 alpha） |
| `.home-screen` 等 | 检查是否有写死 | 审计 |

### 2.2 气泡与消息
| 位置 | 现状 | 目标 |
|---|---|---|
| `.bubble-user` | 渐变走 `--bubble-user-from/to`；文字 `--bubble-user-ink*` | ✅ 已 token |
| `.bubble-assistant` | `rgba(var(--surface-rgb),…)` | ✅ 需测浅底 alpha |
| `.bubble-edit textarea` (L1488) | `rgba(255,255,255,.16)` 边框 / `rgba(255,255,255,.06)` 底 | `--sheen-rgb` / `--field-rgb` |
| 附件/chip | 多处 `rgba(255,255,255,.0x)` | `--sheen-rgb` |
| `.turn-nav-*` | 预览面板深底 | `--surface-2-rgb` |

### 2.3 工具卡 / 推理 / 媒体卡
| `.tool-card` / `.tool-card pre` | 深底 + 浅字 literal | 面令牌 + `--code-*` |
| `.reasoning pre` (L1878) | 深底 | `--code-bg` |
| `.tool-media__raw pre` (L2027) | 深底 | `--code-bg` |
| `.media-test-preview` | 检查 | 面令牌 |

### 2.4 输入与编辑器（用户重点）
| 位置 | 现状 | 目标 |
|---|---|---|
| `.composer` (L2195) | `rgba(7,27,37,.82)` | `rgba(var(--field-rgb), .82)` + `--field-border` |
| `.composer textarea` (L2202) | `transparent`（靠 composer 底） | ok，但 placeholder 颜色要跟 `--faint` |
| `.composer textarea::placeholder` (L2217) | `--faint` | ✅ |
| `.field input/select/textarea` (L3067) | `rgba(var(--surface-2-rgb),.65)` | 改用 `--field-rgb` + `--field-border` |
| `.field …:focus` (L3085) | `rgba(127,227,212,.45)` | `rgba(var(--line-rgb),.45)` |
| `.search-field input` (L2849) | 审计 | 同上 |
| `.input-with-action input` (L3102) | 审计 | 同上 |
| `.drawer-digest-input` (L4296) | `rgba(8,27,39,.5)` + `var(--ink,#e8f7fb)` | `--field-rgb` + `--text` |
| 工坊 `.code-editor` (L3540) + `Workshop.tsx` `oneDark` | CodeMirror 恒暗主题 | **产品决策**：造一个随 `--code-*` 的浅/深主题，或接受编辑器恒暗（见 4.3） |
| `.preview-frame` (L3550) | `#ffffff` | **保留白色**（渲染用户网页，必须白底），但外框随 token |

### 2.5 Markdown / 代码块
| `.markdown` 正文/标题/li | `--text` | ✅ |
| `.markdown code:not(pre)` (L2643) | `background: rgba(127,227,212,.1); color:#bdf6ec` | `--code-inline-bg` / `--code-inline-ink` |
| `.code-card` (L2654) | `background:#071820; border rgba(127,227,212,.16)` | `--code-bg` / `rgba(var(--line-rgb),.16)` |
| `.code-head/.code-actions button` | 深底 + 浅字 | `--code-*` |
| 表格 `th/td` (L2650) | `var(--line)` | ✅ |
| 引用块 / hr / 链接 | 审计 | `--line` / `--aqua`（浅色需加深） |

### 2.6 弹层 / 抽屉 / 提示
| `.modal` / `.sheet` / `.drawer` / `HistoryDrawer` | 深底（`--glass-strong` 或 literal） | 面令牌 + `--overlay-rgb` 遮罩 |
| `.toast` | 审计（L~5588 `rgba(255,255,255,.09)`） | `--sheen-rgb` |
| `.approval-*` (L4962+) | 多 literal | 面/语义令牌 |
| `ConfirmDialog` / `Menu` | 审计 | 面令牌 |

### 2.7 设置 / 外观
| `.settings-card` | `--glass` | ✅ 测浅色 alpha |
| 主题卡 `.theme-deep/iceberg/tropical > span` (L3591) | 写死渐变（只是色卡预览） | 更新为新配色预览 |
| `.appearance-*` 取色器/滑杆 | 部分 literal | 面/线令牌 |
| `checkbox` / `radio` / `switch` | 用系统色或 literal | 新增 `--color-control-*`，且 `color-scheme` 跟随 |

### 2.8 列表 / 徽章 / 日历 / 助手 / 导入
| `.memory-type.*` / `.memory-badge.*` | 语义色 `#ffd08a / #a9c8ff / #ffb2c8` + 半透明底 | 保留色相，浅色版加深，底用 `--chip-bg` |
| `.calendar-dot.*` | `#9fd8ea / --accent / --aqua` | 审计浅底对比 |
| `styles-assistants.css`（4.7KB） | 多处 `rgba(8,31,42,.92)`、`rgba(111,215,240,.x)` | 全部接面/线/`--aqua` 令牌 |
| `styles-calendar.css`（7.3KB） | `rgba(8,31,42,.55)` 等 | 同上 |
| `styles-import.css`（2.7KB） | `rgba(255,123,123,.x)` 等 | 语义令牌 |

### 2.9 媒体 / 照片
`.media-*` / `photos` / 图片容器：审计深底与占位色 → 面令牌。

### 2.10 装饰 / 特效
| `.orca-bubble`（3D 台词气泡） | 写死 `rgba(24,58,72,.86)` 等 + 白高光 | **决策**：3D 台词气泡是否跟 UI 色调？（建议给三套配色，但可后续） |
| `.stage .orca-thought` | `--glass-strong` | ✅ |
| `.pet-layer` / `zen-dot` / `splash` / `boot-error` | 审计 | 面/语义令牌 |

### 2.11 交互态（极易漏）
| 类别 | 说明 |
|---|---|
| `::selection` | 全局未定义 → 加 `background: rgba(var(--line-rgb),.32)`，浅色版对比更高 |
| `caret-color` | ✅ 已加 `var(--accent)`，但**这只管输入插入符，不管选择手柄**（见第 5 节） |
| `:focus-visible` | 焦点环颜色用 `--aqua`，浅色需加深 |
| `:disabled` | 多处 `opacity`/literal 灰 | 统一 `--faint` |
| `::placeholder` | 散落 | 统一 `--faint` |
| `::-webkit-scrollbar` | 审计（多处 `display:none` + 少数有色） | `--scrollbar` |
| `-webkit-tap-highlight` | ✅ 已关 |

### 2.12 Web 注入端 & 桌面端
| `src/lib/web-mode.ts`（注入 chat.deepseek.com 的样式） | 目前不感知 `appTone` | 决策：网页版独立配色，或按 tone 注入两套 |
| `SelectionCopyBar.tsx`（自绘工具条） | 用 app 变量 | ✅ 跟随 |
| Electron 窗口背景 / 标题栏 | 审计 | 面令牌 |

---

## 3. 原生 Android 全量清单

| 文件 / 属性 | 现状 | 必须改 |
|---|---|---|
| `styles.xml` `android:windowBackground` | `#04141d` 固定 | 按 tone 动态（浅色主题要浅底，否则启动闪深色 / 边界露深色） |
| `android:statusBarColor` / `navigationBarColor` | `#04141d` 固定 | **运行时按 tone 设置**（MainActivity 监听设置变化，调窗色） |
| `android:windowLightStatusBar` / `windowLightNavigationBar` | `false` 固定 | 浅底时设 `true`（图标转深），否则浅底白图标看不见 |
| `android:textColorPrimary` / `textColorSecondary` | `#e6f2f6/#9fc0cc` | 浅色主题需深色（对话框、菜单文字） |
| `android:colorBackgroundFloating` | `#0b1b24` | 按 tone |
| `android:popupBackground` | 透明 drawable | ✅ 保留 |
| `android:textColorHighlight` | `#447FE3D4` | 按 tone |
| `android:textCursorDrawable` | `ds_caret`（青） | 按 tone（或 CSS caret-color 已覆盖） |
| `android:textSelectHandle*` | `ds_handle` | ⚠️ 对 WebView 无效（见第 5 节），对设置页 TextView 有效 |
| `android:colorControlNormal/Activated` | 未设 | **新增**：checkbox/radio/switch/滚动条/光标颜色 |
| `Dialog` / `AlertDialog` 主题 | 继承深色 | 浅色主题需配套浅色对话框主题 |
| `AppTheme.NoActionBarLaunch` / splash | `#04141d` | 按 tone 或保持中性深色（决策） |
| `android:forceDarkAllowed` | `false`（已加） | ✅ |

---

## 4. 需要新增的运行时机制（否则原生跟不上 CSS）

1. **tone → 原生系统栏**：`MainActivity` 监听 `settings.appTone`/`customBase`，算出色值后 `window.statusBarColor = …`、`WindowInsetsControllerCompat.isAppearanceLightStatusBars = isLightTone`，导航栏同理。
2. **`index.html` 的 `<meta name="theme-color">`** 随 tone 更新（浏览器地址栏 / PWA）。
3. **`color-scheme`**：已随 `.app[data-tone]` 设置；确认原生表单控件、日期选择器、滚动条跟随。
4. **3D 场景**：`Stage`（WebGL）与 `.stage-wrap` 渐变/蒙层的关系要定——建议 **3D 画面独立（跟 `aquariumTheme`），只让周围渐变和面板跟 `appTone`**，避免浅色 UI 里突然一块深色海。
5. **CodeMirror oneDark**：要么做随变量的编辑器主题（推荐，工坊才协调），要么明确「编辑器恒暗」并接受。

---

## 5. 选中手柄白底专项（本次必须解决）

### 5.1 为什么改 drawable 没用
- `android:textSelectHandle / textSelectHandleLeft / Right` 只作用于 **TextView/EditText**；
- WebView 的文本选择手柄是 **Chromium 的 `HandleView` 自绘**，从 WebView/框架资源取图，**不读我们 Activity 主题里的这几个属性**；
- 所以白底是 Chromium 手柄自带的外观，主题层改不动。

### 5.2 候选方案（按推荐度）
| 方案 | 做法 | 可控性 | 工作量 | 风险 |
|---|---|---|---|---|
| **A. 网页自绘手柄（推荐）** | 监听 `selectionchange`，用 `range.getClientRects()` 拿到选区首尾，画两个自定义手柄 div；`touchmove` 时用 `caretRangeFromPoint` 更新选区。主界面本来就把系统 floating toolbar 压掉了，正好配套。 | 高（颜色/形状/大小全可控，能做成品牌风格） | 中 | 需要处理滚动、横屏、iframe、性能 |
| B. 继续试原生 | `textSelectHandleWindowStyle` + `colorControlActivated` + `forceDarkAllowed=false` + `windowBackground` 透明（部分已做） | 低 | 小 | WebView 91 大概率无效 |
| C. 换/升级 WebView | 引导更新 Android System WebView | 低 | 小 | 用户环境不可控 |
| D. 资源覆盖 | 用同名 9-patch 覆盖框架 handle 图 | 极低 | 中 | 仅当 WebView 从 app 资源取图才有效 |

### 5.3 建议
直接做 **方案 A**，因为：
- 用户明确「每次都有、很明显」，需要确定性修复；
- 他们重视美术效果，自绘手柄可以做成和品牌一致的样式（甚至比系统更好看）；
- 与现有的 `SelectionCopyBar` 自绘工具条是同一套思路，架构一致。

### 5.4 验证
我会出 **两个 APK** 供真机对比：一个「自绘手柄」，一个「原生参数全开」。你各装一次，看手柄白底是否消失、拖动是否跟手，再定最终方案。

---

## 6. 自动守卫与验收测试（防回归）

1. **写死色守卫**：新测试扫描 `src/*.css`，除白名单（气泡墨色、`#ffffff` 预览框、阴影 `0,0,0`）外，若出现 `#hex` 或 `rgba(r,g,b` 字面量 → fail。
2. **对比度守卫**：node 里对三套 tone 计算 `--text` vs `--bg`、`--text` vs `--surface-*` 的 WCAG 对比度，要求 ≥ 4.5（正文）。
3. **真机逐屏 checklist**：首页 / 对话 / 消息操作 / 输入区 / 设置 / 外观 / 记忆 / 日历 / 助手 / 工坊 / 媒体 / 导入 / 网页版 —— 每屏看：底色、面板、文字、输入框、按钮、弹层、滚动条、选择手柄。
4. 现有 60 个测试 + typecheck + Android 编译 CI 保持全绿。

---

## 7. 实施顺序（分批，每批可独立出 APK 验收）

| 批次 | 内容 | 产出 |
|---|---|---|
| **B1** | 令牌扩容（第 1.2 节）+ 全站替换深色面/青线/白高光/输入框/代码块（第 2.1–2.5 节） | 一份 APK，先解决「输入框深、字浅」 |
| **B2** | 弹层/抽屉/提示/设置/列表/徽章/日历/助手/导入（2.6–2.9）+ 交互态（2.11） | 一份 APK |
| **B3** | 原生系统栏/对话框/滚动条随 tone（第 3、4 节） | 一份 APK |
| **B4** | 选中手柄自绘（第 5 节，含 A/B 对比包） | 两份 APK |
| **B5** | 3D/特效/桌面端/web-mode（2.10、2.12） | 一份 APK |

> 每一批都跑 typecheck + 全部测试 + Android 编译，再出包给你真机验收，不一次性堆到最后。
