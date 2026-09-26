import type { AssistantActivity, ChatMessage } from "@/store/chat"

export function shouldShowTypingIndicator(
  messages: ChatMessage[],
  isTyping: boolean,
  activity: AssistantActivity | undefined,
  expandedDetailMessageIds: ReadonlySet<string>,
): boolean {
  if (!isTyping) return false
  if (activity === "tool") return true

  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index
      break
    }
  }
  const currentReplies = messages.slice(lastUserIndex + 1)

  return !currentReplies.some(
    (message) =>
      message.streaming === true &&
      message.content.trim().length > 0 &&
      ((message.kind ?? "normal") === "normal" ||
        (message.kind === "thought" &&
          expandedDetailMessageIds.has(message.id))),
  )
}
