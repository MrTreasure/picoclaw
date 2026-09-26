import type { TFunction } from "i18next"
import { toast } from "sonner"
import { launcherFetch } from "@/api/http"

import type { ChatAttachment } from "@/store/chat"

const CHAT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
] as const

const CHAT_IMAGE_MIME_TYPE_SET = new Set<string>(CHAT_IMAGE_MIME_TYPES)
const CHAT_IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
}
const CHAT_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
}

export const CHAT_IMAGE_ACCEPT = CHAT_IMAGE_MIME_TYPES.join(",")

const MAX_CHAT_IMAGE_SIZE_BYTES = 7 * 1024 * 1024
const MAX_CHAT_IMAGE_SIZE_LABEL = "7 MB"

function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".")
  if (lastDotIndex === -1) {
    return ""
  }
  return fileName.slice(lastDotIndex).toLowerCase()
}

function getSupportedImageMimeType(file: File): string | null {
  const normalizedType = file.type.trim().toLowerCase()
  if (normalizedType && CHAT_IMAGE_MIME_TYPE_SET.has(normalizedType)) {
    return normalizedType
  }

  const extension = getFileExtension(file.name)
  return CHAT_IMAGE_MIME_BY_EXTENSION[extension] ?? null
}

function normalizeImageFileForUpload(file: File, filename: string): File {
  const mimeType = getSupportedImageMimeType(file)
  if (!mimeType || file.type.trim().toLowerCase() === mimeType) {
    return file
  }

  const normalizedName = file.name.trim() || filename
  return new File([file], normalizedName, { type: mimeType })
}

function getAttachmentFilename(file: File, index: number): string {
  const trimmedName = file.name.trim()
  if (trimmedName) {
    return trimmedName
  }

  const mimeType = getSupportedImageMimeType(file)
  const extension = mimeType ? CHAT_IMAGE_EXTENSION_BY_MIME[mimeType] : ".png"
  return `image-${index + 1}${extension}`
}

function getTransferItemFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return []
  }

  const files = Array.from(dataTransfer.files)
  if (files.length > 0) {
    return files
  }

  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export function hasFileTransfer(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false
  }

  if (dataTransfer.files.length > 0) {
    return true
  }

  return Array.from(dataTransfer.items).some((item) => item.kind === "file")
}

export function getTransferredFiles(dataTransfer: DataTransfer | null) {
  return getTransferItemFiles(dataTransfer)
}

export async function buildChatImageAttachments(
  files: readonly File[],
  t: TFunction,
  sessionId: string,
  messageId: string,
): Promise<ChatAttachment[]> {
  const nextAttachments: ChatAttachment[] = []

  for (const [index, file] of files.entries()) {
    const filename = getAttachmentFilename(file, index)

    const mimeType = getSupportedImageMimeType(file)
    if (!mimeType) {
      toast.error(
        t("chat.invalidImage", {
          name: filename,
        }),
      )
      continue
    }

    if (file.size > MAX_CHAT_IMAGE_SIZE_BYTES) {
      toast.error(
        t("chat.imageTooLarge", {
          name: filename,
          size: MAX_CHAT_IMAGE_SIZE_LABEL,
        }),
      )
      continue
    }

    try {
      const normalizedFile = normalizeImageFileForUpload(file, filename)
      const form = new FormData()
      form.set("session_id", sessionId)
      form.set("message_id", messageId)
      form.set("file", normalizedFile, filename)
      const response = await launcherFetch("/pico/upload", { method: "POST", body: form })
      if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
      const result = (await response.json()) as { ref: string; filename?: string; content_type?: string }
      if (!result.ref?.startsWith("media://")) throw new Error("Missing media reference")
      nextAttachments.push({
        type: "image",
        filename: result.filename || filename,
        url: URL.createObjectURL(normalizedFile),
        mediaRef: result.ref,
        contentType: result.content_type || mimeType,
      })
    } catch {
      toast.error(
        t("chat.imageReadFailed", {
          name: filename,
        }),
      )
    }
  }

  return nextAttachments
}
