import { afterEach, describe, expect, it, vi } from "vitest"

import { getLocalChatCacheStats } from "@/features/chat/local-storage-stats"

const originalIndexedDB = globalThis.indexedDB

afterEach(() => {
  vi.stubGlobal("indexedDB", originalIndexedDB)
})

describe("local chat cache stats", () => {
  it("returns zero without creating a missing database", async () => {
    const open = vi.fn()
    vi.stubGlobal("indexedDB", { databases: async () => [], open })
    await expect(getLocalChatCacheStats()).resolves.toEqual({
      bytes: 0,
      count: 0,
    })
    expect(open).not.toHaveBeenCalled()
  })

  it("counts actual JSON UTF-8 bytes through a readonly cursor", async () => {
    const records = [
      { id: "pico", messages: [{ content: "你好" }] },
      { id: "weixin", messages: [] },
    ]
    const transaction = {
      oncomplete: null as null | (() => void),
      onerror: null,
      onabort: null,
      objectStore: vi.fn(),
    }
    transaction.objectStore.mockReturnValue({
      openCursor: () => {
        const cursor = {
          result: null as null | { value: unknown; continue: () => void },
          onsuccess: null as null | (() => void),
        }
        let index = 0
        const next = () => {
          cursor.result =
            index < records.length
              ? { value: records[index++], continue: next }
              : null
          const done = cursor.result === null
          queueMicrotask(() => {
            cursor.onsuccess?.()
            if (done) transaction.oncomplete?.()
          })
        }
        queueMicrotask(next)
        return cursor
      },
    })
    const database = {
      objectStoreNames: { contains: (name: string) => name === "sessions" },
      transaction: vi.fn().mockReturnValue(transaction),
      close: vi.fn(),
    }
    vi.stubGlobal("indexedDB", {
      databases: async () => [{ name: "musec137-chat" }],
      open: (name: string) => {
        expect(name).toBe("musec137-chat")
        const request = {
          result: database,
          onsuccess: null as null | (() => void),
          onerror: null,
          onupgradeneeded: null,
        }
        queueMicrotask(() => request.onsuccess?.())
        return request
      },
    })
    await expect(getLocalChatCacheStats()).resolves.toEqual({
      bytes: records.reduce(
        (sum, record) =>
          sum + new TextEncoder().encode(JSON.stringify(record)).length,
        0,
      ),
      count: 2,
    })
    expect(database.transaction).toHaveBeenCalledWith("sessions", "readonly")
    expect(database.close).toHaveBeenCalledOnce()
  })
})
