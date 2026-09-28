import { launcherFetch } from "@/api/http"

export interface SessionSummary {
  id: string
  channel: "pico" | "weixin"
  title: string
  preview: string
  message_count: number
  sub_agent?: boolean
  created: string
  updated: string
}

export interface SessionDetail {
  id: string
  channel?: "pico" | "weixin"
  messages: {
    role: "user" | "assistant"
    content: string
    created_at?: string
    kind?: "normal" | "thought" | "tool_calls"
    model_name?: string
    media?: string[]
    attachments?: {
      type?: "image" | "audio" | "video" | "file"
      url: string
      filename?: string
      content_type?: string
    }[]
    tool_calls?: {
      id?: string
      type?: string
      function?: {
        name?: string
        arguments?: string
      }
      extra_content?: {
        tool_feedback_explanation?: string
      }
    }[]
  }[]
  summary: string
  created: string
  updated: string
  message_offset?: number
  message_total?: number
  has_more?: boolean
  next_before?: number
}

export interface SessionHistoryPageOptions {
  before?: number
  limit?: number
}

export async function getSessions(
  offset: number = 0,
  limit: number = 20,
  channel?: "pico" | "weixin",
): Promise<SessionSummary[]> {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString(),
  })
  if (channel) params.set("channel", channel)

  const res = await launcherFetch(`/api/sessions?${params.toString()}`)
  if (!res.ok) {
    throw new Error(`Failed to fetch sessions: ${res.status}`)
  }
  return res.json()
}

/** The server owns title validation as well; keep this client limit aligned. */
export async function renameSession(id: string, title: string): Promise<void> {
  const res = await launcherFetch(
    `/api/sessions/${encodeURIComponent(id)}/title`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    },
  )
  if (!res.ok) throw new Error(`Failed to rename session ${id}: ${res.status}`)
}

export async function getSessionHistory(
  id: string,
  options: SessionHistoryPageOptions = {},
): Promise<SessionDetail> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit))
  }
  if (options.before !== undefined) {
    params.set("before", String(options.before))
  }
  const query = params.size > 0 ? `?${params.toString()}` : ""
  const res = await launcherFetch(
    `/api/sessions/${encodeURIComponent(id)}${query}`,
  )
  if (!res.ok) {
    throw new Error(`Failed to fetch session ${id}: ${res.status}`)
  }
  return res.json()
}

export interface SessionToolCallDetail {
  name: string
  arguments: string
  explanation: string
  result: string
  result_found: boolean
}

export async function getSessionToolCall(
  sessionId: string,
  callId: string,
): Promise<SessionToolCallDetail> {
  const res = await launcherFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/tool-calls/${encodeURIComponent(callId)}`,
  )
  if (!res.ok) {
    throw new Error(`Failed to fetch tool call: ${res.status}`)
  }
  return res.json()
}

export class SessionBusyError extends Error {
  constructor() {
    super("Session has an active task or pending messages")
    this.name = "SessionBusyError"
  }
}

async function sessionDeletionConfirmed(id: string): Promise<boolean> {
  try {
    const check = await launcherFetch(
      `/api/sessions/${encodeURIComponent(id)}?limit=1`,
      { signal: AbortSignal.timeout(5000) },
    )
    return check.status === 404
  } catch {
    return false
  }
}
export async function deleteSession(id: string): Promise<void> {
  let res: Response
  try {
    res = await launcherFetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  } catch {
    if (await sessionDeletionConfirmed(id)) return
    throw new Error("连接中断，暂时无法确认删除结果。可刷新列表核对后重试。")
  }
  if (res.status === 404) return
  if (res.status === 409) throw new SessionBusyError()
  if (!res.ok) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      if (await sessionDeletionConfirmed(id)) return
      throw new Error(
        `删除服务暂时不可用或响应超时（${res.status}），暂时无法确认结果，请刷新列表后重试。`,
      )
    }
    const raw = (await res.text()).trim()
    const detail = /<!doctype|<html/i.test(raw)
      ? "服务返回了错误页面"
      : raw.slice(0, 200)
    throw new Error(
      `删除会话失败（HTTP ${res.status}）${detail ? "：" + detail : ""}`,
    )
  }
}

export async function clearTaskRunSessions(): Promise<number> {
  const res = await launcherFetch("/api/sessions/task-runs", {
    method: "DELETE",
  })
  if (!res.ok)
    throw new Error(`Failed to clear task run sessions: ${res.status}`)
  const body = (await res.json()) as { deleted_files?: number }
  return body.deleted_files ?? 0
}
