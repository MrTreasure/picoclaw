import { useState } from "react"

import { ImageViewer } from "@/components/chat/image-viewer"
import { isSafeImageSource } from "@/features/chat/image-gallery"

// Keep Markdown's inline image valid inside paragraphs and linked images.
export function MessageImage({
  src,
  alt,
  title,
}: {
  src?: string
  alt?: string
  title?: string
}) {
  const [open, setOpen] = useState(false)
  if (!src || !isSafeImageSource(src)) return <span>{alt || "图片不可用"}</span>
  return (
    <>
      <img
        src={src}
        alt={alt || "聊天图片"}
        title={title}
        loading="lazy"
        role="button"
        tabIndex={0}
        aria-label={`放大图片：${alt || "聊天图片"}`}
        className="cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            event.stopPropagation()
            setOpen(true)
          }
        }}
      />
      {open && (
        <ImageViewer
          gallery={[
            { messageId: src, imageIndex: 0, url: src, alt: alt || "聊天图片" },
          ]}
          index={0}
          onSelect={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
