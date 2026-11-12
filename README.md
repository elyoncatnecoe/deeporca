# 深鲸 · DeepSea

一个把 AI 养在深海里的个人客户端：聊天的旁边有一只虎鲸，它会记住你、陪你写小网页，也能直接打开 DeepSeek 网页版。

- **Windows**：安装包（推荐，见下方下载）
- **Android**：APK，Android 8.0+，arm64
- **两种聊天方式**：
  - **API 模式**：填自己的 DeepSeek API Key，直连官方接口；有长期记忆、代码工坊、虎鲸反应、生图与语音
  - **网页模式**：不填 Key，内嵌 `chat.deepseek.com`，用你的网页账号登录；头像、纸雕提示词助手与明暗主题由深鲸提供
- **看得见的过程**：思考内容实时展开、思考强度可调（关/低/高/最高）、回答计时；支持图片和文本附件
- **会回应的虎鲸**：头顶气泡跟着脑袋走，实时显示它在想什么/说什么；点一下会蹭你，模型也能通过指令让它转圈、下潜、睡觉
- **本地优先**：对话、记忆、工坊文件、API Key 都在你自己的设备上；没有中转服务器，没有遥测。

> 个人非官方客户端，与 DeepSeek 官方无关。虎鲸形象为 DeepSeek 品牌标识，仅作个人陪伴界面使用；网页模式只做本地外观美化，不抓取页面数据、不绕过登录。

## 下载与安装

从 **[Releases 页面](https://github.com/elyoncatnecoe/deeporca/releases/latest)** 下载最新版：

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `DeepSea-0.1.0-setup.exe` | 一键安装（推荐） |
| Android | `DeepSea-0.1.0.apk` | arm64，Android 8.0+ |

每个 Release 还附带 `SHA256SUMS.txt`（校验文件完整性）和 `latest.json`（版本清单，供更新检查使用）。

### Windows

运行安装包即可。这是**个人未签名构建**，SmartScreen 可能提示“未知发布者”，选择“更多信息 → 仍要运行”。数据在 `%APPDATA%\deepsea\`；卸载不会删除它，方便下次继续用。

### Android

安装 APK 需要允许“安装未知来源应用”。数据在应用私有目录，卸载即删除；重要记忆请先在设置里导出。首次启动会显示深鲸启动图；需要系统 Android System WebView 正常。

## 现在能做什么

### 沉浸式聊天

3D 海底是主界面，对话是海面上的一块玻璃。发送时虎鲸会加速，回复时它会摆尾，出错时会往下沉。桌面端对话在右侧，手机端是可拖拽的底部面板。

对话页头部有个**快捷指令**菜单：11 条虎鲸动作（转个圈 / 下潜 / 上浮 / 蹭蹭 / 吐泡泡 / 睡觉 / 醒来 / 甩水 / 凑近 / 安静 / 玩耍 —— 本地解析，不花 token）+ 5 条常用指令（写网页 / 记住当前记忆 / 总结对话 / 解释代码 / 拆待办）。点一条**只填进输入框**，不会替你发送。

### 头顶的气泡，和能被“上身”的虎鲸

- 气泡挂在虎鲸头顶，随着它游动、转身、放大缩小；不在对话页也能看到它打招呼
- 发送后显示“正在深想 / 已经想了 N 个字”，流式回复时气泡同步显示它正在说的话，结束后停在最后一句
- 点气泡或戳虎鲸会触发摸头动作和一句随机回应；聊天中点击气泡也会互动
- 开启“身体联动”后，模型会在回复里写 `<body act="spin" mood="playful" say="看我的！" />` 这样的指令；深鲸会把标签从正文里拿掉，再让虎鲸转圈、下潜、浮出水面、睡觉或说一句气泡台词

### 布置：把水族馆小游戏接进 App

参考上游项目 orca-aquarium-shell（MIT）的玩法整套搬进来了，入口在首页右上角、**设置旁边那个房间图标**。

- **投喂**：打开投喂模式（按钮变 ✓）后，点一下虎鲸 / Clawd / Seal-GPT 才会把 token 丢给**那一只**；吃得越多它长得越大（上限 1.55×），「复原」只把体型收回去、累计投喂数不清零
- **布置**：7 种海底道具（小岩石 / 珊瑚 / 海草 / 宝箱 / 海葵 / 小灯 / 贝壳），选一个点海底放下，↺↻ 旋转，可一键清空
- **拍照**：抓拍它当下在干什么（**不会**转过来看镜头），按构图 / 距离 / 朝向评出「贴贴特写 / 完美瞬间 / 背影远眺 / 日常抓拍」，拍立得边框直接烤进文件，最多存 8 张；点开任意一张可以看大图、左右翻页，并「保存到相册」或分享出去（安卓写进系统相册 `Pictures/深鲸`，Windows 走保存对话框）
- **伙伴**：🦀 Clawd（方块小螃蟹，左舷）和 🦭 Seal-GPT（背着 OpenAI 商标斑点的小海豹，右舷）各自只有一只、可以同时召唤，跟着虎鲸 1 秒前的轨迹游
- **外观**：海底主题（奶油暮海 / 雾霭冰山 / 蜜桃暖阳）、虎鲸 5 套皮肤、辉光强度、画面质量
- **动作速度**：一根滑杆（0.4×–1.8×）同时调身体摇摆 / 尾鳍 / 胸鳍 / 体波 —— 有人觉得抖得可爱，有人觉得抽搐，交给玩家自己拧
- 手机进「布置」会收起对话面板（屏幕放不下）；桌面端海底在左、对话在右，两边同时在场
- 面板右上角那个眼睛图标是**欣赏模式**：隐藏所有菜单只看海，右下角留一个淡圆点随时退出

### 长期记忆（RikkaHub 式）

- 每 4 轮（可调）从对话里抽取稳定事实：名字、偏好、项目、相处方式
- 新对话自动召回相关记忆，并带上最近几段对话的一句话回顾
- 记忆页可搜索、按类型筛选、编辑、置顶、删除、导出
- 自动记忆可整个关掉；抽取用便宜的 `deepseek-chat`，不占主对话模型
- 所有记忆只在本机 IndexedDB，删除一条就不再召回

### 代码工坊

- 模型有 `list_files` / `read_file` / `write_file` / `delete_file` 四个本地工具，会直接把页面写进工坊
- 文件树 + CodeMirror 编辑器 + 沙箱预览，按项目隔离文件
- 聊天里的代码块可以复制、运行 JS、存入工坊
- 导出为单文件 HTML；小游戏/小工具可以直接分享

### 生图与语音（工具调用）

- 设置 → **生图与语音**：填两套独立的 API（地址 / Key / 模型，可配高级请求头），并支持「获取可用模型」按能力筛选；生图支持 OpenRouter、OpenAI 兼容、Gemini / Imagen、阿里百炼，语音支持 OpenRouter、OpenAI 兼容、Gemini TTS、MiniMax、阿里百炼 TTS、ElevenLabs
- 用户明确说「画一只…」「把这张图改成…」时，模型才调用 `generate_image`；普通聊天、角色扮演、只是发图时不会自动生图
- 用户明确说「用语音说…」「朗读一下…」时，模型才调用 `speak`；对话里出现播放器，**由用户自己点播放**，不自动外放
- 每条助手回复的动作条上还有**喇叭按钮**：点一下把这条回复的文字用同一套语音 API 朗读出来，再点停止
- 生成的图片/语音只存在本机，删除消息或对话会一起清理，也不包含在导出备份里

### 助手与网页版纸雕提示词

- 首页右上角「助手」入口可开关助手人格、管理多个助手（头像、人设、模型、思考强度、快捷消息、正则替换）
- 网页版可显示纸雕虎鲸小助手，默认提示词可编辑、可一键复制（手机上没有右键也能用）
- 网页版同时解锁官方「朗读」入口

### 网页模式（免 Key）

- 打开官方 `chat.deepseek.com`，用手机号/微信/Apple 正常登录
- 网页端皮肤只做加法：头像、纸雕助手、官方朗读；站内自己的浅色/深色主题保持不变
- 单独的窗口/Activity，Cookie 持久化；外链交给系统浏览器
- 网页账号也支持图片附件（上传到网页账号后随消息发送）
- 限制：工具调用不可用；网页模式的对话在官网账号里

## 第一次使用

1. 启动后选择：**网页版 · 不用 Key**（先试）或 **API 模式 · 完整体验**（填 Key）。
2. API Key 在 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 创建，只加密保存在本机（Windows 用 DPAPI，Android 用 Keystore AES-GCM）。
3. 默认模型 `deepseek-flash`（支持看图）；也可以换成 `deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner` 或自定义 OpenAI 兼容地址。
4. 设置里可以改**界面色调**、自动记忆频率、思考强度、网页模式明暗，导出全部数据。

## 数据与隐私

| 数据 | 位置 | 说明 |
|---|---|---|
| 对话 / 记忆 / 工坊文件 | 本机 IndexedDB | 不上传 |
| 生成图片 / 语音 | 本机 IndexedDB `media` 表 | 只在本机；不进备份，删除消息/对话时清理 |
| 附件 | 随消息发给你配置的 API | 图片会先在本机压缩；不经过深鲸的服务器 |
| API Key | Windows DPAPI / Android Keystore | 不写日志、不导出 |
| 网页模式 Cookie | 独立 WebView 分区 | 只用于官网登录 |
| API 请求 | 你的设备 → 你填的地址 | 没有中转 |

设置 → 数据：可导出全部备份（JSON，不含 Key），里面**包含水族馆进度**，但**不含照片**。

## 检查更新

本仓库用 GitHub Releases 发布，以下端点是稳定的，可直接用于“检查更新 / 下载更新”：

- 最新 Release（API）：`https://api.github.com/repos/elyoncatnecoe/deeporca/releases/latest`
- 版本清单：`https://github.com/elyoncatnecoe/deeporca/releases/latest/download/latest.json`
- 最新安装包：`https://github.com/elyoncatnecoe/deeporca/releases/latest/download/DeepSea-0.1.0-setup.exe`
- 最新 APK：`https://github.com/elyoncatnecoe/deeporca/releases/latest/download/DeepSea-0.1.0.apk`

`latest.json` 含版本号、tag、发布时间、各平台文件名 / 下载地址 / 字节数 / SHA-256。客户端当前**没有**内置自动更新模块，这个清单是给更新下载功能对接用的。

## 从源码构建

要求：Node 22+、pnpm、JDK 21、Android SDK 35（仅 APK）、Windows。

```bash
pnpm install
pnpm build          # 仅 Vite 前端产物 + ES 兼容检查
pnpm build:exe      # dist-app/DeepSea-0.1.0-setup.exe
node scripts/package-portable.mjs  # 可选：免安装 zip
pnpm build:android  # dist-apk/DeepSea-0.1.0.apk
```

默认工具链放在仓库内 `.toolchain/{jdk21,android-sdk}`；也可以设置 `JAVA_HOME` / `ANDROID_HOME` 指向自己的安装。

- 图标/启动图：`python scripts/make-icons.py`（Pillow），从 `deepwhale.png` 生成 Windows `.ico` 和 Android mipmap。
- Android release 签名：在 `android/keystore.properties` 里配置 `storeFile` / `storePassword` / `keyAlias` / `keyPassword`，指向你自己的 keystore。**升级安装必须用同一个 keystore 签名**，请自行妥善保管，不要提交到版本库（`.gitignore` 已排除）。
- 调试构建：`node scripts/build-android.mjs --debug`。

## 技术结构

```
src/
  components/      React UI：首页、对话、记忆、工坊、设置、助手、日历
    room/          「布置」屏：投喂 / 装饰 / 拍照相册 / 伙伴 / 海底外观
    pet/           网页版纸雕虎鲸（无框架挂载器）
  lib/             数据库、流式客户端、附件压缩、提示词、身体联动、记忆、工坊、平台适配
    import/        外部对话格式导入适配器
  orca/            Three.js 虎鲸 / 海底场景（源自 orca-aquarium-shell，MIT）
electron/          Electron 主进程/preload：窗口、安全存储、网页账号 HTTP 客户端
android/           Capacitor Android 工程 + 原生插件（安全存储、网页窗口、剪贴板、相册）
scripts/           构建、图标、mock API、E2E
test/              单元测试（node:test）
```

- **没有服务端**：聊天循环、工具、记忆都在客户端完成。
- **流式**：SSE。API 请求在 Android 走原生 `HttpURLConnection`、桌面走 Electron 主进程，绕过第三方接口的 CORS 限制。
- **3D**：Three.js 0.147；虎鲸的“反应”由 `body.ts` 解析模型指令后调用场景表演接口。
- **网页模式**：`chat.deepseek.com` 返回 `frame-ancestors 'none'`，不能 iframe；因此 Electron 用独立 `BrowserWindow`，Android 用独立 `WebChatActivity`。

## 已知限制

- 图片附件按模型/供应商的「看图」判定发送，真不支持时按接口报错提示。
- 自定义接口必须是 **HTTPS**：Android 侧 `usesCleartextTraffic="false"`。
- 思考强度和思考内容取决于模型/接口是否返回 `reasoning_content`。
- 非官方客户端；网页模式的站点结构改版后，注入的外观层可能失效。
- 卸载 App 会删除本地数据；请先导出。
- 未做云同步、账号体系、iOS/Linux/macOS 版本；Windows EXE 未签名，首次运行会有 SmartScreen 提示。

## 开源许可

本项目源代码采用 **MIT License**（SPDX: `MIT`），详见 [LICENSE](LICENSE)。

> Copyright (c) 2026 elyoncat

第三方组件与依赖的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**品牌与名称**：MIT 许可覆盖源代码。名称 “DeepSea / 深鲸” 与 `resources/`、`deepwhale.png` 中的虎鲸美术用于标识本项目，作者保留这些标识，以便改动版不被误认为官方发布。Fork 完全欢迎（包括作者本人不一定认同的用途）；请在分发改动版时改名并替换美术。DeepSeek 名称与虎鲸形象是 DeepSeek 的品牌资产，本项目为非官方、与 DeepSeek 无关联、未获其背书。
