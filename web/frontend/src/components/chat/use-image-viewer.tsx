import { useMemo, useState } from "react"

import { ImageViewer } from "@/components/chat/image-viewer"
import { buildImageGallery, galleryIndex } from "@/features/chat/image-gallery"
import type { GalleryImage } from "@/features/chat/image-gallery"
import type { ChatMessage } from "@/store/chat"

export function useImageViewer(messages: ChatMessage[]) {
  const gallery = useMemo(() => buildImageGallery(messages), [messages])
  const [selection, setSelection] = useState<Pick<
    GalleryImage,
    "messageId" | "imageIndex"
  > | null>(null)
  const index = selection ? galleryIndex(gallery, selection) : -1
  const open = (messageId: string, imageIndex: number) =>
    setSelection({ messageId, imageIndex })
  const viewer =
    index >= 0 ? (
      <ImageViewer
        gallery={gallery}
        index={index}
        onSelect={setSelection}
        onClose={() => setSelection(null)}
      />
    ) : null
  return { open, viewer }
}
