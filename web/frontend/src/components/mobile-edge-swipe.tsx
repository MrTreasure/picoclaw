import { IconArrowLeft, IconLogout } from "@tabler/icons-react"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"

import {
  EDGE_SWIPE_START_PX,
  EDGE_SWIPE_TRIGGER_PX,
  edgeSwipeAction,
  isCompletedEdgeSwipe,
  returnToSessions,
} from "@/lib/edge-swipe"
import { cn } from "@/lib/utils"

interface SwipeTracking {
  pointerId: number
  startX: number
  startY: number
}

function isInteractiveTextTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, [contenteditable="true"], [role="dialog"]',
      ),
    )
  )
}

function requestAppExit() {
  window.close()
  window.setTimeout(() => {
    if (document.visibilityState === "visible") window.history.back()
  }, 120)
}

export function MobileEdgeSwipe() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const navigate = useNavigate()
  const trackingRef = useRef<SwipeTracking | null>(null)
  const [gesture, setGesture] = useState({ visible: false, x: 0, y: 0 })

  useEffect(() => {
    const action = edgeSwipeAction(pathname)
    if (!action) return

    const reset = () => {
      trackingRef.current = null
      setGesture({ visible: false, x: 0, y: 0 })
    }

    const onPointerDown = (event: PointerEvent) => {
      if (
        event.pointerType !== "touch" ||
        event.isPrimary === false ||
        event.clientX > EDGE_SWIPE_START_PX ||
        isInteractiveTextTarget(event.target)
      ) {
        return
      }
      trackingRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      const tracking = trackingRef.current
      if (!tracking || tracking.pointerId !== event.pointerId) return
      const deltaX = event.clientX - tracking.startX
      const deltaY = event.clientY - tracking.startY
      if (deltaX < 0 || Math.abs(deltaY) > Math.max(48, deltaX)) {
        reset()
        return
      }
      if (deltaX < 12) return
      setGesture({
        visible: true,
        x: Math.min(deltaX, EDGE_SWIPE_TRIGGER_PX + 24),
        y: tracking.startY,
      })
    }

    const onPointerUp = (event: PointerEvent) => {
      const tracking = trackingRef.current
      if (!tracking || tracking.pointerId !== event.pointerId) return
      const completed = isCompletedEdgeSwipe(
        event.clientX - tracking.startX,
        event.clientY - tracking.startY,
      )
      reset()
      if (!completed) return
      navigator.vibrate?.(12)
      if (action === "sessions") {
        returnToSessions(() => {
          void navigate({ to: "/sessions", replace: true })
        })
      } else {
        requestAppExit()
      }
    }

    window.addEventListener("pointerdown", onPointerDown, { capture: true })
    window.addEventListener("pointermove", onPointerMove, { capture: true })
    window.addEventListener("pointerup", onPointerUp, { capture: true })
    window.addEventListener("pointercancel", reset, { capture: true })
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      })
      window.removeEventListener("pointermove", onPointerMove, {
        capture: true,
      })
      window.removeEventListener("pointerup", onPointerUp, { capture: true })
      window.removeEventListener("pointercancel", reset, { capture: true })
    }
  }, [navigate, pathname])

  const ready = gesture.x >= EDGE_SWIPE_TRIGGER_PX

  return (
    <div
      className={cn(
        "pointer-events-none fixed left-0 z-[90] flex size-12 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-[opacity,background-color,border-color] duration-100 motion-reduce:transition-none",
        ready
          ? "border-secondary/60 bg-secondary text-secondary-foreground"
          : "border-border/80 bg-background/90 text-foreground",
        gesture.visible ? "opacity-100" : "opacity-0",
      )}
      style={{
        top: Math.max(72, Math.min(gesture.y - 24, window.innerHeight - 120)),
        transform: `translate3d(${Math.max(8, gesture.x - 40)}px, 0, 0)`,
      }}
      aria-hidden="true"
    >
      {edgeSwipeAction(pathname) === "exit" ? (
        <IconLogout className="size-6" />
      ) : (
        <IconArrowLeft className="size-6" />
      )}
    </div>
  )
}
