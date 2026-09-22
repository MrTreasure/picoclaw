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
      // History can be loaded more than once while the live socket reconnects.
      // Keep IDs stable so repeated hydration never creates a second copy.
      id: `hist-${sessionId}-${index}`,
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

export function messageSignature(message: ChatMessage): string {
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

function reconciliationSignature(message: ChatMessage): string {
  const content = message.content.trim()
  if (content) {
    // The session API and the live Pico event describe the same durable reply
    // with different transport metadata (model name, attachment shape and
    // timestamps). Content + presentation kind is the stable identity shared
    // by both paths. Occurrence counts in mergeHistoryMessages keep repeated
    // answers in separate turns rather than collapsing them globally.
    return `${message.role}\u0000${message.kind ?? "normal"}\u0000${content}`
  }

  return messageSignature({ ...message, modelName: undefined })
}

function removeShadowedHistoryCopies(messages: ChatMessage[]): ChatMessage[] {
  const turnByIndex: number[] = []
  let turn = 0
  messages.forEach((message, index) => {
    if (message.role === "user") {
      turn += 1
    }
    turnByIndex[index] = turn
  })

  const removed = new Set<number>()
  messages.forEach((message, liveIndex) => {
    if (message.role !== "assistant" || message.id.startsWith("hist-")) {
      return
    }

    const signature = reconciliationSignature(message)
    for (let index = liveIndex - 1; index >= 0; index -= 1) {
      if (turnByIndex[index] !== turnByIndex[liveIndex]) {
        break
      }
      const candidate = messages[index]
      if (
        candidate?.id.startsWith("hist-") &&
        !removed.has(index) &&
        reconciliationSignature(candidate) === signature
      ) {
        removed.add(index)
        break
      }
    }
  })

  return removed.size === 0
    ? messages
    : messages.filter((_, index) => !removed.has(index))
}

export function removeMatchingHistoryCopies(
  messages: ChatMessage[],
  liveMessage: ChatMessage,
): ChatMessage[] {
  if (
    liveMessage.role !== "assistant" ||
    liveMessage.content.trim().length === 0
  ) {
    return messages
  }

  const signature = reconciliationSignature(liveMessage)
  const liveIndex = messages.findIndex(
    (message) => message.id === liveMessage.id,
  )
  let latestUserIndex = -1
  const searchEnd = liveIndex >= 0 ? liveIndex : messages.length
  for (let index = searchEnd - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index
      break
    }
  }
  let duplicateIndex = -1

  messages.forEach((message, index) => {
    if (
      index <= latestUserIndex ||
      !message.id.startsWith("hist-") ||
      reconciliationSignature(message) !== signature
    ) {
      return
    }

    // Prefer the last matching history entry in the current turn. This covers
    // long-running replies whose persisted and live timestamps can be many
    // minutes apart while preserving the same text from older turns.
    duplicateIndex = index
  })

  return duplicateIndex < 0
    ? messages
    : messages.filter((_, index) => index !== duplicateIndex)
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
  currentMessages = removeShadowedHistoryCopies(
    splitMarkedAssistantMessages(currentMessages),
  )
  const currentIds = new Set(currentMessages.map((message) => message.id))
  const unmatchedCurrentSignatures = new Map<string, number>()
  for (const message of currentMessages) {
    const signature = reconciliationSignature(message)
    unmatchedCurrentSignatures.set(
      signature,
      (unmatchedCurrentSignatures.get(signature) ?? 0) + 1,
    )
  }

  const missingHistoryMessages = historyMessages.filter((message) => {
    if (currentIds.has(message.id)) {
      return false
    }
    const signature = reconciliationSignature(message)
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
