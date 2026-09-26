import { codexSocketManager } from "@/api/codex-socket-manager"
import { launcherFetch } from "@/api/http"

export interface CodexWorkspace {
  name: string
  path: string
}

export interface CodexThread {
  id: string
  source?: string
  name?: string | null
  preview?: string
  cwd?: string
  createdAt?: number
  updatedAt?: number
  status?: { type: string }
  model?: string | null
  reasoningEffort?: string | null
  historyMode?: string
  turns?: CodexTurn[]
}

export interface CodexTurn {
  id: string
  status?: string
  items?: CodexItem[]
}

export interface CodexItem {
  id: string
  type: string
  text?: string
  summary?: Array<string | { text?: string }>
  content?: Array<{ type: string; text?: string; path?: string; url?: string }>
  command?: string
  tool?: string
  server?: string
  arguments?: unknown
  result?: unknown
  error?: unknown
  aggregatedOutput?: string
  changes?: unknown[]
  status?: string
}

export interface CodexRpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

export function codexWebSocketURL(path: string): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:"
  return `${scheme}//${location.host}${path}`
}

async function getJSON<T>(path: string): Promise<T> {
  const response = await launcherFetch(path)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

export const getCodexWorkspaces = () =>
  getJSON<CodexWorkspace[]>("/api/codex/workspaces")

export interface CodexModel {
  id: string
  model: string
  displayName: string
  defaultReasoningEffort: string
  supportedReasoningEfforts: Array<{
    reasoningEffort: string
    description?: string
  }>
  inputModalities?: string[]
  isDefault?: boolean
}

export interface CodexImage {
  path: string
  url: string
}

export async function uploadCodexImage(file: File): Promise<CodexImage> {
  const body = new FormData()
  body.append("image", file)
  const response = await launcherFetch("/api/codex/images", {
    method: "POST",
    body,
  })
  if (!response.ok)
    throw new Error((await response.text()).trim() || `HTTP ${response.status}`)
  return response.json() as Promise<CodexImage>
}

// A route owns a listener, not the tab-wide WebSocket. Closing one client
// never interrupts another route's pending requests or event stream.
export class CodexRpcClient {
  private release: (() => void) | null = null
  private closed = false
  onEvent?: (message: CodexRpcMessage) => void
  onClose?: () => void
  onReconnect?: () => void

  async connect(): Promise<void> {
    if (this.closed) throw new Error("Codex client has been closed")
    if (!this.release) this.release = codexSocketManager.subscribe({
      event: (message) => this.onEvent?.(message),
      close: () => this.onClose?.(),
      reconnect: () => this.onReconnect?.(),
    })
    await codexSocketManager.connect()
    if (this.closed) throw new Error("Codex client has been closed")
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex client has been closed"))
    return codexSocketManager.request<T>(method, params)
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.closed) codexSocketManager.notify(method, params)
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    if (!this.closed) codexSocketManager.respond(id, result)
  }

  close(): void {
    this.closed = true
    this.release?.()
    this.release = null
  }
}

// Call on logout/account change to close the authenticated tab-wide transport.
export function stopCodexSocket(): void {
  codexSocketManager.stop()
}
