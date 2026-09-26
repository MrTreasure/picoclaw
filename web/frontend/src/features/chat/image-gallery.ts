import type { ChatMessage } from "@/store/chat"

export interface GalleryImage {
  messageId: string
  imageIndex: number
  url: string
  alt: string
}
export function isSafeImageSource(url: string): boolean {
  const value = url.trim()
  // oxlint-disable-next-line eslint/no-control-regex
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return false
  if (value.toLowerCase().startsWith("data:")) {
    const comma = value.indexOf(",")
    if (comma < 0) return false
    const header = value.slice(0, comma).toLowerCase()
    const allowed = ["png", "jpeg", "gif", "webp", "avif", "bmp"]
    return (
      header.endsWith(";base64") &&
      allowed.some((mime) => header === `data:image/${mime};base64`)
    )
  }
  if (/^blob:/i.test(value)) return /^blob:https?:\/\//i.test(value)
  if (/^[a-z][\w+.-]*:/i.test(value)) return /^https?:\/\//i.test(value)
  return value.startsWith("/") && !value.startsWith("//")
}
export function buildImageGallery(messages: ChatMessage[]): GalleryImage[] {
  return messages.flatMap((message) =>
    (message.attachments ?? [])
      .filter((attachment) => attachment.type === "image")
      .map((attachment, imageIndex) => ({
        messageId: message.id,
        imageIndex,
        url: attachment.url,
        alt: attachment.filename || "Attached image",
      }))
      .filter((image) => isSafeImageSource(image.url)),
  )
}
export function galleryIndex(
  gallery: GalleryImage[],
  selection: Pick<GalleryImage, "messageId" | "imageIndex">,
): number {
  return gallery.findIndex(
    (item) =>
      item.messageId === selection.messageId &&
      item.imageIndex === selection.imageIndex,
  )
}
export function horizontalSwipe(dx: number, dy: number): -1 | 0 | 1 {
  return Math.abs(dx) >= 55 && Math.abs(dx) > Math.abs(dy) * 1.5
    ? dx < 0
      ? 1
      : -1
    : 0
}
