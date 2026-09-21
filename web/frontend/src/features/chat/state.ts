const LAST_SESSION_STORAGE_KEY = "picoclaw:last-session-id"
const UNIX_MS_THRESHOLD = 1e12

function readStorageValue() {
  return (
    globalThis.localStorage?.getItem(LAST_SESSION_STORAGE_KEY)?.trim() || ""
  )
}

export function readStoredSessionId(): string {
  return readStorageValue()
}

export function writeStoredSessionId(sessionId: string) {
  if (sessionId) {
    globalThis.localStorage?.setItem(LAST_SESSION_STORAGE_KEY, sessionId)
    return
  }

  globalThis.localStorage?.removeItem(LAST_SESSION_STORAGE_KEY)
}

export function clearStoredSessionId() {
  globalThis.localStorage?.removeItem(LAST_SESSION_STORAGE_KEY)
}

export function generateSessionId(): string {
  const now = new Date()
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  const starttime =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    pad(now.getMilliseconds(), 3)
  return `pico_${starttime}_main`
}

export function getInitialActiveSessionId(): string {
  const linkedSession = new URLSearchParams(
    globalThis.location?.search ?? "",
  ).get("session_id")
  if (linkedSession?.trim()) {
    writeStoredSessionId(linkedSession.trim())
    return linkedSession.trim()
  }
  return readStorageValue() || generateSessionId()
}

export function normalizeUnixTimestamp(timestamp: number): number {
  return timestamp < UNIX_MS_THRESHOLD ? timestamp * 1000 : timestamp
}
