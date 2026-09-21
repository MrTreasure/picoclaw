import { useCallback, useEffect, useRef, useState } from "react"
import type { PointerEventHandler } from "react"

interface UseLongPressOptions {
  delay?: number
  movementTolerance?: number
  onLongPress: () => void
}

export function useLongPress({
  delay = 500,
  movementTolerance = 10,
  onLongPress,
}: UseLongPressOptions) {
  const timerRef = useRef<number | null>(null)
  const originRef = useRef({ x: 0, y: 0 })
  const [isTracking, setIsTracking] = useState(false)

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setIsTracking(false)
  }, [])

  useEffect(() => cancel, [cancel])

  const onPointerDown: PointerEventHandler<HTMLElement> = useCallback(
    (event) => {
      if (!event.isPrimary || event.button !== 0) return
      cancel()
      originRef.current = { x: event.clientX, y: event.clientY }
      setIsTracking(true)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setIsTracking(false)
        if (typeof navigator.vibrate === "function") {
          navigator.vibrate(10)
        }
        onLongPress()
      }, delay)
    },
    [cancel, delay, onLongPress],
  )

  const onPointerMove: PointerEventHandler<HTMLElement> = useCallback(
    (event) => {
      const distance = Math.hypot(
        event.clientX - originRef.current.x,
        event.clientY - originRef.current.y,
      )
      if (distance > movementTolerance) cancel()
    },
    [cancel, movementTolerance],
  )

  return {
    isTracking,
    longPressProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
    },
  }
}
