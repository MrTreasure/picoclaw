import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  readSessionDraft,
  writeSessionDraft,
} from "@/features/chat/session-draft"

const items = new Map<string, string>()
const storage = {
  getItem: vi.fn((key: string) => items.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    items.set(key, value)
  }),
  removeItem: vi.fn((key: string) => {
    items.delete(key)
  }),
}

beforeEach(() => {
  items.clear()
  vi.stubGlobal("sessionStorage", storage)
  vi.clearAllMocks()
})

describe("Pico text drafts", () => {
  it("keeps sessions separate and removes the sent draft", () => {
    writeSessionDraft("pico_one", "hello")
    writeSessionDraft("pico_two", "world")
    expect(readSessionDraft("pico_one")).toBe("hello")
    expect(readSessionDraft("pico_two")).toBe("world")
    writeSessionDraft("pico_one", "")
    expect(readSessionDraft("pico_one")).toBe("")
    expect(readSessionDraft("pico_two")).toBe("world")
    expect(storage.removeItem).toHaveBeenCalledWith(
      "picoclaw:pico:text-draft:pico_one",
    )
  })

  it("never writes a draft with no session", () => {
    writeSessionDraft("", "hello")
    expect(readSessionDraft("")).toBe("")
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it("tolerates denied reads and writes", () => {
    storage.getItem.mockImplementationOnce(() => {
      throw new Error("denied")
    })
    storage.setItem.mockImplementationOnce(() => {
      throw new Error("quota")
    })
    storage.removeItem.mockImplementationOnce(() => {
      throw new Error("denied")
    })
    expect(readSessionDraft("pico_one")).toBe("")
    expect(() => writeSessionDraft("pico_one", "text")).not.toThrow()
    expect(() => writeSessionDraft("pico_one", "")).not.toThrow()
  })
})
