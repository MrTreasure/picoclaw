import { describe, expect, it } from "vitest"

import { mergeCachedMessages } from "@/features/chat/local-cache"
import type { ChatMessage } from "@/store/chat"

function message(id: string, content: string, timestamp: number): ChatMessage {
  return { id, content, timestamp, role: "assistant" }
}

describe("local chat cache", () => {
  it("updates an existing streaming message without duplicating it", () => {
    expect(
      mergeCachedMessages(
        [{ ...message("reply", "partial", 2), streaming: true }],
        [message("reply", "complete", 2)],
      ),
    ).toEqual([message("reply", "complete", 2)])
  })

  it("keeps cached history before the currently rendered page", () => {
    expect(
      mergeCachedMessages(
        [message("old", "older", 1)],
        [message("new", "newer", 2)],
      ).map((item) => item.id),
    ).toEqual(["old", "new"])
  })
})
