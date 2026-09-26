import type { CodexRpcMessage } from "./codex"

type Listener = {
  event: (message: CodexRpcMessage) => void
  close: () => void
  reconnect: () => void
}

// One transport per browser tab. A route releases only its listener/lease,
// never the underlying authenticated app-server connection.
export class CodexSocketManager {
  private socket: WebSocket | null = null
  private opening: Promise<void> | null = null
  private ready = false
  private recovering = false
  private stopped = false
  private nextId = 1
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      method: string
      threadId?: string
      revision?: number
    }
  >()
  private activeTurns = new Map<string, string | null>()
  private approvals = new Set<number | string>()
  private revisions = new Map<string, number>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly idleMs = 5 * 60 * 1000
  private foreground = false
  private listeners = new Set<Listener>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = 1000
  private readonly url: () => string

  constructor(url: () => string) {
    this.url = url
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.recover())
      window.addEventListener("pageshow", () => this.recover())
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.recover()
      })
    }
  }

  setForeground(visible: boolean): void {
    if (this.foreground === visible) return
    this.foreground = visible
    this.clearIdle()
    this.scheduleIdle()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    this.scheduleIdle()
    return () => {
      this.listeners.delete(listener)
      this.scheduleIdle()
    }
  }

  async connect(): Promise<void> {
    this.stopped = false
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return
    if (this.opening) return this.opening
    if (typeof navigator !== "undefined" && navigator.onLine === false)
      throw new Error("Codex is offline")
    this.clearRetry()
    const socket = new WebSocket(this.url())
    this.socket = socket
    this.opening = new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      const timer = setTimeout(() => {
        fail(new Error("Codex connection timed out"))
        socket.close()
      }, 15000)
      socket.onopen = () => {
        // Only the internal handshake can send before the transport is ready.
        this.sendRequest(socket, "initialize", {
          clientInfo: {
            name: "musec137_pwa",
            title: "MuseC137 PWA",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        })
          .then(() => {
            if (socket !== this.socket || socket.readyState !== WebSocket.OPEN)
              throw new Error("Codex connection dropped")
            socket.send(JSON.stringify({ method: "initialized", params: {} }))
            this.ready = true
            this.retryDelay = 1000
            const reconnect = this.recovering
            this.recovering = false
            settled = true
            clearTimeout(timer)
            resolve()
            this.scheduleIdle()
            if (reconnect && !this.listeners.size) this.reconcileActive(socket)
            if (reconnect)
              for (const listener of this.listeners) listener.reconnect()
          })
          .catch((error: unknown) => {
            fail(
              error instanceof Error
                ? error
                : new Error("Codex initialization failed"),
            )
            socket.close()
          })
      }
      socket.onmessage = (event: MessageEvent<string>) => {
        let message: CodexRpcMessage
        try {
          message = JSON.parse(event.data) as CodexRpcMessage
        } catch {
          return
        }
        if (message.method) {
          this.observeEvent(message)
          if (this.ready)
            for (const listener of this.listeners) listener.event(message)
        } else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id)
          if (!pending) return
          this.pending.delete(message.id)
          if (message.error) pending.reject(new Error(message.error.message))
          else {
            if (
              !pending.threadId ||
              !["thread/read", "thread/resume"].includes(pending.method) ||
              pending.revision === this.revisions.get(pending.threadId)
            )
              this.observeResult(
                pending.method,
                pending.threadId,
                message.result,
              )
            pending.resolve(message.result)
          }
          this.scheduleIdle()
        }
      }
      socket.onerror = () => {
        fail(new Error("Codex connection failed"))
        socket.close()
      }
      socket.onclose = () => {
        clearTimeout(timer)
        if (socket !== this.socket) {
          fail(new Error("Codex connection dropped"))
          return
        }
        this.socket = null
        this.recovering = true
        const wasReady = this.ready
        this.ready = false
        fail(new Error("Codex connection dropped"))
        for (const pending of this.pending.values())
          pending.reject(new Error("Codex connection dropped"))
        this.pending.clear()
        if (wasReady) for (const listener of this.listeners) listener.close()
        this.scheduleRetry()
      }
    })
    const opening = this.opening
    void opening
      .finally(() => {
        if (this.opening === opening) this.opening = null
      })
      .catch(() => {})
    return opening
  }

  private bump(threadId: string): void {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1)
  }

  private observeEvent(message: CodexRpcMessage): void {
    const params = message.params ?? {}
    const threadId =
      typeof params.threadId === "string" ? params.threadId : null
    const turn = params.turn as { id?: unknown } | undefined
    if (message.method === "turn/started" && threadId) {
      this.activeTurns.set(
        threadId,
        typeof turn?.id === "string" ? turn.id : null,
      )
      this.bump(threadId)
      this.clearIdle()
    } else if (message.method === "turn/completed" && threadId) {
      const active = this.activeTurns.get(threadId)
      // A late completion for an older turn must not stop a newer one.
      if (
        active !== undefined &&
        typeof turn?.id === "string" &&
        active === turn.id
      ) {
        this.activeTurns.delete(threadId)
        this.bump(threadId)
        this.scheduleIdle()
      } else if (active === null && this.socket && this.ready) {
        // Unknown turn identity: an older completion cannot prove this turn ended.
        this.reconcileActive(this.socket)
      }
    }
    // Server-initiated tool approvals require a live socket for the response.
    if (message.id !== undefined && message.method?.startsWith("item/")) {
      this.approvals.add(message.id)
      this.clearIdle()
    }
  }

  private observeResult(
    method: string,
    threadId: string | undefined,
    result: unknown,
  ): void {
    if (!threadId) return
    if (method === "turn/start") {
      const id = (result as { turn?: { id?: unknown } } | null)?.turn?.id
      if (typeof id === "string" && this.activeTurns.get(threadId) === null)
        this.activeTurns.set(threadId, id)
      return
    }
    if (method !== "thread/read" && method !== "thread/resume") return
    const thread = (
      result as {
        thread?: { status?: { type?: string }; turns?: Array<{ id?: string }> }
      } | null
    )?.thread
    const status = thread?.status?.type
    if (status === "active") {
      this.activeTurns.set(threadId, thread?.turns?.at(-1)?.id ?? null)
      this.bump(threadId)
      this.clearIdle()
    } else if (typeof status === "string" && status !== "") {
      this.activeTurns.delete(threadId)
      this.bump(threadId)
      this.scheduleIdle()
    }
  }

  private reconcileActive(socket: WebSocket): void {
    for (const threadId of this.activeTurns.keys()) {
      const revision = this.revisions.get(threadId)
      // Read only. Never replay turn/start, approvals, or other mutations.
      void this.sendRequest<{
        thread?: { status?: { type?: string }; turns?: Array<{ id?: string }> }
      }>(socket, "thread/read", { threadId, includeTurns: true }, false)
        .then((result) => {
          if (
            socket === this.socket &&
            this.revisions.get(threadId) === revision
          )
            this.observeResult("thread/read", threadId, result)
        })
        .catch(() => {})
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private scheduleIdle(): void {
    if (
      this.stopped ||
      this.foreground ||
      this.activeTurns.size ||
      this.approvals.size ||
      this.pending.size ||
      !this.ready
    ) {
      this.clearIdle()
      return
    }
    if (this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (
        this.foreground ||
        this.activeTurns.size ||
        this.approvals.size ||
        this.pending.size
      )
        return
      const socket = this.socket
      this.socket = null // intentional idle close: no retry
      this.ready = false
      this.recovering = false
      socket?.close()
      // A mounted view can reconnect on its next deliberate interaction.
      for (const listener of this.listeners) listener.close()
    }, this.idleMs)
  }

  private sendRequest<T>(
    socket: WebSocket,
    method: string,
    params: Record<string, unknown>,
    observe = true,
  ): Promise<T> {
    if (socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Codex is not connected"))
    const id = this.nextId++
    const threadId =
      typeof params.threadId === "string" ? params.threadId : undefined
    // An uncertain turn/start result (including a dropped response) may already
    // be executing server-side. Hold the socket/reconnect until confirmed idle.
    if (observe && method === "turn/start" && threadId) {
      this.activeTurns.set(threadId, null)
      this.bump(threadId)
    }
    this.clearIdle()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        method: observe ? method : "reconcile/read",
        threadId,
        revision: threadId ? this.revisions.get(threadId) : undefined,
      })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        // A local send failure cannot have started a server turn.
        if (
          observe &&
          method === "turn/start" &&
          threadId &&
          this.activeTurns.get(threadId) === null
        )
          this.activeTurns.delete(threadId)
        this.scheduleIdle()
        reject(error instanceof Error ? error : new Error("Codex send failed"))
      }
    })
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (
      !this.ready ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      // A foreground idle close reconnects on the next deliberate request.
      // Fail this mutation rather than queueing it across a new handshake.
      if (!this.stopped && this.listeners.size)
        void this.connect().catch(() => {})
      return Promise.reject(
        new Error(
          "Codex is not connected; reconnecting. Retry the action once connected",
        ),
      )
    }
    return this.sendRequest<T>(this.socket, method, params)
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ method, params }))
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ id, result }))
    this.approvals.delete(id)
    this.scheduleIdle()
  }

  private recover(): void {
    if (
      !this.stopped &&
      (this.listeners.size || this.activeTurns.size || this.approvals.size) &&
      !this.ready &&
      !this.opening
    )
      void this.connect().catch(() => {})
  }

  private scheduleRetry(): void {
    if (
      this.stopped ||
      !(this.listeners.size || this.activeTurns.size || this.approvals.size) ||
      this.retryTimer ||
      (typeof navigator !== "undefined" && navigator.onLine === false)
    )
      return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.recover()
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, 30000)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  stop(): void {
    this.stopped = true
    this.clearRetry()
    this.clearIdle()
    this.activeTurns.clear()
    this.approvals.clear()
    this.revisions.clear()
    this.ready = false
    this.recovering = false
    const socket = this.socket
    this.socket = null
    socket?.close()
    for (const pending of this.pending.values())
      pending.reject(new Error("Codex session ended"))
    this.pending.clear()
    for (const listener of this.listeners) listener.close()
    this.listeners.clear()
  }
}

// Kept at module scope: client instances on different routes share this socket.
export const codexSocketManager = new CodexSocketManager(() => {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:"
  return `${scheme}//${location.host}/api/codex/app-server/ws`
})

export function setCodexDetailVisible(visible: boolean): void {
  codexSocketManager.setForeground(visible)
}
