import { toast } from "sonner"

import {
  parseAssistantMessageCreateState,
  parseAssistantMessageUpdateState,
} from "@/features/chat/assistant-message-state"
import { removeMatchingHistoryCopies } from "@/features/chat/history"
import { normalizeUnixTimestamp } from "@/features/chat/state"
import {
  type AssistantActivity,
  type ChatAttachment,
  type ContextUsage,
  updateChatStore,
} from "@/store/chat"

export interface PicoMessage {
  type: string
  id?: string
  session_id?: string
  timestamp?: number | string
  payload?: Record<string, unknown>
}

function activityForKind(
  kind: string,
  fallback: AssistantActivity = "thinking",
): AssistantActivity {
  return kind === "tool_calls" || kind === "tool_feedback" ? "tool" : fallback
}

function parseAttachments(
  payload: Record<string, unknown>,
): ChatAttachment[] | undefined {
  const raw = payload.attachments
  if (!Array.isArray(raw)) {
    return undefined
  }

  const attachments: ChatAttachment[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue
    }

    const attachment = item as Record<string, unknown>
    const url = typeof attachment.url === "string" ? attachment.url : ""
    if (!url) {
      continue
    }

    const type =
      attachment.type === "audio" ||
      attachment.type === "video" ||
      attachment.type === "file" ||
      attachment.type === "image"
        ? attachment.type
        : "file"

    const filename =
      typeof attachment.filename === "string" ? attachment.filename : undefined
    const contentType =
      typeof attachment.content_type === "string"
        ? attachment.content_type
        : undefined

    attachments.push({
      type,
      url,
      ...(filename ? { filename } : {}),
      ...(contentType ? { contentType } : {}),
    })
  }

  return attachments.length > 0 ? attachments : undefined
}

function parseContextUsage(
  payload: Record<string, unknown>,
): ContextUsage | undefined {
  const raw = payload.context_usage
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as Record<string, unknown>
  const used = Number(obj.used_tokens)
  const total = Number(obj.total_tokens)
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0)
    return undefined
  return {
    used_tokens: used,
    total_tokens: total,
    history_tokens:
      obj.history_tokens != null ? Number(obj.history_tokens) : undefined,
    compress_at_tokens: Number(obj.compress_at_tokens) || 0,
    summarize_at_tokens:
      obj.summarize_at_tokens != null
        ? Number(obj.summarize_at_tokens)
        : undefined,
    used_percent: Number(obj.used_percent) || 0,
  }
}

function parseModelName(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.model_name !== "string") {
    return undefined
  }
  const modelName = payload.model_name.trim()
  return modelName || undefined
}

export function handlePicoMessage(
  message: PicoMessage,
  expectedSessionId: string,
) {
  if (message.session_id && message.session_id !== expectedSessionId) {
    return
  }

  const payload = message.payload || {}

  switch (message.type) {
    case "message.create":
    case "media.create": {
      const messageId = (payload.message_id as string) || `pico-${Date.now()}`
      const { content, kind, toolCalls } =
        parseAssistantMessageCreateState(payload)
      const attachments = parseAttachments(payload)
      const contextUsage = parseContextUsage(payload)
      const isPlaceholder = payload.placeholder === true
      const isStreaming = payload.final === false
      const modelName = parseModelName(payload)
      const timestamp =
        message.timestamp !== undefined &&
        Number.isFinite(Number(message.timestamp))
          ? normalizeUnixTimestamp(Number(message.timestamp))
          : Date.now()

      const nextMessage = {
        id: messageId,
        role: "assistant" as const,
        content,
        kind,
        ...(modelName ? { modelName } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        attachments,
        streaming: isStreaming,
        timestamp,
      }

      updateChatStore((prev) => ({
        messages: removeMatchingHistoryCopies(
          prev.messages.some((item) => item.id === messageId)
            ? prev.messages.map((item) =>
                item.id === messageId ? { ...item, ...nextMessage } : item,
              )
            : [...prev.messages, nextMessage],
          nextMessage,
        ),
        isTyping:
          kind === "normal" || message.type === "media.create"
            ? !isPlaceholder && isStreaming
            : true,
        assistantActivity:
          kind === "normal" || message.type === "media.create"
            ? isStreaming
              ? "thinking"
              : undefined
            : activityForKind(kind, prev.assistantActivity),
        ...(contextUsage ? { contextUsage } : {}),
      }))
      break
    }

    case "message.update": {
      const messageId = payload.message_id as string
      const attachments = parseAttachments(payload)
      const contextUsage = parseContextUsage(payload)
      const modelName = parseModelName(payload)
      const timestamp =
        message.timestamp !== undefined &&
        Number.isFinite(Number(message.timestamp))
          ? normalizeUnixTimestamp(Number(message.timestamp))
          : Date.now()
      if (!messageId) {
        break
      }
      const explicitKind =
        typeof payload.kind === "string"
          ? payload.kind.trim().toLowerCase()
          : ""
      const isDetailUpdate =
        explicitKind === "thought" ||
        explicitKind === "tool_calls" ||
        explicitKind === "tool_feedback" ||
        payload.tool_calls !== undefined
      const updateActivity: AssistantActivity =
        explicitKind === "tool_calls" ||
        explicitKind === "tool_feedback" ||
        payload.tool_calls !== undefined
          ? "tool"
          : "thinking"

      updateChatStore((prev) => ({
        messages: (() => {
          let found = false
          let liveMessage: (typeof prev.messages)[number] | undefined
          let messages = prev.messages.map((msg) => {
            if (msg.id !== messageId) {
              return msg
            }
            found = true
            const { content, kind, toolCalls } =
              parseAssistantMessageUpdateState(payload, msg)
            liveMessage = {
              ...msg,
              id: messageId,
              content,
              kind,
              toolCalls,
              ...(modelName ? { modelName } : {}),
              ...(attachments ? { attachments } : {}),
              streaming:
                typeof payload.final === "boolean"
                  ? payload.final === false
                  : msg.streaming,
            }
            return liveMessage
          })
          if (found) {
            return liveMessage
              ? removeMatchingHistoryCopies(messages, liveMessage)
              : messages
          }

          const { content, kind, toolCalls } =
            parseAssistantMessageUpdateState(payload)

          liveMessage = {
            id: messageId,
            role: "assistant" as const,
            content,
            kind,
            toolCalls,
            ...(modelName ? { modelName } : {}),
            ...(attachments ? { attachments } : {}),
            streaming: payload.final === false,
            timestamp,
          }
          messages = [...messages, liveMessage]
          return removeMatchingHistoryCopies(messages, liveMessage)
        })(),
        isTyping: isDetailUpdate ? true : payload.final === false,
        assistantActivity: !isDetailUpdate
          ? payload.final === false
            ? "thinking"
            : undefined
          : updateActivity,
        ...(contextUsage ? { contextUsage } : {}),
      }))
      break
    }

    case "message.delete": {
      const messageId = payload.message_id as string
      if (!messageId) {
        break
      }

      updateChatStore((prev) => ({
        messages: prev.messages.filter((msg) => msg.id !== messageId),
      }))
      break
    }

    case "typing.start":
      updateChatStore((prev) => ({
        isTyping: true,
        assistantActivity: prev.assistantActivity ?? "thinking",
      }))
      break

    case "typing.stop":
      updateChatStore((prev) => {
        let lastUserIndex = -1
        for (let index = prev.messages.length - 1; index >= 0; index -= 1) {
          if (prev.messages[index]?.role === "user") {
            lastUserIndex = index
            break
          }
        }
        const replies = prev.messages.slice(lastUserIndex + 1)
        const hasStreamingReply = replies.some(
          (chatMessage) =>
            chatMessage.role === "assistant" && chatMessage.streaming === true,
        )
        const hasFinalAssistantReply = replies.some(
          (chatMessage) =>
            chatMessage.role === "assistant" &&
            (chatMessage.kind ?? "normal") === "normal" &&
            chatMessage.streaming !== true &&
            (chatMessage.content.trim().length > 0 ||
              Boolean(chatMessage.attachments?.length)),
        )

        const isTyping =
          hasStreamingReply || (lastUserIndex >= 0 && !hasFinalAssistantReply)

        return {
          // The server can stop its typing event shortly before the first
          // response chunk reaches the browser. Keep feedback visible until
          // real assistant content arrives so the conversation never appears
          // to stall between the indicator and the reply.
          isTyping,
          assistantActivity: isTyping
            ? (prev.assistantActivity ?? "thinking")
            : undefined,
        }
      })
      break

    case "error": {
      const requestId =
        typeof payload.request_id === "string" ? payload.request_id : ""
      const errorMessage =
        typeof payload.message === "string" ? payload.message : ""

      console.error("Pico error:", payload)
      if (errorMessage) {
        toast.error(errorMessage)
      }
      updateChatStore((prev) => ({
        messages: requestId
          ? prev.messages.filter((msg) => msg.id !== requestId)
          : prev.messages,
        isTyping: false,
        assistantActivity: undefined,
      }))
      break
    }

    case "pong":
      break

    default:
      console.log("Unknown pico message type:", message.type)
  }
}
