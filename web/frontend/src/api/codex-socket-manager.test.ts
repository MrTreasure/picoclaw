import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CodexSocketManager } from "./codex-socket-manager"

class FakeSocket {
  static sockets: FakeSocket[] = []
  static OPEN = 1
  readyState = 0
  sent: Array<{ id?: number; method?: string; params?: unknown }> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(_url: string) {
    FakeSocket.sockets.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as { id?: number; method?: string })
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  handshake() {
    this.open()
    expect(this.sent[0]?.method).toBe("initialize")
    this.receive({ id: this.sent[0]?.id, result: {} })
  }
}

beforeEach(() => {
  FakeSocket.sockets = []
  vi.stubGlobal("WebSocket", FakeSocket)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function tick() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("shared Codex socket", () => {
  it("uses one initialized socket for concurrent clients and globally unique request IDs", async () => {
    const manager = new CodexSocketManager(() => "ws://test")
    const eventA = vi.fn(),
      eventB = vi.fn()
    const releaseA = manager.subscribe({
      event: eventA,
      close: vi.fn(),
      reconnect: vi.fn(),
    })
    manager.subscribe({ event: eventB, close: vi.fn(), reconnect: vi.fn() })
    const first = manager.connect(),
      second = manager.connect()
    expect(FakeSocket.sockets).toHaveLength(1)
    const socket = FakeSocket.sockets[0]!
    socket.handshake()
    await Promise.all([first, second])
    expect(socket.sent[1]?.method).toBe("initialized")
    const a = manager.request("thread/list", {}),
      b = manager.request("model/list", {})
    expect(socket.sent[2]?.id).not.toBe(socket.sent[3]?.id)
    socket.receive({ method: "turn/started", params: { threadId: "x" } })
    expect(eventA).toHaveBeenCalledOnce()
    expect(eventB).toHaveBeenCalledOnce()
    releaseA()
    socket.receive({ method: "turn/completed" })
    expect(eventA).toHaveBeenCalledOnce()
    expect(eventB).toHaveBeenCalledTimes(2)
    socket.receive({ id: socket.sent[3]?.id, result: "b" })
    socket.receive({ id: socket.sent[2]?.id, result: "a" })
    await expect(a).resolves.toBe("a")
    await expect(b).resolves.toBe("b")
    manager.stop()
  })

  it("rejects dropped requests, reinitializes, and never replays a mutation", async () => {
    vi.useFakeTimers()
    const manager = new CodexSocketManager(() => "ws://test")
    const close = vi.fn(),
      reconnect = vi.fn()
    manager.subscribe({ event: vi.fn(), close, reconnect })
    const opening = manager.connect()
    const socket = FakeSocket.sockets[0]!
    socket.handshake()
    await opening
    const mutation = manager.request("turn/start", {})
    socket.close()
    await expect(mutation).rejects.toThrow("dropped")
    expect(close).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    const next = FakeSocket.sockets[1]!
    expect(next.sent).toHaveLength(0)
    next.handshake()
    await tick()
    expect(next.sent.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
    ])
    expect(reconnect).toHaveBeenCalledOnce()
    manager.stop()
  })

  it("notifies subscribers when the first handshake fails but a retry succeeds", async () => {
    vi.useFakeTimers()
    const manager = new CodexSocketManager(() => "ws://test")
    const reconnect = vi.fn()
    manager.subscribe({ event: vi.fn(), close: vi.fn(), reconnect })
    const opening = manager.connect()
    FakeSocket.sockets[0]!.close()
    await expect(opening).rejects.toThrow("dropped")
    await vi.advanceTimersByTimeAsync(1000)
    FakeSocket.sockets[1]!.handshake()
    await tick()
    expect(reconnect).toHaveBeenCalledOnce()
    manager.stop()
  })

  it("blocks uninitialized and stopped sends and rejects in-flight work on logout", async () => {
    const manager = new CodexSocketManager(() => "ws://test")
    await expect(manager.request("turn/start", {})).rejects.toThrow(
      "not connected",
    )
    const opening = manager.connect()
    const socket = FakeSocket.sockets[0]!
    socket.open()
    manager.notify("turn/start", {})
    expect(socket.sent).toHaveLength(1)
    socket.receive({ id: socket.sent[0]?.id, result: {} })
    await opening
    const pending = manager.request("turn/start", {})
    manager.stop()
    await expect(pending).rejects.toThrow("session ended")
    await expect(manager.request("turn/start", {})).rejects.toThrow(
      "not connected",
    )
  })
  it("keeps a running turn across route release, then closes five minutes after completion", async () => {
    vi.useFakeTimers()
    const manager = new CodexSocketManager(() => "ws://test")
    const release = manager.subscribe({
      event: vi.fn(),
      close: vi.fn(),
      reconnect: vi.fn(),
    })
    const opening = manager.connect()
    const socket = FakeSocket.sockets[0]!
    socket.handshake()
    await opening
    socket.receive({
      method: "turn/started",
      params: { threadId: "t", turn: { id: "a" } },
    })
    release()
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    expect(socket.readyState).toBe(1)
    socket.receive({
      method: "turn/completed",
      params: { threadId: "t", turn: { id: "a" } },
    })
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    expect(socket.readyState).toBe(1)
    const close = vi.fn()
    const reopened = manager.subscribe({
      event: vi.fn(),
      close,
      reconnect: vi.fn(),
    })
    manager.setForeground(true)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(socket.readyState).toBe(1)
    manager.setForeground(false)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1)
    expect(socket.readyState).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.readyState).toBe(3)
    expect(close).toHaveBeenCalledOnce()
    await expect(
      manager.request("turn/start", { threadId: "t" }),
    ).rejects.toThrow("not connected")
    const connecting = manager.connect()
    const next = FakeSocket.sockets[1]!
    next.handshake()
    await connecting
    expect(next.sent.map((message) => message.method).join(",")).toBe(
      "initialize,initialized",
    )
    reopened()
    manager.stop()
  })

  it("does not treat a stale completion as ending an unknown newer turn", async () => {
    vi.useFakeTimers()
    const manager = new CodexSocketManager(() => "ws://test")
    const opening = manager.connect()
    const socket = FakeSocket.sockets[0]!
    socket.handshake()
    await opening
    const pending = manager.request("turn/start", { threadId: "t" })
    socket.receive({
      method: "turn/completed",
      params: { threadId: "t", turn: { id: "old" } },
    })
    expect(socket.sent.at(-1)?.method).toBe("thread/read")
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    expect(socket.readyState).toBe(1)
    manager.stop()
    await expect(pending).rejects.toThrow("session ended")
  })

  it("closes an idle nonrunning socket, but never closes pending requests or approvals", async () => {
    vi.useFakeTimers()
    const manager = new CodexSocketManager(() => "ws://test")
    const release = manager.subscribe({
      event: vi.fn(),
      close: vi.fn(),
      reconnect: vi.fn(),
    })
    const opening = manager.connect()
    const socket = FakeSocket.sockets[0]!
    socket.handshake()
    await opening
    const request = manager.request("model/list", {})
    release()
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    expect(socket.readyState).toBe(1)
    socket.receive({ id: socket.sent.at(-1)?.id, result: {} })
    await request
    socket.receive({
      id: 900,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t" },
    })
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    expect(socket.readyState).toBe(1)
    manager.respond(900, { decision: "accept" })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(socket.readyState).toBe(3)
    manager.stop()
  })

  it("reconciles off-route active turns after reconnect without replaying mutations", async () => {
    vi.useFakeTimers()
    const manager = new CodexSocketManager(() => "ws://test")
    const release = manager.subscribe({
      event: vi.fn(),
      close: vi.fn(),
      reconnect: vi.fn(),
    })
    const opening = manager.connect()
    const socket = FakeSocket.sockets[0]!
    socket.handshake()
    await opening
    const started = manager.request("turn/start", { threadId: "t" })
    socket.receive({
      id: socket.sent.at(-1)?.id,
      result: { turn: { id: "a" } },
    })
    await started
    release()
    socket.close()
    await vi.advanceTimersByTimeAsync(1000)
    const next = FakeSocket.sockets[1]!
    next.handshake()
    await tick()
    expect(next.sent.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
    ])
    next.receive({
      id: next.sent.at(-1)?.id,
      result: { thread: { status: { type: "idle" } } },
    })
    await tick()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(next.readyState).toBe(3)
    manager.stop()
  })

  it("does not retry an initial failed connection without an active turn or listener", async () => {
    vi.useFakeTimers()
    const manager = new CodexSocketManager(() => "ws://test")
    const opening = manager.connect()
    FakeSocket.sockets[0]!.close()
    await expect(opening).rejects.toThrow("dropped")
    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(FakeSocket.sockets).toHaveLength(1)
    manager.stop()
  })
})
