import { IconArrowDown } from "@tabler/icons-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useAtomValue } from "jotai"
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  useEffect,
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
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const documentInputRef = useRef<HTMLInputElement>(null)
  const draftMessageIdRef = useRef(`msg-${crypto.randomUUID()}`)
  const dragDepthRef = useRef(0)
  const loadingOlderRef = useRef(false)
  const didInitialScrollRef = useRef(false)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [input, setInput] = useState("")
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [isDragActive, setIsDragActive] = useState(false)
  const assistantDetailVisibility = useAtomValue(assistantDetailVisibilityAtom)

  const {
    messages,
    activeSessionId,
    connectionState,
    isTyping,
    contextUsage,
    hasOlderMessages,
    isLoadingOlderMessages,
    loadOlderMessages,
    sendMessage,
  } = usePicoChat()

  const { state: gwState } = useGateway()
  const isGatewayRunning = gwState === "running"

  const { defaultModelName, hasAvailableModels } = useChatModels({
    isConnected: isGatewayRunning,
  })
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
  // Variable-height chat bubbles require the virtualizer's imperative
  // measurements; this hook intentionally opts out of React Compiler memoizing.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visibleMessages.length + (isTyping ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      index >= visibleMessages.length
        ? 64
        : visibleMessages[index]?.role === "assistant"
          ? 180
          : 92,
    getItemKey: (index) =>
      index >= visibleMessages.length
        ? "typing-indicator"
        : (visibleMessages[index]?.id ?? index),
    overscan: 6,
  })

  useEffect(() => {
    didInitialScrollRef.current = false
    loadingOlderRef.current = false
    setIsAtBottom(true)
  }, [activeSessionId])

  const syncScrollState = (element: HTMLDivElement) => {
    const { clientHeight, scrollHeight, scrollTop } = element
    setIsAtBottom(scrollHeight - scrollTop <= clientHeight + 10)
  }

  const handleScroll = async (e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget
    syncScrollState(element)
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
    const previousHeight = element.scrollHeight
    const previousTop = element.scrollTop
    const loaded = await loadOlderMessages()
    requestAnimationFrame(() => {
      const current = scrollRef.current
      if (loaded && current) {
        current.scrollTop = current.scrollHeight - previousHeight + previousTop
      }
      loadingOlderRef.current = false
    })
  }

  const scrollToBottom = () => {
    const element = scrollRef.current
    if (!element) return
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    })
  }

  useEffect(() => {
    if (scrollRef.current) {
      if (isAtBottom) {
        requestAnimationFrame(() => {
          const element = scrollRef.current
          if (!element) return
          element.scrollTop = element.scrollHeight
          didInitialScrollRef.current = true
          syncScrollState(element)
        })
      }
    }
  }, [messages, isTyping, isAtBottom, virtualizer])

  const handleSend = () => {
    if ((!input.trim() && attachments.length === 0) || !canInput) return
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

    const nextAttachments = await buildChatImageAttachments(files, t)
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
      />

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full [scrollbar-gutter:stable] overflow-y-auto px-3 pt-[calc(4.75rem+env(safe-area-inset-top))] pb-3 md:px-8 lg:px-24 xl:px-48"
        >
          <div className="mx-auto w-full max-w-225 pb-5">
            {messages.length === 0 && !isTyping && (
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
                const msg = visibleMessages[virtualItem.index]
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
                    {msg ? (
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
                          />
                        ) : (
                          <UserMessage
                            content={msg.content}
                            attachments={msg.attachments}
                            timestamp={msg.timestamp}
                          />
                        )}
                      </div>
                    ) : (
                      <TypingIndicator />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {isLoadingOlderMessages && (
          <div className="bg-background/80 text-muted-foreground pointer-events-none absolute top-[calc(5rem+env(safe-area-inset-top))] left-1/2 z-30 -translate-x-1/2 rounded-full border px-3 py-1 text-xs shadow-sm backdrop-blur-xl">
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
        inputDisabledReason={null}
        canSend={canSubmit}
        isDragActive={isDragActive}
        contextUsage={contextUsage}
      />
    </div>
  )
}
