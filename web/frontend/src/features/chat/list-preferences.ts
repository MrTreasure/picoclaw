import { lastAuthenticatedListScope } from "@/hooks/session-list-cache"

export interface ConversationPreference {
  pinned?: boolean
  archived?: boolean
}
export type ConversationPreferences = Record<string, ConversationPreference>
export function preferenceKey() {
  const scope = lastAuthenticatedListScope()
  return scope
    ? "musec137:conversation-preferences:" + encodeURIComponent(scope)
    : null
}
export function readConversationPreferences(): ConversationPreferences {
  try {
    const key = preferenceKey()
    return key ? JSON.parse(localStorage.getItem(key) || "{}") : {}
  } catch {
    return {}
  }
}
export function saveConversationPreferences(value: ConversationPreferences) {
  const key = preferenceKey()
  if (!key) throw new Error("登录状态尚未确认")
  localStorage.setItem(key, JSON.stringify(value))
}
export interface ListPosition {
  searchField?: string
  query: string
  filter: string
  archived: boolean
  top: number
}
const positions = new Map<string, ListPosition>()
const pending = new Map<string, ReturnType<typeof setTimeout>>()
function flushPosition(key: string) {
  try {
    sessionStorage.setItem(key, JSON.stringify(positions.get(key)))
  } catch {
    /* Optional persistence. */
  }
}
if (typeof window !== "undefined")
  window.addEventListener("pagehide", () => {
    for (const [key, timer] of pending) {
      clearTimeout(timer)
      flushPosition(key)
    }
    pending.clear()
  })
export function readListPosition(): ListPosition {
  const key = (preferenceKey() || "guest") + ":position"
  if (positions.has(key)) return positions.get(key)!
  try {
    return (
      JSON.parse(
        sessionStorage.getItem((preferenceKey() || "guest") + ":position") ||
          "null",
      ) || { query: "", filter: "all", archived: false, top: 0 }
    )
  } catch {
    return { query: "", filter: "all", archived: false, top: 0 }
  }
}
export function saveListPosition(value: ListPosition) {
  const key = (preferenceKey() || "guest") + ":position"
  positions.set(key, value)
  if (pending.has(key)) return
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      flushPosition(key)
    }, 200),
  )
}
