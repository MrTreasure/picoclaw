import {
  IconArrowUp,
  IconPlayerStopFilled,
  IconPlus,
  IconX,
} from "@tabler/icons-react"
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useRef,
} from "react"
import { useTranslation } from "react-i18next"
import TextareaAutosize from "react-textarea-autosize"

import { ContextUsageRing } from "@/components/chat/context-usage-ring"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ChatAttachment, ContextUsage } from "@/store/chat"

export type ChatInputDisabledReason =
  | "gatewayUnknown"
  | "gatewayStarting"
  | "gatewayRestarting"
  | "gatewayStopping"
  | "gatewayStopped"
  | "gatewayError"
  | "websocketConnecting"
  | "websocketDisconnected"
  | "websocketError"
  | "noDefaultModel"

interface ChatComposerProps {
  input: string
  attachments: ChatAttachment[]
  onInputChange: (value: string) => void
  onAddImages: () => void
  onPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void
  onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => void
  onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void
  onRemoveAttachment: (index: number) => void
  onSend: () => void
  onStop: () => void
  onContextDetail?: () => void
  inputDisabledReason: ChatInputDisabledReason | null
  canSend: boolean
  isGenerating: boolean
  isDragActive: boolean
  contextUsage?: ContextUsage
}

export function ChatComposer({
  input,
  attachments,
  onInputChange,
  onAddImages,
  onPaste,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  onRemoveAttachment,
  onSend,
  onStop,
  onContextDetail,
  inputDisabledReason,
  canSend,
  isGenerating,
  isDragActive,
  contextUsage,
}: ChatComposerProps) {
  const { t } = useTranslation()
  const canInput = inputDisabledReason === null
  const composingRef = useRef(false)
  const disabledMessage =
    inputDisabledReason === null
      ? null
      : t(`chat.disabledPlaceholder.${inputDisabledReason}`)
  const placeholder = disabledMessage ?? t("chat.placeholder")

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as Event & {
      isComposing?: boolean
      keyCode?: number
    }
    if (
      composingRef.current ||
      nativeEvent.isComposing ||
      nativeEvent.keyCode === 229
    ) {
      return
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="border-border/70 bg-card relative z-10 shrink-0 border-t px-2 pt-2 pb-[calc(.5rem+env(safe-area-inset-bottom))] md:px-8 md:pt-3 md:pb-4 lg:px-24 xl:px-48">
      <div className="mx-auto flex max-w-[900px] flex-col items-end">
        <div
          className={cn(
            "relative flex w-full flex-col transition-colors",
            isDragActive && "bg-accent/50 ring-ring/70 rounded-xl ring-2",
          )}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {isDragActive && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-violet-400/70 bg-violet-500/10">
              <div className="bg-background/95 text-foreground rounded-full px-4 py-2 text-sm font-medium shadow-sm">
                {t("chat.dropImagesActive")}
              </div>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2 px-1">
              {attachments.map((attachment, index) => (
                <div
                  key={`${attachment.url}-${index}`}
                  className="bg-background relative h-20 w-20 overflow-hidden rounded-xl border"
                >
                  <img
                    src={attachment.url}
                    alt={attachment.filename || t("chat.uploadedImage")}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(index)}
                    className="bg-background/85 text-foreground absolute top-1 right-1 inline-flex h-6 w-6 items-center justify-center rounded-full border shadow-sm transition hover:bg-white"
                    aria-label={t("chat.removeImage")}
                    title={t("chat.removeImage")}
                  >
                    <IconX className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="text-foreground border-border hover:bg-muted size-12 shrink-0 rounded-full bg-transparent shadow-none"
              onClick={onAddImages}
              disabled={!canInput}
              aria-label={t("chat.attachImage")}
              title={t("chat.attachImage")}
            >
              <IconPlus className="size-6" aria-hidden="true" />
            </Button>

            <div className="bg-muted/80 focus-within:border-ring/70 focus-within:bg-background flex min-h-12 min-w-0 flex-1 items-end rounded-xl border border-transparent px-1 transition-colors">
              <TextareaAutosize
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={() => {
                  composingRef.current = false
                }}
                onPaste={onPaste}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                disabled={!canInput}
                title={disabledMessage || undefined}
                className={cn(
                  "placeholder:text-muted-foreground/65 min-h-11 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-2.5 text-base leading-6 shadow-none focus-visible:ring-0 focus-visible:outline-none",
                  !canInput && "cursor-not-allowed",
                )}
                minRows={1}
                maxRows={6}
              />
              {contextUsage && (
                <div className="mb-0.5 shrink-0">
                  <ContextUsageRing
                    usage={contextUsage}
                    onDetailClick={onContextDetail}
                  />
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {canInput && isGenerating && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive border-border size-12 rounded-full bg-transparent shadow-none transition-colors"
                  onClick={onStop}
                  aria-label={t("chat.stopGeneration")}
                  title={t("chat.stopGeneration")}
                >
                  <IconPlayerStopFilled className="size-4" aria-hidden="true" />
                </Button>
              )}
              {canInput && (
                <span tabIndex={!canSend ? 0 : undefined}>
                  <Button
                    type="button"
                    size="icon"
                    className="bg-secondary text-secondary-foreground hover:bg-secondary/85 size-12 rounded-full shadow-none transition-colors"
                    onClick={onSend}
                    disabled={!canSend}
                    aria-label={t("chat.sendMessage")}
                  >
                    <IconArrowUp className="size-5" aria-hidden="true" />
                  </Button>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
