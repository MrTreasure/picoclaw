import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { type SessionSummary, deleteSession, getSessions } from "@/api/sessions"
import { deleteCachedSession } from "@/features/chat/local-cache"

const LIMIT = 20
let cachedSessionList: SessionSummary[] = []
let listMutationVersion = 0

interface UseSessionHistoryOptions {
  activeSessionId: string
  onDeletedActiveSession: () => void
}

export function useSessionHistory({
  activeSessionId,
  onDeletedActiveSession,
}: UseSessionHistoryOptions) {
  const { t } = useTranslation()
  const observerRef = useRef<HTMLDivElement>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>(cachedSessionList)
  const [offset, setOffset] = useState(cachedSessionList.length)
  const [hasMore, setHasMore] = useState(
    cachedSessionList.length >= LIMIT,
  )
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const loadSessions = useCallback(
    async (reset = true) => {
      try {
        const mutationVersion = listMutationVersion
        const currentOffset = reset ? 0 : offset
        if (reset) {
          setLoadError(false)
          setHasMore(true)
          setOffset(0)
        }

        const data = await getSessions(currentOffset, LIMIT)
        if (mutationVersion !== listMutationVersion) return
        setLoadError(false)

        if (data.length < LIMIT) {
          setHasMore(false)
        }

        if (reset) {
          cachedSessionList = data
          setSessions(data)
        } else {
          setSessions((prev) => {
            const existingIds = new Set(prev.map((s) => s.id))
            const newItems = data.filter((s) => !existingIds.has(s.id))
            cachedSessionList = [...prev, ...newItems]
            return cachedSessionList
          })
        }

        setOffset(currentOffset + data.length)
      } catch (err) {
        console.error("Failed to fetch session history:", err)
        setLoadError(true)
        if (!reset) {
          setHasMore(false)
        }
      } finally {
        setIsLoadingMore(false)
      }
    },
    [offset],
  )

  useEffect(() => {
    if (!observerRef.current || !hasMore || isLoadingMore || loadError) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          hasMore &&
          !isLoadingMore &&
          !loadError
        ) {
          setIsLoadingMore(true)
          void loadSessions(false)
        }
      },
      { threshold: 0.1 },
    )

    observer.observe(observerRef.current)
    return () => observer.disconnect()
  }, [hasMore, isLoadingMore, loadError, loadSessions])

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        const deletedLoadedSession = sessions.some(
          (session) => session.id === id,
        )
        if (id === activeSessionId) onDeletedActiveSession()
        await deleteSession(id)
        await deleteCachedSession(id)
        listMutationVersion += 1
        cachedSessionList = cachedSessionList.filter((s) => s.id !== id)
        setSessions((prev) => prev.filter((s) => s.id !== id))
        if (deletedLoadedSession) {
          setOffset((prev) => Math.max(prev - 1, 0))
        }
        toast.success(t("chat.sessionDeleted"))
      } catch (err) {
        console.error("Failed to delete session:", err)
        toast.error(t("chat.sessionDeleteFailed"))
      }
    },
    [activeSessionId, onDeletedActiveSession, sessions, t],
  )

  const handleDeleteSessions = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return []
      try {
        if (ids.includes(activeSessionId)) onDeletedActiveSession()
        const results = await Promise.allSettled(
          ids.map(async (id) => {
            await deleteSession(id)
            await deleteCachedSession(id)
            return id
          }),
        )
        const deletedIds = new Set(
          results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          ),
        )
        if (deletedIds.size > 0) listMutationVersion += 1
        cachedSessionList = cachedSessionList.filter(
          (session) => !deletedIds.has(session.id),
        )
        setSessions((previous) =>
          previous.filter((session) => !deletedIds.has(session.id)),
        )
        setOffset((previous) => Math.max(previous - deletedIds.size, 0))
        if (deletedIds.size > 0) toast.success(`已删除 ${deletedIds.size} 段会话`)
        if (deletedIds.size !== ids.length) {
          toast.error(`${ids.length - deletedIds.size} 段会话删除失败`)
        }
        return [...deletedIds]
      } catch (err) {
        console.error("Failed to delete sessions:", err)
        toast.error(t("chat.sessionDeleteFailed"))
        void loadSessions(true)
        return []
      }
    },
    [activeSessionId, loadSessions, onDeletedActiveSession, t],
  )

  return {
    sessions,
    hasMore,
    loadError,
    loadErrorMessage: t("chat.historyLoadFailed"),
    observerRef,
    loadSessions,
    handleDeleteSession,
    handleDeleteSessions,
  }
}
