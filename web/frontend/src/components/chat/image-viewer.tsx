import { IconChevronLeft, IconChevronRight, IconX } from "@tabler/icons-react"
import { useEffect, useLayoutEffect, useRef } from "react"
import { createPortal } from "react-dom"

import { horizontalSwipe } from "@/features/chat/image-gallery"
import type { GalleryImage } from "@/features/chat/image-gallery"

export function ImageViewer({
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
  const closeRef = useRef<HTMLButtonElement>(null)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
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
      data-image-viewer
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
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
          aria-label="Close image viewer"
          onClick={onClose}
          className="flex size-11 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-white"
        >
          <IconX aria-hidden="true" />
        </button>
      </div>
      <div
        className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center overflow-hidden"
        onTouchStart={(event) => {
          const touch = event.changedTouches[0]
          if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY }
        }}
        onTouchEnd={(event) => {
          const touch = event.changedTouches[0]
          const start = touchStart.current
          touchStart.current = null
          if (touch && start)
            move(
              horizontalSwipe(touch.clientX - start.x, touch.clientY - start.y),
            )
        }}
        onTouchCancel={() => {
          touchStart.current = null
        }}
      >
        <img
          key={`${current.messageId}:${current.imageIndex}`}
          src={current.url}
          alt={current.alt}
          draggable={false}
          className="max-h-full max-w-full object-contain select-none"
        />
        <button
          type="button"
          aria-label="Previous image"
          disabled={index === 0}
          onClick={() => move(-1)}
          className="absolute left-2 flex size-11 items-center justify-center rounded-full bg-black/50 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-30"
        >
          <IconChevronLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Next image"
          disabled={index === gallery.length - 1}
          onClick={() => move(1)}
          className="absolute right-2 flex size-11 items-center justify-center rounded-full bg-black/50 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-30"
        >
          <IconChevronRight aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  )
}
