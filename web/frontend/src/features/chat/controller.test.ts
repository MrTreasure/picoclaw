import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { loadSessionMessages } = vi.hoisted(() => ({
  loadSessionMessages: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }))
vi.mock("@/features/chat/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/chat/history")>()),
  loadSessionMessages,
}))

class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  static sockets: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null = null
  onerror: (() => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.sockets.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  receive(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
    id?: string,
  ) {
    this.onmessage?.({
      data: JSON.stringify({ type, payload, session_id: sessionId, id }),
    })
  }
  sent: string[] = []
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
  remoteClose(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code, reason: "network lost", wasClean: false })
  }
}

let controller: typeof import("@/features/chat/controller")
let chat: typeof import("@/store/chat")
let gateway: typeof import("@/store/gateway")
let resolveHistory: (page: {
  messages: []
  hasMore: false
  nextBefore: null
}) => void
const emptyPage = { messages: [], hasMore: false, nextBefore: null } satisfies {
  messages: []
  hasMore: false
  nextBefore: null
}

beforeEach(async () => {
  vi.useFakeTimers()
  FakeSocket.sockets = []
  vi.stubGlobal("WebSocket", FakeSocket)
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  vi.stubGlobal("location", {
    protocol: "https:",
    host: "example.test",
    pathname: "/",
    search: "",
  })
  vi.stubGlobal("window", {
    location: globalThis.location,
    setTimeout,
    clearTimeout,
  })
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  vi.resetModules()
  controller = await import("@/features/chat/controller")
  chat = await import("@/store/chat")
  gateway = await import("@/store/gateway")
  gateway.updateGatewayStore({ status: "running" })
  loadSessionMessages.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveHistory = resolve
      }),
  )
})

afterEach(() => {
  controller?.disconnectChat()
  loadSessionMessages.mockReset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("Pico socket lifecycle", () => {
  it("reuses A in A/B/A and isolates inactive output from B", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const a = FakeSocket.sockets[0]!
    a.open()
    const aId = chat.getChatState().activeSessionId
    expect(controller.sendChatMessage({ content: "test" })).toBe(true)
    await controller.switchChatSession("session_b")
    const b = FakeSocket.sockets[1]!
    b.open()
    a.receive(
      "message.create",
      { message_id: "a-reply", content: "private A", final: false },
      aId,
    )
    expect(chat.getChatState().activeSessionId).toBe("session_b")
    expect(
      chat.getChatState().messages.find((m) => m.id === "a-reply"),
    ).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1)
    expect(a.readyState).toBe(FakeSocket.OPEN)
    await controller.switchChatSession(aId)
    expect(FakeSocket.sockets).toHaveLength(2)
    expect(a.readyState).toBe(FakeSocket.OPEN)
    expect(b.readyState).toBe(FakeSocket.OPEN)
    expect(chat.getChatState().connectionState).toBe("connected")
  })

  it("closes inactive socket five minutes after confirmed terminal only", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const a = FakeSocket.sockets[0]!
    a.open()
    expect(controller.sendChatMessage({ content: "test" })).toBe(true)
    await controller.switchChatSession("session_b")
    FakeSocket.sockets[1]!.open()
    a.receive("typing.stop", {})
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(a.readyState).toBe(FakeSocket.OPEN)
    a.receive("message.update", {
      message_id: "reply",
      content: "done",
      final: true,
    })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1)
    expect(a.readyState).toBe(FakeSocket.OPEN)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.readyState).toBe(3)
  })

  it("keeps the foreground socket after completion, then closes five minutes after leaving the detail", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const socket = FakeSocket.sockets[0]!
    socket.open()
    expect(controller.sendChatMessage({ content: "first" })).toBe(true)
    socket.receive("typing.stop", {})
    socket.receive("message.update", {
      message_id: "answer",
      content: "done",
      final: true,
    })
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    expect(socket.readyState).toBe(1)
    controller.setChatDetailVisible(false)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1)
    expect(socket.readyState).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.readyState).toBe(3)
    controller.setChatDetailVisible(true)
    expect(socket.readyState).toBe(3)
    expect(FakeSocket.sockets).toHaveLength(1)
  })

  it("cancels the background timer upon re-entering and restarts a full five minutes on leaving again", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const socket = FakeSocket.sockets[0]!
    socket.open()
    controller.setChatDetailVisible(false)
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    controller.setChatDetailVisible(true)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(socket.readyState).toBe(1)
    controller.setChatDetailVisible(false)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1)
    expect(socket.readyState).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.readyState).toBe(3)
  })

  it("retains foreground unfinished turn beyond five minutes", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const socket = FakeSocket.sockets[0]!
    socket.open()
    expect(controller.sendChatMessage({ content: "first" })).toBe(true)
    socket.receive("typing.stop", {})
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    expect(socket.readyState).toBe(1)
    socket.receive("message.update", {
      message_id: "answer",
      content: "done",
      final: true,
    })
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    expect(socket.readyState).toBe(1)
  })

  it("keeps five uncertain sessions and refuses a sixth without switching", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    FakeSocket.sockets[0]!.open()
    expect(controller.sendChatMessage({ content: "first" })).toBe(true)
    for (let n = 1; n < 5; n++) {
      await controller.switchChatSession(`session_${n}`)
      FakeSocket.sockets[n]!.open()
      expect(controller.sendChatMessage({ content: `turn ${n}` })).toBe(true)
    }
    const current = chat.getChatState().activeSessionId
    await controller.switchChatSession("session_6")
    expect(chat.getChatState().activeSessionId).toBe(current)
    expect(FakeSocket.sockets).toHaveLength(5)
  })

  it("queues A confirmation while B is foreground and responds only on A socket", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const a = FakeSocket.sockets[0]!
    a.open()
    const aId = chat.getChatState().activeSessionId
    expect(controller.sendChatMessage({ content: "test" })).toBe(true)
    await controller.switchChatSession("session_b")
    const b = FakeSocket.sockets[1]!
    b.open()
    a.receive(
      "confirmation.request",
      { prompt: "Proceed?", expires_at: Date.now() + 120000 },
      aId,
      "confirm-a",
    )
    expect(chat.getChatState().pendingConfirmations).toHaveLength(0)
    expect(controller.respondToConfirmation("confirm-a", true)).toBe(false)
    await controller.switchChatSession(aId)
    expect(
      chat.getChatState().pendingConfirmations.map((c) => c.requestId),
    ).toEqual(["confirm-a"])
    expect(controller.respondToConfirmation("confirm-a", true)).toBe(true)
    expect(b.sent).toHaveLength(0)
    expect(JSON.parse(a.sent.at(-1)!)).toMatchObject({
      type: "confirmation.respond",
      session_id: aId,
    })
  })

  it("keeps the same session-bound socket while live output runs outside the detail view", async () => {
    await controller.connectChat()
    const socket = FakeSocket.sockets[0]!
    socket.open()
    socket.receive("typing.start", {})
    expect(chat.getChatState().isTyping).toBe(true)
    // A route change does not call switchChatSession or tear down the root controller.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(FakeSocket.sockets).toHaveLength(1)
    expect(socket.readyState).toBe(FakeSocket.OPEN)
    resolveHistory(emptyPage)
    await Promise.resolve()
    expect(chat.getChatState().isTyping).toBe(true)
    socket.receive("message.create", {
      message_id: "answer",
      content: "done",
      final: true,
    })
    expect(chat.getChatState().isTyping).toBe(false)
  })

  it("does not let a stale history snapshot erase streamed activity", async () => {
    await controller.connectChat()
    const socket = FakeSocket.sockets[0]!
    socket.open()
    socket.receive("message.create", {
      message_id: "answer",
      content: "partial",
      final: false,
    })
    resolveHistory(emptyPage)
    await Promise.resolve()
    expect(chat.getChatState().isTyping).toBe(true)
    expect(
      chat.getChatState().messages.find((m) => m.id === "answer")?.content,
    ).toBe("partial")
  })

  it("expires an untouched background socket after five minutes and frees its slot", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const first = FakeSocket.sockets[0]!
    first.open()
    const firstId = chat.getChatState().activeSessionId
    for (let n = 1; n < 5; n++) {
      await controller.switchChatSession(`idle_${n}`)
      FakeSocket.sockets[n]!.open()
    }
    const current = chat.getChatState().activeSessionId
    await controller.switchChatSession("sixth")
    // All five sockets retain their full grace period; no premature eviction.
    expect(chat.getChatState().activeSessionId).toBe(current)
    expect(FakeSocket.sockets).toHaveLength(5)
    expect(first.readyState).toBe(1)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(first.readyState).toBe(3)
    await controller.switchChatSession("sixth")
    expect(FakeSocket.sockets).toHaveLength(6)
    await controller.switchChatSession(firstId)
    expect(FakeSocket.sockets).toHaveLength(7) // expired A needs a new socket
  })

  it("evicts only a successful non-active deletion, fencing late history and cache", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const first = FakeSocket.sockets[0]!
    first.open()
    const firstId = chat.getChatState().activeSessionId
    await controller.switchChatSession("second")
    FakeSocket.sockets[1]!.open()
    // A failed DELETE never calls the success-only eviction hook.
    expect(first.readyState).toBe(1)
    controller.evictDeletedChatSession(firstId)
    expect(first.readyState).toBe(3)
    first.receive(
      "message.create",
      { message_id: "late", content: "late" },
      firstId,
    )
    expect(chat.getChatState().messages.some((m) => m.id === "late")).toBe(
      false,
    )
    await controller.switchChatSession(firstId)
    expect(chat.getChatState().activeSessionId).toBe("second")
    expect(FakeSocket.sockets).toHaveLength(2)
  })

  it("ignores a history response arriving after successful deletion", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    FakeSocket.sockets[0]!.open()
    const id = chat.getChatState().activeSessionId
    await controller.switchChatSession("second")
    FakeSocket.sockets[1]!.open()
    let finishHistory!: (page: typeof emptyPage) => void
    loadSessionMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishHistory = resolve
        }),
    )
    const returning = controller.switchChatSession(id)
    controller.evictDeletedChatSession(id)
    finishHistory(emptyPage)
    await returning
    expect(chat.getChatState().messages).toHaveLength(0)
    expect(FakeSocket.sockets[0]!.readyState).toBe(3)
    expect(controller.sendChatMessage({ content: "blocked" })).toBe(false)
  })

  it("evicts active deletion synchronously and does not reconnect or save on timer", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const socket = FakeSocket.sockets[0]!
    socket.open()
    const id = chat.getChatState().activeSessionId
    expect(controller.sendChatMessage({ content: "pending" })).toBe(true)
    controller.evictDeletedChatSession(id)
    expect(socket.readyState).toBe(3)
    expect(controller.sendChatMessage({ content: "never replay" })).toBe(false)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(FakeSocket.sockets).toHaveLength(1)
    await controller.newChatSession(true, true)
    expect(chat.getChatState().activeSessionId).not.toBe(id)
    expect(FakeSocket.sockets).toHaveLength(2)
  })

  it("quarantines a closed uncertain background chat without consuming a slot", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const first = FakeSocket.sockets[0]!
    first.open()
    const firstId = chat.getChatState().activeSessionId
    expect(controller.sendChatMessage({ content: "uncertain" })).toBe(true)
    for (let n = 1; n < 5; n++) {
      await controller.switchChatSession(`live_${n}`)
      FakeSocket.sockets[n]!.open()
      expect(controller.sendChatMessage({ content: `turn ${n}` })).toBe(true)
    }
    first.remoteClose()
    await controller.switchChatSession("sixth")
    expect(FakeSocket.sockets).toHaveLength(6)
    await controller.switchChatSession(firstId)
    expect(chat.getChatState().connectionState).toBe("error")
    expect(FakeSocket.sockets).toHaveLength(6)
    expect(controller.sendChatMessage({ content: "do not replay" })).toBe(false)
  })

  it("reuses a socket opened while backgrounded and keeps pending send status", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const first = FakeSocket.sockets[0]!
    first.open()
    expect(controller.sendChatMessage({ content: "still pending" })).toBe(true)
    const firstId = chat.getChatState().activeSessionId
    await controller.switchChatSession("second")
    const second = FakeSocket.sockets[1]!
    await controller.switchChatSession(firstId)
    expect(
      chat.getChatState().messages.find((m) => m.content === "still pending")
        ?.sendStatus,
    ).toBe("pending")
    second.open()
    await controller.switchChatSession("second")
    expect(chat.getChatState().connectionState).toBe("connected")
    expect(FakeSocket.sockets).toHaveLength(2)
  })

  it("does not let stale returning history clear a live partial stream", async () => {
    let resolveReturn!: (page: typeof emptyPage) => void
    loadSessionMessages
      .mockResolvedValueOnce(emptyPage)
      .mockResolvedValueOnce(emptyPage)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveReturn = resolve
          }),
      )
    await controller.connectChat()
    const first = FakeSocket.sockets[0]!
    first.open()
    const firstId = chat.getChatState().activeSessionId
    await controller.switchChatSession("second")
    FakeSocket.sockets[1]!.open()
    const returning = controller.switchChatSession(firstId)
    first.receive(
      "message.create",
      { message_id: "live", content: "partial", final: false },
      firstId,
    )
    resolveReturn(emptyPage)
    await returning
    expect(chat.getChatState().isTyping).toBe(true)
    expect(
      chat.getChatState().messages.find((m) => m.id === "live")?.content,
    ).toBe("partial")
  })

  it("expires confirmations without a further server event, retaining an uncertain turn", async () => {
    loadSessionMessages.mockResolvedValue(emptyPage)
    await controller.connectChat()
    const first = FakeSocket.sockets[0]!
    first.open()
    const firstId = chat.getChatState().activeSessionId
    first.receive(
      "confirmation.request",
      { prompt: "Proceed?", expires_at: Date.now() + 1000 },
      firstId,
      "req",
    )
    await controller.switchChatSession("second")
    FakeSocket.sockets[1]!.open()
    await vi.advanceTimersByTimeAsync(1000)
    await controller.switchChatSession(firstId)
    expect(chat.getChatState().pendingConfirmations).toHaveLength(0)
    expect(controller.respondToConfirmation("req", true)).toBe(false)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(first.readyState).toBe(1)
  })

  it("logs close code and reconnects without replaying messages", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      await controller.switchChatSession(chat.getChatState().activeSessionId)
      const socket = FakeSocket.sockets[0]!
      socket.open()
      socket.remoteClose(1006)
      expect(info).toHaveBeenCalledWith(
        "Pico WebSocket closed",
        expect.objectContaining({ code: 1006, visibility: "visible" }),
      )
      await vi.advanceTimersByTimeAsync(1000)
      expect(FakeSocket.sockets).toHaveLength(2)
      expect(FakeSocket.sockets[1]!.url).toBe(socket.url)
    } finally {
      info.mockRestore()
    }
  })
})
