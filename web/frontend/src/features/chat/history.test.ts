import { describe, expect, it } from "vitest"

import {
  mergeHistoryMessages,
  removeMatchingHistoryCopies,
} from "@/features/chat/history"
import type { ChatMessage } from "@/store/chat"

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message",
    role: "assistant",
    content: "reply",
    timestamp: 1,
    ...overrides,
  }
}

describe("chat history reconciliation", () => {
  it("merges a reconnect history copy despite transport metadata differences", () => {
    const history = [
      message({ id: "hist-session-1", modelName: "deepseek-flash" }),
    ]
    const live = [message({ id: "live-1", timestamp: 120_000 })]

    expect(mergeHistoryMessages(history, live)).toEqual(live)
  })

  it("removes a history copy from the current turn without a time window", () => {
    const currentUser = message({
      id: "user-current",
      role: "user",
      content: "question",
      timestamp: 1,
    })
    const historyCopy = message({
      id: "hist-session-2",
      modelName: "deepseek-flash",
      timestamp: 2,
    })
    const live = message({ id: "live-2", timestamp: 3_600_000 })

    expect(
      removeMatchingHistoryCopies([currentUser, historyCopy, live], live),
    ).toEqual([currentUser, live])
  })

  it("keeps an identical reply from an older turn", () => {
    const olderHistory = message({ id: "hist-session-older", timestamp: 1 })
    const currentUser = message({
      id: "user-current",
      role: "user",
      content: "another question",
      timestamp: 2,
    })
    const live = message({ id: "live-current", timestamp: 3 })

    expect(
      removeMatchingHistoryCopies([olderHistory, currentUser, live], live),
    ).toEqual([olderHistory, currentUser, live])
  })

  it("repairs an already duplicated history/live pair on the next reconnect", () => {
    const currentUser = message({
      id: "user-current",
      role: "user",
      content: "question",
      timestamp: 1,
    })
    const historyCopy = message({
      id: "hist-session-3",
      modelName: "deepseek-flash",
      timestamp: 2,
    })
    const live = message({ id: "live-3", timestamp: 60_000 })

    expect(
      mergeHistoryMessages(
        [currentUser, historyCopy],
        [currentUser, historyCopy, live],
      ),
    ).toEqual([currentUser, live])
  })
})

describe("uncertain send reconciliation", () => {
  const local = (
    id: string,
    status: "failed" | "pending" | "unconfirmed",
    timestamp = 10_000,
  ) =>
    message({
      id,
      role: "user",
      content: "same question",
      timestamp,
      sendStatus: status,
    })
  const durable = (id: string, timestamp: number) =>
    message({ id, role: "user", content: "same question", timestamp })

  it("keeps an unconfirmed or failed send when history has no confirmation", () => {
    const old = durable("hist-old", 1_000)
    for (const status of ["failed", "unconfirmed"] as const) {
      expect(mergeHistoryMessages([old], [local("local", status)])).toEqual([
        old,
        local("local", status),
      ])
    }
  })

  it("prefers authoritative history on confirmation even for a failed local send", () => {
    const confirmed = durable("hist-new", 10_100)
    expect(
      mergeHistoryMessages([confirmed], [local("local", "failed")]),
    ).toEqual([confirmed])
  })

  it("does not let a failed local send shadow a distinct older matching history entry", () => {
    const old = durable("hist-old", 1_000)
    expect(
      mergeHistoryMessages([old], [local("local", "failed")]),
    ).toHaveLength(2)
  })

  it("consumes separate confirmation records for repeated identical sends", () => {
    const first = durable("hist-1", 10_100)
    const second = durable("hist-2", 10_200)
    expect(
      mergeHistoryMessages(
        [first, second],
        [local("local-1", "pending"), local("local-2", "unconfirmed", 10_050)],
      ),
    ).toEqual([first, second])
  })

  it("removes a stale cached transient when authoritative history is already in current", () => {
    const confirmed = durable("hist-new", 10_100)
    expect(
      mergeHistoryMessages(
        [local("local", "unconfirmed")],
        [confirmed, local("local", "unconfirmed")],
      ),
    ).toEqual([confirmed])
  })
})

describe("local send cache persistence", () => {
  it("preserves failed sends and restores pending sends as unconfirmed without storing oversized inline media", async () => {
    const { loadCachedSession, saveCachedSession } =
      await import("@/features/chat/local-cache")
    const records = new Map<string, unknown>()
    const database = {
      objectStoreNames: { contains: () => true },
      close: () => {},
      transaction: () => {
        const transaction: {
          oncomplete?: () => void
          onerror?: () => void
          onabort?: () => void
          objectStore: () => {
            put: (value: { id: string }) => void
            get: (id: string) => {
              result?: unknown
              onsuccess?: () => void
              onerror?: () => void
            }
          }
        } = {
          objectStore: () => ({
            put: (value) => {
              records.set(value.id, value)
              queueMicrotask(() => transaction.oncomplete?.())
            },
            get: (id) => {
              const request: { result?: unknown; onsuccess?: () => void } = {}
              queueMicrotask(() => {
                request.result = records.get(id)
                request.onsuccess?.()
                transaction.oncomplete?.()
              })
              return request
            },
          }),
        }
        return transaction
      },
    }
    const originalIndexedDB = globalThis.indexedDB
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open: () => {
          const request: { result: typeof database; onsuccess?: () => void } = {
            result: database,
          }
          queueMicrotask(() => request.onsuccess?.())
          return request
        },
      },
    })
    try {
      const session = {
        id: "send-cache-test",
        messages: [
          message({
            id: "pending",
            role: "user",
            sendStatus: "pending",
            attachments: [
              {
                type: "image" as const,
                url: `data:image/png;base64,${"x".repeat(600_000)}`,
              },
            ],
          }),
          message({
            id: "failed",
            role: "user",
            sendStatus: "failed",
            sendError: "rejected",
          }),
        ],
        hasMore: false,
        nextBefore: null,
        updatedAt: 1,
      }
      await saveCachedSession(session)
      const restored = await loadCachedSession(session.id)
      expect(restored?.messages.map((item) => item.sendStatus)).toEqual([
        "unconfirmed",
        "failed",
      ])
      expect(restored?.messages[0]?.attachments).toBeUndefined()
      expect(restored?.messages[1]?.sendError).toBe("rejected")
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: originalIndexedDB,
      })
    }
  })
})
