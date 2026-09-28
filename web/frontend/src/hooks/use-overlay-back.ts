import { useRouter } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useRef } from "react"

// One history entry for the overlay stack; switching sheet → dialog reuses it.
const overlays = new Map<symbol, () => void>()
const marker = "__museOverlay"
let listening = false
let ownsEntry = false
let overlayURL = ""
let pushEntry: (() => void) | null = null
function ensureEntry() {
  if (ownsEntry && overlayURL === location.href) return
  overlayURL = location.href
  pushEntry?.()
  ownsEntry = true
}
function onBack() {
  if (!ownsEntry) return
  ownsEntry = false
  const top = [...overlays.values()].at(-1)
  top?.()
  setTimeout(() => {
    if (overlays.size) ensureEntry()
  }, 0)
}
export function useOverlayBack(open: boolean, close: () => void) {
  const router = useRouter()
  const latest = useRef(close)
  useLayoutEffect(() => {
    latest.current = close
  }, [close])
  useEffect(() => {
    if (!open) return
    pushEntry = () =>
      router.history.push(location.pathname + location.search + location.hash, {
        ...router.history.location.state,
        [marker]: true,
      })
    const token = Symbol()
    overlays.set(token, () => latest.current())
    if (!listening) {
      window.addEventListener("popstate", onBack)
      listening = true
    }
    ensureEntry()
    return () => {
      overlays.delete(token)
      // Allow a replacement overlay to mount before removing the history entry.
      queueMicrotask(() => {
        if (overlays.size) {
          ensureEntry()
          return
        }
        if (
          ownsEntry &&
          overlayURL === location.href &&
          history.state?.[marker]
        ) {
          ownsEntry = false
          history.back()
        } else {
          ownsEntry = false
        }
      })
    }
  }, [open, router])
}
