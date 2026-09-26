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
