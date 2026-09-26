import {
  IconArrowLeft,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconSend,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import {
  type CodexItem,
  CodexRpcClient,
  type CodexRpcMessage,
  type CodexThread,
  type CodexWorkspace,
  getCodexWorkspaces,
} from "@/api/codex"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

interface CodexPageProps {
  threadId?: string
}

interface Approval {
  id: number | string
  method: string
  params: Record<string, unknown>
}

interface CodexQuestion {
  id: string
  header: string
  question: string
  isSecret?: boolean
  options?: Array<{ label: string; description: string }> | null
}

function itemText(item: CodexItem): string {
  if (item.type === "userMessage")
    return item.content?.map((part) => part.text ?? "").join("\n") ?? ""
  return item.text ?? item.command ?? ""
}

function flattenThread(thread: CodexThread): CodexItem[] {
  return (thread.turns ?? []).flatMap((turn) => turn.items ?? [])
}

function displayItem(item: CodexItem): boolean {
  return [
    "userMessage",
    "agentMessage",
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "reasoning",
    "plan",
  ].includes(item.type)
}

function grantedPermissions(requested: unknown): Record<string, unknown> {
  if (!requested || typeof requested !== "object") return {}
  return Object.fromEntries(
    Object.entries(requested).filter(([, value]) => value != null),
  )
}

export function CodexPage({ threadId }: CodexPageProps) {
  return <CodexConversationPage threadId={threadId} />
}

function CodexConversationPage({ threadId }: { threadId?: string }) {
  const navigate = useNavigate()
  const rpcRef = useRef<CodexRpcClient | null>(null)
  const listBottomRef = useRef<HTMLDivElement>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState("")
  const [threads, setThreads] = useState<CodexThread[]>([])
  const [workspaces, setWorkspaces] = useState<CodexWorkspace[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [pendingThread, setPendingThread] = useState<{
    id: string
    workspace: string
  } | null>(null)
  const [workspace, setWorkspace] = useState("")
  const [draft, setDraft] = useState("")
  const [items, setItems] = useState<CodexItem[]>([])
  const [running, setRunning] = useState(false)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [title, setTitle] = useState("")

  const loadLists = useCallback(async (rpc?: CodexRpcClient) => {
    const client = rpc ?? rpcRef.current
    if (!client) return
    try {
      const [threadResult, workspaceResult] = await Promise.all([
        client.request<{ data: CodexThread[] }>("thread/list", {
          limit: 50,
          sortKey: "recency_at",
          // Codex app-server reports newly created PWA threads as source "vscode"
          // in current releases; restricting to "appServer" hides them entirely.
        }),
        getCodexWorkspaces(),
      ])
      setThreads(
        (threadResult.data ?? []).filter(
          (thread) => thread.historyMode === "legacy",
        ),
      )
      setWorkspaces(workspaceResult)
      setWorkspace((current) => current || workspaceResult[0]?.path || "")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载 Codex 会话失败")
    }
  }, [])

  useEffect(() => {
    const rpc = new CodexRpcClient()
    rpcRef.current = rpc
    let cancelled = false
    rpc.onClose = () => {
      if (!cancelled) setConnected(false)
    }
    rpc.onEvent = (message: CodexRpcMessage) => {
      const params = message.params ?? {}
      if (
        (message.method?.includes("/requestApproval") ||
          message.method === "item/tool/requestUserInput") &&
        message.id !== undefined &&
        params.threadId === threadId
      ) {
        setApproval({ id: message.id, method: message.method, params })
        setAnswers({})
        return
      }
      if (message.method === "serverRequest/resolved") {
        setApproval((current) =>
          current && current.id === params.requestId ? null : current,
        )
      }
      if (
        message.method === "item/started" ||
        message.method === "item/completed"
      ) {
        if (params.threadId !== threadId) return
        const item = params.item as CodexItem | undefined
        if (!item) return
        setItems((current) => {
          const index = current.findIndex((existing) => existing.id === item.id)
          if (index < 0) return [...current, item]
          return current.map((existing, at) => (at === index ? item : existing))
        })
      }
      if (
        message.method === "item/agentMessage/delta" ||
        message.method === "item/commandExecution/outputDelta"
      ) {
        if (params.threadId !== threadId) return
        const itemId = params.itemId as string | undefined
        const delta = params.delta as string | undefined
        if (!itemId || !delta) return
        setItems((current) => {
          const index = current.findIndex((existing) => existing.id === itemId)
          const type =
            message.method === "item/agentMessage/delta"
              ? "agentMessage"
              : "commandExecution"
          if (index < 0)
            return [
              ...current,
              {
                id: itemId,
                type,
                text: type === "agentMessage" ? delta : undefined,
                aggregatedOutput:
                  type === "commandExecution" ? delta : undefined,
              },
            ]
          return current.map((existing, at) =>
            at === index
              ? {
                  ...existing,
                  ...(type === "agentMessage"
                    ? { text: (existing.text ?? "") + delta }
                    : {
                        aggregatedOutput:
                          (existing.aggregatedOutput ?? "") + delta,
                      }),
                }
              : existing,
          )
        })
      }
      if (message.method === "turn/started" && params.threadId === threadId)
        setRunning(true)
      if (message.method === "turn/completed" && params.threadId === threadId)
        setRunning(false)
      if (message.method === "error" && params.threadId === threadId) {
        const detail = params.error as { message?: string } | undefined
        setError(detail?.message ?? "Codex 运行失败")
      }
    }
    void rpc
      .connect()
      .then(async () => {
        if (cancelled) return
        setConnected(true)
        if (!threadId) await loadLists(rpc)
        if (threadId) {
          try {
            const result = await rpc.request<{ thread: CodexThread }>(
              "thread/read",
              { threadId, includeTurns: true },
            )
            if (cancelled) return
            if (result.thread.historyMode !== "legacy") {
              await navigate({ to: "/codex", search: {} })
              return
            }
            setItems(flattenThread(result.thread))
            setTitle(result.thread.name || result.thread.preview || "Codex")
            setWorkspace(result.thread.cwd || "")
            setRunning(result.thread.status?.type === "active")
            await rpc.request("thread/resume", { threadId })
          } catch (cause) {
            if (!cancelled)
              setError(cause instanceof Error ? cause.message : "会话恢复失败")
          }
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Codex 连接失败")
      })
    return () => {
      cancelled = true
      rpc.close()
      rpcRef.current = null
    }
  }, [loadLists, navigate, threadId])

  useLayoutEffect(
    () => listBottomRef.current?.scrollIntoView({ block: "end" }),
    [items, running, approval],
  )

  const createThread = async () => {
    const rpc = rpcRef.current
    const firstPrompt = draft.trim()
    if (!rpc || !workspace || !firstPrompt || creating) return
    setCreating(true)
    setError("")
    try {
      // If turn/start failed earlier, retry on that thread instead of creating
      // another empty one. A workspace change intentionally starts a new thread.
      let target = pendingThread?.workspace === workspace ? pendingThread : null
      if (!target) {
        const result = await rpc.request<{ thread: CodexThread }>(
          "thread/start",
          {
            cwd: workspace,
            sandbox: "workspace-write",
            approvalPolicy: "on-request",
            historyMode: "legacy",
          },
        )
        target = { id: result.thread.id, workspace }
        setPendingThread(target)
      }
      await rpc.request("turn/start", {
        threadId: target.id,
        cwd: target.workspace,
        input: [{ type: "text", text: firstPrompt }],
      })
      // Keep the draft until turn/start succeeds; a failed send is recoverable.
      setDraft("")
      setPendingThread(null)
      setShowCreate(false)
      await navigate({ to: "/codex", search: { thread: target.id } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建会话失败")
    } finally {
      setCreating(false)
    }
  }

  const sendPrompt = async () => {
    const rpc = rpcRef.current
    if (!rpc || !threadId || !workspace || !draft.trim() || running) return
    const text = draft.trim()
    setDraft("")
    setError("")
    try {
      await rpc.request("turn/start", {
        threadId,
        cwd: workspace,
        input: [{ type: "text", text }],
      })
    } catch (cause) {
      setDraft(text)
      setError(cause instanceof Error ? cause.message : "发送失败")
    }
  }

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <header className="border-border/70 flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-end border-b px-2 pb-1">
        <div className="flex h-14 w-full items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-12 rounded-full"
            onClick={() => void navigate({ to: "/sessions" })}
            aria-label="返回会话列表"
          >
            <IconArrowLeft className="size-6" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">
              {threadId ? title || "Codex" : "Codex 会话"}
            </h1>
            <p className="text-muted-foreground truncate text-xs">
              {threadId ? workspace : connected ? "已连接 NAS" : "连接中"}
            </p>
          </div>
          {threadId && running && (
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label="停止 Codex"
              onClick={() =>
                void rpcRef.current?.request("turn/interrupt", { threadId })
              }
            >
              <IconPlayerStop className="size-5" />
            </Button>
          )}
          {!threadId && (
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label="刷新"
              onClick={() => void loadLists()}
            >
              <IconRefresh className="size-5" />
            </Button>
          )}
        </div>
      </header>
      {error && (
        <div
          role="alert"
          className="bg-destructive/10 text-destructive px-4 py-2 text-sm"
        >
          {error}
        </div>
      )}
      {!threadId ? (
        <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 pb-24">
          <div className="mx-auto max-w-3xl space-y-5">
            {!showCreate ? (
              <Button
                className="min-h-12 w-full rounded-2xl"
                onClick={() => setShowCreate(true)}
              >
                <IconPlus className="size-5" /> 新建 Codex 会话
              </Button>
            ) : (
              <section className="bg-card border-border rounded-2xl border p-4">
                <h2 className="mb-3 font-semibold">新建 Codex 会话</h2>
                <label className="mb-3 block text-sm">
                  工作区
                  <select
                    className="bg-background border-border mt-2 min-h-12 w-full rounded-xl border px-3"
                    value={workspace}
                    onChange={(event) => setWorkspace(event.target.value)}
                    disabled={creating}
                  >
                    {workspaces.map((entry) => (
                      <option key={entry.path} value={entry.path}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  第一条消息
                  <Textarea
                    className="mt-2 min-h-28 text-base"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="告诉 Codex 要处理什么…"
                  />
                </label>
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={creating}
                    onClick={() => setShowCreate(false)}
                  >
                    取消
                  </Button>
                  <Button
                    disabled={
                      creating || !connected || !workspace || !draft.trim()
                    }
                    onClick={() => void createThread()}
                  >
                    {creating ? "创建并发送中…" : "创建并发送"}
                  </Button>
                </div>
              </section>
            )}
            <section>
              <h2 className="mb-2 px-1 text-sm font-semibold">
                最近的 Codex 对话
              </h2>
              <div className="bg-card border-border overflow-hidden rounded-2xl border">
                {threads.map((thread) => (
                  <button
                    key={thread.id}
                    className="border-border/60 block min-h-18 w-full border-b px-4 py-3 text-left last:border-b-0"
                    onClick={() =>
                      void navigate({
                        to: "/codex",
                        search: { thread: thread.id },
                      })
                    }
                  >
                    <strong className="block truncate">
                      {thread.name || thread.preview || "Codex 对话"}
                    </strong>
                    <small className="text-muted-foreground mt-1 block truncate">
                      {thread.cwd || "工作区未知"}
                    </small>
                  </button>
                ))}
                {threads.length === 0 && (
                  <p className="text-muted-foreground px-4 py-5 text-sm">
                    还没有 Codex 对话
                  </p>
                )}
              </div>
            </section>
          </div>
        </main>
      ) : (
        <>
          <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
            <div className="mx-auto max-w-3xl space-y-4">
              {items.filter(displayItem).map((item) => (
                <CodexItemView key={item.id} item={item} />
              ))}
              {running && (
                <div className="text-muted-foreground px-2 text-sm">
                  Codex 正在处理…
                </div>
              )}
              {approval && (
                <div className="bg-card rounded-2xl border border-amber-500/50 p-4">
                  {approval.method === "item/tool/requestUserInput" ? (
                    <>
                      <h2 className="font-semibold">Codex 需要你的回答</h2>
                      {(
                        (approval.params.questions as CodexQuestion[]) ?? []
                      ).map((question) => (
                        <label key={question.id} className="mt-3 block text-sm">
                          <span className="font-medium">{question.header}</span>
                          <span className="mt-1 block">
                            {question.question}
                          </span>
                          {question.options?.length ? (
                            <select
                              className="bg-background border-border mt-2 min-h-11 w-full rounded-xl border px-3"
                              value={answers[question.id] ?? ""}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  [question.id]: event.target.value,
                                }))
                              }
                            >
                              <option value="">请选择</option>
                              {question.options.map((option) => (
                                <option key={option.label} value={option.label}>
                                  {option.label} — {option.description}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={question.isSecret ? "password" : "text"}
                              className="bg-background border-border mt-2 min-h-11 w-full rounded-xl border px-3"
                              value={answers[question.id] ?? ""}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  [question.id]: event.target.value,
                                }))
                              }
                            />
                          )}
                        </label>
                      ))}
                      <Button
                        className="mt-3 min-h-11"
                        onClick={() => {
                          const questions =
                            (approval.params.questions as CodexQuestion[]) ?? []
                          rpcRef.current?.respond(approval.id, {
                            answers: Object.fromEntries(
                              questions.map((question) => [
                                question.id,
                                { answers: [answers[question.id] ?? ""] },
                              ]),
                            ),
                          })
                          setApproval(null)
                        }}
                      >
                        提交回答
                      </Button>
                    </>
                  ) : (
                    <>
                      <h2 className="font-semibold">需要你确认</h2>
                      <p className="text-muted-foreground mt-1 text-sm">
                        {String(approval.params.reason || approval.method)}
                      </p>
                      <pre className="bg-background mt-2 max-h-36 overflow-auto rounded-xl p-3 text-xs whitespace-pre-wrap">
                        {String(
                          approval.params.command ||
                            JSON.stringify(
                              approval.params.permissions ?? approval.params,
                              null,
                              2,
                            ),
                        )}
                      </pre>
                      <div className="mt-3 flex gap-2">
                        <Button
                          variant="outline"
                          className="min-h-11"
                          onClick={() => {
                            rpcRef.current?.respond(
                              approval.id,
                              approval.method ===
                                "item/permissions/requestApproval"
                                ? { permissions: {}, scope: "turn" }
                                : { decision: "decline" },
                            )
                            setApproval(null)
                          }}
                        >
                          拒绝
                        </Button>
                        <Button
                          className="min-h-11"
                          onClick={() => {
                            rpcRef.current?.respond(
                              approval.id,
                              approval.method ===
                                "item/permissions/requestApproval"
                                ? {
                                    permissions: grantedPermissions(
                                      approval.params.permissions,
                                    ),
                                    scope: "turn",
                                  }
                                : { decision: "accept" },
                            )
                            setApproval(null)
                          }}
                        >
                          允许本次
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
              <div ref={listBottomRef} />
            </div>
          </main>
          <div className="bg-background border-border shrink-0 border-t px-3 pt-3 pb-[calc(.75rem+env(safe-area-inset-bottom))]">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <Textarea
                className="min-h-12 flex-1 resize-none text-base"
                rows={1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="继续和 Codex 对话…"
              />
              <Button
                size="icon"
                className="size-12 shrink-0 rounded-full"
                disabled={!connected || running || !draft.trim()}
                onClick={() => void sendPrompt()}
                aria-label="发送"
              >
                <IconSend className="size-5" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function CodexItemView({ item }: { item: CodexItem }) {
  if (item.type === "userMessage")
    return (
      <div className="bg-secondary text-secondary-foreground ml-auto max-w-[90%] rounded-2xl px-4 py-3 whitespace-pre-wrap">
        {itemText(item)}
      </div>
    )
  if (item.type === "agentMessage")
    return (
      <div className="bg-card border-border prose dark:prose-invert max-w-none rounded-2xl border px-4 py-3 text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {item.text || ""}
        </ReactMarkdown>
      </div>
    )
  const label =
    item.type === "commandExecution"
      ? "执行命令"
      : item.type === "fileChange"
        ? "修改文件"
        : item.type === "reasoning"
          ? "思考"
          : item.type === "plan"
            ? "计划"
            : "工具调用"
  const detail =
    item.command ||
    item.aggregatedOutput ||
    item.text ||
    (item.changes ? JSON.stringify(item.changes, null, 2) : "")
  return (
    <details className="bg-card border-border rounded-2xl border px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">
        {label}
        {item.status ? ` · ${item.status}` : ""}
      </summary>
      <pre className="text-muted-foreground mt-3 max-h-64 overflow-auto text-xs whitespace-pre-wrap">
        {detail}
      </pre>
    </details>
  )
}
