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
  content?: Array<{ type: string; text?: string }>
  command?: string
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

export class CodexRpcClient {
  private socket: WebSocket | null = null
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >()
  onEvent?: (message: CodexRpcMessage) => void
  onClose?: () => void

  async connect(): Promise<void> {
    const socket = new WebSocket(codexWebSocketURL("/api/codex/app-server/ws"))
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("Codex 连接失败"))
    })
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: CodexRpcMessage
      try {
        message = JSON.parse(event.data) as CodexRpcMessage
      } catch {
        return
      }
      if (message.method) {
        this.onEvent?.(message)
      } else if (
        typeof message.id === "number" &&
        this.pending.has(message.id)
      ) {
        const pending = this.pending.get(message.id)!
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      }
    }
    socket.onclose = () => {
      for (const pending of this.pending.values())
        pending.reject(new Error("Codex 连接已断开"))
      this.pending.clear()
      this.onClose?.()
    }
    await this.request("initialize", {
      clientInfo: {
        name: "musec137_pwa",
        title: "MuseC137 PWA",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    })
    this.notify("initialized", {})
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Codex 尚未连接"))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify({ method, params }))
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify({ id, result }))
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}
