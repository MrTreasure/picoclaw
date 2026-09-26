import type { SessionSummary } from "@/api/sessions"

// Separate from the message cache. Never store credentials or raw session tokens.
const DATABASE = "musec137-session-list"
const STORE = "summaries"
export const MAX_SESSION_SUMMARIES = 200
const MAX_AGE_MS = 5 * 60 * 1000

export interface SessionListSnapshot {
  sessions: SessionSummary[]
  offset: number
  hasMore: boolean
}
interface StoredSnapshot extends SessionListSnapshot {
  id: string
  savedAt: number
}

/** Avoid a large refresh; preserve the cached tail only if the first page
 * still matches, otherwise discard it to keep pagination offsets correct. */
export function reconcileFirstPage(
  page: SessionSummary[],
  cached: SessionListSnapshot | null,
  pageSize = 20,
): SessionSummary[] {
  if (
    !cached ||
    page.length !== pageSize ||
    cached.sessions.length < pageSize ||
    !page.every((item, index) => item.id === cached.sessions[index].id)
  )
    return page
  return [...page, ...cached.sessions.slice(pageSize)]
}

export function validCacheScope(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value)
}

function validSnapshot(value: unknown, scope: string): value is StoredSnapshot {
  if (!value || typeof value !== "object") return false
  const s = value as Partial<StoredSnapshot>
  if (s.id !== scope || !Number.isFinite(s.savedAt)) return false
  const age = Date.now() - s.savedAt!
  if (
    age < 0 ||
    age > MAX_AGE_MS ||
    !Array.isArray(s.sessions) ||
    s.sessions.length > MAX_SESSION_SUMMARIES ||
    !Number.isSafeInteger(s.offset) ||
    s.offset! < 0 ||
    s.offset !== s.sessions.length ||
    typeof s.hasMore !== "boolean"
  )
    return false
  const ids = new Set<string>()
  return s.sessions.every((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      !["pico", "weixin"].includes(item.channel) ||
      typeof item.title !== "string" ||
      typeof item.preview !== "string" ||
      !Number.isSafeInteger(item.message_count) ||
      item.message_count < 0 ||
      typeof item.created !== "string" ||
      typeof item.updated !== "string"
    )
      return false
    ids.add(item.id)
    return true
  })
}

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined" || !indexedDB)
    return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: "id" })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => resolve(null)
  })
}

async function operation<T>(
  mode: IDBTransactionMode,
  execute: (store: IDBObjectStore, setResult: (value: T) => void) => void,
): Promise<T | null> {
  let db: IDBDatabase | null = null
  try {
    db = await open()
    if (!db) return null
    const database = db
    return await new Promise<T>((resolve, reject) => {
      let result: T
      const tx = database.transaction(STORE, mode)
      execute(tx.objectStore(STORE), (value) => {
        result = value
      })
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    return null // Quota, denied storage, or private browsing: network-only fallback.
  } finally {
    db?.close()
  }
}

// Generation changes synchronously, before queued IndexedDB work. Late writes
// from a previous login/deletion cannot recreate a revoked snapshot.
let generation = 0
export function sessionListCacheGeneration(): number {
  return generation
}
let queue: Promise<unknown> = Promise.resolve()
function ordered<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}

export function readSessionListCache(
  scope: string,
): Promise<SessionListSnapshot | null> {
  if (!validCacheScope(scope)) return Promise.resolve(null)
  const version = generation
  return ordered(async () => {
    if (version !== generation) return null
    const value = await operation<unknown>("readonly", (store, setResult) => {
      const request = store.get(scope)
      request.onsuccess = () => setResult(request.result)
    })
    if (version !== generation || !validSnapshot(value, scope)) return null
    return {
      sessions: value.sessions,
      offset: value.offset,
      hasMore: value.hasMore,
    }
  })
}

export function writeSessionListCache(
  scope: string,
  snapshot: SessionListSnapshot,
): Promise<void> {
  if (!validCacheScope(scope)) return Promise.resolve()
  const version = generation
  return ordered(async () => {
    if (version !== generation) return
    const sessions = snapshot.sessions.slice(0, MAX_SESSION_SUMMARIES)
    await operation<void>("readwrite", (store) => {
      store.put({
        id: scope,
        savedAt: Date.now(),
        sessions,
        offset: sessions.length,
        hasMore:
          snapshot.hasMore || snapshot.sessions.length > MAX_SESSION_SUMMARIES,
      } satisfies StoredSnapshot)
    })
  })
}

export function invalidateSessionListCache(scope?: string): Promise<void> {
  ++generation
  return ordered(async () => {
    await operation<void>("readwrite", (store) => {
      if (scope && validCacheScope(scope)) store.delete(scope)
      else store.clear()
    })
  })
}
