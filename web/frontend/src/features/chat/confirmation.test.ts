import { beforeEach, describe, expect, it } from "vitest"

import { handlePicoMessage } from "@/features/chat/protocol"
import { getChatState, updateChatStore } from "@/store/chat"

const sessionId = "confirmation-test"
const request = (payload: Record<string, unknown>, session = sessionId) =>
  handlePicoMessage(
    { type: "confirmation.request", session_id: session, payload },
    sessionId,
  )
const resolved = (payload: Record<string, unknown>, session = sessionId) =>
  handlePicoMessage(
    { type: "confirmation.resolved", session_id: session, payload },
    sessionId,
  )

describe("Pico inline confirmations", () => {
  beforeEach(() =>
    updateChatStore({ activeSessionId: sessionId, pendingConfirmations: [] }),
  )

  it("requires matching explicit session and typed nonempty ID and prompt", () => {
    request({ request_id: "wrong", prompt: "No" }, "another-session")
    handlePicoMessage(
      {
        type: "confirmation.request",
        payload: { request_id: "missing-session", prompt: "No" },
      },
      sessionId,
    )
    request({ request_id: 123, prompt: "No" })
    request({ request_id: "empty-prompt", prompt: " " })
    request({ request_id: "too-long", prompt: "x".repeat(16_385) })
    expect(getChatState().pendingConfirmations).toEqual([])
    request({ request_id: "request-1", prompt: "Run command?" })
    handlePicoMessage(
      {
        type: "confirmation.request",
        id: "top-level-id",
        session_id: sessionId,
        payload: { prompt: "Another command?" },
      },
      sessionId,
    )
    expect(getChatState().pendingConfirmations).toEqual([
      {
        requestId: "request-1",
        sessionId,
        prompt: "Run command?",
        status: "awaiting",
      },
      {
        requestId: "top-level-id",
        sessionId,
        prompt: "Another command?",
        status: "awaiting",
      },
    ])
  })

  it("deduplicates and bounds requests, and only resolves a typed matching ID", () => {
    for (let i = 0; i < 10; i++)
      request({ request_id: `request-${i}`, prompt: `Command ${i}` })
    request({ request_id: "request-0", prompt: "Different command" })
    expect(getChatState().pendingConfirmations).toHaveLength(8)
    resolved({ request_id: "request-0", approved: "true" })
    resolved({ request_id: "request-0", approved: true }, "other-session")
    expect(getChatState().pendingConfirmations).toHaveLength(8)
    resolved({ request_id: "request-0", approved: false, reason: "denied" })
    expect(getChatState().pendingConfirmations).toHaveLength(7)
    expect(
      getChatState().pendingConfirmations.some(
        (item) => item.requestId === "request-0",
      ),
    ).toBe(false)
  })
})
