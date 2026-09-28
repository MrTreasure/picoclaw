import {
  IconBrandWechat,
  IconCheck,
  IconCode,
  IconMessageCircle,
  IconMessagePlus,
  IconPencil,
  IconRobot,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import dayjs from "dayjs"
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { CodexRpcClient, type CodexThread } from "@/api/codex"
import { getLauncherAuthStatus } from "@/api/launcher-auth"
import type { SessionSummary } from "@/api/sessions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { deleteCodexHistoryCache } from "@/features/codex/history-cache"
import {
  invalidateCodexSessionListCache,
  invalidateSessionListCache,
  lastAuthenticatedListScope,
  peekCodexSessionListCache,
  readCodexSessionListCache,
  rememberAuthenticatedListScope,
  sessionListCacheGeneration,
  subscribeListCacheRevocation,
  validCacheScope,
  writeCodexSessionListCache,
} from "@/hooks/session-list-cache"
import { usePicoChat } from "@/hooks/use-pico-chat"
import { useSessionHistory } from "@/hooks/use-session-history"
import {
  clearChatNavigationOrigin,
  markChatOpenedFromSessions,
} from "@/lib/edge-swipe"

type SessionListEntry =
  | { kind: "muse"; session: SessionSummary; updated: number }
  | { kind: "codex"; thread: CodexThread; updated: number }

const museKey = (id: string) => `muse:${id}`
const codexKey = (id: string) => `codex:${id}`
// Sub-agent turns use a semantic session key ending in _sub. Do not infer
// provenance from message text or from legacy opaque session IDs.
const isSubAgentSession = (session: SessionSummary) =>
  session.channel === "pico" &&
  (session.sub_agent === true ||
    /^[a-z0-9][a-z0-9-]*_\d{8}t\d{9}_sub$/.test(session.id))

export function SessionListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeSessionId, switchSession, newChat } = usePicoChat()
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState(false)
  const [pressedId, setPressedId] = useState<string | null>(null)
  const [showNewSession, setShowNewSession] = useState(false)
  const [codexThreads, setCodexThreads] = useState<CodexThread[]>(() => {
    const scope = lastAuthenticatedListScope()
    return scope ? (peekCodexSessionListCache(scope) ?? []) : []
  })
  const [codexStatus, setCodexStatus] = useState<
    "loading" | "cached" | "ready" | "error"
  >(() => {
    const scope = lastAuthenticatedListScope()
    return scope && peekCodexSessionListCache(scope) ? "cached" : "loading"
  })
  const [codexRetry, setCodexRetry] = useState(0)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTriggeredRef = useRef(false)
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  const loadedRef = useRef(false)
  const codexScopeRef = useRef<string | null>(null)
  const codexLoadGeneration = useRef(0)
  const {
    sessions,
    initialLoading,
    hasMore,
    loadError,
    loadErrorMessage,
    observerRef,
    loadSessions,
    handleDeleteSessions,
    handleRenameSession,
  } = useSessionHistory({
    activeSessionId,
    onDeletedActiveSession: () => void newChat(true, true),
  })

  useEffect(
    () =>
      subscribeListCacheRevocation(() => {
        codexLoadGeneration.current += 1
        codexScopeRef.current = null
        setCodexThreads([])
        setCodexStatus("error")
      }),
    [],
  )

  useEffect(() => {
    clearChatNavigationOrigin()
  }, [])

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    void loadSessions(true)
  }, [loadSessions])

  useEffect(() => {
    let cancelled = false
    const generation = ++codexLoadGeneration.current
    const hinted = lastAuthenticatedListScope()
    const immediate = hinted ? peekCodexSessionListCache(hinted) : null
    codexScopeRef.current = hinted
    setCodexThreads(immediate ?? [])
    setCodexStatus(immediate ? "cached" : "loading")
    const authGeneration = sessionListCacheGeneration()
    const hintedRead = hinted ? readCodexSessionListCache(hinted) : null
    let liveApplied = false
    if (hintedRead)
      void hintedRead.then((snapshot) => {
        if (
          !snapshot ||
          liveApplied ||
          cancelled ||
          generation !== codexLoadGeneration.current ||
          authGeneration !== sessionListCacheGeneration() ||
          lastAuthenticatedListScope() !== hinted
        )
          return
        setCodexThreads(snapshot)
        setCodexStatus("cached")
      })
    const rpc = new CodexRpcClient()
    void (async () => {
      const status = await getLauncherAuthStatus()
      if (
        cancelled ||
        generation !== codexLoadGeneration.current ||
        authGeneration !== sessionListCacheGeneration()
      )
        return
      if (!status.authenticated || !validCacheScope(status.cache_scope)) {
        codexScopeRef.current = null
        void invalidateSessionListCache()
        setCodexThreads([])
        setCodexStatus("error")
        return
      }
      const scope = status.cache_scope
      if (hinted && hinted !== scope) setCodexThreads([])
      rememberAuthenticatedListScope(scope)
      codexScopeRef.current = scope
      const cached =
        scope === hinted ? hintedRead : readCodexSessionListCache(scope)
      const live = rpc.connect().then(async () => {
        const threads: CodexThread[] = []
        const cursors = new Set<string>()
        let cursor: string | null = null
        do {
          const page: { data: CodexThread[]; nextCursor?: string | null } =
            await rpc.request("thread/list", {
              limit: 50,
              sortKey: "recency_at",
              ...(cursor ? { cursor } : {}),
            })
          threads.push(...(page.data ?? []))
          cursor = page.nextCursor ?? null
          if (cursor) {
            if (cursors.has(cursor))
              throw new Error("Codex pagination cursor repeated")
            cursors.add(cursor)
          }
        } while (cursor)
        return threads
      })
      // Ensure the live request cannot reject before a handler is attached.
      let liveSettled = false
      const settledLive = live.then(
        (result) => {
          liveSettled = true
          return { ok: true as const, result }
        },
        (error: unknown) => {
          liveSettled = true
          return { ok: false as const, error }
        },
      )
      if (cached)
        void cached.then((snapshot) => {
          if (
            !cancelled &&
            generation === codexLoadGeneration.current &&
            authGeneration === sessionListCacheGeneration() &&
            !liveSettled &&
            !liveApplied &&
            snapshot
          ) {
            setCodexThreads(snapshot)
            setCodexStatus("cached")
          }
        })
      const outcome = await settledLive
      if (
        cancelled ||
        generation !== codexLoadGeneration.current ||
        authGeneration !== sessionListCacheGeneration()
      )
        return
      if (!outcome.ok) {
        console.error("Failed to load Codex conversations:", outcome.error)
        if (String(outcome.error).includes("401")) {
          void invalidateSessionListCache()
          setCodexThreads([])
        }
        setCodexStatus("error")
        return
      }
      const threads = outcome.result
      liveApplied = true
      setCodexThreads(threads)
      setCodexStatus("ready")
      void writeCodexSessionListCache(scope, threads)
    })().catch((error: unknown) => {
      if (!cancelled && generation === codexLoadGeneration.current) {
        console.error("Failed to load Codex conversations:", error)
        setCodexStatus("error")
      }
    })
    return () => {
      cancelled = true
      codexLoadGeneration.current += 1
      rpc.close()
    }
  }, [codexRetry])

  // Sort only when source lists change; a search keystroke just filters.
  const sortedEntries = useMemo(() => {
    const museEntries: SessionListEntry[] = sessions.map((session) => ({
      kind: "muse",
      session,
      updated: dayjs(session.updated).valueOf(),
    }))
    const codexEntries: SessionListEntry[] = codexThreads.map((thread) => ({
      kind: "codex",
      thread,
      updated: (thread.updatedAt ?? thread.createdAt ?? 0) * 1000,
    }))
    return [...museEntries, ...codexEntries].sort(
      (a, b) => b.updated - a.updated,
    )
  }, [sessions, codexThreads])

  const visibleEntries = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase()
    if (!normalizedQuery) return sortedEntries
    return sortedEntries.filter((entry) =>
      (entry.kind === "muse"
        ? `${entry.session.title} ${entry.session.preview}`
        : `${entry.thread.name || ""} ${entry.thread.preview || ""} ${entry.thread.cwd || ""}`
      )
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    )
  }, [deferredQuery, sortedEntries])

  const selectionMode = selectedIds.size > 0
  const awaitingInitialLists = initialLoading || codexStatus === "loading"

  const toggleSelection = (key: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const beginLongPress = (key: string, event: React.PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    cancelLongPress()
    suppressClickRef.current = false
    pointerStartRef.current = { x: event.clientX, y: event.clientY }
    setPressedId(key)
    longPressTriggeredRef.current = false
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      longPressTriggeredRef.current = true
      suppressClickRef.current = true
      setPressedId(null)
      if (!selectedIds.has(key)) toggleSelection(key)
      navigator.vibrate?.([12, 28, 18])
    }, 460)
  }

  const cancelLongPress = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
    pointerStartRef.current = null
    setPressedId(null)
  }

  const moveLongPress = (event: React.PointerEvent) => {
    const start = pointerStartRef.current
    if (
      start &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
    ) {
      cancelLongPress()
      // Touch scrolling may still synthesize a click on release.
      suppressClickRef.current = true
    }
  }

  useEffect(
    () => () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    },
    [],
  )

  const openSession = async (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId)
    if (session?.channel === "weixin") {
      await navigate({
        to: "/sessions/$sessionId",
        params: { sessionId },
      })
      return
    }
    markChatOpenedFromSessions()
    // Start navigation before changing the shared chat atom so the list does
    // not paint once more with a different active session.
    const navigation = navigate({ to: "/" })
    void switchSession(sessionId)
    await navigation
  }

  const deleteSelected = async () => {
    if (deleting) return
    const keys = [...selectedIds]
    const museIds = keys
      .filter((key) => key.startsWith("muse:"))
      .map((key) => key.slice("muse:".length))
    const codexIds = keys
      .filter((key) => key.startsWith("codex:"))
      .map((key) => key.slice("codex:".length))
    setConfirmBulkDelete(false)
    setDeleting(true)
    const deleted = new Set<string>()
    try {
      if (museIds.length) {
        for (const id of await handleDeleteSessions(museIds))
          deleted.add(museKey(id))
      }
      if (codexIds.length) {
        codexLoadGeneration.current += 1
        // Revoke pending reads/writes before a delete can race a refresh.
        const scope = codexScopeRef.current
        if (scope) await invalidateCodexSessionListCache(scope)
        const rpc = new CodexRpcClient()
        try {
          await rpc.connect()
          // A failed thread must not block deletion of the other selections.
          for (const id of codexIds) {
            try {
              await rpc.request("thread/delete", { threadId: id })
              const scope = codexScopeRef.current
              if (scope) void deleteCodexHistoryCache(scope, id)
              deleted.add(codexKey(id))
            } catch (error) {
              console.error("Failed to delete Codex thread:", error)
            }
          }
        } catch (error) {
          console.error("Failed to connect for Codex deletion:", error)
        } finally {
          rpc.close()
        }
      }
    } catch (error) {
      console.error("Failed to delete selected sessions:", error)
    } finally {
      setCodexThreads((threads) =>
        threads.filter((thread) => !deleted.has(codexKey(thread.id))),
      )
      setSelectedIds((current) => {
        const remaining = new Set(current)
        for (const key of deleted) remaining.delete(key)
        return remaining
      })
      const failedCodex = codexIds.filter((id) => !deleted.has(codexKey(id)))
      if (failedCodex.length)
        toast.error(`${failedCodex.length} 段 Codex 会话删除失败，请重试`)
      const deletedCodex = codexIds.filter((id) => deleted.has(codexKey(id)))
      if (deletedCodex.length) {
        const scope = codexScopeRef.current
        if (scope)
          void writeCodexSessionListCache(
            scope,
            codexThreads.filter((thread) => !deleted.has(codexKey(thread.id))),
          )
        toast.success(`已永久删除 ${deletedCodex.length} 段 Codex 会话`)
      }
      setDeleting(false)
      if (codexIds.length) setCodexRetry((n) => n + 1)
    }
  }

  const submitRename = async () => {
    if (!renameId || renaming) return
    const title = renameTitle.trim()
    if (!title || title.length > 60) {
      setRenameError(true)
      return
    }
    setRenameError(false)
    setRenaming(true)
    try {
      await handleRenameSession(renameId, title)
      setRenameId(null)
    } catch (error) {
      console.error("Failed to rename conversation:", error)
      setRenameError(true)
    } finally {
      setRenaming(false)
    }
  }

  const createSession = async () => {
    await newChat()
    markChatOpenedFromSessions()
    await navigate({ to: "/" })
  }

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <header className="border-border/70 bg-background/92 flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-end border-b px-4 pb-1 backdrop-blur-xl">
        <div className="flex h-14 w-full items-center justify-between">
          {selectionMode ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-12 rounded-full"
                onClick={() => setSelectedIds(new Set())}
                aria-label="取消选择"
              >
                <IconX className="size-6" />
              </Button>
              <h1 className="text-lg font-semibold">
                已选择 {selectedIds.size} 项
              </h1>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive size-12 rounded-full"
                onClick={() => setConfirmBulkDelete(true)}
                disabled={deleting}
                aria-label="删除所选会话"
              >
                <IconTrash className="size-5" />
              </Button>
            </>
          ) : (
            <>
              <div className="size-12" aria-hidden="true" />
              <h1 className="text-xl font-semibold tracking-tight">会话</h1>
              <Button
                variant="ghost"
                size="icon"
                className="size-12 rounded-full"
                onClick={() => setShowNewSession(true)}
                aria-label={t("chat.newChat")}
              >
                <IconMessagePlus className="size-6" aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto w-full max-w-3xl px-3 py-3 sm:px-6">
          <label className="bg-card border-border/70 focus-within:border-ring mb-3 flex min-h-12 items-center gap-3 rounded-2xl border px-4 transition-colors">
            <IconSearch
              className="text-muted-foreground size-5 shrink-0"
              aria-hidden="true"
            />
            <span className="sr-only">搜索会话</span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话"
              className="h-11 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </label>

          {loadError && (
            <div className="border-destructive/40 bg-destructive/10 text-destructive mb-3 flex min-h-12 items-center justify-between rounded-xl border px-4 text-sm">
              <span>{loadErrorMessage}</span>
              <Button variant="ghost" onClick={() => void loadSessions(true)}>
                重试
              </Button>
            </div>
          )}

          {codexStatus === "error" && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive mb-3 flex min-h-12 items-center justify-between rounded-xl border px-4 text-sm"
            >
              <span>Codex 对话加载失败，已显示可用的其他对话。</span>
              <Button
                variant="ghost"
                onClick={() => setCodexRetry((n) => n + 1)}
              >
                重试
              </Button>
            </div>
          )}

          {awaitingInitialLists && visibleEntries.length === 0 && (
            <div
              role="status"
              className="text-muted-foreground flex flex-col items-center px-6 py-20 text-center"
            >
              <div className="bg-muted mb-5 flex size-16 items-center justify-center rounded-2xl">
                <IconMessageCircle
                  className="size-8 animate-pulse"
                  aria-hidden="true"
                />
              </div>
              <p className="text-foreground text-lg font-semibold">
                正在加载对话…
              </p>
            </div>
          )}

          {!awaitingInitialLists &&
            !loadError &&
            codexStatus !== "error" &&
            visibleEntries.length === 0 && (
              <div className="text-muted-foreground flex flex-col items-center px-6 py-20 text-center">
                <div className="bg-muted mb-5 flex size-16 items-center justify-center rounded-2xl">
                  <IconMessageCircle className="size-8" aria-hidden="true" />
                </div>
                <p className="text-foreground text-lg font-semibold">
                  {query ? "没有匹配的会话" : t("chat.noHistory")}
                </p>
                <p className="mt-2 text-sm">点击右上角开始一段新对话</p>
              </div>
            )}

          <div className="space-y-2">
            {visibleEntries.map((entry) => {
              if (entry.kind === "codex") {
                const thread = entry.thread
                const key = codexKey(thread.id)
                return (
                  <div
                    key={key}
                    className={`group border-border/55 bg-card flex min-h-20 items-center gap-3 rounded-2xl border px-3 py-3 shadow-sm transition-[transform,background-color,box-shadow] duration-150 sm:px-4 ${selectedIds.has(key) ? "border-secondary/60 bg-secondary/10 shadow-md" : pressedId === key ? "bg-muted/80 scale-[0.985] shadow-inner" : "active:scale-[0.99]"}`}
                  >
                    <button
                      type="button"
                      className="focus-visible:ring-ring flex min-w-0 flex-1 touch-pan-y items-center gap-3 rounded-xl text-left select-none focus-visible:ring-2 focus-visible:outline-none"
                      onPointerDown={(event) => beginLongPress(key, event)}
                      onPointerMove={moveLongPress}
                      onPointerUp={cancelLongPress}
                      onPointerCancel={cancelLongPress}
                      onPointerLeave={cancelLongPress}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        cancelLongPress()
                        suppressClickRef.current = true
                        if (!selectedIds.has(key)) toggleSelection(key)
                      }}
                      onClick={() => {
                        if (
                          suppressClickRef.current ||
                          longPressTriggeredRef.current
                        ) {
                          suppressClickRef.current = false
                          longPressTriggeredRef.current = false
                          return
                        }
                        if (selectionMode) toggleSelection(key)
                        else
                          void navigate({
                            to: "/codex",
                            search: { thread: thread.id },
                          })
                      }}
                    >
                      <span className="bg-secondary/10 text-secondary flex size-14 shrink-0 items-center justify-center rounded-2xl">
                        {selectedIds.has(key) ? (
                          <IconCheck className="size-7" aria-label="已选择" />
                        ) : (
                          <IconCode className="size-7" aria-hidden="true" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-3">
                          <span className="truncate text-[17px] font-semibold">
                            {thread.name || thread.preview || "Codex 对话"}
                          </span>
                          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                            {dayjs(entry.updated).format("HH:mm")}
                          </span>
                        </span>
                        <span className="text-muted-foreground mt-1 block truncate text-sm">
                          {thread.cwd || "Codex 对话"}
                        </span>
                      </span>
                    </button>
                  </div>
                )
              }
              const session = entry.session
              const key = museKey(session.id)
              const isActive = session.id === activeSessionId
              const isWeixin = session.channel === "weixin"
              const isSubAgent = isSubAgentSession(session)
              return (
                <div
                  key={key}
                  className={`group border-border/55 bg-card flex min-h-20 items-center gap-3 rounded-2xl border px-3 py-3 shadow-sm transition-[transform,background-color,box-shadow] duration-150 sm:px-4 ${selectedIds.has(key) ? "border-secondary/60 bg-secondary/10 shadow-md" : pressedId === key ? "bg-muted/80 scale-[0.985] shadow-inner" : "active:scale-[0.99]"}`}
                >
                  <button
                    type="button"
                    className="focus-visible:ring-ring flex min-w-0 flex-1 touch-pan-y items-center gap-3 rounded-xl text-left select-none focus-visible:ring-2 focus-visible:outline-none"
                    onPointerDown={(event) => beginLongPress(key, event)}
                    onPointerMove={moveLongPress}
                    onPointerUp={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                    onPointerLeave={cancelLongPress}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      cancelLongPress()
                      suppressClickRef.current = true
                      if (!selectedIds.has(key)) toggleSelection(key)
                    }}
                    onClick={() => {
                      if (
                        suppressClickRef.current ||
                        longPressTriggeredRef.current
                      ) {
                        suppressClickRef.current = false
                        longPressTriggeredRef.current = false
                        return
                      }
                      if (selectionMode) toggleSelection(key)
                      else void openSession(session.id)
                    }}
                  >
                    <span
                      className={`flex size-14 shrink-0 items-center justify-center rounded-2xl ${isWeixin ? "bg-emerald-500/15 text-emerald-400" : isSubAgent ? "bg-violet-500/15 text-violet-500" : isActive ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground"}`}
                    >
                      {selectedIds.has(key) ? (
                        <IconCheck className="size-7" aria-label="已选择" />
                      ) : isWeixin ? (
                        <IconBrandWechat
                          className="size-7"
                          aria-hidden="true"
                        />
                      ) : isSubAgent ? (
                        <IconRobot
                          className="size-7"
                          aria-label="子 Agent 对话"
                        />
                      ) : (
                        <IconMessageCircle
                          className="size-7"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-3">
                        <span className="truncate text-[17px] font-semibold">
                          {session.title || "新对话"}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                          {dayjs(session.updated).format("HH:mm")}
                        </span>
                      </span>
                      <span className="text-muted-foreground mt-1 block truncate text-sm">
                        {session.preview && session.preview !== session.title
                          ? session.preview
                          : t("chat.messagesCount", {
                              count: session.message_count,
                            })}
                      </span>
                      {isWeixin && (
                        <span className="mt-1 block text-xs font-medium text-emerald-400">
                          微信记录
                        </span>
                      )}
                      {isSubAgent && (
                        <span className="mt-1 block text-xs font-medium text-violet-500">
                          子 Agent 对话
                        </span>
                      )}
                      {isActive && (
                        <span className="text-secondary mt-1 block text-xs font-medium">
                          当前会话
                        </span>
                      )}
                    </span>
                  </button>
                  {!selectionMode && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-11 shrink-0 items-center justify-center rounded-xl focus-visible:ring-2 focus-visible:outline-none"
                      aria-label={t("chat.renameSessionLabel", {
                        title: session.title || t("chat.history"),
                      })}
                      onPointerDown={() => cancelLongPress()}
                      onClick={() => {
                        cancelLongPress()
                        setRenameId(session.id)
                        setRenameTitle(session.title)
                        setRenameError(false)
                      }}
                    >
                      <IconPencil className="size-5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {hasMore && sessions.length > 0 && !query && (
            <div
              ref={observerRef}
              className="text-muted-foreground py-5 text-center text-sm"
            >
              {t("chat.loadingMore")}
            </div>
          )}
        </div>
      </main>

      <Dialog
        open={renameId !== null}
        onOpenChange={(open) => {
          if (!open && !renaming) {
            setRenameId(null)
            setRenameError(false)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("chat.renameSession")}</DialogTitle>
            <DialogDescription>
              {t("chat.renameSessionDescription")}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submitRename()
            }}
            className="space-y-4"
          >
            <Input
              autoFocus
              aria-label={t("chat.renameSession")}
              aria-invalid={renameError}
              aria-describedby={
                renameError ? "rename-session-error" : undefined
              }
              maxLength={60}
              value={renameTitle}
              disabled={renaming}
              onChange={(event) => {
                setRenameTitle(event.target.value)
                setRenameError(false)
              }}
            />
            {renameError && (
              <p
                id="rename-session-error"
                role="alert"
                className="text-destructive text-sm"
              >
                {renameTitle.trim().length === 0
                  ? t("chat.renameSessionRequired")
                  : t("chat.renameSessionFailed")}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={renaming}
                onClick={() => setRenameId(null)}
              >
                {t("chat.renameSessionCancel")}
              </Button>
              <Button type="submit" disabled={renaming}>
                {renaming
                  ? t("chat.renameSessionSaving")
                  : t("chat.renameSessionSave")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmBulkDelete}
        onOpenChange={(open) => {
          setConfirmBulkDelete(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除所选会话？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除 {selectedIds.size} 段会话记录（含所选 Pico、微信及
              Codex 对话）。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void deleteSelected()}
            >
              {t("chat.deleteSession")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showNewSession} onOpenChange={setShowNewSession}>
        <DialogContent className="rounded-3xl">
          <DialogHeader>
            <DialogTitle>新建会话</DialogTitle>
            <DialogDescription>选择要对话的助手</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Button
              variant="outline"
              className="min-h-14 justify-start text-base"
              onClick={() => {
                setShowNewSession(false)
                void createSession()
              }}
            >
              <IconMessageCircle className="size-5" /> MuseC137
            </Button>
            <Button
              variant="outline"
              className="min-h-14 justify-start text-base"
              onClick={() => {
                setShowNewSession(false)
                void navigate({ to: "/codex", search: {} })
              }}
            >
              <IconCode className="size-5" /> Codex
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
