import type { ChatToolCall } from "@/store/chat"

const DYNAMIC_CONTEXT_START = "## Current Time"
const DYNAMIC_CONTEXT_SEPARATOR = /\r?\n\r?\n---\r?\n\r?\n/

export function sanitizeToolFeedbackExplanation(value: string): string {
  const trimmed = value.trim()
  const contextStart = trimmed.indexOf(DYNAMIC_CONTEXT_START)
  if (contextStart < 0) {
    return trimmed
  }

  const beforeContext = trimmed.slice(0, contextStart).trim()
  if (
    beforeContext !== "" &&
    !/^Continuing (?:the )?current task\.:?$/i.test(beforeContext)
  ) {
    return trimmed
  }

  const contextAndMessage = trimmed.slice(contextStart)
  const separator = DYNAMIC_CONTEXT_SEPARATOR.exec(contextAndMessage)
  if (!separator || separator.index === undefined) {
    return trimmed
  }

  const userMessage = contextAndMessage
    .slice(separator.index + separator[0].length)
    .trim()
  if (!userMessage) {
    return ""
  }
  return beforeContext ? `${beforeContext} ${userMessage}` : userMessage
}

function parseLegacyToolFeedbackContent(
  content: string,
): ChatToolCall[] | undefined {
  const trimmed = content.trim()
  const match =
    /^🔧\s+`([^`\n\r]*?)(?:\.{1,2})?`[^\n\r]*(?:\r?\n([\s\S]*))?$/.exec(trimmed)
  if (!match) {
    return undefined
  }

  const toolName = match[1]?.trim() ?? ""
  const body = match[2]?.trim() ?? ""
  const codeFence = /```(?:json)?\r?\n([\s\S]*?)\r?\n```/m.exec(body)
  const argumentsText = codeFence?.[1]?.trim() ?? ""
  const explanation = body
    .replace(/```(?:json)?\r?\n[\s\S]*?\r?\n```/gm, "")
    .trim()

  return [
    {
      type: "function",
      function: {
        name: toolName,
        ...(argumentsText ? { arguments: argumentsText } : {}),
      },
      ...(explanation
        ? {
            extraContent: {
              toolFeedbackExplanation: explanation,
            },
          }
        : {}),
    },
  ]
}

export function parseToolCallsValue(raw: unknown): ChatToolCall[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }

  const toolCalls: ChatToolCall[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue
    }

    const toolCall = item as Record<string, unknown>
    const rawFunction =
      toolCall.function && typeof toolCall.function === "object"
        ? (toolCall.function as Record<string, unknown>)
        : null
    const rawExtraContent =
      toolCall.extra_content && typeof toolCall.extra_content === "object"
        ? (toolCall.extra_content as Record<string, unknown>)
        : null

    const nextToolCall: ChatToolCall = {
      ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
      ...(typeof toolCall.type === "string" ? { type: toolCall.type } : {}),
    }

    if (rawFunction) {
      const name =
        typeof rawFunction.name === "string" ? rawFunction.name : undefined
      const argumentsText =
        typeof rawFunction.arguments === "string"
          ? rawFunction.arguments
          : undefined

      if (name || argumentsText) {
        nextToolCall.function = {
          ...(name ? { name } : {}),
          ...(argumentsText ? { arguments: argumentsText } : {}),
        }
      }
    }

    if (rawExtraContent) {
      const toolFeedbackExplanation =
        typeof rawExtraContent.tool_feedback_explanation === "string"
          ? sanitizeToolFeedbackExplanation(
              rawExtraContent.tool_feedback_explanation,
            )
          : undefined

      if (toolFeedbackExplanation) {
        nextToolCall.extraContent = {
          toolFeedbackExplanation,
        }
      }
    }

    if (
      nextToolCall.id ||
      nextToolCall.type ||
      nextToolCall.function ||
      nextToolCall.extraContent
    ) {
      toolCalls.push(nextToolCall)
    }
  }

  return toolCalls.length > 0 ? toolCalls : undefined
}

export function parseToolCallsFromContent(
  content: string,
): ChatToolCall[] | undefined {
  return parseLegacyToolFeedbackContent(content)
}

export function toolCallsSignature(toolCalls?: ChatToolCall[]): string {
  return (toolCalls ?? [])
    .map((toolCall) =>
      [
        toolCall.id ?? "",
        toolCall.type ?? "",
        toolCall.function?.name ?? "",
        toolCall.function?.arguments ?? "",
        toolCall.extraContent?.toolFeedbackExplanation ?? "",
      ].join("\u0001"),
    )
    .join("\u0002")
}
