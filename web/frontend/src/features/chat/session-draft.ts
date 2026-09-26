// Drafts are text-only and live only for the lifetime of this browser tab.
const DRAFT_KEY_PREFIX = "picoclaw:pico:text-draft:"

export function readSessionDraft(sessionId: string): string {
  if (!sessionId) return ""
  try {
    return (
      globalThis.sessionStorage?.getItem(DRAFT_KEY_PREFIX + sessionId) ?? ""
    )
  } catch {
    // Private browsing and restrictive storage policies may deny access.
    return ""
  }
}

export function writeSessionDraft(sessionId: string, text: string): void {
  if (!sessionId) return
  try {
    const key = DRAFT_KEY_PREFIX + sessionId
    if (text) {
      globalThis.sessionStorage?.setItem(key, text)
    } else {
      globalThis.sessionStorage?.removeItem(key)
    }
  } catch {
    // Keep editing usable even when storage is unavailable or full.
  }
}
