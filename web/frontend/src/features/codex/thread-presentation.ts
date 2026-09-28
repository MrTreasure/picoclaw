import type { CodexThread } from "@/api/codex"

export function codexThreadOrigin(
  thread: CodexThread,
): "pwa" | "terminal" | "other" {
  if (thread.originator?.startsWith("musec137_pwa")) return "pwa"
  if (thread.source === "cli" || thread.originator === "codex-tui")
    return "terminal"
  return "other"
}

export function codexDeleteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/active writer|writer lock/i.test(message)) {
    return "该对话仍被另一个 Codex 进程占用，请退出对应终端或会话后重试。"
  }
  if (/active turn|turn.*in progress/i.test(message)) {
    return "该对话仍在执行任务，请先停止任务再删除。"
  }
  if (/no rollout found|thread not found/i.test(message)) {
    return "服务端找不到该对话记录，请刷新列表后确认是否已删除。"
  }
  if (/forked history still references/i.test(message)) {
    return "该对话仍被分叉对话引用，请先处理相关分叉对话。"
  }
  return message.slice(0, 300) || "服务未返回具体原因"
}
