import { getSessionHistory } from "@/api/sessions"
import { normalizeUnixTimestamp } from "@/features/chat/state"
import {
  parseToolCallsValue,
  toolCallsSignature,
} from "@/features/chat/tool-calls"
import type { ChatAttachment, ChatMessage } from "@/store/chat"

const MESSAGE_SPLIT_MARKER = "<|[SPLIT]|>"

function toChatAttachments({
  media,
  attachments,
}: {
  media?: string[]
  attachments?: {
    type?: "image" | "audio" | "video" | "file"
    url: string
    filename?: string
    content_type?: string
  }[]
}): ChatAttachment[] | undefined {
  const normalizedAttachments = attachments
    ?.filter((attachment) => attachment.url)
    .map(
      (attachment) =>
        ({
          type: attachment.type ?? "file",
          url: attachment.url,
          filename: attachment.filename,
          contentType: attachment.content_type,
        }) satisfies ChatAttachment,
    )

  const legacyMediaAttachments = (media ?? [])
    .filter((item) => item.startsWith("data:image/"))
    .map((url) => ({ type: "image" as const, url }))

  const merged = [...(normalizedAttachments ?? []), ...legacyMediaAttachments]

  return merged.length > 0 ? merged : undefined
}

export async function loadSessionMessages(
  sessionId: string,
): Promise<ChatMessage[]> {
  const detail = await getSessionHistory(sessionId)
  return splitMarkedAssistantMessages(
    detail.messages.map((message, index) => ({
      id: `hist-${index}-${Date.now()}`,
      role: message.role,
      content: message.content,
      kind:
        message.role === "assistant" ? (message.kind ?? "normal") : undefined,
      modelName: message.model_name,
      toolCalls:
        message.role === "assistant"
          ? parseToolCallsValue(message.tool_calls)
          : undefined,
      attachments: toChatAttachments({
        media: message.media,
        attachments: message.attachments,
      }),
      timestamp: message.created_at ?? detail.updated,
    })),
  )
}

function splitMarkedAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (
      message.role !== "assistant" ||
      !message.content.includes(MESSAGE_SPLIT_MARKER)
    ) {
      return [message]
    }

    const parts = message.content
      .split(MESSAGE_SPLIT_MARKER)
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length === 0) {
      return [{ ...message, content: "" }]
    }

    return parts.map((content, index) => ({
      ...message,
      id: `${message.id}-part-${index}`,
      content,
      attachments: index === parts.length - 1 ? message.attachments : undefined,
    }))
  })
}

function normalizeMessageTimestamp(timestamp: number | string): string {
  if (typeof timestamp === "number") {
    return String(normalizeUnixTimestamp(timestamp))
  }

  const trimmed = timestamp.trim()
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return String(normalizeUnixTimestamp(Number(trimmed)))
  }

  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? trimmed : String(parsed)
}

function messageSignature(message: ChatMessage): string {
  const attachmentSignature = (message.attachments ?? [])
    .map(
      (attachment) =>
        `${attachment.type}\u0001${attachment.url}\u0001${attachment.filename ?? ""}`,
    )
    .join("\u0002")

  return `${message.role}\u0000${message.content}\u0000${message.kind ?? ""}\u0000${message.modelName ?? ""}\u0000${attachmentSignature}\u0000${toolCallsSignature(
    message.toolCalls,
  )}`
}

function comparableTimestamp(timestamp: number | string): number {
  const normalized = normalizeMessageTimestamp(timestamp)
  const numeric = Number(normalized)
  return Number.isFinite(numeric) ? numeric : 0
}

export function mergeHistoryMessages(
  historyMessages: ChatMessage[],
  currentMessages: ChatMessage[],
): ChatMessage[] {
  historyMessages = splitMarkedAssistantMessages(historyMessages)
  currentMessages = splitMarkedAssistantMessages(currentMessages)
  const currentIds = new Set(currentMessages.map((message) => message.id))
  const unmatchedCurrentSignatures = new Map<string, number>()
  for (const message of currentMessages) {
    const signature = messageSignature(message)
    unmatchedCurrentSignatures.set(
      signature,
      (unmatchedCurrentSignatures.get(signature) ?? 0) + 1,
    )
  }

  const missingHistoryMessages = historyMessages.filter((message) => {
    if (currentIds.has(message.id)) {
      return false
    }
    const signature = messageSignature(message)
    const matches = unmatchedCurrentSignatures.get(signature) ?? 0
    if (matches === 0) {
      return true
    }
    unmatchedCurrentSignatures.set(signature, matches - 1)
    return false
  })

  const merged = [...missingHistoryMessages, ...currentMessages]

  return merged.sort(
    (left, right) =>
      comparableTimestamp(left.timestamp) -
      comparableTimestamp(right.timestamp),
  )
}
