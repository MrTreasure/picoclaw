import type { CodexThread } from "@/api/codex"
import type { SessionSummary } from "@/api/sessions"

// Separate from the message cache. Never store credentials or raw session tokens.
const DATABASE = "musec137-session-list"
const STORE = "summaries"
export const MAX_SESSION_SUMMARIES = 200
const MAX_AGE_MS = 5 * 60 * 1000
const listMaxAge = () =>
  typeof navigator !== "undefined" && navigator.onLine === false
    ? 30 * 24 * 60 * 60 * 1000
    : MAX_AGE_MS
const CODEX_PREFIX = "codex:"
// The list is the navigation entry for locally retained Codex histories.
// Pico summaries keep the short freshness window; Codex is refreshed online.
const CODEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_CODEX_THREADS = 50

export interface SessionListSnapshot {
  sessions: SessionSummary[]
  offset: number
  hasMore: boolean
}
interface StoredSnapshot extends SessionListSnapshot {
  id: string
  savedAt: number
}

// Persist only display fields, never raw RPC responses, turns or credentials.
type CachedCodexThread = Pick<
  CodexThread,
  | "id"
  | "historyMode"
  | "name"
  | "preview"
  | "cwd"
  | "createdAt"
  | "updatedAt"
  | "source"
  | "originator"
>
interface StoredCodexSnapshot {
  id: string
  savedAt: number
  threads: CachedCodexThread[]
}
// A convenience hint, not authentication. API and WebSocket remain server-authorized.
const RELATION_KEY = "musec137:last-authenticated-list-scope"
const RELATION_AGE_MS = 30 * 24 * 60 * 60 * 1000
let currentScope: string | null = null
let museMemory: {
  scope: string
  snapshot: SessionListSnapshot
  savedAt: number
} | null = null
let codexMemory: {
  scope: string
  threads: CodexThread[]
  savedAt: number
} | null = null

export function lastAuthenticatedListScope(): string | null {
  if (currentScope) return currentScope
  try {
    const stored = JSON.parse(localStorage.getItem(RELATION_KEY) || "null") as {
      scope?: unknown
      at?: unknown
    } | null
    if (
      validCacheScope(stored?.scope) &&
      typeof stored?.at === "number" &&
      Date.now() >= stored.at &&
      Date.now() - stored.at < RELATION_AGE_MS
    ) {
      currentScope = stored.scope
      return currentScope
    }
  } catch {
    /* Storage can be disabled. */
  }
  return null
}

export function rememberAuthenticatedListScope(scope: string): void {
  if (!validCacheScope(scope)) return
  if (currentScope && currentScope !== scope) {
    museMemory = null
    codexMemory = null
  }
  currentScope = scope
  try {
    localStorage.setItem(
      RELATION_KEY,
      JSON.stringify({ scope, at: Date.now() }),
    )
  } catch {
    /* Network-only fallback. */
  }
}

/** Call on explicit logout before navigation (alongside clearing Codex history). */
export function revokeAuthenticatedListScope(): Promise<void> {
  currentScope = null
  try {
    localStorage.removeItem(RELATION_KEY)
  } catch {
    /* ignore */
  }
  return invalidateSessionListCache()
}

export function peekSessionListCache(
  scope: string,
): SessionListSnapshot | null {
  return scope === currentScope &&
    museMemory &&
    museMemory.scope === scope &&
    Date.now() - museMemory.savedAt <= listMaxAge()
    ? museMemory.snapshot
    : null
}

export function peekCodexSessionListCache(scope: string): CodexThread[] | null {
  return scope === currentScope &&
    codexMemory &&
    codexMemory.scope === scope &&
    Date.now() - codexMemory.savedAt <= CODEX_MAX_AGE_MS
    ? codexMemory.threads
    : null
}

const codexKey = (scope: string) => `${CODEX_PREFIX}${scope}`

function validCodexThread(value: unknown): value is CachedCodexThread {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const t = value as Partial<CachedCodexThread>
  const timestamp = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0
  return (
    typeof t.id === "string" &&
    t.id.length > 0 &&
    t.id.length <= 256 &&
    (t.historyMode === "legacy" || t.historyMode === "paginated") &&
    (t.name === undefined ||
      t.name === null ||
      (typeof t.name === "string" && t.name.length <= 256)) &&
    (t.preview === undefined ||
      (typeof t.preview === "string" && t.preview.length <= 2048)) &&
    (t.cwd === undefined ||
      (typeof t.cwd === "string" && t.cwd.length <= 2048)) &&
    (t.createdAt === undefined || timestamp(t.createdAt)) &&
    (t.updatedAt === undefined || timestamp(t.updatedAt)) &&
    (t.createdAt !== undefined || t.updatedAt !== undefined)
  )
}

function validCodexSnapshot(
  value: unknown,
  scope: string,
): value is StoredCodexSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const s = value as Partial<StoredCodexSnapshot>
  if (
    s.id !== codexKey(scope) ||
    !Number.isFinite(s.savedAt) ||
    Date.now() - s.savedAt! < 0 ||
    Date.now() - s.savedAt! > CODEX_MAX_AGE_MS ||
    !Array.isArray(s.threads) ||
    s.threads.length > MAX_CODEX_THREADS
  )
    return false
  const ids = new Set<string>()
  return s.threads.every((t) => {
    if (!validCodexThread(t) || ids.has(t.id)) return false
    ids.add(t.id)
    return true
  })
}

function cleanCodexThreads(threads: CodexThread[]): CachedCodexThread[] {
  const ids = new Set<string>()
  const result: CachedCodexThread[] = []
  if (!Array.isArray(threads)) return result
  for (const t of threads) {
    if (!validCodexThread(t) || ids.has(t.id)) continue
    ids.add(t.id)
    const clean: CachedCodexThread = { id: t.id, historyMode: t.historyMode }
    if (t.source === "cli" || t.source === "vscode") clean.source = t.source
    if (
      t.originator === "codex-tui" ||
      t.originator?.startsWith("musec137_pwa")
    )
      clean.originator = t.originator.slice(0, 100)
    if (t.name !== undefined) clean.name = t.name
    if (t.preview !== undefined) clean.preview = t.preview
    if (t.cwd !== undefined) clean.cwd = t.cwd
    if (t.createdAt !== undefined) clean.createdAt = t.createdAt
    if (t.updatedAt !== undefined) clean.updatedAt = t.updatedAt
    result.push(clean)
    if (result.length === MAX_CODEX_THREADS) break
  }
  return result
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
    age > listMaxAge() ||
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
      (item.sub_agent !== undefined && typeof item.sub_agent !== "boolean") ||
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
let codexGeneration = 0
export function sessionListCacheGeneration(): number {
  return generation
}
const revocationListeners = new Set<() => void>()
export function subscribeListCacheRevocation(listener: () => void): () => void {
  revocationListeners.add(listener)
  return () => {
    revocationListeners.delete(listener)
  }
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
    const snapshot = {
      sessions: value.sessions,
      offset: value.offset,
      hasMore: value.hasMore,
    }
    if (
      !museMemory ||
      museMemory.scope !== scope ||
      museMemory.savedAt <= value.savedAt
    )
      museMemory = { scope, snapshot, savedAt: value.savedAt }
    return snapshot
  })
}

export function writeSessionListCache(
  scope: string,
  snapshot: SessionListSnapshot,
): Promise<void> {
  if (!validCacheScope(scope)) return Promise.resolve()
  const version = generation
  const sessions = snapshot.sessions.slice(0, MAX_SESSION_SUMMARIES)
  const clean = {
    sessions,
    offset: sessions.length,
    hasMore:
      snapshot.hasMore || snapshot.sessions.length > MAX_SESSION_SUMMARIES,
  }
  museMemory = { scope, snapshot: clean, savedAt: Date.now() }
  return ordered(async () => {
    if (version !== generation) return
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

/** Account-scoped Codex list; old v1 IndexedDB store needs no migration. */
export function readCodexSessionListCache(
  scope: string,
): Promise<CodexThread[] | null> {
  if (!validCacheScope(scope)) return Promise.resolve(null)
  const version = codexGeneration
  return ordered(async () => {
    if (version !== codexGeneration) return null
    const value = await operation<unknown>("readonly", (store, setResult) => {
      const request = store.get(codexKey(scope))
      request.onsuccess = () => setResult(request.result)
    })
    if (version !== codexGeneration || !validCodexSnapshot(value, scope))
      return null
    const threads = cleanCodexThreads(value.threads)
    if (
      !codexMemory ||
      codexMemory.scope !== scope ||
      codexMemory.savedAt <= value.savedAt
    )
      codexMemory = { scope, threads, savedAt: value.savedAt }
    return threads
  })
}

export function writeCodexSessionListCache(
  scope: string,
  threads: CodexThread[],
): Promise<void> {
  if (!validCacheScope(scope)) return Promise.resolve()
  const version = codexGeneration
  // The fixed-size local cache cannot honestly represent a longer list.
  const clean = cleanCodexThreads(threads)
  const incomplete =
    threads.length > MAX_CODEX_THREADS || clean.length !== threads.length
  codexMemory = incomplete
    ? null
    : { scope, threads: clean, savedAt: Date.now() }
  return ordered(async () => {
    if (version !== codexGeneration) return
    await operation<void>("readwrite", (store) => {
      if (incomplete) {
        store.delete(codexKey(scope))
        return
      }
      store.put({
        id: codexKey(scope),
        savedAt: Date.now(),
        threads: clean,
      } satisfies StoredCodexSnapshot)
    })
  })
}

/** Scoped invalidation never removes Pico or another account's cache. */
export function invalidateCodexSessionListCache(scope?: string): Promise<void> {
  ++codexGeneration
  codexMemory = null
  return ordered(async () => {
    await operation<void>("readwrite", (store) => {
      if (scope && validCacheScope(scope)) store.delete(codexKey(scope))
      else {
        const request = store.openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          if (
            typeof cursor.key === "string" &&
            cursor.key.startsWith(CODEX_PREFIX)
          )
            cursor.delete()
          cursor.continue()
        }
      }
    })
  })
}

export function invalidateSessionListCache(scope?: string): Promise<void> {
  ++generation
  museMemory = null
  if (!scope || !validCacheScope(scope)) {
    ++codexGeneration // logout clears both
    codexMemory = null
    currentScope = null
    try {
      localStorage.removeItem(RELATION_KEY)
    } catch {
      /* ignore */
    }
    for (const listener of revocationListeners) listener()
  }
  return ordered(async () => {
    await operation<void>("readwrite", (store) => {
      if (scope && validCacheScope(scope)) store.delete(scope)
      else store.clear()
    })
  })
}
