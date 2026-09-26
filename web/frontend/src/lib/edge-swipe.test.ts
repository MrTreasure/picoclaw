import { afterEach, expect, it, vi } from "vitest"

import { edgeSwipeAction, returnToSessions } from "./edge-swipe"

afterEach(() => vi.unstubAllGlobals())

it("returns from chat pages to the session list before exiting", () => {
  expect(edgeSwipeAction("/")).toBe("sessions")
  expect(edgeSwipeAction("/sessions/weixin-123")).toBe("sessions")
  expect(edgeSwipeAction("/sessions")).toBe("exit")
})

it("uses the explicit session route even when chat has navigation history", () => {
  const removeItem = vi.fn()
  const back = vi.fn()
  const navigateToSessions = vi.fn()
  vi.stubGlobal("window", {
    sessionStorage: { removeItem },
    history: { back },
  })

  returnToSessions(navigateToSessions)

  expect(navigateToSessions).toHaveBeenCalledOnce()
  expect(back).not.toHaveBeenCalled()
  expect(removeItem).toHaveBeenCalledWith("picoclaw:chat-from-sessions")
})
