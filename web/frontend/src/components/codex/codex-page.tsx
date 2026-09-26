import {
  IconArrowDown,
  IconArrowLeft,
  IconPhoto,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconSend,
  IconX,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import {
  type CodexImage,
  type CodexItem,
  type CodexModel,
  CodexRpcClient,
  type CodexRpcMessage,
  type CodexThread,
  type CodexWorkspace,
  getCodexWorkspaces,
  uploadCodexImage,
} from "@/api/codex"
import { getLauncherAuthStatus } from "@/api/launcher-auth"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  readCodexHistoryCache,
  writeCodexHistoryCache,
} from "@/features/codex/history-cache"
import { validCacheScope } from "@/hooks/session-list-cache"

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

function imagePreview(path?: string): string | null {
  const name = path?.split("/").pop()
  return name && /^[0-9a-f]{32}\.(jpg|png|gif|webp)$/.test(name)
    ? `/api/codex/images/${name}`
    : null
}

const effortLabels: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "超高",
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
  const cacheScopeRef = useRef<string | null>(null)
  const liveHydratedThreadRef = useRef<string | null>(null)
  const listRef = useRef<HTMLElement>(null)
  const followRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const scrollThreadRef = useRef(threadId)
  const positionedThreadRef = useRef<string | undefined>(undefined)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const activeTurnRef = useRef<string | null>(null)
  const completedTurnRef = useRef<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null)
  const [historyFromCache, setHistoryFromCache] = useState(false)
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
  const [draftImages, setDraftImages] = useState<
    Array<CodexImage & { name: string }>
  >([])
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [models, setModels] = useState<CodexModel[]>([])
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState("")
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
    let cancelled = false
    cacheScopeRef.current = null
    liveHydratedThreadRef.current = null
    if (!threadId) return
    void getLauncherAuthStatus()
      .then(async (status) => {
        if (
          cancelled ||
          !status.authenticated ||
          !validCacheScope(status.cache_scope)
        )
          return
        const scope = status.cache_scope
        cacheScopeRef.current = scope
        const cached = await readCodexHistoryCache(scope, threadId)
        if (
          cancelled ||
          cacheScopeRef.current !== scope ||
          !cached ||
          liveHydratedThreadRef.current === threadId
        )
          return
        // Network remains authoritative. Cached history is a read-only fallback;
        // it never resumes a turn or replays an approval/send.
        setItems(flattenThread(cached))
        setHistoryFromCache(true)
        setLoadedThreadId(threadId)
        setTitle(cached.name || cached.preview || "Codex")
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [threadId])

  useEffect(() => {
    const rpc = new CodexRpcClient()
    rpcRef.current = rpc
    let cancelled = false
    // Keep item events in arrival order; a completed item must replace all
    // preceding deltas, not be overwritten by a later frame callback.
    let pendingItems: Array<(items: CodexItem[]) => CodexItem[]> = []
    let frame: number | null = null
    const flushItems = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      if (!pendingItems.length) return
      const updates = pendingItems
      pendingItems = []
      setItems((current) =>
        updates.reduce((items, update) => update(items), current),
      )
    }
    const queueItem = (update: (items: CodexItem[]) => CodexItem[]) => {
      pendingItems.push(update)
      if (frame === null) frame = requestAnimationFrame(flushItems)
    }
    rpc.onClose = () => {
      flushItems()
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
        if (!item) {
          if (message.method === "item/completed") flushItems()
          return
        }
        queueItem((current) => {
          const index = current.findIndex((existing) => existing.id === item.id)
          if (index < 0) return [...current, item]
          return current.map((existing, at) => (at === index ? item : existing))
        })
        if (message.method === "item/completed") flushItems()
      }
      if (
        message.method === "item/agentMessage/delta" ||
        message.method === "item/commandExecution/outputDelta"
      ) {
        if (params.threadId !== threadId) return
        const itemId = params.itemId as string | undefined
        const delta = params.delta as string | undefined
        if (!itemId || !delta) return
        queueItem((current) => {
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
      if (message.method === "turn/started" && params.threadId === threadId) {
        activeTurnRef.current =
          (params.turn as { id?: string } | undefined)?.id ?? null
        setRunning(true)
      }
      if (message.method === "turn/completed" && params.threadId === threadId) {
        flushItems()
        completedTurnRef.current =
          (params.turn as { id?: string } | undefined)?.id ?? null
        activeTurnRef.current = null
        setRunning(false)
        const scope = cacheScopeRef.current
        if (scope && threadId) {
          // Store a fresh, server-confirmed turn after completion; never cache
          // partial deltas as an authoritative transcript.
          void rpc
            .request<{ thread: CodexThread }>("thread/read", {
              threadId,
              includeTurns: true,
            })
            .then((result) => {
              if (!cancelled && result.thread?.historyMode === "legacy")
                void writeCodexHistoryCache(scope, threadId, result.thread)
            })
            .catch(() => {})
        }
      }
      if (message.method === "error" && params.threadId === threadId) {
        flushItems()
        const detail = params.error as { message?: string } | undefined
        setError(detail?.message ?? "Codex 运行失败")
      }
    }
    void rpc
      .connect()
      .then(async () => {
        if (cancelled) return
        setConnected(true)
        try {
          const result = await rpc.request<{ data: CodexModel[] }>(
            "model/list",
            { limit: 100 },
          )
          if (!cancelled) {
            setModels(result.data ?? [])
            const preferred =
              result.data?.find((entry) => entry.isDefault) ?? result.data?.[0]
            setModel((current) => current || preferred?.model || "")
            setEffort(
              (current) => current || preferred?.defaultReasoningEffort || "",
            )
          }
        } catch (cause) {
          if (!cancelled)
            setError(
              cause instanceof Error ? cause.message : "加载 Codex 模型失败",
            )
        }
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
            flushItems()
            liveHydratedThreadRef.current = threadId
            setItems(flattenThread(result.thread))
            setHistoryFromCache(false)
            setLoadedThreadId(threadId)
            const scope = cacheScopeRef.current
            if (scope)
              void writeCodexHistoryCache(scope, threadId, result.thread)
            else
              void getLauncherAuthStatus()
                .then((status) => {
                  if (
                    !cancelled &&
                    status.authenticated &&
                    validCacheScope(status.cache_scope)
                  ) {
                    cacheScopeRef.current = status.cache_scope
                    void writeCodexHistoryCache(
                      status.cache_scope,
                      threadId,
                      result.thread,
                    )
                  }
                })
                .catch(() => {})
            setTitle(result.thread.name || result.thread.preview || "Codex")
            setWorkspace(result.thread.cwd || "")
            setRunning(result.thread.status?.type === "active")
            activeTurnRef.current =
              result.thread.status?.type === "active"
                ? (result.thread.turns?.at(-1)?.id ?? null)
                : null
            if (result.thread.model) setModel(result.thread.model)
            if (result.thread.reasoningEffort)
              setEffort(result.thread.reasoningEffort)
            const resumed = await rpc.request<{ thread: CodexThread }>(
              "thread/resume",
              { threadId },
            )
            if (cancelled) return
            if (
              resumed.thread?.status?.type &&
              resumed.thread.status.type !== "active"
            ) {
              activeTurnRef.current = null
              setRunning(false)
            }
            if (resumed.thread?.model) setModel(resumed.thread.model)
            if (resumed.thread?.reasoningEffort)
              setEffort(resumed.thread.reasoningEffort)
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
      // The next mount restores durable thread state; never schedule a state
      // update on a conversation that has already unmounted.
      if (frame !== null) cancelAnimationFrame(frame)
      pendingItems = []
      rpc.close()
      activeTurnRef.current = null
      completedTurnRef.current = null
      rpcRef.current = null
    }
  }, [loadLists, navigate, threadId])

  const threadReady = !!threadId && loadedThreadId === threadId

  useLayoutEffect(() => {
    if (scrollThreadRef.current !== threadId) {
      scrollThreadRef.current = threadId
      followRef.current = true
      positionedThreadRef.current = undefined
      lastScrollTopRef.current = 0
      setShowJump(false)
      setApproval(null)
    }
    const list = listRef.current
    if (!list || !threadReady) return
    if (positionedThreadRef.current !== threadId) {
      // Initial positioning happens before paint, even for long histories.
      positionedThreadRef.current = threadId
      followRef.current = true
      list.scrollTop = list.scrollHeight
      lastScrollTopRef.current = list.scrollTop
      setShowJump(false)
    } else if (followRef.current) {
      list.scrollTop = list.scrollHeight
      lastScrollTopRef.current = list.scrollTop
    }
  }, [threadId, threadReady, items, running, approval])

  const onListScroll = () => {
    const list = listRef.current
    if (!list || !threadReady || positionedThreadRef.current !== threadId)
      return
    const nearBottom =
      list.scrollHeight - list.clientHeight - list.scrollTop <= 96
    // Content growth can increase distance from bottom without a user scroll.
    // Only scrolling upward (including scrollbar drags) suspends auto-follow.
    if (nearBottom) followRef.current = true
    else if (list.scrollTop < lastScrollTopRef.current - 1)
      followRef.current = false
    lastScrollTopRef.current = list.scrollTop
    setShowJump(!followRef.current)
  }

  const jumpToLatest = () => {
    const list = listRef.current
    if (!list || !threadReady) return
    followRef.current = true
    list.scrollTop = list.scrollHeight
    lastScrollTopRef.current = list.scrollTop
    setShowJump(false)
  }

  const createThread = async () => {
    const rpc = rpcRef.current
    const firstPrompt = draft.trim()
    if (
      !rpc ||
      !workspace ||
      (!firstPrompt && !draftImages.length) ||
      creating ||
      uploading ||
      !model ||
      !effort
    )
      return
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
            model,
          },
        )
        target = { id: result.thread.id, workspace }
        setPendingThread(target)
      }
      await rpc.request("turn/start", {
        threadId: target.id,
        cwd: target.workspace,
        model,
        effort,
        input: [
          ...(firstPrompt ? [{ type: "text", text: firstPrompt }] : []),
          ...draftImages.map((image) => ({
            type: "localImage",
            path: image.path,
          })),
        ],
      })
      // Keep the draft until turn/start succeeds; a failed send is recoverable.
      setDraft("")
      setDraftImages([])
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
    if (
      !rpc ||
      !threadId ||
      !workspace ||
      (!draft.trim() && !draftImages.length) ||
      sending ||
      uploading ||
      !model ||
      !effort
    )
      return
    const originalDraft = draft
    const text = draft.trim()
    const images = draftImages
    const input = [
      ...(text ? [{ type: "text", text }] : []),
      ...images.map((image) => ({ type: "localImage", path: image.path })),
    ]
    setSending(true)
    setError("")
    try {
      if (running) {
        if (!activeTurnRef.current)
          throw new Error("正在同步当前回合，请稍后重试")
        await rpc.request("turn/steer", {
          threadId,
          expectedTurnId: activeTurnRef.current,
          input,
        })
      } else {
        const result = await rpc.request<{ turn: { id: string } }>(
          "turn/start",
          {
            threadId,
            cwd: workspace,
            model,
            effort,
            input,
          },
        )
        if (completedTurnRef.current !== result.turn.id) {
          activeTurnRef.current = result.turn.id
          setRunning(true)
        }
      }
      setDraft((current) => (current === originalDraft ? "" : current))
      const sentPaths = new Set(images.map((image) => image.path))
      setDraftImages((current) =>
        current.filter((image) => !sentPaths.has(image.path)),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败")
    } finally {
      setSending(false)
    }
  }

  const selectedModel = models.find((entry) => entry.model === model)
  const efforts = selectedModel?.supportedReasoningEfforts ?? []
  const canSendImage = selectedModel?.inputModalities?.includes("image") ?? true

  const changeModel = (next: string) => {
    setModel(next)
    const entry = models.find((candidate) => candidate.model === next)
    if (
      entry &&
      !entry.supportedReasoningEfforts.some(
        (option) => option.reasoningEffort === effort,
      )
    )
      setEffort(entry.defaultReasoningEffort)
  }

  const addImages = async (files: FileList | null) => {
    if (!files?.length || uploading) return
    const selected = Array.from(files)
    if (draftImages.length + selected.length > 4) {
      setError("每条消息最多添加 4 张图片")
      return
    }
    setUploading(true)
    setError("")
    try {
      for (const file of selected) {
        if (!file.type.startsWith("image/")) throw new Error("请选择图片文件")
        if (file.size > 10 * 1024 * 1024)
          throw new Error("每张图片不能超过 10 MB")
        const image = await uploadCodexImage(file)
        setDraftImages((current) => [...current, { ...image, name: file.name }])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "图片上传失败")
    } finally {
      setUploading(false)
      if (imageInputRef.current) imageInputRef.current.value = ""
    }
  }

  const settings = (
    <div className="grid grid-cols-2 gap-2">
      <label className="text-muted-foreground min-w-0 text-xs">
        对话模型
        <select
          className="bg-background border-border text-foreground mt-1 min-h-11 w-full rounded-xl border px-2"
          value={model}
          onChange={(event) => changeModel(event.target.value)}
          disabled={!connected || creating || sending || running}
        >
          {!model && <option value="">加载中…</option>}
          {model && !selectedModel && <option value={model}>{model}</option>}
          {models.map((entry) => (
            <option key={entry.id} value={entry.model}>
              {entry.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="text-muted-foreground min-w-0 text-xs">
        思考强度
        <select
          className="bg-background border-border text-foreground mt-1 min-h-11 w-full rounded-xl border px-2"
          value={effort}
          onChange={(event) => setEffort(event.target.value)}
          disabled={
            !connected || creating || sending || running || !selectedModel
          }
        >
          {!effort && <option value="">加载中…</option>}
          {effort &&
            !efforts.some((entry) => entry.reasoningEffort === effort) && (
              <option value={effort}>{effort}</option>
            )}
          {efforts.map((entry) => (
            <option key={entry.reasoningEffort} value={entry.reasoningEffort}>
              {effortLabels[entry.reasoningEffort] ?? entry.reasoningEffort}
            </option>
          ))}
        </select>
      </label>
    </div>
  )

  const imageControls = draftImages.length > 0 && (
    <div className="flex flex-wrap gap-2" aria-label="待发送图片">
      {draftImages.map((image) => (
        <div
          key={image.path}
          className="bg-secondary relative size-16 overflow-hidden rounded-xl"
        >
          <img
            src={image.url}
            alt={image.name}
            className="size-full object-cover"
          />
          <button
            type="button"
            className="bg-background/90 absolute top-0 right-0 flex size-7 items-center justify-center rounded-bl-lg"
            aria-label={`移除 ${image.name}`}
            onClick={() =>
              setDraftImages((current) =>
                current.filter((entry) => entry.path !== image.path),
              )
            }
          >
            <IconX className="size-4" />
          </button>
        </div>
      ))}
    </div>
  )

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(event) => void addImages(event.target.files)}
      />
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
              {threadId
                ? historyFromCache && !connected
                  ? "本地历史 · 离线只读"
                  : workspace || (connected ? "已连接 NAS" : "连接中")
                : connected
                  ? "已连接 NAS"
                  : "连接中"}
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
                <div className="mb-3">{settings}</div>
                <label className="block text-sm">
                  第一条消息
                  <Textarea
                    className="mt-2 min-h-28 text-base"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="告诉 Codex 要处理什么…"
                  />
                </label>
                {imageControls}
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-11"
                    aria-label="添加图片"
                    disabled={!canSendImage || uploading || creating}
                    onClick={() => imageInputRef.current?.click()}
                  >
                    <IconPhoto className="size-5" />
                  </Button>
                  {uploading && (
                    <span className="text-muted-foreground text-sm">
                      图片上传中…
                    </span>
                  )}
                </div>
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
                      creating ||
                      uploading ||
                      !connected ||
                      !workspace ||
                      !model ||
                      !effort ||
                      (!draft.trim() && !draftImages.length)
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
          <div className="relative flex min-h-0 flex-1 flex-col">
            <main
              ref={listRef}
              onScroll={onListScroll}
              className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
            >
              <div className="mx-auto max-w-3xl space-y-4">
                {threadReady && (
                  <>
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
                            <h2 className="font-semibold">
                              Codex 需要你的回答
                            </h2>
                            {(
                              (approval.params.questions as CodexQuestion[]) ??
                              []
                            ).map((question) => (
                              <label
                                key={question.id}
                                className="mt-3 block text-sm"
                              >
                                <span className="font-medium">
                                  {question.header}
                                </span>
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
                                      <option
                                        key={option.label}
                                        value={option.label}
                                      >
                                        {option.label} — {option.description}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    type={
                                      question.isSecret ? "password" : "text"
                                    }
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
                                  (approval.params
                                    .questions as CodexQuestion[]) ?? []
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
                              {String(
                                approval.params.reason || approval.method,
                              )}
                            </p>
                            <pre className="bg-background mt-2 max-h-36 overflow-auto rounded-xl p-3 text-xs whitespace-pre-wrap">
                              {String(
                                approval.params.command ||
                                  JSON.stringify(
                                    approval.params.permissions ??
                                      approval.params,
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
                  </>
                )}
              </div>
            </main>
            {showJump && threadReady && (
              <Button
                className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-lg"
                onClick={jumpToLatest}
                aria-label={
                  approval ? "跳转到 Codex 待处理请求" : "跳转到最新消息"
                }
              >
                <IconArrowDown className="size-4" />
                {approval ? "有待处理请求 · 跳转到底部" : "跳转到最新消息"}
              </Button>
            )}
          </div>
          <div className="bg-background border-border shrink-0 border-t px-3 pt-3 pb-[calc(.75rem+env(safe-area-inset-bottom))]">
            <div className="mx-auto max-w-3xl space-y-2">
              {settings}
              {imageControls}
              <div className="flex items-end gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-12 shrink-0 rounded-full"
                  aria-label="添加图片"
                  disabled={!canSendImage || uploading || sending}
                  onClick={() => imageInputRef.current?.click()}
                >
                  <IconPhoto className="size-5" />
                </Button>
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
                  disabled={
                    !connected ||
                    !threadReady ||
                    uploading ||
                    sending ||
                    !model ||
                    !effort ||
                    (!draft.trim() && !draftImages.length)
                  }
                  onClick={() => void sendPrompt()}
                  aria-label={running ? "插入当前回复" : "发送"}
                >
                  <IconSend className="size-5" />
                </Button>
              </div>
              {uploading && (
                <p className="text-muted-foreground text-xs">图片上传中…</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const CodexItemView = memo(function CodexItemView({
  item,
}: {
  item: CodexItem
}) {
  if (item.type === "userMessage")
    return (
      <div className="bg-secondary text-secondary-foreground ml-auto max-w-[90%] rounded-2xl px-4 py-3 whitespace-pre-wrap">
        {itemText(item)}
        {item.content
          ?.filter(
            (part) => part.type === "image" || part.type === "localImage",
          )
          .map((part, index) => {
            const preview = imagePreview(part.path)
            return preview ? (
              <img
                key={index}
                src={preview}
                alt="已发送图片"
                className="mt-2 max-h-64 max-w-full rounded-lg object-contain"
                loading="lazy"
              />
            ) : (
              <span key={index} className="mt-2 block text-sm">
                [图片]
              </span>
            )
          })}
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
})
