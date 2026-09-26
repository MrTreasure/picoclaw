export type EdgeSwipeAction = "sessions" | "exit" | null

export const EDGE_SWIPE_START_PX = 28
export const EDGE_SWIPE_TRIGGER_PX = 88
const CHAT_FROM_SESSIONS_KEY = "picoclaw:chat-from-sessions"

export function edgeSwipeAction(pathname: string): EdgeSwipeAction {
  if (pathname === "/") return "sessions"
  if (pathname === "/codex") return "sessions"
  if (pathname.startsWith("/sessions/")) return "sessions"
  if (pathname === "/sessions" || pathname === "/me") return "exit"
  return null
}

export function isCompletedEdgeSwipe(deltaX: number, deltaY: number) {
  return deltaX >= EDGE_SWIPE_TRIGGER_PX && deltaX > Math.abs(deltaY) * 1.35
}

export function markChatOpenedFromSessions() {
  window.sessionStorage.setItem(CHAT_FROM_SESSIONS_KEY, "1")
}

export function clearChatNavigationOrigin() {
  window.sessionStorage.removeItem(CHAT_FROM_SESSIONS_KEY)
}

export function returnToSessions(fallback: () => void) {
  clearChatNavigationOrigin()
  fallback()
}
