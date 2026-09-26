import { describe, expect, it } from "vitest"

import { shouldShowTypingIndicator } from "@/features/chat/typing-indicator-state"
import type { ChatMessage } from "@/store/chat"

const user = (id: string): ChatMessage => ({
  id,
  role: "user",
  content: id,
  timestamp: 1,
})
const assistant = (id: string, content: string): ChatMessage => ({
  id,
  role: "assistant",
  content,
  streaming: true,
  timestamp: 2,
})

describe("typing indicator", () => {
  it("appears for a new turn even when an older reply remains marked streaming", () => {
    const messages = [
      user("old"),
      assistant("old-reply", "旧内容"),
      user("new"),
    ]
    expect(
      shouldShowTypingIndicator(messages, true, "thinking", new Set()),
    ).toBe(true)
  })

  it("hides when the current reply starts streaming text", () => {
    const messages = [user("new"), assistant("new-reply", "第一段")]
    expect(
      shouldShowTypingIndicator(messages, true, "thinking", new Set()),
    ).toBe(false)
  })

  it("shows tool activity after an earlier text chunk", () => {
    const messages = [user("new"), assistant("new-reply", "先回答")]
    expect(shouldShowTypingIndicator(messages, true, "tool", new Set())).toBe(
      true,
    )
  })
})
