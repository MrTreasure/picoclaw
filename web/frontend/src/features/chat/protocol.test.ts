import { beforeEach, describe, expect, it } from "vitest"

import { handlePicoMessage } from "@/features/chat/protocol"
import { getChatState, updateChatStore } from "@/store/chat"

describe("Pico streaming messages", () => {
  beforeEach(() => updateChatStore({ messages: [], isTyping: false }))

  it("shows each partial response before the final response", () => {
    const sessionId = "streaming-test"
    const messageId = "reply"
    const send = (type: string, content: string, final: boolean) => {
      handlePicoMessage(
        {
          type,
          session_id: sessionId,
          payload: { message_id: messageId, content, final },
        },
        sessionId,
      )
    }

    send("message.create", "第一段", false)
    expect(getChatState().messages[0]).toMatchObject({
      content: "第一段",
      streaming: true,
    })

    send("message.update", "第一段第二段", false)
    expect(getChatState().messages[0]).toMatchObject({
      content: "第一段第二段",
      streaming: true,
    })

    send("message.update", "第一段第二段完成", true)
    expect(getChatState().messages[0]).toMatchObject({
      content: "第一段第二段完成",
      streaming: false,
    })
    expect(getChatState().messages).toHaveLength(1)
  })
})

describe("Pico send error", () => {
  beforeEach(() => updateChatStore({ messages: [], isTyping: false }))

  it("keeps the matching optimistic text and attachments with failure status", () => {
    const attachment = {
      type: "image" as const,
      url: "media://test",
      mediaRef: "media://test",
    }
    updateChatStore({
      activeSessionId: "send-test",
      isTyping: true,
      messages: [
        {
          id: "request-1",
          role: "user",
          content: "Please check",
          timestamp: Date.now(),
          attachments: [attachment],
          sendStatus: "pending",
        },
        {
          id: "history",
          role: "user",
          content: "previous",
          timestamp: Date.now(),
        },
      ],
    })
    handlePicoMessage(
      {
        type: "error",
        session_id: "send-test",
        payload: {
          request_id: "request-1",
          message: "Server rejected request",
        },
      },
      "send-test",
    )
    expect(getChatState().messages).toEqual([
      expect.objectContaining({
        id: "request-1",
        content: "Please check",
        attachments: [attachment],
        sendStatus: "failed",
        sendError: "Server rejected request",
      }),
      expect.objectContaining({ id: "history" }),
    ])
    expect(getChatState().isTyping).toBe(false)
  })

  it("does not alter unrelated messages for an unknown request ID", () => {
    updateChatStore({
      messages: [
        {
          id: "other",
          role: "user",
          content: "safe",
          timestamp: 1,
          sendStatus: "pending",
        },
      ],
    })
    handlePicoMessage(
      { type: "error", payload: { request_id: "missing" } },
      "send-test",
    )
    expect(getChatState().messages[0]?.sendStatus).toBe("pending")
  })
})
