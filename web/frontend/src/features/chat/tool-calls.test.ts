import { describe, expect, it } from "vitest"

import { sanitizeToolFeedbackExplanation } from "@/features/chat/tool-calls"

describe("tool feedback explanation", () => {
  it("removes internal runtime, session, and sender context", () => {
    const explanation = `Continuing the current task.: ## Current Time
2026-09-22 19:07 (Tuesday)

## Runtime
linux amd64, Go go1.26.5

## Current Session
Channel: pico
Chat ID: pico:test

## Current Sender
Current sender: pico-user

---

检查服务状态`

    expect(sanitizeToolFeedbackExplanation(explanation)).toBe(
      "Continuing the current task.: 检查服务状态",
    )
  })

  it("leaves ordinary explanations unchanged", () => {
    expect(sanitizeToolFeedbackExplanation("读取配置文件")).toBe("读取配置文件")
  })
})
