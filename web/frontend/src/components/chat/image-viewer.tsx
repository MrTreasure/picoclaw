import {
  IconChevronLeft,
  IconChevronRight,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { horizontalSwipe } from "@/features/chat/image-gallery"
import type { GalleryImage } from "@/features/chat/image-gallery"
import { useOverlayBack } from "@/hooks/use-overlay-back"

export function ImageViewer(props: {
  gallery: GalleryImage[]
  index: number
  onSelect: (selection: Pick<GalleryImage, "messageId" | "imageIndex">) => void
  onClose: () => void
}) {
  useOverlayBack(true, props.onClose)
  const image = props.gallery[props.index]
  return image ? (
    <ImageViewerFrame
      key={image.messageId + ":" + image.imageIndex + ":" + image.url}
      {...props}
    />
  ) : null
}

function ImageViewerFrame({
  gallery,
  index,
  onSelect,
  onClose,
}: {
  gallery: GalleryImage[]
  index: number
  onSelect: (selection: Pick<GalleryImage, "messageId" | "imageIndex">) => void
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const closeRef = useRef<HTMLButtonElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{
    scale: number
    x: number
    y: number
    cx: number
    cy: number
    distance: number
  } | null>(null)
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const update = (scale: number, x = 0, y = 0) => {
    scale = Math.max(1, Math.min(5, scale))
    const bounds = stage.current?.getBoundingClientRect()
    const maxX = ((bounds?.width ?? 0) * (scale - 1)) / 2
    const maxY = ((bounds?.height ?? 0) * (scale - 1)) / 2
    const next = {
      scale,
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    }
    viewRef.current = next
    setView(next)
  }
  const baseline = () => {
    const points = [...pointers.current.values()]
    const a = points[0],
      b = points[1] ?? a
    if (!a) {
      gesture.current = null
      return
    }
    gesture.current = {
      ...viewRef.current,
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    }
  }
  const latest = useRef({ gallery, index, onSelect, onClose })
  useLayoutEffect(() => {
    latest.current = { gallery, index, onSelect, onClose }
  }, [gallery, index, onSelect, onClose])
  const move = (offset: number) => {
    const next = gallery[index + offset]
    if (next)
      onSelect({ messageId: next.messageId, imageIndex: next.imageIndex })
  }
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        latest.current.onClose()
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault()
        const { gallery, index, onSelect } = latest.current
        const next = gallery[index + (event.key === "ArrowRight" ? 1 : -1)]
        if (next)
          onSelect({ messageId: next.messageId, imageIndex: next.imageIndex })
      }
      if (event.key === "Tab") {
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-image-viewer] button:not(:disabled)",
          ),
        )
        const current = controls.indexOf(document.activeElement as HTMLElement)
        if (
          controls.length &&
          (current < 0 ||
            (event.shiftKey && current === 0) ||
            (!event.shiftKey && current === controls.length - 1))
        ) {
          event.preventDefault()
          controls[event.shiftKey ? controls.length - 1 : 0]?.focus()
        }
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", onKeyDown)
      previousFocus?.focus()
    }
  }, [])
  const current = gallery[index]
  return createPortal(
    <div
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      data-image-viewer
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      className="fixed inset-0 z-[100] flex flex-col bg-black/95 text-white"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex min-h-14 items-center justify-between px-3">
        <span aria-live="polite" className="text-sm tabular-nums">
          {index + 1} / {gallery.length}
        </span>
        <button
          ref={closeRef}
          type="button"
          aria-label="关闭图片预览"
          onClick={onClose}
          className="flex size-11 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-white"
        >
          <IconX aria-hidden="true" />
        </button>
      </div>
      <div
        ref={stage}
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden"
        onDoubleClick={(event) => {
          if ((event.target as Element).closest("button")) return
          update(viewRef.current.scale > 1 ? 1 : 2.5)
        }}
        onPointerDown={(event) => {
          if ((event.target as Element).closest("button") || event.button !== 0)
            return
          event.currentTarget.setPointerCapture(event.pointerId)
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          })
          swipe.current =
            pointers.current.size === 1 && viewRef.current.scale === 1
              ? { x: event.clientX, y: event.clientY }
              : null
          baseline()
        }}
        onPointerMove={(event) => {
          if (!pointers.current.has(event.pointerId)) return
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          })
          const start = gesture.current
          const points = [...pointers.current.values()]
          if (!start || !points.length) return
          const a = points[0],
            b = points[1] ?? a
          const cx = (a.x + b.x) / 2,
            cy = (a.y + b.y) / 2
          if (points.length > 1 && start.distance > 0) {
            const scale = Math.max(
              1,
              Math.min(
                5,
                (start.scale * Math.hypot(a.x - b.x, a.y - b.y)) /
                  start.distance,
              ),
            )
            const rect = stage.current?.getBoundingClientRect()
            if (!rect) return
            const ox = start.cx - rect.left - rect.width / 2
            const oy = start.cy - rect.top - rect.height / 2
            update(
              scale,
              cx - start.cx + ox - ((ox - start.x) * scale) / start.scale,
              cy - start.cy + oy - ((oy - start.y) * scale) / start.scale,
            )
          } else if (viewRef.current.scale > 1) {
            update(
              start.scale,
              start.x + cx - start.cx,
              start.y + cy - start.cy,
            )
          }
        }}
        onPointerUp={(event) => {
          const start = swipe.current
          if (
            start &&
            pointers.current.size === 1 &&
            viewRef.current.scale === 1
          ) {
            const offset = horizontalSwipe(
              event.clientX - start.x,
              event.clientY - start.y,
            )
            if (offset) move(offset)
          }
          swipe.current = null
          pointers.current.delete(event.pointerId)
          baseline()
        }}
        onPointerCancel={() => {
          pointers.current.clear()
          gesture.current = null
          swipe.current = null
        }}
        onLostPointerCapture={(event) => {
          pointers.current.delete(event.pointerId)
          baseline()
        }}
      >
        <img
          key={`${current.messageId}:${current.imageIndex}:${attempt}`}
          src={current.url}
          alt={current.alt}
          draggable={false}
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false)
            setFailed(true)
          }}
          className="max-h-full max-w-full object-contain select-none"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            cursor: view.scale > 1 ? "grab" : "zoom-in",
          }}
        />
        {loading && (
          <span role="status" className="pointer-events-none absolute text-sm">
            正在加载图片…
          </span>
        )}
        {failed && (
          <div
            role="alert"
            className="absolute flex flex-col items-center gap-2 bg-black/80 p-4"
          >
            <span>图片加载失败</span>
            <button
              type="button"
              className="min-h-11 rounded-lg px-4 underline"
              onClick={() => {
                setFailed(false)
                setLoading(true)
                setAttempt((value) => value + 1)
              }}
            >
              重新加载
            </button>
          </div>
        )}
        <button
          type="button"
          aria-label="上一张图片"
          disabled={index === 0}
          onClick={() => move(-1)}
          className="absolute left-2 flex size-11 items-center justify-center rounded-full bg-black/50 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-30"
        >
          <IconChevronLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="下一张图片"
          disabled={index === gallery.length - 1}
          onClick={() => move(1)}
          className="absolute right-2 flex size-11 items-center justify-center rounded-full bg-black/50 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-30"
        >
          <IconChevronRight aria-hidden="true" />
        </button>
      </div>
      <div className="flex min-h-14 items-center justify-center gap-4">
        <button
          type="button"
          aria-label="缩小图片"
          disabled={view.scale <= 1}
          onClick={() => update(view.scale - 0.5, view.x, view.y)}
          className="flex size-11 items-center justify-center rounded-full disabled:opacity-30"
        >
          <IconZoomOut />
        </button>
        <button
          type="button"
          aria-label="恢复图片大小"
          onClick={() => update(1)}
          className="min-h-11 min-w-16 tabular-nums"
        >
          {Math.round(view.scale * 100)}%
        </button>
        <button
          type="button"
          aria-label="放大图片"
          disabled={view.scale >= 5}
          onClick={() => update(view.scale + 0.5, view.x, view.y)}
          className="flex size-11 items-center justify-center rounded-full disabled:opacity-30"
        >
          <IconZoomIn />
        </button>
      </div>
    </div>,
    document.body,
  )
}
