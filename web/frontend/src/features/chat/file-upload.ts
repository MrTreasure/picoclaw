import { toast } from "sonner"

import { launcherFetch } from "@/api/http"
import type { ChatAttachment } from "@/store/chat"

const CHAT_FILE_EXTENSIONS = [".txt", ".md", ".pdf", ".json", ".xml"]
export const CHAT_FILE_ACCEPT = CHAT_FILE_EXTENSIONS.join(",")
const MAX_CHAT_FILE_SIZE = 20 * 1024 * 1024

interface PicoUploadResponse {
  ref: string
  filename: string
  content_type?: string
  type?: ChatAttachment["type"]
}

export async function uploadChatFiles(
  files: readonly File[],
  sessionId: string,
  messageId: string,
): Promise<ChatAttachment[]> {
  const uploaded: ChatAttachment[] = []

  for (const file of files) {
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
    if (!CHAT_FILE_EXTENSIONS.includes(extension)) {
      toast.error(
        `不支持“${file.name}”，请选择 TXT、MD、PDF、JSON 或 XML 文件。`,
      )
      continue
    }
    if (file.size === 0 || file.size > MAX_CHAT_FILE_SIZE) {
      toast.error(`“${file.name}”必须小于 20 MB 且不能为空。`)
      continue
    }

    const form = new FormData()
    form.set("session_id", sessionId)
    form.set("message_id", messageId)
    form.set("file", file, file.name)
    const response = await launcherFetch("/pico/upload", {
      method: "POST",
      body: form,
    })
    if (!response.ok) {
      toast.error(`上传“${file.name}”失败。`)
      continue
    }
    const result = (await response.json()) as PicoUploadResponse
    uploaded.push({
      type: result.type ?? "file",
      url: URL.createObjectURL(file),
      mediaRef: result.ref,
      filename: result.filename || file.name,
      contentType: result.content_type || file.type,
    })
  }

  return uploaded
}
