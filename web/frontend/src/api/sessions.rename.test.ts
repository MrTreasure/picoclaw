import { afterEach, describe, expect, it, vi } from "vitest"

import { SessionBusyError, deleteSession, renameSession } from "./sessions"

afterEach(() => vi.unstubAllGlobals())

describe("renameSession", () => {
  it("PATCHes the encoded session ID with only the new title", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetch)
    await renameSession("pico:foo/bar", "New title")
    expect(fetch).toHaveBeenCalledWith("/api/sessions/pico%3Afoo%2Fbar/title", {
      credentials: "same-origin",
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    })
  })

  it("rejects a failed response without changing local state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    )
    await expect(renameSession("id", "Title")).rejects.toThrow("500")
  })
})

describe("deleteSession", () => {
  it("identifies a busy conversation without treating it as deleted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 409 }),
    )
    await expect(deleteSession("busy")).rejects.toBeInstanceOf(SessionBusyError)
  })

  it("preserves non-conflict failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: false,
          status: 503,
          text: async () => "gateway unavailable",
        }),
    )
    await expect(deleteSession("offline")).rejects.toThrow("503")
  })
})
