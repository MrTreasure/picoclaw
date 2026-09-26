import type { CodexItem, CodexThread, CodexTurn } from "@/api/codex"
import { validCacheScope } from "@/hooks/session-list-cache"

// Private to this origin/browser profile, not encrypted: never use on a shared device.
// Only an allowlist of display fields is persisted; no raw RPC responses or media.
const DATABASE = "musec137-codex-history"
const STORE = "threads"
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_BYTES = 2 * 1024 * 1024
export const MAX_CACHED_HISTORY_THREADS = 20
const encoder = new TextEncoder()

interface RecordEntry {
  key: string
  scope: string
  threadId: string
  savedAt: number
  accessedAt: number
  payload: string
}
export interface HistoryCacheStats {
  /** Exact serialized UTF-8 bytes of this module's stored records, not IDB disk usage. */
  bytes: number
  count: number
}
const emptyStats = (): HistoryCacheStats => ({ bytes: 0, count: 0 })
const size = (value: RecordEntry) =>
  encoder.encode(JSON.stringify(value)).byteLength
const key = (scope: string, id: string) => `${scope}:${id}`
const validId = (id: unknown): id is string =>
  typeof id === "string" &&
  id.length > 0 &&
  id.length <= 256 &&
  // oxlint-disable-next-line eslint/no-control-regex
  !/[\x00-\x1f]/.test(id) &&
  !/^data:/i.test(id)
const safeTime = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0

// Deliberately conservative. Unknown metadata (including auth URLs, file paths,
// environment variables and opaque changes) never crosses this boundary.
function text(value: unknown, limit = 32768): string | undefined {
  if (typeof value !== "string") return undefined
  const clipped = value.slice(0, limit)
  return clipped
    .replace(/data:[^\s"']{0,200000}/gi, "[media omitted]")
    .replace(
      /(?:Bearer\s+|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s"']+/gi,
      "[credential omitted]",
    )
    .replace(
      /-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g,
      "[credential omitted]",
    )
}
function cleanItem(item: CodexItem): CodexItem | null {
  if (
    !item ||
    !validId(item.id) ||
    typeof item.type !== "string" ||
    item.type.length > 64
  )
    return null
  const out: CodexItem = { id: item.id, type: item.type }
  for (const field of ["text", "command", "aggregatedOutput"] as const) {
    const value = text(item[field])
    if (value !== undefined) out[field] = value
  }
  if (typeof item.status === "string") out.status = text(item.status, 128)
  if (Array.isArray(item.content)) {
    out.content = item.content.slice(0, 64).flatMap((part) => {
      if (!part || part.type !== "text" || typeof part.text !== "string")
        return []
      return [{ type: "text", text: text(part.text) }]
    })
  }
  // No changes, URL, path, images, blobs, or unknown fields.
  return out
}
function cleanThread(thread: CodexThread, id: string): CodexThread | null {
  if (
    !thread ||
    thread.id !== id ||
    thread.historyMode !== "legacy" ||
    !Array.isArray(thread.turns)
  )
    return null
  if (thread.turns.length > 200) return null // avoid silently caching partial histories
  const turns: CodexTurn[] = []
  let count = 0
  for (const turn of thread.turns) {
    if (!turn || !validId(turn.id) || !Array.isArray(turn.items)) return null
    count += turn.items.length
    if (count > 1000) return null
    const items: CodexItem[] = []
    for (const item of turn.items) {
      const cleaned = cleanItem(item)
      if (!cleaned) return null
      items.push(cleaned)
    }
    const out: CodexTurn = { id: turn.id, items }
    if (typeof turn.status === "string") out.status = text(turn.status, 128)
    turns.push(out)
  }
  const out: CodexThread = { id, historyMode: "legacy", turns }
  if (thread.name === null) out.name = null
  else if (typeof thread.name === "string") out.name = text(thread.name, 256)
  if (typeof thread.preview === "string")
    out.preview = text(thread.preview, 2048)
  if (safeTime(thread.createdAt)) out.createdAt = thread.createdAt
  if (safeTime(thread.updatedAt)) out.updatedAt = thread.updatedAt
  return out
}
function validRecord(v: unknown, scope: string, id: string): v is RecordEntry {
  if (!v || typeof v !== "object") return false
  const r = v as Partial<RecordEntry>
  const now = Date.now()
  return (
    r.key === key(scope, id) &&
    r.scope === scope &&
    r.threadId === id &&
    safeTime(r.savedAt) &&
    safeTime(r.accessedAt) &&
    r.savedAt! <= now &&
    now - r.savedAt! <= TTL_MS &&
    typeof r.payload === "string" &&
    encoder.encode(r.payload).byteLength <= MAX_BYTES &&
    size(r as RecordEntry) <= MAX_BYTES
  )
}
function parsed(r: RecordEntry): CodexThread | null {
  try {
    const value = JSON.parse(r.payload) as CodexThread
    // Reject foreign/corrupt records; re-sanitizing also protects against malformed IDB contents.
    const clean = cleanThread(value, r.threadId)
    return clean && JSON.stringify(clean) === r.payload ? clean : null
  } catch {
    return null
  }
}
function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined" || !indexedDB)
    return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DATABASE, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: "key" })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve(null)
  })
}
async function transaction<T>(
  run: (store: IDBObjectStore, done: (result: T) => void) => void,
): Promise<T | null> {
  let db: IDBDatabase | null = null
  try {
    db = await open()
    if (!db) return null
    const database = db
    return await new Promise<T>((resolve, reject) => {
      let result: T
      const tx = database.transaction(STORE, "readwrite")
      try {
        run(tx.objectStore(STORE), (value) => {
          result = value
        })
      } catch (error) {
        tx.abort()
        reject(error)
      }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    return null
  } finally {
    // private browsing, quota or denied storage: network-only fallback
    db?.close()
  }
}
const versions = new Map<string, number>()
let epoch = 0
let queue: Promise<unknown> = Promise.resolve()
function ordered<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}
function version(scope: string, id: string) {
  return versions.get(key(scope, id)) ?? 0
}
function active(scope: string, id: string, global: number, local: number) {
  return epoch === global && version(scope, id) === local
}
function removeExpiredAndInvalid(
  store: IDBObjectStore,
  records: RecordEntry[],
  scope: string,
): RecordEntry[] {
  return records.filter((r) => {
    if (r.scope !== scope) return false
    if (
      !validId(r.threadId) ||
      !validRecord(r, scope, r.threadId) ||
      !parsed(r)
    ) {
      store.delete(r.key)
      return false
    }
    return true
  })
}

export function readCodexHistoryCache(
  scope: string,
  threadId: string,
): Promise<CodexThread | null> {
  if (!validCacheScope(scope) || !validId(threadId))
    return Promise.resolve(null)
  const global = epoch,
    local = version(scope, threadId)
  return ordered(async () => {
    if (!active(scope, threadId, global, local)) return null
    const result = await transaction<CodexThread | null>((store, done) => {
      const req = store.get(key(scope, threadId))
      req.onsuccess = () => {
        const r = req.result as RecordEntry | undefined
        if (!r) return done(null)
        if (!validRecord(r, scope, threadId) || !parsed(r)) {
          store.delete(key(scope, threadId))
          return done(null)
        }
        const touched = {
          ...r,
          accessedAt: Math.max(Date.now(), r.accessedAt + 1),
        }
        if (size(touched) <= MAX_BYTES) store.put(touched)
        done(parsed(r))
      }
    })
    return active(scope, threadId, global, local) ? result : null
  })
}

export function writeCodexHistoryCache(
  scope: string,
  threadId: string,
  thread: CodexThread,
): Promise<void> {
  if (!validCacheScope(scope) || !validId(threadId)) return Promise.resolve()
  const global = epoch,
    local = version(scope, threadId)
  const clean = cleanThread(thread, threadId)
  if (!clean) return Promise.resolve()
  const payload = JSON.stringify(clean)
  const now = Date.now()
  const record: RecordEntry = {
    key: key(scope, threadId),
    scope,
    threadId,
    savedAt: now,
    accessedAt: now,
    payload,
  }
  if (size(record) > MAX_BYTES) return Promise.resolve()
  return ordered(async () => {
    if (!active(scope, threadId, global, local)) return
    await transaction<void>((store) => {
      const req = store.getAll()
      req.onsuccess = () => {
        const entries = removeExpiredAndInvalid(
          store,
          req.result as RecordEntry[],
          scope,
        )
          .filter((r) => r.threadId !== threadId)
          .sort(
            (a, b) =>
              b.accessedAt - a.accessedAt ||
              b.savedAt - a.savedAt ||
              a.key.localeCompare(b.key),
          )
        for (const old of entries.slice(MAX_CACHED_HISTORY_THREADS - 1))
          store.delete(old.key)
        store.put(record)
      }
    })
  })
}

export function deleteCodexHistoryCache(
  scope: string,
  threadId: string,
): Promise<void> {
  if (!validCacheScope(scope) || !validId(threadId)) return Promise.resolve()
  versions.set(key(scope, threadId), version(scope, threadId) + 1)
  return ordered(async () => {
    await transaction<void>((store) => {
      store.delete(key(scope, threadId))
    })
  })
}

/** Without scope, logout invalidates every queued operation and clears all histories. */
export function clearCodexHistoryCache(scope?: string): Promise<void> {
  if (scope !== undefined && !validCacheScope(scope)) return Promise.resolve()
  ++epoch
  versions.clear()
  return ordered(async () => {
    await transaction<void>((store) => {
      if (!scope) {
        store.clear()
        return
      }
      const req = store.getAll()
      req.onsuccess = () => {
        for (const r of req.result as RecordEntry[])
          if (r.scope === scope) store.delete(r.key)
      }
    })
  })
}

export function codexHistoryCacheStats(
  scope: string,
): Promise<HistoryCacheStats> {
  if (!validCacheScope(scope)) return Promise.resolve(emptyStats())
  const global = epoch
  return ordered(async () => {
    if (global !== epoch) return emptyStats()
    const result = await transaction<HistoryCacheStats>((store, done) => {
      const req = store.getAll()
      req.onsuccess = () => {
        const entries = removeExpiredAndInvalid(
          store,
          req.result as RecordEntry[],
          scope,
        )
        done({
          bytes: entries.reduce((total, r) => total + size(r), 0),
          count: entries.length,
        })
      }
    })
    return global === epoch ? (result ?? emptyStats()) : emptyStats()
  })
}
