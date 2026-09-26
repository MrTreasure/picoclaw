const LAST_SESSION_STORAGE_KEY = "picoclaw:last-session-id"
const UNIX_MS_THRESHOLD = 1e12

function readStorageValue() {
  return normalizeSessionId(
    globalThis.localStorage?.getItem(LAST_SESSION_STORAGE_KEY) ?? "",
  )
}

export function normalizeSessionId(sessionId: string): string {
  return sessionId.trim().replace(/^(pico_\d{8})T(?=\d{9}_main$)/, "$1t")
}

export function readStoredSessionId(): string {
  return readStorageValue()
}

export function writeStoredSessionId(sessionId: string) {
  const normalized = normalizeSessionId(sessionId)
  if (normalized) {
    globalThis.localStorage?.setItem(LAST_SESSION_STORAGE_KEY, normalized)
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
  return `pico_${starttime.replace("T", "t")}_main`
}

export function getInitialActiveSessionId(): string {
  const linkedSession = new URLSearchParams(
    globalThis.location?.search ?? "",
  ).get("session_id")
  const normalizedLinkedSession = normalizeSessionId(linkedSession ?? "")
  if (normalizedLinkedSession) {
    writeStoredSessionId(normalizedLinkedSession)
    return normalizedLinkedSession
  }
  const storedSession = readStorageValue()
  if (storedSession) return storedSession

  const generatedSession = generateSessionId()
  writeStoredSessionId(generatedSession)
  return generatedSession
}

export function normalizeUnixTimestamp(timestamp: number): number {
  return timestamp < UNIX_MS_THRESHOLD ? timestamp * 1000 : timestamp
}
