import { describe, expect, it } from "vitest"

import {
  mergeHistoryMessages,
  removeMatchingHistoryCopies,
} from "@/features/chat/history"
import type { ChatMessage } from "@/store/chat"

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message",
    role: "assistant",
    content: "reply",
    timestamp: 1,
    ...overrides,
  }
}

describe("chat history reconciliation", () => {
  it("merges a reconnect history copy despite transport metadata differences", () => {
    const history = [
      message({ id: "hist-session-1", modelName: "deepseek-flash" }),
    ]
    const live = [message({ id: "live-1", timestamp: 120_000 })]

    expect(mergeHistoryMessages(history, live)).toEqual(live)
  })

  it("removes a history copy from the current turn without a time window", () => {
    const currentUser = message({
      id: "user-current",
      role: "user",
      content: "question",
      timestamp: 1,
    })
    const historyCopy = message({
      id: "hist-session-2",
      modelName: "deepseek-flash",
      timestamp: 2,
    })
    const live = message({ id: "live-2", timestamp: 3_600_000 })

    expect(
      removeMatchingHistoryCopies([currentUser, historyCopy, live], live),
    ).toEqual([currentUser, live])
  })

  it("keeps an identical reply from an older turn", () => {
    const olderHistory = message({ id: "hist-session-older", timestamp: 1 })
    const currentUser = message({
      id: "user-current",
      role: "user",
      content: "another question",
      timestamp: 2,
    })
    const live = message({ id: "live-current", timestamp: 3 })

    expect(
      removeMatchingHistoryCopies([olderHistory, currentUser, live], live),
    ).toEqual([olderHistory, currentUser, live])
  })

  it("repairs an already duplicated history/live pair on the next reconnect", () => {
    const currentUser = message({
      id: "user-current",
      role: "user",
      content: "question",
      timestamp: 1,
    })
    const historyCopy = message({
      id: "hist-session-3",
      modelName: "deepseek-flash",
      timestamp: 2,
    })
    const live = message({ id: "live-3", timestamp: 60_000 })

    expect(
      mergeHistoryMessages(
        [currentUser, historyCopy],
        [currentUser, historyCopy, live],
      ),
    ).toEqual([currentUser, live])
  })
})
