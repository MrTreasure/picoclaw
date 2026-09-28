import { lastAuthenticatedListScope } from "@/hooks/session-list-cache"

let reading: string | null = null
const seen = new Set<string>()
const changed = "musec137:unread-changed"
function key() {
  return (
    "musec137:unread:" + encodeURIComponent(lastAuthenticatedListScope() || "")
  )
}
export function unreadConversations(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(key()) || "{}")
  } catch {
    return {}
  }
}
function write(value: Record<string, string>) {
  try {
    localStorage.setItem(key(), JSON.stringify(value))
    window.dispatchEvent(new Event(changed))
  } catch {
    /* Optional indicators cannot block chat. */
  }
}
export function markConversationRead(id: string) {
  const value = unreadConversations()
  if (value[id]) {
    delete value[id]
    write(value)
  }
  if ("serviceWorker" in navigator)
    void navigator.serviceWorker.ready
      .then(async (registration) => {
        const tag = "musec137-" + id.replace(/^(muse|codex):/, "")
        const notifications = await registration.getNotifications({ tag })
        notifications.forEach((notification) => notification.close())
      })
      .catch(() => {})
  const badge = navigator as Navigator & { clearAppBadge?: () => Promise<void> }
  if (!Object.keys(value).length) void badge.clearAppBadge?.().catch(() => {})
}
export function observeReadingConversation(id: string) {
  reading = id
  const read = () => {
    if (document.visibilityState === "visible" && reading === id)
      markConversationRead(id)
  }
  read()
  document.addEventListener("visibilitychange", read)
  return () => {
    document.removeEventListener("visibilitychange", read)
    if (reading === id) reading = null
  }
}
export function markConversationUnread(id: string, eventId: string): boolean {
  if (reading === id && document.visibilityState === "visible") {
    markConversationRead(id)
    return false
  }
  const value = unreadConversations()
  if (value[id] === eventId) return false
  value[id] = eventId
  write(value)
  return true
}
export function subscribeUnread(callback: () => void) {
  window.addEventListener(changed, callback)
  window.addEventListener("storage", callback)
  return () => {
    window.removeEventListener(changed, callback)
    window.removeEventListener("storage", callback)
  }
}
export function notifyCodexCompleted(id: string, eventId: string) {
  const token = key() + ":" + id + ":" + eventId
  if (seen.has(token)) return
  seen.add(token)
  if (seen.size > 256) seen.delete(seen.values().next().value!)
  if (typeof document === "undefined" || typeof window === "undefined") return
  if (!markConversationUnread("codex:" + id, eventId)) return
  if (
    document.visibilityState === "visible" ||
    !("Notification" in window) ||
    Notification.permission !== "granted" ||
    !("serviceWorker" in navigator)
  )
    return
  void navigator.serviceWorker.ready
    .then((registration) =>
      registration.showNotification("Codex 任务已完成", {
        body: "点击查看结果",
        tag: "musec137-" + id,
        icon: "/web-app-manifest-192x192.png",
        data: { url: "/codex?thread=" + encodeURIComponent(id) },
      }),
    )
    .catch(() => {})
}
