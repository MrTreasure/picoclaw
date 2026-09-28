import {
  IconArrowDown,
  IconChevronDown,
  IconCode,
  IconFolder,
  IconRobot,
  IconTool,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

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
import { setCodexDetailVisible } from "@/api/codex-socket-manager"
import { getLauncherAuthStatus } from "@/api/launcher-auth"
import { AssistantMessage } from "@/components/chat/assistant-message"
import { ImageViewer } from "@/components/chat/image-viewer"
import { MessageActions } from "@/components/chat/message-actions"
import { TypingIndicator } from "@/components/chat/typing-indicator"
import { UserMessage } from "@/components/chat/user-message"
import { CodexComposer } from "@/components/codex/codex-composer"
import { CodexControls } from "@/components/codex/codex-controls"
import { Button } from "@/components/ui/button"
import type { AssistantDetailVisibility } from "@/features/chat/detail-visibility"
import type { GalleryImage } from "@/features/chat/image-gallery"
import { isSafeImageSource } from "@/features/chat/image-gallery"
import {
  readDraftAttachments,
  readSessionDraft,
  writeDraftAttachments,
  writeSessionDraft,
} from "@/features/chat/session-draft"
import { observeReadingConversation } from "@/features/chat/unread"
import {
  readCodexHistoryCache,
  writeCodexHistoryCache,
} from "@/features/codex/history-cache"
import {
  lastAuthenticatedListScope,
  validCacheScope,
} from "@/hooks/session-list-cache"

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

function itemImageSource(part: { path?: string; url?: string }): string | null {
  const local = imagePreview(part.path)
  return local || (part.url && isSafeImageSource(part.url) ? part.url : null)
}

function reasoningText(item: CodexItem): string {
  const summary = item.summary
    ?.map((part) => (typeof part === "string" ? part : (part.text ?? "")))
    .filter(Boolean)
    .join("\n\n")
  if (summary) return summary
  return (
    item.content
      ?.map((part) => (typeof part === "string" ? part : (part.text ?? "")))
      .filter(Boolean)
      .join("\n\n") ?? ""
  )
}

function flattenThread(thread: CodexThread): CodexItem[] {
  return (thread.turns ?? []).flatMap((turn) => turn.items ?? [])
}

function displayItem(
  item: CodexItem,
  visibility: AssistantDetailVisibility,
): boolean {
  if (item.type === "reasoning")
    return visibility === "thought" || visibility === "all"
  if (
    ["commandExecution", "fileChange", "mcpToolCall", "plan"].includes(
      item.type,
    )
  )
    return visibility === "tool_calls" || visibility === "all"
  return item.type === "userMessage" || item.type === "agentMessage"
}

function grantedPermissions(requested: unknown): Record<string, unknown> {
  if (!requested || typeof requested !== "object") return {}
  return Object.fromEntries(
    Object.entries(requested).filter(([, value]) => value != null),
  )
}

export function CodexPage({ threadId }: CodexPageProps) {
  return <CodexConversationPage key={threadId || "new"} threadId={threadId} />
}

function CodexConversationPage({ threadId }: { threadId?: string }) {
  useEffect(
    () =>
      threadId ? observeReadingConversation("codex:" + threadId) : undefined,
    [threadId],
  )
  useEffect(() => {
    setCodexDetailVisible(true)
    return () => setCodexDetailVisible(false)
  }, [])
  const navigate = useNavigate()
  const rpcRef = useRef<CodexRpcClient | null>(null)
  const cacheScopeRef = useRef<string | null>(null)
  const liveHydratedThreadRef = useRef<string | null>(null)
  const listRef = useRef<HTMLElement>(null)
  const followRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const scrollThreadRef = useRef(threadId)
  const positionedThreadRef = useRef<string | undefined>(undefined)
  const activeTurnRef = useRef<string | null>(null)
  const completedTurnRef = useRef<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null)
  const [historyFromCache, setHistoryFromCache] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState("")
  const [workspaces, setWorkspaces] = useState<CodexWorkspace[]>([])
  const [creating, setCreating] = useState(false)
  const [pendingThread, setPendingThread] = useState<{
    id: string
    workspace: string
  } | null>(null)
  const [workspace, setWorkspace] = useState("")
  const draftKey = "codex:" + (threadId || "new")
  const [draft, setDraft] = useState(() => readSessionDraft(draftKey))
  useEffect(() => {
    writeSessionDraft(draftKey, draft)
  }, [draftKey, draft])
  const [draftImages, setDraftImages] = useState<
    Array<CodexImage & { name: string }>
  >(() => readDraftAttachments<CodexImage & { name: string }>(draftKey))
  useEffect(() => {
    writeDraftAttachments(draftKey, draftImages)
  }, [draftKey, draftImages])
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [models, setModels] = useState<CodexModel[]>([])
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState("")
  const [detailVisibility, setDetailVisibility] =
    useState<AssistantDetailVisibility>("all")
  const [items, setItems] = useState<CodexItem[]>([])
  const [running, setRunning] = useState(false)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [title, setTitle] = useState("")
  const [imageSelection, setImageSelection] = useState<{
    itemId: string
    imageIndex: number
  } | null>(null)

  useEffect(() => {
    if (threadId) return
    let cancelled = false
    void getCodexWorkspaces()
      .then((result) => {
        if (cancelled) return
        setWorkspaces(result)
        setWorkspace((current) => current || result[0]?.path || "")
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "加载工作区失败")
      })
    return () => {
      cancelled = true
    }
  }, [threadId])

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
      .catch(async (error: unknown) => {
        if (error instanceof Error && /40[13]/.test(error.message)) return
        const scope = lastAuthenticatedListScope()
        if (cancelled || !scope || liveHydratedThreadRef.current === threadId)
          return
        const cached = await readCodexHistoryCache(scope, threadId).catch(
          () => null,
        )
        if (
          cancelled ||
          !cached ||
          scope !== lastAuthenticatedListScope() ||
          liveHydratedThreadRef.current === threadId
        )
          return
        setItems(flattenThread(cached))
        setHistoryFromCache(true)
        setLoadedThreadId(threadId)
        setTitle(cached.name || cached.preview || "Codex")
      })
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
      if (!cancelled) {
        setConnected(false)
        setApproval(null)
      }
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
      if (
        message.method === "item/reasoning/summaryTextDelta" ||
        message.method === "item/reasoning/textDelta"
      ) {
        if (params.threadId !== threadId) return
        const itemId = params.itemId as string | undefined
        const delta = params.delta as string | undefined
        if (!itemId || !delta) return
        const isSummary = message.method === "item/reasoning/summaryTextDelta"
        const index =
          typeof params.summaryIndex === "number" ? params.summaryIndex : 0
        queueItem((current) => {
          const position = current.findIndex((item) => item.id === itemId)
          const existing =
            position >= 0
              ? current[position]
              : { id: itemId, type: "reasoning" }
          if (!existing) return current
          let updated: CodexItem
          if (isSummary) {
            const parts = [...(existing.summary ?? [])]
            const previous = parts[index]
            parts[index] =
              (typeof previous === "string"
                ? previous
                : (previous?.text ?? "")) + delta
            updated = { ...existing, summary: parts }
          } else {
            const parts = [...(existing.content ?? [])]
            const previous = parts[0]
            parts[0] = {
              type: "text",
              text:
                (typeof previous === "string"
                  ? previous
                  : (previous?.text ?? "")) + delta,
            }
            updated = { ...existing, content: parts }
          }
          return position < 0
            ? [...current, updated]
            : current.map((item, at) => (at === position ? updated : item))
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
              if (!cancelled && result.thread)
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
    const hydrate = async () => {
      if (cancelled) return
      setConnected(true)
      try {
        const result = await rpc.request<{ data: CodexModel[] }>("model/list", {
          limit: 100,
        })
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
      if (threadId) {
        try {
          const result = await rpc.request<{ thread: CodexThread }>(
            "thread/read",
            { threadId, includeTurns: true },
          )
          if (cancelled) return
          if (!result.thread || !Array.isArray(result.thread.turns)) {
            throw new Error("Codex did not return complete thread turns")
          }
          flushItems()
          liveHydratedThreadRef.current = threadId
          setItems(flattenThread(result.thread))
          setHistoryFromCache(false)
          setLoadedThreadId(threadId)
          const scope = cacheScopeRef.current
          if (scope) void writeCodexHistoryCache(scope, threadId, result.thread)
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
    }
    rpc.onReconnect = () => {
      if (!cancelled)
        void hydrate().catch((cause: unknown) => {
          if (!cancelled)
            setError(cause instanceof Error ? cause.message : "Codex 恢复失败")
        })
    }
    void rpc
      .connect()
      .then(hydrate)
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
  }, [navigate, threadId])

  const threadReady = !!threadId && loadedThreadId === threadId
  const visibleItems = useMemo(
    () => items.filter((item) => displayItem(item, detailVisibility)),
    [items, detailVisibility],
  )
  // Keep the streaming end in normal flow; only stable history is windowed.
  const historyCount = Math.max(0, visibleItems.length - 10)
  const contentRef = useRef<HTMLDivElement>(null)
  const [historyMargin, setHistoryMargin] = useState(0)
  const userScrollIntent = useRef(false)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () =>
      setHistoryMargin(parseFloat(getComputedStyle(list).paddingTop) || 0)
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [threadReady])
  // oxlint-disable-next-line react/incompatible-library
  const historyVirtualizer = useVirtualizer({
    count: threadReady ? historyCount : 0,
    getScrollElement: () => listRef.current,
    getItemKey: (index) => visibleItems[index].id,
    estimateSize: (index) =>
      visibleItems[index].type === "userMessage" ? 120 : 220,
    overscan: 6,
    gap: 12,
    scrollMargin: historyMargin,
    useAnimationFrameWithResizeObserver: true,
  })
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(() => {
      const list = listRef.current
      if (list && followRef.current && threadReady) {
        list.scrollTop = list.scrollHeight
        lastScrollTopRef.current = list.scrollTop
      }
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [threadReady])

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
    else if (
      userScrollIntent.current &&
      list.scrollTop < lastScrollTopRef.current - 1
    )
      followRef.current = false
    lastScrollTopRef.current = list.scrollTop
    userScrollIntent.current = false
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
      writeSessionDraft(draftKey, "")
      writeDraftAttachments(draftKey, [])
      setDraft("")
      setDraftImages([])
      setPendingThread(null)
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

  const addImages = async (files: File[]) => {
    if (!files.length || uploading) return
    const selected = files
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
    }
  }

  const gallery = useMemo<GalleryImage[]>(
    () =>
      items.flatMap((item) =>
        item.type !== "userMessage"
          ? []
          : (item.content ?? [])
              .filter(
                (part) => part.type === "image" || part.type === "localImage",
              )
              .map((part, imageIndex) => ({
                messageId: item.id,
                imageIndex,
                url: itemImageSource(part) ?? "",
                alt: "已发送图片",
              }))
              .filter((entry) => entry.url),
      ),
    [items],
  )
  const selectedImageIndex = imageSelection
    ? gallery.findIndex(
        (image) =>
          image.messageId === imageSelection.itemId &&
          image.imageIndex === imageSelection.imageIndex,
      )
    : -1
  const canSubmit =
    connected &&
    !!model &&
    !!effort &&
    !uploading &&
    !sending &&
    !creating &&
    (threadId ? threadReady && !!workspace : !!workspace) &&
    (!!draft.trim() || draftImages.length > 0)

  return (
    <div className="bg-background relative flex h-full min-h-0 flex-col overflow-hidden">
      {selectedImageIndex >= 0 && (
        <ImageViewer
          gallery={gallery}
          index={selectedImageIndex}
          onSelect={(selection) =>
            setImageSelection({
              itemId: selection.messageId,
              imageIndex: selection.imageIndex,
            })
          }
          onClose={() => setImageSelection(null)}
        />
      )}
      <CodexControls
        title={threadId ? title || "Codex" : "Codex"}
        newConversation={!threadId}
        workspace={
          historyFromCache && !connected ? "本地历史 · 离线只读" : workspace
        }
        connected={connected}
        running={running}
        busy={creating || sending}
        model={model}
        effort={effort}
        models={models}
        detailVisibility={detailVisibility}
        onModelChange={changeModel}
        onEffortChange={setEffort}
        onDetailVisibilityChange={setDetailVisibility}
      />
      {error && (
        <div
          role="alert"
          className="bg-destructive/10 text-destructive absolute top-[calc(4rem+env(safe-area-inset-top))] right-0 left-0 z-30 px-4 py-2 text-sm"
        >
          {error}
        </div>
      )}
      {!threadId ? (
        <>
          <main className="min-h-0 flex-1 scroll-pt-[calc(4.75rem+env(safe-area-inset-top))] overflow-y-auto px-3 pt-[calc(4.75rem+env(safe-area-inset-top))] pb-6 md:px-8 lg:px-24 xl:px-48">
            <div className="mx-auto flex max-w-[900px] flex-col items-center px-3 py-12 text-center">
              <div className="bg-accent text-accent-foreground mb-6 flex size-16 items-center justify-center rounded-2xl">
                <IconRobot className="size-8" aria-hidden="true" />
              </div>
              <h1 className="text-xl font-medium">开始 Codex 对话</h1>
              <p className="text-muted-foreground mt-2 max-w-sm text-sm">
                选择工作区，然后在下方告诉 Codex 要处理什么。
              </p>
              <label className="mt-8 w-full max-w-sm text-left text-sm font-medium">
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
              <p className="text-muted-foreground mt-3 max-w-sm text-xs">
                模型与思考强度在右上角的对话设置中选择。
              </p>
            </div>
          </main>
          <CodexComposer
            draft={draft}
            images={draftImages}
            connected={connected}
            canSendImage={canSendImage}
            canSend={!!canSubmit}
            busy={creating}
            running={false}
            uploading={uploading}
            onDraftChange={setDraft}
            onImages={(files) => void addImages(files)}
            onRemoveImage={(path) =>
              setDraftImages((current) =>
                current.filter((image) => image.path !== path),
              )
            }
            onSend={() => void createThread()}
          />
        </>
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <main
              ref={listRef}
              onScroll={onListScroll}
              onWheel={() => {
                userScrollIntent.current = true
              }}
              onTouchStart={() => {
                userScrollIntent.current = true
              }}
              onPointerDown={() => {
                userScrollIntent.current = true
              }}
              onKeyDown={(event) => {
                if (["ArrowUp", "PageUp", "Home"].includes(event.key))
                  userScrollIntent.current = true
              }}
              className="min-h-0 flex-1 scroll-pt-[calc(4.75rem+env(safe-area-inset-top))] overflow-y-auto px-3 pt-[calc(4.75rem+env(safe-area-inset-top))] pb-4 md:px-8 lg:px-24 xl:px-48"
            >
              <div
                ref={contentRef}
                className="mx-auto max-w-[900px] space-y-3 md:space-y-4"
              >
                {threadReady && (
                  <>
                    {historyCount > 0 && (
                      <div
                        className="relative"
                        style={{ height: historyVirtualizer.getTotalSize() }}
                      >
                        {historyVirtualizer.getVirtualItems().map((row) => {
                          const item = visibleItems[row.index]
                          return (
                            <div
                              key={item.id}
                              ref={historyVirtualizer.measureElement}
                              data-index={row.index}
                              className="absolute top-0 left-0 w-full"
                              style={{
                                transform: `translateY(${row.start - historyMargin}px)`,
                              }}
                            >
                              <CodexItemView
                                item={item}
                                running={false}
                                onImageOpen={(imageIndex) =>
                                  setImageSelection({
                                    itemId: item.id,
                                    imageIndex,
                                  })
                                }
                              />
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {visibleItems.slice(historyCount).map((item) => (
                      <CodexItemView
                        key={item.id}
                        item={item}
                        running={running}
                        onImageOpen={(imageIndex) =>
                          setImageSelection({ itemId: item.id, imageIndex })
                        }
                      />
                    ))}
                    {running && <TypingIndicator activity="thinking" />}
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
                variant="secondary"
                size={approval ? "default" : "icon"}
                className={`absolute right-3 bottom-3 z-30 rounded-full border shadow-lg backdrop-blur-xl md:right-5 md:bottom-4 ${approval ? "" : "size-11"}`}
                onClick={jumpToLatest}
                aria-label={
                  approval ? "跳转到 Codex 待处理请求" : "跳转到最新消息"
                }
              >
                <IconArrowDown className="size-5" aria-hidden="true" />
                {approval && "有待处理请求"}
              </Button>
            )}
          </div>
          <CodexComposer
            draft={draft}
            images={draftImages}
            connected={connected && threadReady}
            canSendImage={canSendImage}
            canSend={!!canSubmit}
            busy={sending}
            running={running}
            uploading={uploading}
            onDraftChange={setDraft}
            onImages={(files) => void addImages(files)}
            onRemoveImage={(path) =>
              setDraftImages((current) =>
                current.filter((image) => image.path !== path),
              )
            }
            onSend={() => void sendPrompt()}
            onStop={() =>
              void rpcRef.current?.request("turn/interrupt", { threadId })
            }
          />
        </>
      )}
    </div>
  )
}

const CodexItemView = memo(function CodexItemView({
  item,
  running,
  onImageOpen,
}: {
  item: CodexItem
  running: boolean
  onImageOpen: (imageIndex: number) => void
}) {
  if (item.type === "userMessage") {
    const attachments = (item.content ?? [])
      .filter((part) => part.type === "image" || part.type === "localImage")
      .map((part) => ({
        type: "image" as const,
        url: itemImageSource(part) ?? "",
        filename: "已发送图片",
      }))
      .filter((entry) => entry.url)
    return (
      <UserMessage
        content={itemText(item)}
        attachments={attachments}
        onImageOpen={onImageOpen}
      />
    )
  }
  if (item.type === "agentMessage")
    return <AssistantMessage content={item.text ?? ""} senderName="Codex" />
  if (item.type === "reasoning")
    return (
      <AssistantMessage
        kind="thought"
        senderName="Codex"
        content={
          reasoningText(item) ||
          (running || item.status === "inProgress"
            ? "思考中…"
            : "此回合没有可展示的思考内容")
        }
      />
    )

  const label =
    item.type === "commandExecution"
      ? "执行命令"
      : item.type === "fileChange"
        ? "修改文件"
        : item.type === "plan"
          ? "计划"
          : "工具调用"
  const Icon =
    item.type === "commandExecution"
      ? IconCode
      : item.type === "fileChange"
        ? IconFolder
        : IconTool
  const detail = [
    item.command,
    item.aggregatedOutput,
    item.text,
    item.arguments ? JSON.stringify(item.arguments, null, 2) : "",
    item.result ? JSON.stringify(item.result, null, 2) : "",
    item.error ? JSON.stringify(item.error, null, 2) : "",
    item.changes ? JSON.stringify(item.changes, null, 2) : "",
  ]
    .filter(Boolean)
    .join("\n\n")
  return (
    <MessageActions content={detail || label} className="w-full">
      <details className="group w-full max-w-[94%] overflow-hidden rounded-2xl rounded-tl-[5px] border border-cyan-800/70 bg-cyan-950/45 text-cyan-50 sm:max-w-[86%]">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-left text-xs font-medium [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {label}
              {item.command ? ` · ${item.command}` : ""}
            </span>
          </span>
          <IconChevronDown
            className="size-4 shrink-0 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <pre className="max-h-64 overflow-auto border-t border-cyan-800/60 px-3 py-3 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
          {detail || "暂无可展示内容"}
        </pre>
      </details>
    </MessageActions>
  )
})
