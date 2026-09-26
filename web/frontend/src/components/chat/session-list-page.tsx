import {
  IconBrandWechat,
  IconCheck,
  IconCode,
  IconMessageCircle,
  IconMessagePlus,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import dayjs from "dayjs"
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { CodexRpcClient, type CodexThread } from "@/api/codex"
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
import { usePicoChat } from "@/hooks/use-pico-chat"
import { useSessionHistory } from "@/hooks/use-session-history"
import {
  clearChatNavigationOrigin,
  markChatOpenedFromSessions,
} from "@/lib/edge-swipe"

type SessionListEntry =
  | { kind: "muse"; session: SessionSummary; updated: number }
  | { kind: "codex"; thread: CodexThread; updated: number }

export function SessionListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeSessionId, switchSession, newChat } = usePicoChat()
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pressedId, setPressedId] = useState<string | null>(null)
  const [showNewSession, setShowNewSession] = useState(false)
  const [codexThreads, setCodexThreads] = useState<CodexThread[]>([])
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTriggeredRef = useRef(false)
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  const loadedRef = useRef(false)
  const {
    sessions,
    hasMore,
    loadError,
    loadErrorMessage,
    observerRef,
    loadSessions,
    handleDeleteSessions,
  } = useSessionHistory({
    activeSessionId,
    onDeletedActiveSession: () => void newChat(true),
  })

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
    const rpc = new CodexRpcClient()
    void rpc
      .connect()
      .then(() =>
        rpc.request<{ data: CodexThread[] }>("thread/list", {
          limit: 50,
          sortKey: "recency_at",
        }),
      )
      .then((result) => {
        if (!cancelled)
          setCodexThreads(
            (result.data ?? []).filter(
              (thread) => thread.historyMode === "legacy",
            ),
          )
      })
      .catch(() => {})
    return () => {
      cancelled = true
      rpc.close()
    }
  }, [])

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

  const toggleSelection = (sessionId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const beginLongPress = (sessionId: string, event: React.PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    cancelLongPress()
    suppressClickRef.current = false
    pointerStartRef.current = { x: event.clientX, y: event.clientY }
    setPressedId(sessionId)
    longPressTriggeredRef.current = false
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      longPressTriggeredRef.current = true
      suppressClickRef.current = true
      setPressedId(null)
      if (!selectedIds.has(sessionId)) toggleSelection(sessionId)
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

          {!loadError && visibleEntries.length === 0 && (
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
                return (
                  <div
                    key={`codex:${thread.id}`}
                    className="border-border/55 bg-card flex min-h-20 items-center gap-3 rounded-2xl border px-3 py-3 shadow-sm sm:px-4"
                  >
                    <button
                      type="button"
                      className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:ring-2 focus-visible:outline-none"
                      onClick={() =>
                        void navigate({
                          to: "/codex",
                          search: { thread: thread.id },
                        })
                      }
                    >
                      <span className="bg-secondary/10 text-secondary flex size-14 shrink-0 items-center justify-center rounded-2xl">
                        <IconCode className="size-7" aria-hidden="true" />
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
              const isActive = session.id === activeSessionId
              const isWeixin = session.channel === "weixin"
              return (
                <div
                  key={session.id}
                  className={`group border-border/55 bg-card flex min-h-20 items-center gap-3 rounded-2xl border px-3 py-3 shadow-sm transition-[transform,background-color,box-shadow] duration-150 sm:px-4 ${selectedIds.has(session.id) ? "border-secondary/60 bg-secondary/10 shadow-md" : pressedId === session.id ? "bg-muted/80 scale-[0.985] shadow-inner" : "active:scale-[0.99]"}`}
                >
                  <button
                    type="button"
                    className="focus-visible:ring-ring flex min-w-0 flex-1 touch-pan-y items-center gap-3 rounded-xl text-left select-none focus-visible:ring-2 focus-visible:outline-none"
                    onPointerDown={(event) => beginLongPress(session.id, event)}
                    onPointerMove={moveLongPress}
                    onPointerUp={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                    onPointerLeave={cancelLongPress}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      cancelLongPress()
                      suppressClickRef.current = true
                      if (!selectedIds.has(session.id))
                        toggleSelection(session.id)
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
                      if (selectionMode) toggleSelection(session.id)
                      else void openSession(session.id)
                    }}
                  >
                    <span
                      className={`flex size-14 shrink-0 items-center justify-center rounded-2xl ${isWeixin ? "bg-emerald-500/15 text-emerald-400" : isActive ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground"}`}
                    >
                      {selectedIds.has(session.id) ? (
                        <IconCheck className="size-7" aria-label="已选择" />
                      ) : isWeixin ? (
                        <IconBrandWechat
                          className="size-7"
                          aria-hidden="true"
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
                        {session.preview ||
                          t("chat.messagesCount", {
                            count: session.message_count,
                          })}
                      </span>
                      {isWeixin && (
                        <span className="mt-1 block text-xs font-medium text-emerald-400">
                          微信记录
                        </span>
                      )}
                      {isActive && (
                        <span className="text-secondary mt-1 block text-xs font-medium">
                          当前会话
                        </span>
                      )}
                    </span>
                  </button>
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
              将永久删除 {selectedIds.size}{" "}
              段会话记录，包括所选微信记录。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const ids = [...selectedIds]
                setConfirmBulkDelete(false)
                setDeleting(true)
                void handleDeleteSessions(ids)
                  .then((deleted) => {
                    setSelectedIds((current) => {
                      const remaining = new Set(current)
                      for (const id of deleted) remaining.delete(id)
                      return remaining
                    })
                  })
                  .finally(() => setDeleting(false))
              }}
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
