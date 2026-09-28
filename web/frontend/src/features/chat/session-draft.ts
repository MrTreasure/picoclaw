import { toast } from "sonner"

import { lastAuthenticatedListScope } from "@/hooks/session-list-cache"

// Text drafts survive app restarts, isolated by the last authenticated scope.
// The legacy tab draft remains a fallback while authentication is resolving.
function draftWarning(attachments = false) {
  if (typeof window === "undefined") return
  toast.warning(
    attachments
      ? "附件草稿未保存，关闭页面后可能需要重新添加。"
      : "草稿未能持久保存，请保留此页面或复制文字后再关闭。",
    {
      id: attachments ? "attachment-draft-failed" : "text-draft-failed",
      duration: 8000,
    },
  )
}
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
  // The current tab may contain a newer edit if persistent storage was full.
  try {
    const tab = sessionStorage.getItem(DRAFT_KEY_PREFIX + sessionId)
    if (tab !== null) return tab
  } catch {
    /* Persistent storage can still be available. */
  }
  try {
    const scoped = key(sessionId)
    return scoped ? (localStorage.getItem(scoped) ?? "") : ""
  } catch {
    return ""
  }
}
export function writeSessionDraft(sessionId: string, text: string): void {
  if (!sessionId) return
  try {
    const scoped = key(sessionId)
    if (!scoped && text) draftWarning()
    if (scoped) {
      if (text) localStorage.setItem(scoped, text)
      else localStorage.removeItem(scoped)
    }
  } catch {
    draftWarning()
  }
  try {
    if (text) sessionStorage.setItem(DRAFT_KEY_PREFIX + sessionId, text)
    else sessionStorage.removeItem(DRAFT_KEY_PREFIX + sessionId)
  } catch {
    draftWarning()
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
    if (!scoped) {
      if (attachments.length) draftWarning(true)
      return
    }
    // Store already uploaded references, not raw image bytes or temporary blob URLs.
    const value = JSON.stringify(attachments)
    if (
      value.length > 64000 ||
      value.includes("blob:") ||
      value.includes("data:image/")
    ) {
      if (attachments.length) draftWarning(true)
      return
    }
    if (attachments.length) localStorage.setItem(scoped + ":attachments", value)
    else localStorage.removeItem(scoped + ":attachments")
  } catch {
    draftWarning(true)
  }
}
