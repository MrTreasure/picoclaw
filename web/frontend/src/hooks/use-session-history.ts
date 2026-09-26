import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { getLauncherAuthStatus } from "@/api/launcher-auth"
import { type SessionSummary, deleteSession, getSessions } from "@/api/sessions"
import { deleteCachedSession } from "@/features/chat/local-cache"

import {
  invalidateSessionListCache,
  readSessionListCache,
  reconcileFirstPage,
  sessionListCacheGeneration,
  validCacheScope,
  writeSessionListCache,
} from "./session-list-cache"

const LIMIT = 20
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
  const requestVersion = useRef(0)
  const loadingRef = useRef(false)
  const scopeRef = useRef<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const loadSessions = useCallback(
    async (reset = true) => {
      // Block observer calls before React commits the loading state.
      if (!reset && loadingRef.current) return
      loadingRef.current = true
      const request = ++requestVersion.current
      const mutationVersion = listMutationVersion
      const authGeneration = sessionListCacheGeneration()
      setIsLoadingMore(true)
      if (reset) {
        // Nothing from a previous account may remain visible while auth is pending.
        scopeRef.current = null
        setSessions([])
        setOffset(0)
        setHasMore(false)
        setLoadError(false)
      }
      try {
        let scope = scopeRef.current
        if (reset) {
          const status = await getLauncherAuthStatus()
          if (
            request !== requestVersion.current ||
            mutationVersion !== listMutationVersion ||
            authGeneration !== sessionListCacheGeneration()
          )
            return
          if (!status.authenticated) throw new Error("Not authenticated")
          scope = validCacheScope(status.cache_scope)
            ? status.cache_scope
            : null
          scopeRef.current = scope
        }
        if (
          (!reset && scopeRef.current !== scope) ||
          authGeneration !== sessionListCacheGeneration()
        )
          return
        // Auth is verified before showing cache; start network and storage in
        // parallel so IndexedDB latency does not delay the first API request.
        const currentOffset = reset ? 0 : offset
        const cacheRead = reset && scope ? readSessionListCache(scope) : null
        if (cacheRead) {
          void cacheRead.then((cached) => {
            if (
              !cached ||
              request !== requestVersion.current ||
              mutationVersion !== listMutationVersion ||
              scopeRef.current !== scope ||
              authGeneration !== sessionListCacheGeneration()
            )
              return
            setSessions(cached.sessions)
            setOffset(cached.offset)
            setHasMore(cached.hasMore)
          })
        }
        // Never request 200 rows just because 200 were visible last time.
        const data = await getSessions(currentOffset, LIMIT)
        const cached = cacheRead ? await cacheRead : null
        if (
          request !== requestVersion.current ||
          mutationVersion !== listMutationVersion ||
          scopeRef.current !== scope ||
          authGeneration !== sessionListCacheGeneration()
        )
          return
        setLoadError(false)
        const more = data.length === LIMIT
        if (reset) {
          const next = reconcileFirstPage(data, cached)
          const nextHasMore =
            cached &&
            data.length === LIMIT &&
            cached.sessions.length >= LIMIT &&
            data.every((item, index) => item.id === cached.sessions[index].id)
              ? cached.hasMore
              : more
          setSessions(next)
          setOffset(next.length)
          setHasMore(nextHasMore)
          if (scope)
            void writeSessionListCache(scope, {
              sessions: next,
              offset: next.length,
              hasMore: nextHasMore,
            })
        } else {
          setHasMore(more)
          setSessions((prev) => {
            if (
              request !== requestVersion.current ||
              mutationVersion !== listMutationVersion ||
              scopeRef.current !== scope ||
              authGeneration !== sessionListCacheGeneration()
            )
              return prev
            const ids = new Set(prev.map((s) => s.id))
            const next = [...prev, ...data.filter((s) => !ids.has(s.id))]
            if (scope)
              void writeSessionListCache(scope, {
                sessions: next,
                offset: next.length,
                hasMore: more,
              })
            return next
          })
          setOffset(currentOffset + data.length)
        }
      } catch (err) {
        if (
          request !== requestVersion.current ||
          mutationVersion !== listMutationVersion ||
          authGeneration !== sessionListCacheGeneration()
        )
          return
        console.error("Failed to fetch session history:", err)
        // The API reports 401 explicitly; transport/5xx failures after a
        // confirmed auth check must not erase a usable scoped snapshot.
        const unauthorized =
          err instanceof Error && /(?:^|\s)401$/.test(err.message)
        if (unauthorized || !scopeRef.current) {
          scopeRef.current = null
          void invalidateSessionListCache()
          setSessions([])
          setOffset(0)
          setHasMore(false)
        } else if (reset) {
          const cached = await readSessionListCache(scopeRef.current)
          if (
            request !== requestVersion.current ||
            mutationVersion !== listMutationVersion ||
            authGeneration !== sessionListCacheGeneration()
          )
            return
          if (cached) {
            setSessions(cached.sessions)
            setOffset(cached.offset)
            setHasMore(cached.hasMore)
          }
        }
        setLoadError(true)
      } finally {
        if (request === requestVersion.current) {
          loadingRef.current = false
          setIsLoadingMore(false)
        }
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
          !loadingRef.current &&
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
        listMutationVersion += 1
        requestVersion.current += 1
        loadingRef.current = true
        void invalidateSessionListCache(scopeRef.current ?? undefined)
        setHasMore(false)
        const deletedLoadedSession = sessions.some(
          (session) => session.id === id,
        )
        await deleteSession(id)
        if (id === activeSessionId) onDeletedActiveSession()
        await deleteCachedSession(id)
        loadingRef.current = false
        setIsLoadingMore(false)
        setHasMore(true)
        setSessions((prev) => prev.filter((s) => s.id !== id))
        if (deletedLoadedSession) {
          setOffset((prev) => Math.max(prev - 1, 0))
        }
        toast.success(t("chat.sessionDeleted"))
      } catch (err) {
        console.error("Failed to delete session:", err)
        toast.error(t("chat.sessionDeleteFailed"))
        void loadSessions(true)
      }
    },
    [activeSessionId, loadSessions, onDeletedActiveSession, sessions, t],
  )

  const handleDeleteSessions = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return []
      try {
        listMutationVersion += 1
        requestVersion.current += 1
        loadingRef.current = true
        void invalidateSessionListCache(scopeRef.current ?? undefined)
        setHasMore(false)
        const results: PromiseSettledResult<string>[] = []
        // The backend scans the same session directory per deletion; avoid
        // racing those scans and overwhelming a mobile connection.
        for (const id of ids) {
          try {
            await deleteSession(id)
            results.push({ status: "fulfilled", value: id })
          } catch (reason) {
            console.error("Failed to delete session:", reason)
            results.push({ status: "rejected", reason })
          }
        }
        const deletedIds = new Set(
          results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          ),
        )
        if (deletedIds.has(activeSessionId)) onDeletedActiveSession()
        await Promise.all([...deletedIds].map((id) => deleteCachedSession(id)))
        loadingRef.current = false
        setIsLoadingMore(false)
        setHasMore(true)
        setSessions((previous) =>
          previous.filter((session) => !deletedIds.has(session.id)),
        )
        setOffset((previous) =>
          Math.max(
            previous -
              sessions.filter((session) => deletedIds.has(session.id)).length,
            0,
          ),
        )
        if (deletedIds.size > 0)
          toast.success(`已删除 ${deletedIds.size} 段会话`)
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
    [activeSessionId, loadSessions, onDeletedActiveSession, sessions, t],
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
