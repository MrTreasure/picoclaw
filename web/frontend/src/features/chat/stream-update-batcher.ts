import type { PicoMessage } from "@/features/chat/protocol"

// Only consecutive, plain-text snapshots for the same message may be merged.
// Metadata-bearing updates and all other events preserve their wire order.
export function createStreamUpdateBatcher(
  deliver: (message: PicoMessage, sessionId: string) => void,
  delay = 64,
) {
  let pending:
    | { message: PicoMessage; sessionId: string; id: string }
    | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const current = pending
    pending = undefined
    if (current) deliver(current.message, current.sessionId)
  }

  function receive(message: PicoMessage, sessionId: string) {
    const payload = message.payload
    const id = payload?.message_id
    const plainText =
      message.type === "message.update" &&
      payload?.final === false &&
      typeof id === "string" &&
      id.length > 0 &&
      typeof payload.content === "string" &&
      Object.keys(payload).every(
        (key) =>
          key === "message_id" ||
          key === "content" ||
          key === "final" ||
          (key === "kind" && payload.kind === "normal"),
      )

    if (!plainText) {
      flush()
      deliver(message, sessionId)
      return
    }
    if (pending && (pending.sessionId !== sessionId || pending.id !== id))
      flush()
    pending = { message, sessionId, id }
    if (timer === undefined) timer = setTimeout(flush, delay)
  }

  function discard() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pending = undefined
  }

  return { receive, flush, discard }
}
