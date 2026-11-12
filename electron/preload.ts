import { contextBridge, ipcRenderer } from 'electron'
import type { DeepSeaBridge } from '../src/lib/global'

/** 主进程 HTTP 桥的请求参数。 */
type HttpRequestOptions = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

type HttpRequestResult = { status: number; headers: Record<string, string>; text: string }
type HttpBinaryResult = { status: number; headers: Record<string, string>; base64: string; mime?: string; text?: string }

/** 主进程推回来的流式事件。 */
type HttpStreamEvent =
  | { id: string; type: 'status'; status: number; headers: Record<string, string> }
  | { id: string; type: 'chunk'; chunk: string }
  | { id: string; type: 'end'; status: number; headers: Record<string, string> }
  | { id: string; type: 'error'; message: string }

/** 绕过渲染层 CORS 的 HTTP 桥（主进程发请求）。 */
type HttpBridge = {
  httpRequest: (options: HttpRequestOptions) => Promise<HttpRequestResult>
  httpRequestBinary: (options: HttpRequestOptions) => Promise<HttpBinaryResult>
  httpStreamStart: (options: HttpRequestOptions) => Promise<{ id: string }>
  httpStreamAbort: (id: string) => Promise<void>
  onHttpStream: (callback: (event: HttpStreamEvent) => void) => () => void
}

const api: DeepSeaBridge & HttpBridge = {
  platform: 'electron',
  version: ipcRenderer.sendSync('app:version') as string,
  secureGet: () => ipcRenderer.invoke('secure:get') as Promise<string | null>,
  secureSet: (value: string) => ipcRenderer.invoke('secure:set', value) as Promise<void>,
  secureRemove: () => ipcRenderer.invoke('secure:remove') as Promise<void>,
  openWebChat: (css: string, js: string) => ipcRenderer.invoke('webchat:open', css, js) as Promise<void>,
  webChatSend: (text: string) =>
    ipcRenderer.invoke('webchat:send', text) as Promise<{ ok: boolean; error?: string }>,
  webChatState: () =>
    ipcRenderer.invoke('webchat:state') as Promise<{ busy: boolean; text: string; reasoning?: string; done: boolean; error?: string } | null>,
  webChatContext: (text: string) => ipcRenderer.invoke('webchat:context', text) as Promise<void>,
  webChatShow: () => ipcRenderer.invoke('webchat:show') as Promise<void>,
  webApiHasSession: () => ipcRenderer.invoke('webapi:has-session') as Promise<boolean>,
  webApiCapture: () => ipcRenderer.invoke('webapi:capture') as Promise<{ ok: boolean; error?: string }>,
  webApiDiagnose: () => ipcRenderer.invoke('webapi:diagnose') as Promise<{
    hasSession: boolean
    sessionValid: boolean
    powReady: boolean
    powSource: string
    notes: string[]
  }>,
  webApiLogin: () => ipcRenderer.invoke('webapi:login') as Promise<{ ok: boolean; error?: string }>,
  webApiForget: () => ipcRenderer.invoke('webapi:forget') as Promise<void>,
  webApiSend: (conversationKey: string, prompt: string, thinking: boolean, systemPrompt: string, refFileIds?: string[]) =>
    ipcRenderer.invoke('webapi:send', conversationKey, prompt, thinking, systemPrompt, refFileIds ?? []) as Promise<{ ok: boolean; error?: string; kind?: string }>,
  webApiUpload: (dataUrl: string, filename: string) =>
    ipcRenderer.invoke('webapi:upload', dataUrl, filename) as Promise<{ ok: boolean; fileId?: string; error?: string }>,
  webApiAbort: () => ipcRenderer.invoke('webapi:abort') as Promise<void>,
  onWebChatDelta: (handler: (payload: { kind: 'text' | 'reasoning'; delta: string }) => void) => {
    const listener = (_event: unknown, payload: { kind: 'text' | 'reasoning'; delta: string }): void => handler(payload)
    ipcRenderer.on('webchat:delta', listener)
    return (): void => { ipcRenderer.removeListener('webchat:delta', listener) }
  },
  onWebChatDone: (handler: (payload: { text: string; reasoning: string; error?: string; kind?: string }) => void) => {
    const listener = (_event: unknown, payload: { text: string; reasoning: string; error?: string; kind?: string }): void => handler(payload)
    ipcRenderer.on('webchat:done', listener)
    return (): void => { ipcRenderer.removeListener('webchat:done', listener) }
  },
  httpRequest: (options: HttpRequestOptions) => ipcRenderer.invoke('http:request', options) as Promise<HttpRequestResult>,
  httpRequestBinary: (options: HttpRequestOptions) => ipcRenderer.invoke('http:requestBinary', options) as Promise<HttpBinaryResult>,
  httpStreamStart: (options: HttpRequestOptions) => ipcRenderer.invoke('http:stream:start', options) as Promise<{ id: string }>,
  httpStreamAbort: (id: string) => ipcRenderer.invoke('http:stream:abort', id) as Promise<void>,
  onHttpStream: (callback: (event: HttpStreamEvent) => void) => {
    const listener = (_event: unknown, payload: HttpStreamEvent): void => callback(payload)
    ipcRenderer.on('http:stream:event', listener)
    return (): void => { ipcRenderer.removeListener('http:stream:event', listener) }
  },
  saveFile: (name: string, content: string) => ipcRenderer.invoke('file:save', name, content) as Promise<boolean>,
  saveImageFile: (name: string, base64: string) => ipcRenderer.invoke('file:saveImage', name, base64) as Promise<boolean>,
  openFile: (accept: string) => ipcRenderer.invoke('file:open', accept) as Promise<string | null>,
  openExternal: (url: string) => ipcRenderer.invoke('open:external', url) as Promise<void>,
  mcpStdioRequest: (command: string, args: string[], request: { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> }, timeoutMs: number) =>
    ipcRenderer.invoke('mcp:stdio:request', command, args, request, timeoutMs) as Promise<{ ok: true; result: unknown } | { ok: false; error: string }>,
  mcpStdioNotify: (command: string, args: string[], message: { jsonrpc: '2.0'; method: string; params?: Record<string, unknown> }) =>
    ipcRenderer.invoke('mcp:stdio:notify', command, args, message) as Promise<void>,
  mcpStdioClose: (command: string, args: string[]) =>
    ipcRenderer.invoke('mcp:stdio:close', command, args) as Promise<void>,
}

contextBridge.exposeInMainWorld('deepsea', api)

