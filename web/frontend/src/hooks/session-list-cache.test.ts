import { afterEach, describe, expect, it, vi } from "vitest"

import {
  MAX_SESSION_SUMMARIES,
  invalidateSessionListCache,
  readSessionListCache,
  reconcileFirstPage,
  validCacheScope,
  writeSessionListCache,
} from "./session-list-cache"

const A = "a".repeat(32)
const B = "b".repeat(32)
const summary = (id: string) => ({
  id,
  channel: "pico" as const,
  title: "title",
  preview: "preview",
  message_count: 1,
  created: "2026-01-01",
  updated: "2026-01-01",
})

// Minimal asynchronous IDB with transaction completion and persistent records.
function mockStorage() {
  const records = new Map<string, unknown>()
  vi.stubGlobal("indexedDB", {
    open: () => {
      const req: Record<string, unknown> = {
        result: {
          objectStoreNames: { contains: () => true },
          close: () => undefined,
          transaction: () => {
            const tx: Record<string, unknown> = {}
            tx.objectStore = () => ({
              get: (key: string) => {
                const r: Record<string, unknown> = { result: records.get(key) }
                queueMicrotask(() => {
                  ;(r.onsuccess as () => void)?.()
                  ;(tx.oncomplete as () => void)?.()
                })
                return r
              },
              put: (value: { id: string }) => {
                records.set(value.id, value)
                queueMicrotask(() => (tx.oncomplete as () => void)?.())
              },
              delete: (key: string) => {
                records.delete(key)
                queueMicrotask(() => (tx.oncomplete as () => void)?.())
              },
              clear: () => {
                records.clear()
                queueMicrotask(() => (tx.oncomplete as () => void)?.())
              },
            })
            return tx
          },
        },
      }
      queueMicrotask(() => (req.onsuccess as () => void)?.())
      return req
    },
  })
  return records
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("scoped session list cache", () => {
  it("accepts only opaque scopes, never raw or absent tokens", () => {
    expect(validCacheScope(A)).toBe(true)
    for (const scope of [
      undefined,
      "recent",
      "token:abc123",
      "a/b",
      " ".repeat(32),
    ])
      expect(validCacheScope(scope)).toBe(false)
  })

  it("isolates scopes, caps at 200 and clears every scope on logout", async () => {
    mockStorage()
    const many = Array.from({ length: 220 }, (_, n) => summary(`${n}`))
    await writeSessionListCache(A, {
      sessions: many,
      offset: 220,
      hasMore: false,
    })
    await writeSessionListCache(B, {
      sessions: [summary("b")],
      offset: 1,
      hasMore: false,
    })
    expect((await readSessionListCache(A))?.sessions).toHaveLength(
      MAX_SESSION_SUMMARIES,
    )
    expect((await readSessionListCache(A))?.hasMore).toBe(true)
    expect((await readSessionListCache(B))?.sessions[0].id).toBe("b")
    await invalidateSessionListCache()
    expect(await readSessionListCache(A)).toBeNull()
    expect(await readSessionListCache(B)).toBeNull()
  })

  it("rejects malformed and aged snapshots", async () => {
    const records = mockStorage()
    records.set(A, {
      id: A,
      savedAt: Date.now(),
      sessions: [{ id: "broken" }],
      offset: 1,
      hasMore: true,
    })
    expect(await readSessionListCache(A)).toBeNull()
    records.set(A, {
      id: A,
      savedAt: Date.now() - 600_000,
      sessions: [],
      offset: 0,
      hasMore: false,
    })
    expect(await readSessionListCache(A)).toBeNull()
    records.set(A, {
      id: B,
      savedAt: Date.now(),
      sessions: [],
      offset: 0,
      hasMore: false,
    })
    expect(await readSessionListCache(A)).toBeNull()
  })

  it("prevents queued late writes resurrecting a deleted list", async () => {
    mockStorage()
    const write = writeSessionListCache(A, {
      sessions: [summary("x")],
      offset: 1,
      hasMore: false,
    })
    const clear = invalidateSessionListCache()
    await Promise.all([write, clear])
    expect(await readSessionListCache(A)).toBeNull()
  })

  it("degrades to network-only if IndexedDB is missing or denied", async () => {
    vi.stubGlobal("indexedDB", undefined)
    expect(await readSessionListCache(A)).toBeNull()
    await expect(
      writeSessionListCache(A, { sessions: [], offset: 0, hasMore: false }),
    ).resolves.toBeUndefined()
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("denied")
      },
    })
    expect(await readSessionListCache(A)).toBeNull()
    await expect(invalidateSessionListCache()).resolves.toBeUndefined()
  })
})

describe("first-page reconciliation", () => {
  it("preserves cached tail and fresh summary fields only when IDs line up", () => {
    const old = Array.from({ length: 4 }, (_, n) => summary(String(n)))
    const fresh = [{ ...summary("0"), title: "updated" }, summary("1")]
    const cached = { sessions: old, offset: 4, hasMore: true }
    expect(reconcileFirstPage(fresh, cached, 2)).toEqual([
      fresh[0],
      fresh[1],
      old[2],
      old[3],
    ])
    expect(
      reconcileFirstPage([summary("new"), fresh[0]], cached, 2),
    ).toHaveLength(2)
    expect(reconcileFirstPage([summary("0")], cached, 2)).toHaveLength(1)
    expect(reconcileFirstPage(fresh, null, 2)).toEqual(fresh)
  })
})
