import { describe, expect, it } from "vitest"

import { codexDeleteError, codexThreadOrigin } from "./thread-presentation"

describe("Codex thread presentation", () => {
  it("uses originator to distinguish PWA from other app-server clients", () => {
    expect(
      codexThreadOrigin({
        id: "1",
        source: "vscode",
        originator: "musec137_pwa_probe",
      }),
    ).toBe("pwa")
    expect(
      codexThreadOrigin({ id: "2", source: "cli", originator: "codex-tui" }),
    ).toBe("terminal")
    expect(codexThreadOrigin({ id: "3", source: "vscode" })).toBe("other")
    expect(codexThreadOrigin({ id: "4" })).toBe("other")
  })
  it("explains occupied threads and preserves unexpected errors", () => {
    expect(
      codexDeleteError(new Error("thread abc already has an active writer")),
    ).toContain("另一个 Codex 进程占用")
    expect(codexDeleteError(new Error("permission denied"))).toBe(
      "permission denied",
    )
    expect(
      codexDeleteError(new Error("no rollout found for thread id abc")),
    ).toContain("刷新列表")
  })
})
