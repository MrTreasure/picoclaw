import { afterEach, describe, expect, it, vi } from "vitest"

import {
  MAX_CODEX_THREADS,
  MAX_SESSION_SUMMARIES,
  invalidateCodexSessionListCache,
  invalidateSessionListCache,
  readCodexSessionListCache,
  readSessionListCache,
  reconcileFirstPage,
  validCacheScope,
  writeCodexSessionListCache,
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
              openCursor: () => {
                const keys = [...records.keys()]
                const r: Record<string, unknown> = {}
                let i = 0
                const advance = () => {
                  const key = keys[i++]
                  r.result =
                    key === undefined
                      ? null
                      : {
                          key,
                          delete: () => records.delete(key),
                          continue: () => queueMicrotask(advance),
                        }
                  ;(r.onsuccess as () => void)?.()
                  if (key === undefined) (tx.oncomplete as () => void)?.()
                }
                queueMicrotask(advance)
                return r
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

const thread = (id: string) => ({
  id,
  historyMode: "legacy",
  name: "name",
  preview: "preview",
  cwd: "/work",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_001,
})

describe("account-scoped Codex list cache", () => {
  it("isolates accounts and Pico, caps 50, strips message/status fields", async () => {
    const records = mockStorage()
    await writeSessionListCache(A, {
      sessions: [summary("p")],
      offset: 1,
      hasMore: false,
    })
    const many = Array.from({ length: 60 }, (_, n) => ({
      ...thread(String(n)),
      turns: [
        {
          id: "secret",
          items: [{ id: "m", type: "text", text: "raw message" }],
        },
      ],
      status: { type: "active" },
      source: "private",
    }))
    await writeCodexSessionListCache(A, [
      ...many.slice(0, MAX_CODEX_THREADS - 1),
      { ...thread("paginated"), historyMode: "paginated" },
    ])
    await writeCodexSessionListCache(B, [thread("B")])
    expect((await readCodexSessionListCache(A))?.length).toBe(MAX_CODEX_THREADS)
    expect((await readCodexSessionListCache(A))?.at(-1)?.historyMode).toBe(
      "paginated",
    )
    expect(JSON.stringify(records.get(`codex:${A}`))).not.toMatch(
      /raw message|secret|private|active/,
    )
    expect(await readCodexSessionListCache(B)).toEqual([thread("B")])
    await writeCodexSessionListCache(A, many)
    expect(await readCodexSessionListCache(A)).toBeNull()
    expect(await readCodexSessionListCache(B)).toEqual([thread("B")])
    await writeCodexSessionListCache(A, many.slice(0, MAX_CODEX_THREADS))
    await invalidateSessionListCache(A)
    expect(await readSessionListCache(A)).toBeNull()
    expect(await readCodexSessionListCache(A)).toHaveLength(MAX_CODEX_THREADS)
    await invalidateCodexSessionListCache(A)
    expect(await readCodexSessionListCache(A)).toBeNull()
    expect(await readCodexSessionListCache(B)).toEqual([thread("B")])
    await invalidateCodexSessionListCache()
    expect(await readCodexSessionListCache(B)).toBeNull()
  })

  it("rejects expired, malformed, duplicate, nonlegacy and cross-scope records", async () => {
    const records = mockStorage()
    const key = `codex:${A}`
    for (const bad of [
      {
        id: key,
        savedAt: Date.now() - 31 * 86_400_000,
        threads: [thread("x")],
      },
      { id: `codex:${B}`, savedAt: Date.now(), threads: [thread("x")] },
      { id: key, savedAt: Date.now(), threads: [thread("x"), thread("x")] },
      { id: key, savedAt: Date.now(), threads: [{ ...thread("x"), cwd: 123 }] },
      {
        id: key,
        savedAt: Date.now(),
        threads: [{ ...thread("x"), historyMode: "new" }],
      },
      {
        id: key,
        savedAt: Date.now(),
        threads: [{ ...thread("x"), updatedAt: Infinity }],
      },
      {
        id: key,
        savedAt: Date.now(),
        threads: Array.from({ length: 51 }, (_, n) => thread(String(n))),
      },
    ]) {
      records.set(key, bad)
      expect(await readCodexSessionListCache(A)).toBeNull()
    }
    expect(await readCodexSessionListCache("invalid")).toBeNull()
    records.set(key, {
      id: key,
      savedAt: Date.now(),
      threads: [{ ...thread("x"), turns: [{ id: "private" }] }],
    })
    expect(await readCodexSessionListCache(A)).toEqual([thread("x")])
  })

  it("logout revokes queued writes and clears both caches", async () => {
    mockStorage()
    const pending = writeCodexSessionListCache(A, [thread("late")])
    const clear = invalidateSessionListCache()
    await Promise.all([pending, clear])
    expect(await readCodexSessionListCache(A)).toBeNull()
    await writeCodexSessionListCache(A, [thread("fresh")])
    await writeSessionListCache(A, {
      sessions: [summary("p")],
      offset: 1,
      hasMore: false,
    })
    await invalidateSessionListCache()
    expect(await readCodexSessionListCache(A)).toBeNull()
    expect(await readSessionListCache(A)).toBeNull()
  })
})

describe("last authenticated local relation and synchronous snapshots", () => {
  it("remembers only an opaque scope, hydrates in memory and revokes on logout", async () => {
    mockStorage()
    const values = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    })
    const {
      rememberAuthenticatedListScope,
      lastAuthenticatedListScope,
      peekSessionListCache,
      peekCodexSessionListCache,
      revokeAuthenticatedListScope,
    } = await import("./session-list-cache")
    rememberAuthenticatedListScope("token:secret")
    expect(lastAuthenticatedListScope()).toBeNull()
    rememberAuthenticatedListScope(A)
    expect(values.size).toBe(1)
    expect([...values.values()][0]).not.toContain("token:secret")
    await writeSessionListCache(A, {
      sessions: [summary("x")],
      offset: 1,
      hasMore: false,
    })
    await writeCodexSessionListCache(A, [thread("one")])
    expect(peekSessionListCache(A)?.sessions[0].id).toBe("x")
    expect(peekCodexSessionListCache(A)?.[0].id).toBe("one")
    await revokeAuthenticatedListScope()
    expect(lastAuthenticatedListScope()).toBeNull()
    expect(peekSessionListCache(A)).toBeNull()
    expect(peekCodexSessionListCache(A)).toBeNull()
    expect(await readSessionListCache(A)).toBeNull()
    expect(await readCodexSessionListCache(A)).toBeNull()
  })

  it("does not restore a stale memory snapshot after scoped deletion", async () => {
    mockStorage()
    const { rememberAuthenticatedListScope, peekSessionListCache } =
      await import("./session-list-cache")
    rememberAuthenticatedListScope(B)
    await writeSessionListCache(B, {
      sessions: [summary("deleted")],
      offset: 1,
      hasMore: false,
    })
    const pending = readSessionListCache(B)
    const invalidation = invalidateSessionListCache(B)
    await Promise.all([pending, invalidation])
    expect(peekSessionListCache(B)).toBeNull()
  })
})
