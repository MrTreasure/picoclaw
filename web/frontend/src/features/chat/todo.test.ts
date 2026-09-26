import { beforeEach, describe, expect, it } from "vitest"

import { handlePicoMessage } from "@/features/chat/protocol"
import { getChatState, updateChatStore } from "@/store/chat"

const sessionId = "todo-test"
const send = (id: string, items: unknown, revision = 1) =>
  handlePicoMessage(
    {
      type: "todo.updated",
      session_id: id,
      payload: { items, revision },
    },
    sessionId,
  )

describe("session TODO events", () => {
  beforeEach(() =>
    updateChatStore({ activeSessionId: sessionId, todoList: undefined }),
  )

  it("accepts structured state only for the active session", () => {
    const items = [
      { content: "Verify API", short: "API", status: "in_progress" },
    ]
    send("other-session", items)
    expect(getChatState().todoList).toBeUndefined()
    send(sessionId, items)
    expect(getChatState().todoList).toEqual({ sessionId, revision: 1, items })
  })

  it("rejects malformed updates without overwriting the last good state", () => {
    send(sessionId, [{ content: "Do work", short: "work", status: "pending" }])
    send(sessionId, [{ content: "Oops", short: "oops", status: "complete" }])
    expect(getChatState().todoList?.items).toHaveLength(1)
    expect(getChatState().todoList?.items[0].content).toBe("Do work")
  })

  it("clears the list when server sends an empty snapshot", () => {
    send(sessionId, [
      { content: "Do work", short: "work", status: "completed" },
    ])
    send(sessionId, [], 2)
    expect(getChatState().todoList?.items).toEqual([])
  })

  it("rejects missing or empty task shorthand", () => {
    send(sessionId, [{ content: "Full task", status: "pending" }])
    expect(getChatState().todoList).toBeUndefined()
    send(sessionId, [{ content: "Full task", short: "", status: "pending" }])
    expect(getChatState().todoList).toBeUndefined()
  })

  it("ignores older revisions", () => {
    send(
      sessionId,
      [{ content: "Latest", short: "latest", status: "in_progress" }],
      3,
    )
    send(
      sessionId,
      [{ content: "Stale", short: "stale", status: "pending" }],
      2,
    )
    expect(getChatState().todoList?.items[0].content).toBe("Latest")
  })
})
