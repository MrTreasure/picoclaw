import { IconArrowDown } from "@tabler/icons-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useAtom } from "jotai"
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslation } from "react-i18next"

import { AssistantMessage } from "@/components/chat/assistant-message"
import {
  ChatComposer,
  type ChatInputDisabledReason,
} from "@/components/chat/chat-composer"
import { ChatControls } from "@/components/chat/chat-controls"
import { ChatEmptyState } from "@/components/chat/chat-empty-state"
import { TypingIndicator } from "@/components/chat/typing-indicator"
import { UserMessage } from "@/components/chat/user-message"
import { Button } from "@/components/ui/button"
import { CHAT_FILE_ACCEPT, uploadChatFiles } from "@/features/chat/file-upload"
import {
  CHAT_IMAGE_ACCEPT,
  buildChatImageAttachments,
  getTransferredFiles,
  hasFileTransfer,
} from "@/features/chat/image-input"
import { shouldShowTypingIndicator } from "@/features/chat/typing-indicator-state"
import { useChatModels } from "@/hooks/use-chat-models"
import { useGateway } from "@/hooks/use-gateway"
import { usePicoChat } from "@/hooks/use-pico-chat"
import type { ConnectionState } from "@/store/chat"
import type { ChatAttachment } from "@/store/chat"
import {
  assistantDetailVisibilityAtom,
  shouldShowAssistantMessage,
} from "@/store/chat"
import type { GatewayState } from "@/store/gateway"

function resolveChatInputDisabledReason({
  hasDefaultModel,
  connectionState,
  gatewayState,
}: {
  hasDefaultModel: boolean
  connectionState: ConnectionState
  gatewayState: GatewayState
}): ChatInputDisabledReason | null {
  if (gatewayState === "unknown") {
    return "gatewayUnknown"
  }

  if (gatewayState === "starting") {
    return "gatewayStarting"
  }

  if (gatewayState === "restarting") {
    return "gatewayRestarting"
  }

  if (gatewayState === "stopping") {
    return "gatewayStopping"
  }

  if (gatewayState === "stopped") {
    return "gatewayStopped"
  }

  if (gatewayState === "error") {
    return "gatewayError"
  }

  if (connectionState === "connecting") {
    return "websocketConnecting"
  }

  if (connectionState === "idle") {
    return "websocketConnecting"
  }

  if (connectionState === "error") {
    return "websocketError"
  }

  if (connectionState === "disconnected") {
    return "websocketDisconnected"
  }

  if (!hasDefaultModel) {
    return "noDefaultModel"
  }

  return null
}

export function ChatPage() {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const documentInputRef = useRef<HTMLInputElement>(null)
  const draftMessageIdRef = useRef(`msg-${crypto.randomUUID()}`)
  const dragDepthRef = useRef(0)
  const loadingOlderRef = useRef(false)
  const olderScrollAnchorRef = useRef<{ height: number; top: number } | null>(
    null,
  )
  const didInitialScrollRef = useRef(false)
  const shouldFollowOutputRef = useRef(true)
  const touchStartYRef = useRef<number | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [input, setInput] = useState("")
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [isDragActive, setIsDragActive] = useState(false)
  const [expandedDetailMessageIds, setExpandedDetailMessageIds] = useState<
    Set<string>
  >(() => new Set())
  const [assistantDetailVisibility, setAssistantDetailVisibility] = useAtom(
    assistantDetailVisibilityAtom,
  )

  const {
    messages,
    activeSessionId,
    connectionState,
    isTyping,
    assistantActivity,
    contextUsage,
    isOpeningSession,
    hasOlderMessages,
    isLoadingOlderMessages,
    loadOlderMessages,
    sendMessage,
  } = usePicoChat()

  const { state: gwState } = useGateway()
  const isGatewayRunning = gwState === "running"

  const {
    defaultModelName,
    hasAvailableModels,
    chatModels,
    thinkingLevel,
    settingDefault,
    settingThinkingLevel,
    handleSetDefault,
    handleSetThinkingLevel,
  } = useChatModels({ isConnected: isGatewayRunning })
  const hasDefaultModel = Boolean(defaultModelName)
  const inputDisabledReason = resolveChatInputDisabledReason({
    hasDefaultModel,
    connectionState,
    gatewayState: gwState,
  })
  const canInput = inputDisabledReason === null
  const canCompose = true

  const visibleMessages = useMemo(
    () =>
      messages.filter((message) =>
        shouldShowAssistantMessage(assistantDetailVisibility, message.kind),
      ),
    [assistantDetailVisibility, messages],
  )
  const showTypingIndicator = shouldShowTypingIndicator(
    visibleMessages,
    isTyping,
    assistantActivity,
    expandedDetailMessageIds,
  )
  // Keep the live end of the conversation in normal flow. Streaming text can
  // grow between virtualizer measurements, which otherwise lets absolute rows
  // overlap the typing indicator or the next message.
  const liveStartIndex = Math.max(0, visibleMessages.length - 10)
  const virtualMessages = visibleMessages.slice(0, liveStartIndex)
  const liveMessages = visibleMessages.slice(liveStartIndex)
  const handleDetailExpandedChange = useCallback(
    (messageId: string, expanded: boolean) => {
      setExpandedDetailMessageIds((previous) => {
        const next = new Set(previous)
        if (expanded) {
          next.add(messageId)
        } else {
          next.delete(messageId)
        }
        return next
      })
    },
    [],
  )
  // Variable-height chat bubbles require the virtualizer's imperative
  // measurements; this hook intentionally opts out of React Compiler memoizing.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtualMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      virtualMessages[index]?.role === "assistant" ? 180 : 92,
    getItemKey: (index) => virtualMessages[index]?.id ?? index,
    overscan: 6,
    useAnimationFrameWithResizeObserver: true,
  })

  useEffect(() => {
    didInitialScrollRef.current = false
    loadingOlderRef.current = false
    olderScrollAnchorRef.current = null
    shouldFollowOutputRef.current = true
    setIsAtBottom(true)
    setExpandedDetailMessageIds(new Set())
  }, [activeSessionId])

  const syncScrollState = (element: HTMLDivElement) => {
    const { clientHeight, scrollHeight, scrollTop } = element
    const atBottom = scrollHeight - scrollTop <= clientHeight + 48
    setIsAtBottom(atBottom)
    return atBottom
  }

  const handleScroll = async (e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget
    const atBottom = syncScrollState(element)
    if (atBottom && !loadingOlderRef.current)
      shouldFollowOutputRef.current = true
    else if (didInitialScrollRef.current) shouldFollowOutputRef.current = false
    if (
      !didInitialScrollRef.current ||
      element.scrollTop > 160 ||
      !hasOlderMessages ||
      isLoadingOlderMessages ||
      loadingOlderRef.current
    ) {
      return
    }

    loadingOlderRef.current = true
    shouldFollowOutputRef.current = false
    olderScrollAnchorRef.current = {
      height: element.scrollHeight,
      top: element.scrollTop,
    }
    const loaded = await loadOlderMessages()
    if (!loaded) olderScrollAnchorRef.current = null
    requestAnimationFrame(() => {
      const current = scrollRef.current
      const anchor = olderScrollAnchorRef.current
      if (loaded && current && anchor) {
        current.scrollTop = current.scrollHeight - anchor.height + anchor.top
      }
      olderScrollAnchorRef.current = null
      loadingOlderRef.current = false
    })
  }

  const scrollToBottom = () => {
    const element = scrollRef.current
    if (!element) return
    shouldFollowOutputRef.current = true
    setIsAtBottom(true)
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    })
  }

  useLayoutEffect(() => {
    const element = scrollRef.current
    const anchor = olderScrollAnchorRef.current
    if (anchor && element) {
      element.scrollTop = element.scrollHeight - anchor.height + anchor.top
      syncScrollState(element)
      return
    }
    if (!shouldFollowOutputRef.current || isOpeningSession) {
      return
    }

    if (element) {
      element.scrollTop = element.scrollHeight
      didInitialScrollRef.current = true
      syncScrollState(element)
    }
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current
      if (
        !element ||
        !shouldFollowOutputRef.current ||
        olderScrollAnchorRef.current
      )
        return
      element.scrollTop = element.scrollHeight
      didInitialScrollRef.current = true
      syncScrollState(element)
    })

    return () => cancelAnimationFrame(frame)
  }, [messages, isTyping, isOpeningSession, virtualizer])

  useEffect(() => {
    const content = scrollContentRef.current
    if (!content || typeof ResizeObserver === "undefined") {
      return
    }

    let frame: number | undefined
    const observer = new ResizeObserver(() => {
      if (!shouldFollowOutputRef.current || olderScrollAnchorRef.current) {
        return
      }

      if (frame !== undefined) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(() => {
        const element = scrollRef.current
        if (
          !element ||
          !shouldFollowOutputRef.current ||
          olderScrollAnchorRef.current
        )
          return
        element.scrollTop = element.scrollHeight
        didInitialScrollRef.current = true
        syncScrollState(element)
      })
    })

    observer.observe(content)
    return () => {
      observer.disconnect()
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
      }
    }
  }, [])

  const handleSend = () => {
    if ((!input.trim() && attachments.length === 0) || !canInput) return
    shouldFollowOutputRef.current = true
    setIsAtBottom(true)
    if (
      sendMessage({
        content: input,
        attachments,
        messageId: draftMessageIdRef.current,
      })
    ) {
      setInput("")
      setAttachments([])
      draftMessageIdRef.current = `msg-${crypto.randomUUID()}`
    }
  }

  const handleOpenGallery = () => {
    if (!canCompose) return
    galleryInputRef.current?.click()
  }

  const handleOpenCamera = () => {
    if (!canCompose) return
    cameraInputRef.current?.click()
  }

  const handleOpenFiles = () => {
    if (!canCompose) return
    documentInputRef.current?.click()
  }

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index))
  }

  const appendImageFiles = async (files: readonly File[]) => {
    if (!canCompose || files.length === 0) {
      return
    }

    const nextAttachments = await buildChatImageAttachments(
      files,
      t,
      activeSessionId,
      draftMessageIdRef.current,
    )
    if (nextAttachments.length === 0) {
      return
    }

    setAttachments((prev) => [...prev, ...nextAttachments])
  }

  const handleImageSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ""

    if (files.length === 0) {
      return
    }

    await appendImageFiles(files)
  }

  const handleDocumentSelection = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (files.length === 0) return

    const uploaded = await uploadChatFiles(
      files,
      activeSessionId,
      draftMessageIdRef.current,
    )
    if (uploaded.length > 0) {
      setAttachments((previous) => [...previous, ...uploaded])
    }
  }

  const resetDragState = () => {
    dragDepthRef.current = 0
    setIsDragActive(false)
  }

  const handleComposerPaste = async (
    event: ClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const files = getTransferredFiles(event.clipboardData)
    if (files.length === 0) {
      return
    }

    await appendImageFiles(files)
  }

  const handleComposerDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    if (!canCompose) {
      return
    }
    dragDepthRef.current += 1
    setIsDragActive(true)
  }

  const handleComposerDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    if (!canCompose) {
      resetDragState()
      return
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsDragActive(false)
    }
  }

  const handleComposerDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = canCompose ? "copy" : "none"
  }

  const handleComposerDrop = async (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    const files = getTransferredFiles(event.dataTransfer)
    resetDragState()

    if (!canCompose || files.length === 0) {
      return
    }

    await appendImageFiles(files)
  }

  const canSubmit =
    canInput && (Boolean(input.trim()) || attachments.length > 0)
  return (
    <div className="bg-background/95 relative flex h-full min-h-0 flex-col overflow-hidden">
      <ChatControls
        defaultModelName={defaultModelName}
        connectionState={connectionState}
        models={chatModels}
        thinkingLevel={thinkingLevel}
        detailVisibility={assistantDetailVisibility}
        disabled={settingDefault || settingThinkingLevel}
        onModelChange={(modelName) => void handleSetDefault(modelName)}
        onThinkingLevelChange={(level) => void handleSetThinkingLevel(level)}
        onDetailVisibilityChange={setAssistantDetailVisibility}
      />

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onWheel={(event) => {
            if (event.deltaY < 0) shouldFollowOutputRef.current = false
          }}
          onTouchStart={(event) => {
            touchStartYRef.current = event.touches[0]?.clientY ?? null
          }}
          onTouchMove={(event) => {
            const startY = touchStartYRef.current
            const currentY = event.touches[0]?.clientY
            if (
              startY !== null &&
              currentY !== undefined &&
              currentY > startY + 8
            ) {
              shouldFollowOutputRef.current = false
            }
          }}
          onTouchEnd={() => {
            touchStartYRef.current = null
          }}
          className="h-full [scrollbar-gutter:stable] overflow-y-auto px-3 pt-[calc(4.75rem+env(safe-area-inset-top))] pb-3 md:px-8 lg:px-24 xl:px-48"
        >
          <div ref={scrollContentRef} className="mx-auto w-full max-w-225 pb-5">
            {isOpeningSession && messages.length === 0 && (
              <p
                className="text-muted-foreground py-16 text-center text-sm"
                role="status"
              >
                正在加载对话记录…
              </p>
            )}
            {!isOpeningSession && messages.length === 0 && !isTyping && (
              <ChatEmptyState
                hasAvailableModels={hasAvailableModels}
                defaultModelName={defaultModelName}
                isConnected={gwState !== "stopped" && gwState !== "error"}
                isInitializing={
                  gwState === "unknown" ||
                  gwState === "starting" ||
                  gwState === "restarting"
                }
              />
            )}

            <div
              className="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const msg = virtualMessages[virtualItem.index]
                return (
                  <div
                    key={virtualItem.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualItem.index}
                    className="absolute top-0 left-0 w-full pb-3 md:pb-4"
                    style={{
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    {msg && (
                      <div className="flex w-full">
                        {msg.role === "assistant" ? (
                          <AssistantMessage
                            content={msg.content}
                            attachments={msg.attachments}
                            kind={msg.kind}
                            modelName={msg.modelName}
                            toolCalls={msg.toolCalls}
                            isStreaming={msg.streaming}
                            timestamp={msg.timestamp}
                            sessionId={activeSessionId}
                            expanded={expandedDetailMessageIds.has(msg.id)}
                            onExpandedChange={(expanded) =>
                              handleDetailExpandedChange(msg.id, expanded)
                            }
                          />
                        ) : (
                          <UserMessage
                            content={msg.content}
                            attachments={msg.attachments}
                            timestamp={msg.timestamp}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="flex flex-col gap-3 md:gap-4">
              {liveMessages.map((msg) => (
                <div key={msg.id} className="flex w-full">
                  {msg.role === "assistant" ? (
                    <AssistantMessage
                      content={msg.content}
                      attachments={msg.attachments}
                      kind={msg.kind}
                      modelName={msg.modelName}
                      toolCalls={msg.toolCalls}
                      isStreaming={msg.streaming}
                      timestamp={msg.timestamp}
                      sessionId={activeSessionId}
                      expanded={expandedDetailMessageIds.has(msg.id)}
                      onExpandedChange={(expanded) =>
                        handleDetailExpandedChange(msg.id, expanded)
                      }
                    />
                  ) : (
                    <UserMessage
                      content={msg.content}
                      attachments={msg.attachments}
                      timestamp={msg.timestamp}
                    />
                  )}
                </div>
              ))}
              {showTypingIndicator && (
                <TypingIndicator activity={assistantActivity} />
              )}
            </div>
          </div>
        </div>

        {isLoadingOlderMessages && (
          <div className="bg-background/95 text-foreground/85 border-border pointer-events-none absolute top-[calc(5rem+env(safe-area-inset-top))] left-1/2 z-30 -translate-x-1/2 rounded-full border px-3 py-1 text-xs shadow-sm backdrop-blur-xl">
            {t("common.loading")}
          </div>
        )}

        {!isAtBottom && messages.length > 0 && (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="absolute right-3 bottom-3 z-30 size-11 rounded-full border shadow-lg backdrop-blur-xl md:right-5 md:bottom-4"
            onClick={scrollToBottom}
            aria-label={t("chat.scrollToBottom")}
            title={t("chat.scrollToBottom")}
          >
            <IconArrowDown className="size-5" aria-hidden="true" />
          </Button>
        )}
      </div>

      <input
        ref={galleryInputRef}
        type="file"
        accept={CHAT_IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={handleImageSelection}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleImageSelection}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={CHAT_FILE_ACCEPT}
        multiple
        className="hidden"
        onChange={handleDocumentSelection}
      />

      <ChatComposer
        input={input}
        attachments={attachments}
        onInputChange={setInput}
        onOpenGallery={handleOpenGallery}
        onOpenCamera={handleOpenCamera}
        onOpenFiles={handleOpenFiles}
        onCompactContext={() => {
          sendMessage({ content: "/compact", attachments: [] })
        }}
        onClearContext={() => {
          sendMessage({ content: "/clear", attachments: [] })
        }}
        onSelectSkill={(name) => setInput(`/use ${name} `)}
        onPaste={handleComposerPaste}
        onDragEnter={handleComposerDragEnter}
        onDragLeave={handleComposerDragLeave}
        onDragOver={handleComposerDragOver}
        onDrop={handleComposerDrop}
        onRemoveAttachment={handleRemoveAttachment}
        onSend={handleSend}
        onStop={() => {
          sendMessage({ content: "/stop", attachments: [] })
        }}
        onContextDetail={() => {
          if (sendMessage({ content: "/context", attachments: [] })) {
            setInput("")
          }
        }}
        inputDisabledReason={inputDisabledReason}
        canSend={canSubmit}
        isDragActive={isDragActive}
        contextUsage={contextUsage}
      />
    </div>
  )
}
