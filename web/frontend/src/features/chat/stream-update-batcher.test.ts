import { afterEach, describe, expect, it, vi } from "vitest"

import type { PicoMessage } from "@/features/chat/protocol"
import { createStreamUpdateBatcher } from "@/features/chat/stream-update-batcher"

const update = (content: string, final = false): PicoMessage => ({
  type: "message.update",
  payload: { message_id: "reply", content, final },
})

describe("stream update batching", () => {
  afterEach(() => vi.useRealTimers())

  it("coalesces partial snapshots but delivers the final update in order", () => {
    vi.useFakeTimers()
    const delivered: PicoMessage[] = []
    const batch = createStreamUpdateBatcher((message) =>
      delivered.push(message),
    )
    batch.receive(update("one"), "s")
    batch.receive(update("two"), "s")
    expect(delivered).toHaveLength(0)
    vi.advanceTimersByTime(64)
    expect(delivered).toEqual([update("two")])
    batch.receive(update("three"), "s")
    batch.receive(update("done", true), "s")
    expect(delivered).toEqual([
      update("two"),
      update("three"),
      update("done", true),
    ])
    vi.runAllTimers()
    expect(delivered).toHaveLength(3)
  })

  it("flushes when message identity or session changes, preserving wire order", () => {
    vi.useFakeTimers()
    const delivered: string[] = []
    const batch = createStreamUpdateBatcher((message, session) => {
      delivered.push(`${session}:${message.payload?.content ?? message.type}`)
    })
    batch.receive(update("first"), "a")
    batch.receive(
      {
        type: "message.update",
        payload: { message_id: "other", content: "second", final: false },
      },
      "a",
    )
    batch.receive(update("third"), "b")
    batch.receive(
      { type: "confirmation.request", payload: { prompt: "Approve?" } },
      "b",
    )
    expect(delivered).toEqual([
      "a:first",
      "a:second",
      "b:third",
      "b:confirmation.request",
    ])
  })

  it("never coalesces metadata-bearing or detail updates", () => {
    vi.useFakeTimers()
    const delivered: PicoMessage[] = []
    const batch = createStreamUpdateBatcher((message) =>
      delivered.push(message),
    )
    const usage: PicoMessage = {
      type: "message.update",
      payload: {
        message_id: "reply",
        content: "first",
        final: false,
        context_usage: { used_tokens: 100 },
      },
    }
    const thought: PicoMessage = {
      type: "message.update",
      payload: {
        message_id: "reply",
        content: "thinking",
        final: false,
        kind: "thought",
      },
    }
    batch.receive(usage, "s")
    batch.receive(thought, "s")
    batch.receive(update("plain"), "s")
    batch.receive(usage, "s")
    expect(delivered).toEqual([usage, thought, update("plain"), usage])
  })

  it("discards unsent updates on disconnect or session switch", () => {
    vi.useFakeTimers()
    const delivered = vi.fn()
    const batch = createStreamUpdateBatcher(delivered)
    batch.receive(update("old"), "a")
    batch.discard()
    vi.runAllTimers()
    expect(delivered).not.toHaveBeenCalled()
    batch.receive(update("new"), "b")
    vi.advanceTimersByTime(64)
    expect(delivered).toHaveBeenCalledWith(update("new"), "b")
  })
})
