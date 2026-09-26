import { afterEach, describe, expect, it, vi } from "vitest"

import type { CodexThread } from "@/api/codex"

import {
  MAX_CACHED_HISTORY_THREADS,
  clearCodexHistoryCache,
  codexHistoryCacheStats,
  deleteCodexHistoryCache,
  readCodexHistoryCache,
  writeCodexHistoryCache,
} from "./history-cache"

const A = "a".repeat(32),
  B = "b".repeat(32)
const thread = (id: string): CodexThread => ({
  id,
  historyMode: "legacy",
  name: "test",
  turns: [
    {
      id: "turn",
      items: [
        {
          id: "user",
          type: "userMessage",
          content: [
            { type: "text", text: "hello" },
            { type: "image", url: "data:image/png;base64,abc" },
          ],
        },
        { id: "reply", type: "agentMessage", text: "answer" },
      ],
    },
  ],
})

// Asynchronous mock IDB: requests finish before transaction completes; DB survives opens.
function mockIDB() {
  const records = new Map<string, unknown>()
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request: Record<string, unknown> = {}
      const db = {
        objectStoreNames: { contains: () => true },
        close: () => undefined,
        transaction: () => {
          const tx: Record<string, unknown> = {}
          let pending = 0
          const requestFor = (result: () => unknown, effect?: () => void) => {
            const r: Record<string, unknown> = {}
            pending++
            queueMicrotask(() => {
              effect?.()
              r.result = result()
              ;(r.onsuccess as (() => void) | undefined)?.()
              pending--
              if (!pending)
                queueMicrotask(() =>
                  (tx.oncomplete as (() => void) | undefined)?.(),
                )
            })
            return r
          }
          tx.objectStore = () => ({
            get: (key: string) => requestFor(() => records.get(key)),
            getAll: () => requestFor(() => [...records.values()]),
            put: (value: { key: string }) =>
              requestFor(
                () => value.key,
                () => records.set(value.key, structuredClone(value)),
              ),
            delete: (key: string) =>
              requestFor(
                () => undefined,
                () => records.delete(key),
              ),
            clear: () =>
              requestFor(
                () => undefined,
                () => records.clear(),
              ),
          })
          return tx
        },
      }
      request.result = db
      queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.())
      return request
    },
  })
  return records
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("Codex history cache", () => {
  it("scopes records and persists only bounded display fields; stats count actual serialized bytes", async () => {
    const records = mockIDB()
    const t = thread("one")
    t.turns![0].items![1].text = "Bearer abc123 data:image/png;base64,abc"
    t.turns![0].items![1].changes = [{ password: "unsafe" }]
    t.cwd = "/private/cwd"
    await writeCodexHistoryCache(A, t.id, t)
    expect(await readCodexHistoryCache(B, t.id)).toBeNull()
    const result = await readCodexHistoryCache(A, t.id)
    expect(result?.turns?.[0].items?.[0].content).toEqual([
      { type: "text", text: "hello" },
    ])
    expect(JSON.stringify(result)).not.toMatch(
      /abc123|data:image|unsafe|private\/cwd/,
    )
    const stored = [...records.values()][0]
    expect(await codexHistoryCacheStats(A)).toEqual({
      count: 1,
      bytes: new TextEncoder().encode(JSON.stringify(stored)).length,
    })
    expect(await codexHistoryCacheStats(B)).toEqual({ count: 0, bytes: 0 })
  })

  it("accepts complete paginated turns without changing their history mode", async () => {
    mockIDB()
    const t = { ...thread("paged"), historyMode: "paginated" }
    await writeCodexHistoryCache(A, t.id, t)
    expect(await readCodexHistoryCache(A, t.id)).toMatchObject({
      historyMode: "paginated",
      turns: [{ id: "turn", items: [{ id: "user" }, { id: "reply" }] }],
    })
    await writeCodexHistoryCache(A, "missing", {
      id: "missing",
      historyMode: "paginated",
    })
    expect(await readCodexHistoryCache(A, "missing")).toBeNull()
    await writeCodexHistoryCache(A, "oversized", {
      id: "oversized",
      historyMode: "paginated",
      turns: [
        {
          id: "t",
          items: [{ id: "i", type: "agentMessage", text: "x".repeat(32769) }],
        },
      ],
    })
    expect(await readCodexHistoryCache(A, "oversized")).toBeNull()
  })

  it("rejects invalid scopes, oversized histories and unsupported modes", async () => {
    mockIDB()
    await writeCodexHistoryCache("token:bad", "one", thread("one"))
    await writeCodexHistoryCache(A, "one", {
      ...thread("one"),
      historyMode: "native",
    })
    await writeCodexHistoryCache(A, "one", {
      ...thread("one"),
      turns: [
        {
          id: "t",
          items: Array.from({ length: 1001 }, (_, n) => ({
            id: `item-${n}`,
            type: "agentMessage",
            text: "x",
          })),
        },
      ],
    })
    expect(await readCodexHistoryCache(A, "one")).toBeNull()
  })

  it("prunes least recently used, expires after 30 days, and deletes scoped records", async () => {
    const records = mockIDB()
    for (let n = 0; n < MAX_CACHED_HISTORY_THREADS; n++)
      await writeCodexHistoryCache(A, String(n), thread(String(n)))
    await readCodexHistoryCache(A, "0")
    ;(records.get(`${A}:1`) as { accessedAt: number }).accessedAt =
      Date.now() - 10000
    await writeCodexHistoryCache(A, "extra", thread("extra"))
    expect((await codexHistoryCacheStats(A)).count).toBe(
      MAX_CACHED_HISTORY_THREADS,
    )
    expect(await readCodexHistoryCache(A, "1")).toBeNull()
    expect(await readCodexHistoryCache(A, "0")).not.toBeNull()
    await writeCodexHistoryCache(B, "one", thread("one"))
    await deleteCodexHistoryCache(A, "0")
    await clearCodexHistoryCache(A)
    expect(await readCodexHistoryCache(B, "one")).not.toBeNull()
    const entry = records.get(`${B}:one`) as { savedAt: number }
    entry.savedAt = Date.now() - 31 * 86400000
    expect(await readCodexHistoryCache(B, "one")).toBeNull()
  })

  it("invalidates writes queued before deletion and logout", async () => {
    mockIDB()
    const first = writeCodexHistoryCache(A, "one", thread("one"))
    const deletion = deleteCodexHistoryCache(A, "one")
    await Promise.all([first, deletion])
    expect(await readCodexHistoryCache(A, "one")).toBeNull()
    const second = writeCodexHistoryCache(A, "two", thread("two"))
    const logout = clearCodexHistoryCache()
    await Promise.all([second, logout])
    expect(await codexHistoryCacheStats(A)).toEqual({ count: 0, bytes: 0 })
  })
})
