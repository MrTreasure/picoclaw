import { type ImgHTMLAttributes, useState } from "react"

import { cn } from "@/lib/utils"

function previewURL(src: string) {
  try {
    const url = new URL(src, location.origin)
    if (url.origin !== location.origin || url.search) return src
    if (
      /^\/api\/codex\/images\/[0-9a-f]{32}\.(jpg|png|gif)$/.test(
        url.pathname,
      ) ||
      /^\/pico\/media\/[\w-]+$/.test(url.pathname)
    ) {
      return "/api/image-thumbnail?src=" + encodeURIComponent(url.pathname)
    }
  } catch {
    /* Inline or foreign media uses its original source. */
  }
  return src
}
export function ChatThumbnail(
  props: ImgHTMLAttributes<HTMLImageElement> & { src: string },
) {
  return <ThumbnailImage key={props.src} {...props} />
}
function ThumbnailImage({
  src,
  className,
  alt,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [fallback, setFallback] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <span className="bg-muted/40 relative inline-flex h-48 w-56 max-w-full items-center justify-center overflow-hidden rounded-lg align-middle sm:h-56 sm:w-64">
      <img
        {...props}
        src={fallback ? src : previewURL(src)}
        alt={alt}
        loading="lazy"
        decoding="async"
        className={cn(
          className,
          "m-0! size-full! max-h-full! max-w-full! object-contain",
        )}
        onError={() => {
          if (!fallback && previewURL(src) !== src) setFallback(true)
          else setFailed(true)
        }}
      />
      {failed && (
        <span className="text-muted-foreground bg-background/90 pointer-events-none absolute px-2 py-1 text-xs">
          图片不可用，点击查看原图
        </span>
      )}
    </span>
  )
}
