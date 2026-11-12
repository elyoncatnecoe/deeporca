export interface McpStdioRequest {
  request: {
    jsonrpc: '2.0'
    id: number
    method: string
    params?: Record<string, unknown>
  }
}

/**
 * 通用 HTTP 桥（Electron 主进程）。
 *
 * 为什么需要它：渲染层是浏览器上下文，跨域请求要过 CORS。第三方 OpenAI 兼容接口
 * 大多是「服务器对服务器」用的，压根不返回 `Access-Control-Allow-Origin`
 * （实测有 OPTIONS 直接 405 的，也有预检通过但 POST 响应没有 ACAO 的），
 * 浏览器只会给一句 `Failed to fetch` —— 换网络、开加速器都没用。
 * 主进程没有 CORS 限制，所以 API 请求改从这里走。
 */
export interface HttpBridgeRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface HttpBridgeResponse {
  status: number
  headers: Record<string, string>
  text: string
}

/** 二进制响应：Electron/Android 都通过 base64 传字节（TTS / 图片下载）。 */
export interface HttpBridgeBinaryResponse {
  status: number
  headers: Record<string, string>
  base64: string
  mime?: string
  text?: string
}

export type HttpStreamEvent =
  | { id: string; type: 'status'; status: number; headers: Record<string, string> }
  | { id: string; type: 'chunk'; chunk: string }
  | { id: string; type: 'end'; status: number; headers: Record<string, string> }
  | { id: string; type: 'error'; message: string }

export interface DeepSeaBridge {
  platform: 'electron'
  version: string
  /**
   * 读凭证。
   *
   * 必须同时带回状态：「读失败」和「没配置」在 `string | null` 上无法区分，
   * 而猜错的代价是覆盖掉用户还能恢复的密文。
   */
  secureGet: () => Promise<{ value: string | null; status: 'available' | 'unavailable' | 'read-error' }>
  secureSet: (value: string) => Promise<void>
  secureRemove: () => Promise<void>
  openWebChat: (css: string, js: string) => Promise<void>
  /** 网页账号模式：把一段话交给隐藏网页窗发送。 */
  webChatSend?: (text: string) => Promise<{ ok: boolean; error?: string }>
  /** 网页账号模式：读当前回复进度；网页窗不在返回 null。 */
  webChatState?: () => Promise<{ busy: boolean; text: string; done: boolean; error?: string } | null>
  /** 网页账号模式：写入人设/记忆前缀。 */
  webChatContext?: (text: string) => Promise<void>
  /** 网页账号模式：把隐藏的网页窗叫出来登录。 */
  webChatShow?: () => Promise<void>
  /* ---- 网页账号·纯 HTTP 模式（窗口关了也能聊） ---- */
  /** 本机是否已有可用的网页登录态。 */
  webApiHasSession?: () => Promise<boolean>
  /** 从网页窗采集登录态（登录完成后调一次）。 */
  webApiCapture?: () => Promise<{ ok: boolean; error?: string }>
  /** 自检：登录态 / 接口 / PoW 各探一遍。 */
  webApiDiagnose?: () => Promise<{ hasSession: boolean; sessionValid: boolean; powReady: boolean; powSource: string; notes: string[] }>
  /** 开窗等登录、采集并验证，一步到位。 */
  webApiLogin?: () => Promise<{ ok: boolean; error?: string }>
  /** 忘掉登录态。 */
  webApiForget?: () => Promise<void>
  /** 发消息；增量通过 onWebChatDelta 推，结束走 onWebChatDone。refFileIds 是已上传附件的 id。 */
  webApiSend?: (conversationKey: string, prompt: string, thinking: boolean, systemPrompt: string, refFileIds?: string[]) => Promise<{ ok: boolean; error?: string; kind?: string }>
  /** 上传一个附件（data URL）到网页账号，返回 file_id。 */
  webApiUpload?: (dataUrl: string, filename: string) => Promise<{ ok: boolean; fileId?: string; error?: string }>
  /** 中断当前网页请求。 */
  webApiAbort?: () => Promise<void>
  /** 订阅回话增量，返回取消函数。 */
  onWebChatDelta?: (handler: (payload: { kind: 'text' | 'reasoning'; delta: string }) => void) => () => void
  /** 订阅回话结束，返回取消函数。 */
  onWebChatDone?: (handler: (payload: { text: string; reasoning: string; error?: string; kind?: string }) => void) => () => void
  saveFile: (name: string, content: string) => Promise<boolean>
  /**
   * 保存图片：二进制通道（file:saveImage）。
   * 上面那条 saveFile 是 utf8 文本写盘，把 base64 交给它会写出一个打不开的「.jpg 文本文件」。
   * 这里收的是已经剥掉 `data:...;base64,` 前缀的纯 base64，主进程用 Buffer 写。
   * 可选：老版本的预加载脚本没有这个方法，调用方要能接受 undefined（→ 退化成下载）。
   */
  saveImageFile?: (name: string, base64: string) => Promise<boolean>
  /** 可选：老版本的预加载脚本没有这个方法，调用方要能接受 undefined。 */
  openFile?: (accept: string) => Promise<string | null>
  openExternal: (url: string) => Promise<void>
  /** MCP stdio：发起一个 JSON-RPC 请求到某个本地命令，返回对应 id 的响应。 */
  mcpStdioRequest?: (command: string, args: string[], request: McpStdioRequest['request'], timeoutMs: number) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>
  /** MCP stdio：发一条通知（无响应）。 */
  mcpStdioNotify?: (command: string, args: string[], message: { jsonrpc: '2.0'; method: string; params?: Record<string, unknown> }) => Promise<void>
  /** 关闭一个 stdio 会话（结束子进程）。 */
  mcpStdioClose?: (command: string, args: string[]) => Promise<void>
  /* ---- 通用 HTTP（绕开渲染层 CORS；见 HttpBridgeRequest 的注释） ---- */
  /** 非流式请求；返回状态码、响应头与完整文本。 */
  httpRequest?: (options: HttpBridgeRequest) => Promise<HttpBridgeResponse>
  /** 非流式二进制请求；返回 base64 字节（语音、图片下载）。 */
  httpRequestBinary?: (options: HttpBridgeRequest) => Promise<HttpBridgeBinaryResponse>
  /** 流式请求：立即返回 id，随后通过 onHttpStream 推 chunk/end/error。 */
  httpStreamStart?: (options: HttpBridgeRequest) => Promise<{ id: string }>
  /** 取消一条流式请求。 */
  httpStreamAbort?: (id: string) => Promise<void>
  /** 订阅流式事件，返回取消订阅函数。 */
  onHttpStream?: (handler: (event: HttpStreamEvent) => void) => () => void
}

declare global {
  interface Window {
    deepsea?: DeepSeaBridge
  }
}

export {}
