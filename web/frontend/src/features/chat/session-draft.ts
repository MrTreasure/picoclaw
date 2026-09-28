import { lastAuthenticatedListScope } from "@/hooks/session-list-cache"

// Text drafts survive app restarts, isolated by the last authenticated scope.
// The legacy tab draft remains a fallback while authentication is resolving.
const DRAFT_KEY_PREFIX = "picoclaw:pico:text-draft:"
function key(id: string) {
  const scope = lastAuthenticatedListScope()
  return scope
    ? "musec137:draft:" +
        encodeURIComponent(scope) +
        ":" +
        encodeURIComponent(id)
    : null
}
export function readSessionDraft(sessionId: string): string {
  if (!sessionId) return ""
  try {
    const scoped = key(sessionId)
    return (
      (scoped ? localStorage.getItem(scoped) : null) ??
      sessionStorage.getItem(DRAFT_KEY_PREFIX + sessionId) ??
      ""
    )
  } catch {
    return ""
  }
}
export function writeSessionDraft(sessionId: string, text: string): void {
  if (!sessionId) return
  try {
    const scoped = key(sessionId)
    if (scoped) {
      if (text) localStorage.setItem(scoped, text)
      else localStorage.removeItem(scoped)
    }
  } catch {
    /* Persistent storage can be denied independently. */
  }
  try {
    if (text) sessionStorage.setItem(DRAFT_KEY_PREFIX + sessionId, text)
    else sessionStorage.removeItem(DRAFT_KEY_PREFIX + sessionId)
  } catch {
    /* Editing remains usable if storage is full or denied. */
  }
}
export function readDraftAttachments<T>(id: string): T[] {
  try {
    const scoped = key(id)
    const value = scoped
      ? JSON.parse(localStorage.getItem(scoped + ":attachments") || "[]")
      : []
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}
export function writeDraftAttachments(id: string, attachments: unknown[]) {
  try {
    const scoped = key(id)
    if (!scoped) return
    // Store already uploaded references, not raw image bytes or temporary blob URLs.
    const value = JSON.stringify(attachments)
    if (
      value.length > 64000 ||
      value.includes("blob:") ||
      value.includes("data:image/")
    )
      return
    if (attachments.length) localStorage.setItem(scoped + ":attachments", value)
    else localStorage.removeItem(scoped + ":attachments")
  } catch {
    /* Sending does not depend on draft persistence. */
  }
}
