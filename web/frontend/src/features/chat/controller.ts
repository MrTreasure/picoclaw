import { getDefaultStore } from "jotai"
import { toast } from "sonner"

import { getSessions } from "@/api/sessions"
import {
  CHAT_HISTORY_PAGE_SIZE,
  loadSessionMessages,
  mergeHistoryMessages,
} from "@/features/chat/history"
import {
  loadCachedSession,
  mergeCachedMessages,
  saveCachedSession,
} from "@/features/chat/local-cache"
import { type PicoMessage, handlePicoMessage } from "@/features/chat/protocol"
import {
  generateSessionId,
  normalizeSessionId,
  readStoredSessionId,
  writeStoredSessionId,
} from "@/features/chat/state"
import { createStreamUpdateBatcher } from "@/features/chat/stream-update-batcher"
import { invalidateSocket, isCurrentSocket } from "@/features/chat/websocket"
import i18n from "@/i18n"
import {
  type ChatAttachment,
  type ChatMessage,
  chatAtom,
  getChatState,
  updateChatStore,
} from "@/store/chat"
import { type GatewayState, gatewayAtom } from "@/store/gateway"
import { refreshGatewayState } from "@/store/gateway"

const store = getDefaultStore()

let wsRef: WebSocket | null = null
let isConnecting = false
let msgIdCounter = 0
let activeSessionIdRef = getChatState().activeSessionId
let initialized = false
let unsubscribeGateway: (() => void) | null = null
let unsubscribeChatCache: (() => void) | null = null
let hydratePromise: Promise<void> | null = null
let connectionGeneration = 0
let sessionSwitchGeneration = 0
let reconnectTimer: number | null = null
let probeTimer: number | null = null
let reconnectAttempts = 0
let shouldMaintainConnection = false
let lastPongAt = 0
let cacheTimer: number | null = null
let cacheSessionIdRef = activeSessionIdRef
let cachedMessagesRef: ChatMessage[] = []
let hiddenCachedMessagesRef: ChatMessage[] = []
let olderCursorRef: number | null = null
const sentRequestIDs = new Set<string>()
const streamUpdates = createStreamUpdateBatcher(handlePicoMessage)

function clearCacheTimer() {
  if (cacheTimer !== null) {
    window.clearTimeout(cacheTimer)
    cacheTimer = null
  }
}

function persistCurrentSession() {
  clearCacheTimer()
  const state = getChatState()
  if (state.activeSessionId !== cacheSessionIdRef) return
  // Preserve the uncertainty, not just the text. A restored pending send is
  // downgraded to unconfirmed by the cache loader; nothing is auto-resubmitted.
  cachedMessagesRef = mergeCachedMessages(
    mergeHistoryMessages(state.messages, cachedMessagesRef),
    state.messages,
  )
  void saveCachedSession({
    id: state.activeSessionId,
    messages: cachedMessagesRef,
    hasMore: state.hasOlderMessages,
    nextBefore: olderCursorRef,
    updatedAt: Date.now(),
  })
}

function scheduleSessionCache() {
  clearCacheTimer()
  cacheTimer = window.setTimeout(persistCurrentSession, 250)
}

function resetCacheContext(sessionId: string) {
  clearCacheTimer()
  cacheSessionIdRef = sessionId
  cachedMessagesRef = []
  hiddenCachedMessagesRef = []
  olderCursorRef = null
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function clearProbeTimer() {
  if (probeTimer !== null) {
    window.clearTimeout(probeTimer)
    probeTimer = null
  }
}

function markPendingUnconfirmed() {
  updateChatStore((prev) => ({
    messages: prev.messages.map((message) =>
      message.sendStatus === "pending"
        ? { ...message, sendStatus: "unconfirmed" as const }
        : message,
    ),
  }))
}

function reconnectStaleSocket() {
  if (
    !shouldMaintainConnection ||
    store.get(gatewayAtom).status !== "running"
  ) {
    return
  }
  connectionGeneration += 1
  clearReconnectTimer()
  clearProbeTimer()
  const socket = wsRef
  wsRef = null
  isConnecting = false
  invalidateSocket(socket)
  streamUpdates.discard()
  markPendingUnconfirmed()
  updateChatStore({
    pendingConfirmations: [],
    todoList: undefined,
    connectionState: "connecting",
  })
  void connectChat()
}

function probeActiveConnection() {
  if (document.visibilityState === "hidden") return
  const socket = wsRef
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    reconnectStaleSocket()
    return
  }

  const startedAt = Date.now()
  try {
    socket.send(
      JSON.stringify({ type: "ping", session_id: activeSessionIdRef }),
    )
  } catch {
    reconnectStaleSocket()
    return
  }

  clearProbeTimer()
  probeTimer = window.setTimeout(() => {
    probeTimer = null
    if (lastPongAt < startedAt) reconnectStaleSocket()
  }, 4_000)
}

function handlePageResume() {
  if (document.visibilityState === "visible") probeActiveConnection()
}

function shouldReconnectFor(generation: number, sessionId: string): boolean {
  return (
    shouldMaintainConnection &&
    generation === connectionGeneration &&
    sessionId === activeSessionIdRef &&
    store.get(gatewayAtom).status === "running"
  )
}

function scheduleReconnect(generation: number, sessionId: string) {
  if (!shouldReconnectFor(generation, sessionId) || reconnectTimer !== null) {
    return
  }

  const delay = Math.min(1000 * 2 ** reconnectAttempts, 5000)
  reconnectAttempts += 1
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    if (!shouldReconnectFor(generation, sessionId)) {
      return
    }
    void connectChat()
  }, delay)
}

async function reconcileSessionAfterConnect({
  socket,
  generation,
  sessionId,
}: {
  socket: WebSocket
  generation: number
  sessionId: string
}) {
  try {
    const historyPage = await loadSessionMessages(sessionId)
    if (
      !isCurrentSocket({
        socket,
        currentSocket: wsRef,
        generation,
        currentGeneration: connectionGeneration,
        sessionId,
        currentSessionId: activeSessionIdRef,
      })
    ) {
      return
    }

    cachedMessagesRef = mergeHistoryMessages(
      historyPage.messages,
      cachedMessagesRef,
    )
    updateChatStore((prev) => ({
      messages: mergeHistoryMessages(historyPage.messages, prev.messages),
      hasOlderMessages:
        hiddenCachedMessagesRef.length > 0 || historyPage.hasMore,
      isTyping: false,
    }))
    if (olderCursorRef === null) {
      olderCursorRef = historyPage.nextBefore
    }
  } catch (error) {
    // Reconciliation is best-effort. Keep the live socket usable even when the
    // history endpoint is temporarily unavailable.
    console.warn("Failed to reconcile session history after reconnect:", error)
  }
}

function setActiveSessionId(sessionId: string) {
  activeSessionIdRef = sessionId
  writeStoredSessionId(sessionId)
  updateChatStore({ activeSessionId: sessionId, todoList: undefined })
}

function disconnectChatInternal({
  clearDesiredConnection,
}: {
  clearDesiredConnection: boolean
}) {
  connectionGeneration += 1
  clearReconnectTimer()
  clearProbeTimer()

  if (clearDesiredConnection) {
    shouldMaintainConnection = false
  }

  const socket = wsRef
  wsRef = null
  isConnecting = false

  invalidateSocket(socket)
  streamUpdates.discard()
  markPendingUnconfirmed()

  updateChatStore({
    pendingConfirmations: [],
    todoList: undefined,
    connectionState: "disconnected",
    isTyping: false,
    assistantActivity: undefined,
  })
}

export async function connectChat() {
  if (store.get(gatewayAtom).status !== "running") {
    return
  }

  if (
    isConnecting ||
    (wsRef &&
      (wsRef.readyState === WebSocket.OPEN ||
        wsRef.readyState === WebSocket.CONNECTING))
  ) {
    return
  }

  const generation = connectionGeneration + 1
  connectionGeneration = generation
  isConnecting = true
  clearReconnectTimer()
  updateChatStore({ connectionState: "connecting" })

  try {
    const sessionId = activeSessionIdRef

    if (generation !== connectionGeneration) {
      isConnecting = false
      return
    }

    const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:"
    const wsUrl = `${wsScheme}//${window.location.host}/pico/ws`
    const url = `${wsUrl}?session_id=${encodeURIComponent(sessionId)}`
    const socket = new WebSocket(url)

    if (generation !== connectionGeneration) {
      isConnecting = false
      invalidateSocket(socket)
      return
    }

    socket.onopen = () => {
      if (
        !isCurrentSocket({
          socket,
          currentSocket: wsRef,
          generation,
          currentGeneration: connectionGeneration,
          sessionId,
          currentSessionId: activeSessionIdRef,
        })
      ) {
        return
      }
      updateChatStore({ connectionState: "connected", todoList: undefined })
      isConnecting = false
      reconnectAttempts = 0
      lastPongAt = Date.now()
      void reconcileSessionAfterConnect({ socket, generation, sessionId })
    }

    socket.onmessage = (event) => {
      if (
        !isCurrentSocket({
          socket,
          currentSocket: wsRef,
          generation,
          currentGeneration: connectionGeneration,
          sessionId,
          currentSessionId: activeSessionIdRef,
        })
      ) {
        return
      }

      try {
        const message = JSON.parse(event.data) as PicoMessage
        if (message.type === "pong") {
          lastPongAt = Date.now()
          clearProbeTimer()
        }
        streamUpdates.receive(message, sessionId)
      } catch {
        console.warn("Non-JSON message from pico:", event.data)
      }
    }

    socket.onclose = () => {
      if (
        !isCurrentSocket({
          socket,
          currentSocket: wsRef,
          generation,
          currentGeneration: connectionGeneration,
          sessionId,
          currentSessionId: activeSessionIdRef,
        })
      ) {
        return
      }
      wsRef = null
      isConnecting = false
      streamUpdates.discard()
      markPendingUnconfirmed()
      updateChatStore({ pendingConfirmations: [], todoList: undefined })
      updateChatStore(
        document.visibilityState === "hidden"
          ? { isTyping: false, assistantActivity: undefined }
          : {
              connectionState: "connecting",
              isTyping: false,
              assistantActivity: undefined,
            },
      )
      scheduleReconnect(generation, sessionId)
    }

    socket.onerror = () => {
      if (
        !isCurrentSocket({
          socket,
          currentSocket: wsRef,
          generation,
          currentGeneration: connectionGeneration,
          sessionId,
          currentSessionId: activeSessionIdRef,
        })
      ) {
        return
      }
      isConnecting = false
      updateChatStore({ connectionState: "connecting" })
      scheduleReconnect(generation, sessionId)
    }

    wsRef = socket
  } catch (error) {
    if (generation !== connectionGeneration) {
      isConnecting = false
      return
    }
    console.error("Failed to connect to pico:", error)
    updateChatStore({ connectionState: "error" })
    isConnecting = false
    scheduleReconnect(generation, activeSessionIdRef)
  }
}

export function disconnectChat() {
  disconnectChatInternal({ clearDesiredConnection: true })
}

export async function hydrateActiveSession() {
  if (hydratePromise) {
    return hydratePromise
  }

  const state = getChatState()
  const storedSessionId = readStoredSessionId()

  if (
    !storedSessionId ||
    state.hasHydratedActiveSession ||
    storedSessionId !== state.activeSessionId
  ) {
    if (!state.hasHydratedActiveSession) {
      updateChatStore({ hasHydratedActiveSession: true })
    }
    return
  }

  hydratePromise = (async () => {
    resetCacheContext(storedSessionId)
    const cached = await loadCachedSession(storedSessionId)

    if (cached && getChatState().activeSessionId === storedSessionId) {
      cachedMessagesRef = cached.messages
      hiddenCachedMessagesRef = cached.messages.slice(
        0,
        -CHAT_HISTORY_PAGE_SIZE,
      )
      olderCursorRef = cached.nextBefore
      const recentCachedMessages = cached.messages.slice(
        -CHAT_HISTORY_PAGE_SIZE,
      )
      updateChatStore((prev) => ({
        messages: mergeHistoryMessages(recentCachedMessages, prev.messages),
        hasOlderMessages: hiddenCachedMessagesRef.length > 0 || cached.hasMore,
        isTyping: false,
        hasHydratedActiveSession: true,
      }))
    }

    try {
      const historyPage = await loadSessionMessages(storedSessionId)
      const currentState = getChatState()
      if (currentState.activeSessionId !== storedSessionId) {
        return
      }

      cachedMessagesRef = mergeCachedMessages(
        mergeHistoryMessages(historyPage.messages, cachedMessagesRef),
        historyPage.messages,
      )
      if (olderCursorRef === null) {
        olderCursorRef = historyPage.nextBefore
      }
      updateChatStore({
        messages: mergeHistoryMessages(
          historyPage.messages,
          currentState.messages,
        ),
        hasOlderMessages:
          hiddenCachedMessagesRef.length > 0 || historyPage.hasMore,
        isTyping: false,
        hasHydratedActiveSession: true,
      })
    } catch (error) {
      console.error("Failed to restore last session history:", error)

      const currentState = getChatState()
      if (currentState.activeSessionId !== storedSessionId) {
        return
      }

      // Older releases could erase the last-session pointer after one failed
      // history request and replace it with a fresh empty ID. Recover from that
      // state by selecting the newest durable Pico session once; the chosen ID
      // is then persisted normally for all later reconnects.
      if (!cached && currentState.messages.length === 0) {
        try {
          const [latestSession] = await getSessions(0, 1, "pico")
          if (latestSession && latestSession.id !== storedSessionId) {
            const latestPage = await loadSessionMessages(latestSession.id)
            disconnectChatInternal({ clearDesiredConnection: false })
            setActiveSessionId(latestSession.id)
            resetCacheContext(latestSession.id)
            cachedMessagesRef = latestPage.messages
            olderCursorRef = latestPage.nextBefore
            updateChatStore({
              messages: latestPage.messages,
              hasOlderMessages: latestPage.hasMore,
              isLoadingOlderMessages: false,
              isTyping: false,
              hasHydratedActiveSession: true,
            })
            if (store.get(gatewayAtom).status === "running") {
              shouldMaintainConnection = true
              await connectChat()
            }
            return
          }
        } catch (latestError) {
          console.warn("Failed to discover latest chat session:", latestError)
        }
      }

      updateChatStore({
        isTyping: false,
        hasHydratedActiveSession: true,
      })
    }
  })().finally(() => {
    hydratePromise = null
  })

  return hydratePromise
}

export async function loadOlderChatMessages(): Promise<boolean> {
  const state = getChatState()
  if (state.isLoadingOlderMessages || !state.hasOlderMessages) return false

  const sessionId = state.activeSessionId
  updateChatStore({ isLoadingOlderMessages: true })
  try {
    if (hiddenCachedMessagesRef.length > 0) {
      const start = Math.max(
        0,
        hiddenCachedMessagesRef.length - CHAT_HISTORY_PAGE_SIZE,
      )
      const page = hiddenCachedMessagesRef.slice(start)
      hiddenCachedMessagesRef = hiddenCachedMessagesRef.slice(0, start)
      if (getChatState().activeSessionId !== sessionId) return false
      updateChatStore((prev) => ({
        messages: mergeHistoryMessages(page, prev.messages),
        hasOlderMessages:
          hiddenCachedMessagesRef.length > 0 || olderCursorRef !== null,
        isLoadingOlderMessages: false,
      }))
      return true
    }

    if (olderCursorRef === null) {
      updateChatStore({
        hasOlderMessages: false,
        isLoadingOlderMessages: false,
      })
      return false
    }

    const historyPage = await loadSessionMessages(sessionId, olderCursorRef)
    if (getChatState().activeSessionId !== sessionId) return false
    olderCursorRef = historyPage.nextBefore
    cachedMessagesRef = mergeCachedMessages(
      mergeHistoryMessages(historyPage.messages, cachedMessagesRef),
      historyPage.messages,
    )
    updateChatStore((prev) => ({
      messages: mergeHistoryMessages(historyPage.messages, prev.messages),
      hasOlderMessages: historyPage.hasMore,
      isLoadingOlderMessages: false,
    }))
    persistCurrentSession()
    return historyPage.messages.length > 0
  } catch (error) {
    console.warn("Failed to load older chat messages:", error)
    if (getChatState().activeSessionId === sessionId) {
      updateChatStore({ isLoadingOlderMessages: false })
    }
    return false
  }
}

export function respondToConfirmation(
  requestId: string,
  approved: boolean,
): boolean {
  const socket = wsRef
  const state = getChatState()
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    state.connectionState !== "connected" ||
    state.activeSessionId !== activeSessionIdRef ||
    !state.pendingConfirmations.some(
      (item) =>
        item.requestId === requestId &&
        item.sessionId === activeSessionIdRef &&
        item.status === "awaiting",
    )
  )
    return false

  // Lock synchronously before sending, preventing a second click. An ambiguous
  // transport failure must not make a potentially delivered decision retryable.
  updateChatStore((prev) => ({
    pendingConfirmations: prev.pendingConfirmations.map((item) =>
      item.requestId === requestId && item.sessionId === activeSessionIdRef
        ? { ...item, status: "submitted" as const, approved }
        : item,
    ),
  }))
  try {
    socket.send(
      JSON.stringify({
        type: "confirmation.respond",
        id: requestId,
        session_id: activeSessionIdRef,
        payload: { request_id: requestId, approved, accepted: approved },
      }),
    )
    return true
  } catch (error) {
    console.error("Failed to send confirmation response:", error)
    // Do not automatically resend an ambiguous decision.
    return false
  }
}

interface SendChatMessageInput {
  content: string
  attachments?: ChatAttachment[]
  messageId?: string
}

export function sendChatMessage({
  content,
  attachments = [],
  messageId,
}: SendChatMessageInput) {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    console.warn("WebSocket not connected")
    return false
  }

  const normalizedContent = content.trim()
  const normalizedAttachments = attachments
    .filter((attachment) => attachment.url || attachment.mediaRef)
    .map((attachment) => ({ ...attachment }))

  if (normalizedAttachments.some((attachment) => !attachment.mediaRef)) {
    console.error("Attachment upload is incomplete; refusing inline media")
    return false
  }

  if (!normalizedContent && normalizedAttachments.length === 0) {
    return false
  }

  const socket = wsRef
  const id = messageId || `msg-${++msgIdCounter}-${Date.now()}`
  if (sentRequestIDs.has(id)) return false
  sentRequestIDs.add(id)

  updateChatStore((prev) => ({
    messages: [
      ...prev.messages,
      {
        id,
        role: "user",
        content: normalizedContent,
        attachments:
          normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
        timestamp: Date.now(),
        sendStatus: "pending",
      },
    ],
    isTyping: true,
    assistantActivity: "thinking",
  }))

  try {
    const payload: Record<string, unknown> = {
      content: normalizedContent,
      media_refs: normalizedAttachments
        .map((attachment) => attachment.mediaRef)
        .filter((ref): ref is string => Boolean(ref)),
    }

    socket.send(
      JSON.stringify({
        type: "message.send",
        id,
        payload,
      }),
    )
    return true
  } catch (error) {
    // Keep the request ID reserved: retrying the same ID can duplicate a
    // request if a transport reports an ambiguous send outcome.
    console.error("Failed to send pico message:", error)
    updateChatStore((prev) => ({
      messages: prev.messages.map((message) =>
        message.id === id
          ? {
              ...message,
              sendStatus: "failed" as const,
              sendError: "Socket send failed",
            }
          : message,
      ),
      isTyping: false,
      assistantActivity: undefined,
    }))
    return false
  }
}

export async function switchChatSession(sessionId: string) {
  sessionId = normalizeSessionId(sessionId)
  if (!sessionId) return

  if (sessionId === activeSessionIdRef) {
    shouldMaintainConnection = true
    if (store.get(gatewayAtom).status === "running") {
      void connectChat()
    }
    return
  }

  const generation = ++sessionSwitchGeneration
  persistCurrentSession()
  disconnectChatInternal({ clearDesiredConnection: false })
  setActiveSessionId(sessionId)
  resetCacheContext(sessionId)
  updateChatStore({
    messages: [],
    isTyping: false,
    assistantActivity: undefined,
    isOpeningSession: true,
    hasHydratedActiveSession: true,
    hasOlderMessages: false,
    isLoadingOlderMessages: false,
    contextUsage: undefined,
  })
  if (store.get(gatewayAtom).status === "running") {
    shouldMaintainConnection = true
    void connectChat()
  }

  const isCurrent = () =>
    sessionSwitchGeneration === generation && activeSessionIdRef === sessionId
  const cachePromise = loadCachedSession(sessionId).then((cached) => {
    if (!isCurrent() || !cached) return cached
    cachedMessagesRef = mergeHistoryMessages(cachedMessagesRef, cached.messages)
    hiddenCachedMessagesRef = cached.messages.slice(0, -CHAT_HISTORY_PAGE_SIZE)
    if (olderCursorRef === null) olderCursorRef = cached.nextBefore
    updateChatStore((prev) => ({
      messages: mergeHistoryMessages(
        cached.messages.slice(-CHAT_HISTORY_PAGE_SIZE),
        prev.messages,
      ),
      isOpeningSession: cached.messages.length === 0,
      hasOlderMessages:
        prev.hasOlderMessages ||
        hiddenCachedMessagesRef.length > 0 ||
        cached.hasMore,
    }))
    return cached
  })
  const historyPromise = loadSessionMessages(sessionId).then((historyPage) => {
    if (!isCurrent()) return
    cachedMessagesRef = mergeCachedMessages(
      mergeHistoryMessages(historyPage.messages, cachedMessagesRef),
      historyPage.messages,
    )
    if (olderCursorRef === null) olderCursorRef = historyPage.nextBefore
    updateChatStore((prev) => ({
      messages: mergeHistoryMessages(historyPage.messages, prev.messages),
      isOpeningSession: false,
      hasOlderMessages:
        hiddenCachedMessagesRef.length > 0 || historyPage.hasMore,
    }))
  })
  await Promise.allSettled([cachePromise, historyPromise]).then((results) => {
    if (!isCurrent()) return
    updateChatStore({ isOpeningSession: false })
    if (results[1].status !== "rejected") return
    console.error("Failed to load session history:", results[1].reason)
    if (getChatState().messages.length === 0)
      toast.error(i18n.t("chat.historyOpenFailed"))
  })
}

export async function newChatSession(
  force = false,
  skipPersistDeleted = false,
) {
  if (!force && getChatState().messages.length === 0) {
    return
  }

  sessionSwitchGeneration += 1
  if (skipPersistDeleted) clearCacheTimer()
  else persistCurrentSession()
  disconnectChatInternal({ clearDesiredConnection: false })
  const sessionId = generateSessionId()
  setActiveSessionId(sessionId)
  resetCacheContext(sessionId)
  updateChatStore({
    messages: [],
    isOpeningSession: false,
    isTyping: false,
    assistantActivity: undefined,
    hasHydratedActiveSession: true,
    hasOlderMessages: false,
    isLoadingOlderMessages: false,
    contextUsage: undefined,
  })

  if (store.get(gatewayAtom).status === "running") {
    shouldMaintainConnection = true
    await connectChat()
  }
}

export function initializeChatStore() {
  if (initialized) {
    return
  }

  initialized = true
  activeSessionIdRef = getChatState().activeSessionId
  let lastGatewayStatus: GatewayState | null = null

  const syncConnectionWithGateway = (force: boolean = false) => {
    const gatewayStatus = store.get(gatewayAtom).status
    if (!force && gatewayStatus === lastGatewayStatus) {
      return
    }
    lastGatewayStatus = gatewayStatus

    if (gatewayStatus === "running") {
      shouldMaintainConnection = true
      void connectChat()
      return
    }

    if (gatewayStatus === "stopped" || gatewayStatus === "error") {
      disconnectChatInternal({ clearDesiredConnection: true })
    }
  }

  unsubscribeGateway = store.sub(gatewayAtom, syncConnectionWithGateway)
  unsubscribeChatCache = store.sub(chatAtom, scheduleSessionCache)
  document.addEventListener("visibilitychange", handlePageResume)
  window.addEventListener("pageshow", handlePageResume)
  window.addEventListener("online", handlePageResume)

  // Start the status request and history hydration together. The active
  // session ID is known before either request begins, and hydrateActiveSession
  // merges any messages that arrive over the live socket in the meantime.
  void refreshGatewayState({ force: true }).then(() => {
    if (initialized) {
      syncConnectionWithGateway(true)
    }
  })

  if (!readStoredSessionId()) {
    updateChatStore({ hasHydratedActiveSession: true })
    syncConnectionWithGateway(true)
    return
  }

  void hydrateActiveSession()
}

export function teardownChatStore() {
  persistCurrentSession()
  unsubscribeGateway?.()
  unsubscribeGateway = null
  unsubscribeChatCache?.()
  unsubscribeChatCache = null
  clearCacheTimer()
  document.removeEventListener("visibilitychange", handlePageResume)
  window.removeEventListener("pageshow", handlePageResume)
  window.removeEventListener("online", handlePageResume)
  initialized = false
  sentRequestIDs.clear()
  disconnectChat()
}
