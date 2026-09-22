import {
  IconBrandWechat,
  IconMessageCircle,
  IconMessagePlus,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import dayjs from "dayjs"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

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
import { Input } from "@/components/ui/input"
import { usePicoChat } from "@/hooks/use-pico-chat"
import { useSessionHistory } from "@/hooks/use-session-history"
import {
  clearChatNavigationOrigin,
  markChatOpenedFromSessions,
} from "@/lib/edge-swipe"

export function SessionListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeSessionId, switchSession, newChat } = usePicoChat()
  const [query, setQuery] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTriggeredRef = useRef(false)
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
    onDeletedActiveSession: newChat,
  })

  useEffect(() => {
    clearChatNavigationOrigin()
  }, [])

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    void loadSessions(true)
  }, [loadSessions])

  const filteredSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return sessions
    return sessions.filter((session) =>
      `${session.title} ${session.preview}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    )
  }, [query, sessions])

  const selectionMode = selectedIds.size > 0

  const toggleSelection = (sessionId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const beginLongPress = (sessionId: string) => {
    longPressTriggeredRef.current = false
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true
      toggleSelection(sessionId)
      navigator.vibrate?.(35)
    }, 520)
  }

  const cancelLongPress = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
  }

  const openSession = async (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId)
    if (session?.channel === "weixin") {
      await navigate({
        to: "/sessions/$sessionId",
        params: { sessionId },
      })
      return
    }
    await switchSession(sessionId)
    markChatOpenedFromSessions()
    await navigate({ to: "/" })
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
                onClick={() => void createSession()}
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

          {!loadError && filteredSessions.length === 0 && (
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

          <div className="border-border/70 bg-card overflow-hidden rounded-2xl border">
            {filteredSessions.map((session, index) => {
              const isActive = session.id === activeSessionId
              const isWeixin = session.channel === "weixin"
              return (
                <div
                  key={session.id}
                  className={`group flex min-h-23 items-center gap-3 px-3 py-3 sm:px-4 ${index > 0 ? "border-border/60 border-t" : ""}`}
                >
                  <button
                    type="button"
                    className={`focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:ring-2 focus-visible:outline-none ${selectedIds.has(session.id) ? "bg-secondary/10 ring-secondary ring-2" : ""}`}
                    onPointerDown={() => beginLongPress(session.id)}
                    onPointerUp={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                    onPointerLeave={cancelLongPress}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      cancelLongPress()
                      if (!selectedIds.has(session.id))
                        toggleSelection(session.id)
                    }}
                    onClick={() => {
                      if (longPressTriggeredRef.current) {
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
                      {isWeixin ? (
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
                void handleDeleteSessions(ids).then((deleted) => {
                  if (deleted) setSelectedIds(new Set())
                })
              }}
            >
              {t("chat.deleteSession")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
