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
import { invalidateSocket } from "@/features/chat/websocket"
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
const MAX_SESSION_SOCKETS = 5
const TERMINAL_IDLE_MS = 5 * 60 * 1000
type Confirmation = import("@/store/chat").PendingConfirmation & {
  expiresAt?: number
}
interface SessionSocket {
  socket: WebSocket
  sessionId: string
  busy: boolean
  everBusy: boolean
  terminalAt: number
  lastUsedAt: number
  finalSeen: boolean
  stopSeen: boolean
  terminal: boolean
  confirmations: Confirmation[]
  idleTimer: ReturnType<typeof setTimeout> | null
  confirmationTimer: ReturnType<typeof setTimeout> | null
}
const sessionSockets = new Map<string, SessionSocket>()
// Route visibility, not merely the selected session ID, determines foreground.
let chatDetailVisible = globalThis.location?.pathname === "/"
export function setChatDetailVisible(visible: boolean): void {
  if (chatDetailVisible === visible) return
  chatDetailVisible = visible
  const entry = sessionSockets.get(activeSessionIdRef)
  if (!entry) {
    if (
      visible &&
      initialized &&
      shouldMaintainConnection &&
      store.get(gatewayAtom).status === "running"
    )
      void connectChat()
    return
  }
  if (
    visible &&
    entry.socket.readyState !== WebSocket.OPEN &&
    entry.socket.readyState !== WebSocket.CONNECTING
  ) {
    if (
      initialized &&
      shouldMaintainConnection &&
      store.get(gatewayAtom).status === "running"
    )
      void connectChat()
    return
  }
  if (!visible && !entry.everBusy && !entry.terminalAt)
    entry.terminalAt = Date.now()
  scheduleIdle(entry)
}
// Lost uncertain turns block their own chat, not unrelated socket slots.
const blockedSessions = new Set<string>()
const liveSessionMessages = new Map<string, ChatMessage[]>()
// Successful server deletion permanently fences late local history/cache writes.
const deletedSessionIds = new Set<string>()
function isForeground(entry: SessionSocket) {
  return (
    sessionSockets.get(entry.sessionId) === entry &&
    !deletedSessionIds.has(entry.sessionId) &&
    entry.sessionId === activeSessionIdRef &&
    wsRef === entry.socket
  )
}
function clearIdle(entry: SessionSocket) {
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
  entry.idleTimer = null
}
function releaseEntry(entry: SessionSocket) {
  clearIdle(entry)
  if (entry.confirmationTimer !== null) clearTimeout(entry.confirmationTimer)
  entry.confirmationTimer = null
  if (sessionSockets.get(entry.sessionId) !== entry) return
  sessionSockets.delete(entry.sessionId)
  liveSessionMessages.delete(entry.sessionId)
  invalidateSocket(entry.socket)
}
function expireConfirmations(entry: SessionSocket) {
  if (entry.confirmationTimer !== null) clearTimeout(entry.confirmationTimer)
  entry.confirmationTimer = null
  entry.confirmations = entry.confirmations.filter(
    (item) => item.expiresAt === undefined || item.expiresAt > Date.now(),
  )
  if (
    entry.busy &&
    entry.finalSeen &&
    entry.stopSeen &&
    !entry.confirmations.length
  ) {
    entry.busy = false
    entry.terminal = true
    entry.terminalAt = Date.now()
  }
  const next = Math.min(
    ...entry.confirmations.map((item) => item.expiresAt ?? Infinity),
  )
  if (Number.isFinite(next))
    entry.confirmationTimer = setTimeout(
      () => {
        entry.confirmationTimer = null
        if (sessionSockets.get(entry.sessionId) !== entry) return
        expireConfirmations(entry)
        if (isForeground(entry)) showConfirmations(entry)
        scheduleIdle(entry)
      },
      Math.max(0, next - Date.now()),
    )
}
function scheduleIdle(entry: SessionSocket) {
  // Viewing this conversation cancels its idle countdown. The five minutes
  // begin only when an inactive session is confirmed idle; routine frames
  // (including pong) must not keep resetting the countdown.
  if (
    (chatDetailVisible && isForeground(entry)) ||
    entry.busy ||
    entry.confirmations.length ||
    (entry.everBusy && !entry.terminal)
  ) {
    clearIdle(entry)
    return
  }
  if (entry.idleTimer !== null) return
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null
    if (
      !(chatDetailVisible && isForeground(entry)) &&
      !entry.busy &&
      (!entry.everBusy || entry.terminal) &&
      !entry.confirmations.length &&
      sessionSockets.get(entry.sessionId) === entry
    ) {
      if (isForeground(entry)) {
        connectionGeneration += 1
        clearProbeTimer()
        clearReconnectTimer()
        wsRef = null
        isConnecting = false
        streamUpdates.flush()
        markPendingUnconfirmed()
        updateChatStore({ connectionState: "disconnected", isTyping: false })
      }
      releaseEntry(entry)
    }
  }, TERMINAL_IDLE_MS)
}
function trackSessionEvent(entry: SessionSocket, message: PicoMessage) {
  if (message.session_id && message.session_id !== entry.sessionId) return false
  const payload = message.payload ?? {}
  if (
    message.type === "confirmation.request" &&
    message.session_id === entry.sessionId
  ) {
    const requestId = payload.request_id ?? message.id
    const prompt = payload.prompt
    const expiresAt = Number(payload.expires_at)
    if (
      typeof requestId === "string" &&
      requestId.trim() &&
      requestId.length <= 256 &&
      typeof prompt === "string" &&
      prompt.trim() &&
      prompt.length <= 16_384 &&
      Number.isFinite(expiresAt) &&
      expiresAt > Date.now() &&
      !entry.confirmations.some((c) => c.requestId === requestId) &&
      entry.confirmations.length < 8
    ) {
      entry.confirmations.push({
        requestId,
        sessionId: entry.sessionId,
        prompt,
        status: "awaiting",
        expiresAt,
      })
      entry.busy = true
      entry.everBusy = true
      entry.terminal = false
    }
  } else if (
    message.type === "confirmation.resolved" &&
    message.session_id === entry.sessionId
  ) {
    const requestId = payload.request_id ?? message.id
    entry.confirmations = entry.confirmations.filter(
      (c) => c.requestId !== requestId,
    )
  }
  // A final normal answer and a typing stop together are required; a tool
  // update, pong or history snapshot is never evidence of turn completion.
  if (message.type === "typing.start") {
    entry.busy = true
    entry.everBusy = true
    entry.terminal = false
    entry.stopSeen = false
    entry.finalSeen = false
  } else if (
    (message.type === "message.create" || message.type === "message.update") &&
    payload.final === false
  ) {
    entry.busy = true
    entry.everBusy = true
    entry.terminal = false
  } else if (message.type === "typing.stop") {
    entry.stopSeen = true
  } else if (
    (message.type === "message.update" || message.type === "message.create") &&
    payload.final === true &&
    (!payload.kind || payload.kind === "normal")
  ) {
    entry.finalSeen = true
  } else if (message.type === "error") {
    entry.stopSeen = true
    entry.finalSeen = true
  }
  if (
    entry.busy &&
    entry.finalSeen &&
    entry.stopSeen &&
    entry.confirmations.length === 0
  ) {
    entry.busy = false
    entry.terminal = true
    entry.terminalAt = Date.now()
  }
  expireConfirmations(entry)
  scheduleIdle(entry)
  return true
}
function showConfirmations(entry: SessionSocket) {
  // A retained socket may have been suspended past the server's two-minute
  // confirmation deadline; never show a button that cannot still succeed.
  expireConfirmations(entry)
  updateChatStore({
    pendingConfirmations: entry.confirmations,
    isTyping: entry.busy,
  })
}

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
  if (
    state.activeSessionId !== cacheSessionIdRef ||
    deletedSessionIds.has(cacheSessionIdRef)
  )
    return
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
  const entry = sessionSockets.get(activeSessionIdRef)
  if (
    entry &&
    (entry.busy ||
      entry.confirmations.length ||
      (entry.everBusy && !entry.terminal))
  ) {
    updateChatStore({ connectionState: "error" })
    return
  }
  if (entry) {
    clearIdle(entry)
    sessionSockets.delete(activeSessionIdRef)
  }
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
    if (sessionSockets.get(activeSessionIdRef)?.busy) return
    reconnectStaleSocket()
    return
  }

  const startedAt = Date.now()
  try {
    socket.send(
      JSON.stringify({ type: "ping", session_id: activeSessionIdRef }),
    )
  } catch {
    if (!sessionSockets.get(activeSessionIdRef)?.busy) reconnectStaleSocket()
    return
  }

  clearProbeTimer()
  probeTimer = window.setTimeout(() => {
    probeTimer = null
    if (lastPongAt < startedAt && !sessionSockets.get(activeSessionIdRef)?.busy)
      reconnectStaleSocket()
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
  getLiveMessageRevision,
}: {
  socket: WebSocket
  generation: number
  sessionId: string
  getLiveMessageRevision: () => number
}) {
  const revisionAtStart = getLiveMessageRevision()
  try {
    const historyPage = await loadSessionMessages(sessionId)
    if (
      deletedSessionIds.has(sessionId) ||
      socket !== wsRef ||
      generation !== connectionGeneration ||
      sessionId !== activeSessionIdRef
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
      // History is a snapshot, not a turn-completion signal. A stream may have
      // started while the history request was in flight.
      ...(getLiveMessageRevision() === revisionAtStart &&
      !sessionSockets.get(sessionId)?.busy
        ? { isTyping: false }
        : {}),
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

function canEnterSession(sessionId: string): boolean {
  if (deletedSessionIds.has(sessionId)) return false
  if (blockedSessions.has(sessionId) || sessionSockets.has(sessionId))
    return true
  if (sessionSockets.size < MAX_SESSION_SOCKETS) return true
  // A five-minute grace is a promise, not an eviction preference. Do not
  // steal another session's socket before its timer expires, even if idle.
  toast.error(
    "Five Pico sessions are already connected. Wait for an idle socket's five-minute grace period before opening another.",
  )
  return false
}
function retainForegroundSocket() {
  // Detach the foreground state only. Never close a socket with an uncertain
  // turn: its confirmation is delivered solely over that original connection.
  clearProbeTimer()
  clearReconnectTimer()
  streamUpdates.flush()
  const old = sessionSockets.get(activeSessionIdRef)
  wsRef = null
  isConnecting = false
  connectionGeneration += 1
  if (old) {
    if (!old.everBusy) old.terminalAt = Date.now()
    scheduleIdle(old)
  }
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

  for (const entry of sessionSockets.values()) releaseEntry(entry)
  blockedSessions.clear()
  liveSessionMessages.clear()
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
  if (
    deletedSessionIds.has(activeSessionIdRef) ||
    blockedSessions.has(activeSessionIdRef)
  ) {
    updateChatStore({ connectionState: "error", pendingConfirmations: [] })
    return
  }
  if (store.get(gatewayAtom).status !== "running") {
    return
  }
  shouldMaintainConnection = true

  const retained = sessionSockets.get(activeSessionIdRef)
  if (
    retained &&
    (retained.socket.readyState === WebSocket.OPEN ||
      retained.socket.readyState === WebSocket.CONNECTING)
  ) {
    retained.lastUsedAt = Date.now()
    wsRef = retained.socket
    scheduleIdle(retained)
    isConnecting = retained.socket.readyState === WebSocket.CONNECTING
    updateChatStore({
      connectionState: isConnecting ? "connecting" : "connected",
    })
    showConfirmations(retained)
    if (!isConnecting) {
      updateChatStore({ isTyping: retained.busy })
      void reconcileSessionAfterConnect({
        socket: retained.socket,
        generation: connectionGeneration,
        sessionId: retained.sessionId,
        getLiveMessageRevision: () => 1,
      })
    }
    return
  }
  if (retained) {
    // A lost connection cannot restore the original confirmation/turn.
    // Keep unknown turns quarantined rather than silently opening a new turn.
    if (
      retained.busy ||
      retained.confirmations.length ||
      (retained.everBusy && !retained.terminal)
    ) {
      updateChatStore({ connectionState: "error", pendingConfirmations: [] })
      toast.error(
        "This Pico connection was lost during an uncertain turn. Refresh or explicitly disconnect before continuing; no request was replayed.",
      )
      return
    }
    releaseEntry(retained)
  }
  if (
    isConnecting ||
    (wsRef &&
      (wsRef.readyState === WebSocket.OPEN ||
        wsRef.readyState === WebSocket.CONNECTING))
  ) {
    return
  }

  if (!canEnterSession(activeSessionIdRef)) {
    updateChatStore({ connectionState: "error" })
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
    let liveMessageRevision = 0
    const entry: SessionSocket = {
      socket,
      sessionId,
      busy: false,
      everBusy: false,
      terminalAt: 0,
      lastUsedAt: Date.now(),
      finalSeen: false,
      stopSeen: false,
      terminal: false,
      confirmations: [],
      idleTimer: null,
      confirmationTimer: null,
    }

    if (generation !== connectionGeneration) {
      isConnecting = false
      invalidateSocket(socket)
      return
    }

    socket.onopen = () => {
      if (sessionSockets.get(sessionId) !== entry) return
      if (!isForeground(entry)) {
        entry.terminalAt = Date.now()
        scheduleIdle(entry)
        return
      }
      updateChatStore({
        connectionState: "connected",
        todoList: undefined,
        isTyping: entry.busy,
      })
      showConfirmations(entry)
      scheduleIdle(entry)
      isConnecting = false
      reconnectAttempts = 0
      lastPongAt = Date.now()
      void reconcileSessionAfterConnect({
        socket,
        generation: connectionGeneration,
        sessionId,
        getLiveMessageRevision: () => liveMessageRevision,
      })
    }

    socket.onmessage = (event) => {
      if (sessionSockets.get(sessionId) !== entry) return
      try {
        const message = JSON.parse(event.data) as PicoMessage
        if (!trackSessionEvent(entry, message)) return
        if (!isForeground(entry)) return
        if (message.type === "pong") {
          lastPongAt = Date.now()
          clearProbeTimer()
        } else {
          liveMessageRevision += 1
        }
        streamUpdates.receive(message, sessionId)
      } catch {
        console.warn("Non-JSON message from pico:", event.data)
      }
    }

    socket.onclose = (event) => {
      if (sessionSockets.get(sessionId) !== entry) return
      if (!isForeground(entry)) {
        // A closed background socket has no callbacks left. Only a proven
        // terminal turn may free its slot; an uncertain turn remains visible
        // as a blocked session rather than silently reconnecting.
        if (
          entry.busy ||
          entry.confirmations.length ||
          (entry.everBusy && !entry.terminal)
        )
          blockedSessions.add(sessionId)
        releaseEntry(entry)
        return
      }
      console.info("Pico WebSocket closed", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        visibility: document.visibilityState,
      })
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
      // Do not reconnect uncertain turns: a confirmation is bound to the
      // original socket and sends must never be replayed automatically.
      if ((entry.terminal || !entry.everBusy) && !entry.confirmations.length) {
        releaseEntry(entry)
        scheduleReconnect(generation, sessionId)
      } else {
        blockedSessions.add(sessionId)
        releaseEntry(entry)
        updateChatStore({ connectionState: "error" })
      }
    }

    socket.onerror = () => {
      if (!isForeground(entry)) {
        return
      }
      isConnecting = false
      updateChatStore({ connectionState: "connecting" })
      // Wait for onclose; reconnecting an unknown turn is unsafe.
    }

    sessionSockets.set(sessionId, entry)
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

// Call synchronously immediately after a successful server DELETE, before
// awaiting IndexedDB cleanup or running an active-session replacement.
export function evictDeletedChatSession(sessionId: string) {
  deletedSessionIds.add(sessionId)
  blockedSessions.delete(sessionId)
  liveSessionMessages.delete(sessionId)
  const entry = sessionSockets.get(sessionId)
  if (entry) releaseEntry(entry)
  if (cacheSessionIdRef === sessionId) clearCacheTimer()
  if (activeSessionIdRef === sessionId) {
    sessionSwitchGeneration += 1
    connectionGeneration += 1
    clearReconnectTimer()
    clearProbeTimer()
    streamUpdates.discard()
    wsRef = null
    isConnecting = false
    updateChatStore({
      connectionState: "disconnected",
      pendingConfirmations: [],
      isTyping: false,
      assistantActivity: undefined,
      todoList: undefined,
    })
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
      updateChatStore({
        hasHydratedActiveSession: true,
        isOpeningSession: false,
      })
    }
    return
  }

  hydratePromise = (async () => {
    resetCacheContext(storedSessionId)
    const cached = await loadCachedSession(storedSessionId)

    if (
      cached &&
      !deletedSessionIds.has(storedSessionId) &&
      getChatState().activeSessionId === storedSessionId
    ) {
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
        isOpeningSession: cached.messages.length === 0,
        hasHydratedActiveSession: true,
      }))
    }

    try {
      const historyPage = await loadSessionMessages(storedSessionId)
      const currentState = getChatState()
      if (
        deletedSessionIds.has(storedSessionId) ||
        currentState.activeSessionId !== storedSessionId
      ) {
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
        isOpeningSession: false,
        hasHydratedActiveSession: true,
      })
    } catch (error) {
      console.error("Failed to restore last session history:", error)

      const currentState = getChatState()
      if (
        deletedSessionIds.has(storedSessionId) ||
        currentState.activeSessionId !== storedSessionId
      ) {
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
            retainForegroundSocket()
            setActiveSessionId(latestSession.id)
            resetCacheContext(latestSession.id)
            cachedMessagesRef = latestPage.messages
            olderCursorRef = latestPage.nextBefore
            updateChatStore({
              messages: latestPage.messages,
              hasOlderMessages: latestPage.hasMore,
              isLoadingOlderMessages: false,
              isTyping: false,
              isOpeningSession: false,
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
        isOpeningSession: false,
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
    !sessionSockets
      .get(activeSessionIdRef)
      ?.confirmations.some(
        (item) =>
          item.requestId === requestId &&
          item.status === "awaiting" &&
          (item.expiresAt === undefined || item.expiresAt > Date.now()),
      ) ||
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
  const entry = sessionSockets.get(activeSessionIdRef)
  if (entry)
    entry.confirmations = entry.confirmations.map((item) =>
      item.requestId === requestId
        ? { ...item, status: "submitted", approved }
        : item,
    )
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

// A completed list is cleared by the server, not by optimistic local state.
// The socket's authenticated session decides which list may be cleared.
export function clearCompletedTodos(
  sessionId: string,
  expectedRevision: number,
): boolean {
  const socket = wsRef
  const state = getChatState()
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    state.connectionState !== "connected" ||
    activeSessionIdRef !== sessionId ||
    state.activeSessionId !== sessionId ||
    state.todoList?.sessionId !== sessionId ||
    state.todoList.revision !== expectedRevision ||
    state.todoList.items.length === 0 ||
    !state.todoList.items.every((item) => item.status === "completed")
  )
    return false
  try {
    socket.send(
      JSON.stringify({
        type: "todo.clear",
        id: `todo-clear-${crypto.randomUUID()}`,
        payload: { expected_revision: expectedRevision },
      }),
    )
    return true
  } catch (error) {
    console.error("Failed to request TODO clear:", error)
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
  if (
    !wsRef ||
    wsRef.readyState !== WebSocket.OPEN ||
    getChatState().activeSessionId !== activeSessionIdRef ||
    sessionSockets.get(activeSessionIdRef)?.socket !== wsRef
  ) {
    // A terminal foreground socket may have expired. Reconnect lazily, but
    // never queue or replay this send: the user must explicitly send again.
    if (
      !wsRef &&
      shouldMaintainConnection &&
      store.get(gatewayAtom).status === "running" &&
      !blockedSessions.has(activeSessionIdRef)
    )
      void connectChat()
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
  const entry = sessionSockets.get(activeSessionIdRef)
  if (entry) {
    entry.busy = true
    entry.everBusy = true
    entry.terminal = false
    entry.finalSeen = false
    entry.stopSeen = false
    clearIdle(entry)
  }

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

  if (!canEnterSession(sessionId)) return
  const generation = ++sessionSwitchGeneration
  streamUpdates.flush()
  persistCurrentSession()
  if (sessionSockets.has(activeSessionIdRef))
    liveSessionMessages.set(activeSessionIdRef, getChatState().messages)
  retainForegroundSocket()
  setActiveSessionId(sessionId)
  resetCacheContext(sessionId)
  updateChatStore({
    messages: liveSessionMessages.get(sessionId) ?? [],
    isTyping: sessionSockets.get(sessionId)?.busy ?? false,
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
    !deletedSessionIds.has(sessionId) &&
    sessionSwitchGeneration === generation &&
    activeSessionIdRef === sessionId
  const cachePromise = loadCachedSession(sessionId).then((cached) => {
    if (!isCurrent() || deletedSessionIds.has(sessionId) || !cached)
      return cached
    cachedMessagesRef = mergeHistoryMessages(cachedMessagesRef, cached.messages)
    hiddenCachedMessagesRef = cached.messages.slice(0, -CHAT_HISTORY_PAGE_SIZE)
    if (olderCursorRef === null) olderCursorRef = cached.nextBefore
    updateChatStore((prev) => ({
      messages: mergeHistoryMessages(
        liveSessionMessages.has(sessionId)
          ? cached.messages
              .slice(-CHAT_HISTORY_PAGE_SIZE)
              .filter(
                (message) =>
                  !prev.messages.some((live) => live.id === message.id),
              )
          : cached.messages.slice(-CHAT_HISTORY_PAGE_SIZE),
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
    if (!isCurrent() || deletedSessionIds.has(sessionId)) return
    cachedMessagesRef = mergeCachedMessages(
      mergeHistoryMessages(historyPage.messages, cachedMessagesRef),
      historyPage.messages,
    )
    if (olderCursorRef === null) olderCursorRef = historyPage.nextBefore
    updateChatStore((prev) => ({
      messages: mergeHistoryMessages(historyPage.messages, prev.messages),
      isTyping: sessionSockets.get(sessionId)?.busy ?? prev.isTyping,
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

  const sessionId = generateSessionId()
  if (!canEnterSession(sessionId)) return
  sessionSwitchGeneration += 1
  streamUpdates.flush()
  if (skipPersistDeleted) clearCacheTimer()
  else persistCurrentSession()
  if (sessionSockets.has(activeSessionIdRef))
    liveSessionMessages.set(activeSessionIdRef, getChatState().messages)
  retainForegroundSocket()
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
    updateChatStore({ hasHydratedActiveSession: true, isOpeningSession: false })
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
