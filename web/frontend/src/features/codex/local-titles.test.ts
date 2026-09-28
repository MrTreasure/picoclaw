import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  readLocalCodexTitle,
  removeLocalCodexTitle,
  saveLocalCodexTitle,
} from "./local-titles"

beforeEach(() => {
  const data = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  })
})
afterEach(() => vi.unstubAllGlobals())
describe("local Codex titles", () => {
  it("isolates identities and removes only the deleted thread title", () => {
    saveLocalCodexTitle("a", "thread", "Custom name")
    saveLocalCodexTitle("b", "thread", "Different name")
    expect(readLocalCodexTitle("a", "thread")).toBe("Custom name")
    expect(readLocalCodexTitle(null, "thread")).toBeNull()
    removeLocalCodexTitle("a", "thread")
    expect(readLocalCodexTitle("a", "thread")).toBeNull()
    expect(readLocalCodexTitle("b", "thread")).toBe("Different name")
  })
  it("reports storage failures", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("quota")
      },
    })
    expect(() => saveLocalCodexTitle("a", "thread", "Title")).toThrow("quota")
    expect(readLocalCodexTitle("a", "thread")).toBeNull()
  })
})
