import {
  IconArrowsMaximize,
  IconBrain,
  IconChevronDown,
  IconDownload,
  IconFileText,
  IconLoader2,
  IconTool,
} from "@tabler/icons-react"
import { memo, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import ReactMarkdown from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"

import { type SessionToolCallDetail, getSessionToolCall } from "@/api/sessions"
import { AudioMessage } from "@/components/chat/audio-message"
import { MessageActions } from "@/components/chat/message-actions"
import { MarkdownCodeBlock } from "@/components/chat/message-code-block"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { isSafeImageSource } from "@/features/chat/image-gallery"
import { formatMessageTime } from "@/hooks/use-pico-chat"
import { cn } from "@/lib/utils"
import {
  type AssistantMessageKind,
  type ChatAttachment,
  type ChatToolCall,
} from "@/store/chat"

interface AssistantMessageProps {
  content: string
  onImageOpen?: (imageIndex: number) => void
  attachments?: ChatAttachment[]
  kind?: AssistantMessageKind
  modelName?: string
  toolCalls?: ChatToolCall[]
  timestamp?: string | number
  isStreaming?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  sessionId?: string
}

function getExecSummary(argumentsText: string): string {
  if (!argumentsText.trim()) {
    return ""
  }

  try {
    const parsed = JSON.parse(argumentsText) as unknown
    if (!parsed || typeof parsed !== "object") {
      return ""
    }

    const args = parsed as Record<string, unknown>
    const action = typeof args.action === "string" ? args.action.trim() : ""
    if (action === "run" && typeof args.command === "string") {
      const command = args.command.replace(/\s+/g, " ").trim()
      return command.length > 96 ? `${command.slice(0, 96)}…` : command
    }

    const rawSessionID = args.sessionId ?? args.session_id
    const sessionID =
      typeof rawSessionID === "string" ? rawSessionID.trim() : ""
    return [action, sessionID].filter(Boolean).join(" · ")
  } catch {
    return ""
  }
}

function formatToolArguments(argumentsText: string): string {
  const trimmed = argumentsText.trim()
  if (!trimmed) return ""

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return trimmed
  }
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  onImageOpen,
  attachments = [],
  kind = "normal",
  modelName,
  toolCalls = [],
  timestamp = "",
  isStreaming = false,
  expanded,
  onExpandedChange,
  sessionId,
}: AssistantMessageProps) {
  const { t } = useTranslation()
  const isThought = kind === "thought"
  const isToolCalls = kind === "tool_calls"
  const isToolFeedback = kind === "tool_feedback"
  const isCollapsedBlock = isThought || isToolCalls
  const hasText = content.trim().length > 0
  const hasToolCalls = toolCalls.length > 0
  const imageAttachments = attachments.filter(
    (attachment) =>
      attachment.type === "image" && isSafeImageSource(attachment.url),
  )
  const audioAttachments = attachments.filter(
    (attachment) => attachment.type === "audio",
  )
  const fileAttachments = attachments.filter(
    (attachment) => attachment.type !== "image" && attachment.type !== "audio",
  )
  const [internalExpanded, setInternalExpanded] = useState(false)
  const [activeToolIndex, setActiveToolIndex] = useState<number | null>(null)
  const [toolDetail, setToolDetail] = useState<SessionToolCallDetail | null>(
    null,
  )
  const [toolDetailError, setToolDetailError] = useState(false)
  const activeToolCall =
    activeToolIndex === null ? null : toolCalls[activeToolIndex]
  const activeCallId = activeToolCall?.id
  useEffect(() => {
    if (activeToolIndex === null) return
    if (!sessionId || !activeCallId) return
    let cancelled = false
    let timer: number | undefined
    let attempts = 0
    const load = async () => {
      try {
        const detail = await getSessionToolCall(sessionId, activeCallId)
        if (cancelled) return
        setToolDetail(detail)
        setToolDetailError(false)
        if (!detail.result_found && attempts++ < 60) {
          timer = window.setTimeout(() => void load(), 2000)
        }
      } catch {
        if (cancelled) return
        if (attempts++ < 60) {
          timer = window.setTimeout(() => void load(), 2000)
        } else {
          setToolDetailError(true)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [activeToolIndex, activeCallId, sessionId])
  const isExpanded = expanded ?? internalExpanded
  const setIsExpanded = (nextExpanded: boolean) => {
    if (expanded === undefined) {
      setInternalExpanded(nextExpanded)
    }
    onExpandedChange?.(nextExpanded)
  }
  const formattedTimestamp =
    timestamp !== "" ? formatMessageTime(timestamp) : ""
  const collapsedLabel = isThought
    ? t("chat.reasoningLabel")
    : t("chat.toolCallsLabel")
  const trimmedModelName = modelName?.trim() ?? ""
  const toolSummaries = toolCalls
    .map((toolCall) => {
      const name = toolCall.function?.name?.trim() ?? ""
      if (!name) return ""
      const detail =
        name.toLowerCase() === "exec"
          ? getExecSummary(toolCall.function?.arguments?.trim() ?? "")
          : ""
      return detail ? `${name} · ${detail}` : name
    })
    .filter(Boolean)
  const toolSummary = [
    ...toolSummaries.slice(0, 2),
    ...(toolSummaries.length > 2 ? [`+${toolSummaries.length - 2}`] : []),
  ].join(" · ")
  const toolCallsContent = toolCalls
    .map((toolCall) => {
      const name = toolCall.function?.name?.trim() ?? ""
      const argumentsText = formatToolArguments(
        toolCall.function?.arguments ?? "",
      )
      return [name, argumentsText].filter(Boolean).join("\n")
    })
    .filter(Boolean)
    .join("\n\n")
  const actionContent = isToolCalls
    ? toolCallsContent
    : content.trim() || toolCallsContent

  if (isToolFeedback) {
    return (
      <MessageActions content={actionContent} className="w-full">
        <div
          className="text-foreground/80 flex items-start gap-2 px-1 py-1 text-[13px] leading-relaxed"
          role="status"
          aria-live="polite"
        >
          <IconLoader2 className="text-foreground/70 mt-0.5 size-3.5 shrink-0 animate-spin" />
          <span className="whitespace-pre-wrap">{content}</span>
        </div>
      </MessageActions>
    )
  }

  return (
    <MessageActions
      content={actionContent}
      className="group flex w-full flex-col gap-1.5"
    >
      {!isCollapsedBlock && (
        <div className="text-foreground/70 flex items-center justify-between gap-2 px-1 text-xs">
          <div className="flex items-center gap-2">
            <span>MuseC137</span>
            {trimmedModelName && (
              <>
                <span className="text-foreground/45">•</span>
                <span>{trimmedModelName}</span>
              </>
            )}
            {formattedTimestamp && (
              <>
                <span className="text-foreground/45">•</span>
                <span>{formattedTimestamp}</span>
              </>
            )}
          </div>
        </div>
      )}

      {(hasText || isCollapsedBlock || hasToolCalls) && (
        <div
          className={cn(
            "relative max-w-[94%] overflow-hidden rounded-2xl rounded-tl-[5px] border sm:max-w-[86%]",
            isCollapsedBlock && "w-full",
            isCollapsedBlock
              ? isThought
                ? "border-violet-800/70 bg-violet-950/45 text-violet-50"
                : "border-cyan-800/70 bg-cyan-950/45 text-cyan-50"
              : "bg-card text-card-foreground border-border dark:border-zinc-600",
          )}
        >
          {isCollapsedBlock && (
            <div className="flex items-center">
              <button
                type="button"
                className="text-foreground/90 hover:text-foreground flex min-h-11 min-w-0 flex-1 touch-manipulation items-center justify-between gap-3 px-3 py-2 text-left text-[12px] font-medium transition-colors"
                onClick={() => setIsExpanded(!isExpanded)}
                aria-expanded={isExpanded}
                aria-label={collapsedLabel}
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                  {isThought ? (
                    <IconBrain
                      className="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <IconTool
                      className="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  {isThought ? (
                    <span className="shrink-0">{collapsedLabel}</span>
                  ) : (
                    <span className="text-foreground/90 min-w-0 truncate font-mono">
                      {toolSummary || "tool"}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <IconChevronDown
                    className={cn(
                      "text-foreground/70 size-3.5 transition-transform duration-200",
                      isExpanded ? "rotate-180" : "",
                    )}
                    aria-hidden="true"
                  />
                </span>
              </button>
              {isToolCalls && hasToolCalls && (
                <button
                  type="button"
                  className="text-foreground/80 hover:text-foreground flex size-11 shrink-0 items-center justify-center"
                  onClick={() => {
                    setToolDetail(null)
                    setToolDetailError(false)
                    setActiveToolIndex(0)
                  }}
                  aria-label={t("chat.expandToolCall")}
                  title={t("chat.expandToolCall")}
                >
                  <IconArrowsMaximize className="size-4" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          {(!isCollapsedBlock || isExpanded) && isToolCalls && hasToolCalls && (
            <div
              className="max-h-64 space-y-2 overflow-y-auto overscroll-contain border-t border-cyan-800/60 px-3 py-3"
              onDoubleClick={() => setIsExpanded(false)}
            >
              {toolCalls.map((toolCall, index) => {
                const toolName = toolCall.function?.name?.trim() ?? ""
                const toolArguments = formatToolArguments(
                  toolCall.function?.arguments ?? "",
                )

                if (!toolArguments && !toolName) {
                  return null
                }

                return (
                  <div
                    key={toolCall.id ?? `${toolName}-${index}`}
                    className={cn(
                      "space-y-2",
                      index > 0 && "border-border/60 border-t pt-3",
                    )}
                  >
                    {toolCalls.length > 1 && (
                      <button
                        type="button"
                        className="flex min-h-11 w-full items-center justify-between gap-2 text-left text-xs text-cyan-100/80 hover:text-cyan-50"
                        onClick={() => {
                          setToolDetail(null)
                          setToolDetailError(false)
                          setActiveToolIndex(index)
                        }}
                      >
                        <span className="truncate">
                          {toolName || `#${index + 1}`}
                        </span>
                        <IconArrowsMaximize
                          className="size-4 shrink-0"
                          aria-hidden="true"
                        />
                      </button>
                    )}
                    {toolArguments && (
                      <pre className="bg-background border-border/70 text-foreground/90 max-h-[min(60dvh,32rem)] overflow-auto rounded-lg border p-3 font-mono text-[12px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
                        <code>{toolArguments}</code>
                      </pre>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {(!isCollapsedBlock || isExpanded) && !isToolCalls && hasText && (
            <div
              onDoubleClick={
                isThought && isExpanded ? () => setIsExpanded(false) : undefined
              }
              className={cn(
                "prose dark:prose-invert prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground prose-code:text-foreground/90 prose-pre:my-2 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:border prose-pre:border-border prose-pre:bg-zinc-100 prose-pre:p-0 prose-pre:text-zinc-900 dark:prose-pre:border-zinc-600 dark:prose-pre:bg-zinc-950 dark:prose-pre:text-zinc-100 max-w-none [overflow-wrap:anywhere] break-words",
                isThought
                  ? "prose-p:my-1.5 prose-p:whitespace-pre-wrap touch-manipulation px-3 pt-0 pb-3 text-[13px] leading-relaxed"
                  : "prose-p:my-2 prose-p:whitespace-pre-wrap p-4 text-[15px] leading-relaxed",
              )}
            >
              {isStreaming ? (
                <div className="whitespace-pre-wrap">{content}</div>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeHighlight]}
                  components={{
                    pre: MarkdownCodeBlock,
                  }}
                >
                  {content}
                </ReactMarkdown>
              )}
            </div>
          )}
        </div>
      )}

      {isToolCalls && (
        <Sheet
          open={activeToolIndex !== null}
          onOpenChange={(open) => {
            if (!open) setActiveToolIndex(null)
          }}
        >
          <SheetContent
            side="bottom"
            className="max-h-[90dvh] gap-0 overflow-hidden rounded-t-3xl border-cyan-800/70 p-0"
          >
            <SheetHeader className="border-border/70 shrink-0 border-b pr-16">
              <SheetTitle>{t("chat.toolDetailTitle")}</SheetTitle>
              <SheetDescription className="truncate font-mono text-xs">
                {toolDetail?.name || activeToolCall?.function?.name || "tool"}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {(toolDetail?.explanation ||
                activeToolCall?.extraContent?.toolFeedbackExplanation) && (
                <p className="text-muted-foreground text-sm whitespace-pre-wrap">
                  {toolDetail?.explanation ||
                    activeToolCall?.extraContent?.toolFeedbackExplanation}
                </p>
              )}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">
                  {t("chat.toolDetailArguments")}
                </h3>
                <pre className="bg-muted/40 border-border max-h-[40dvh] overflow-auto rounded-xl border p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
                  {formatToolArguments(
                    toolDetail?.arguments ||
                      activeToolCall?.function?.arguments ||
                      "",
                  ) || "—"}
                </pre>
              </section>
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">
                  {t("chat.toolDetailResult")}
                </h3>
                <pre className="bg-muted/40 border-border max-h-[40dvh] overflow-auto rounded-xl border p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
                  {toolDetail?.result_found
                    ? toolDetail.result || "—"
                    : !activeCallId || toolDetailError
                      ? t("chat.toolDetailLoadError")
                      : t("chat.toolDetailWaiting")}
                </pre>
              </section>
            </div>
          </SheetContent>
        </Sheet>
      )}

      {imageAttachments.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2">
          {imageAttachments.map((attachment, index) => (
            <button
              key={`${attachment.url}-${index}`}
              type="button"
              aria-label={`View image ${index + 1}`}
              onClick={() => onImageOpen?.(index)}
              className="group/img border-border/50 bg-muted/30 hover:border-border/80 relative overflow-hidden rounded-xl border shadow-sm transition-colors"
            >
              <img
                src={attachment.url}
                alt={attachment.filename || "Attached image"}
                className="max-h-80 max-w-[280px] object-contain transition-transform duration-300 group-hover/img:scale-[1.02]"
              />
              <div className="absolute inset-0 bg-black/0 transition-colors group-hover/img:bg-black/10 dark:group-hover/img:bg-black/20" />
            </button>
          ))}
        </div>
      )}

      {audioAttachments.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          {audioAttachments.map((attachment, index) => (
            <AudioMessage
              key={`${attachment.url}-${index}`}
              attachment={attachment}
            />
          ))}
        </div>
      )}

      {fileAttachments.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-3">
          {fileAttachments.map((attachment, index) => (
            <a
              key={`${attachment.url}-${index}`}
              href={attachment.url}
              download={attachment.filename}
              className="group/file border-border/60 bg-card flex w-fit max-w-sm min-w-[220px] items-center gap-3.5 rounded-xl border px-4 py-3 transition-all duration-300 hover:-translate-y-0.5 hover:border-violet-500/30 hover:shadow-sm dark:hover:border-violet-500/40"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-violet-400 ring-1 ring-violet-500/10 dark:bg-violet-500/10 dark:text-violet-400 dark:ring-violet-500/30">
                <IconFileText className="h-5 w-5" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col pr-1">
                <span className="text-foreground/90 truncate text-[14px] leading-tight font-medium transition-colors group-hover/file:text-violet-600 dark:group-hover/file:text-violet-400">
                  {attachment.filename || "Download file"}
                </span>
                <span className="text-foreground/70 mt-1 text-[12px] font-medium">
                  {attachment.filename?.split(".").pop()?.toUpperCase() ||
                    "FILE"}
                </span>
              </div>
              <div className="bg-muted text-foreground/70 dark:bg-muted/70 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-300 group-hover/file:bg-violet-400 group-hover/file:text-white group-hover/file:shadow-sm dark:group-hover/file:bg-violet-400">
                <IconDownload className="h-4 w-4 transition-transform duration-300 group-hover/file:-translate-y-[1px]" />
              </div>
            </a>
          ))}
        </div>
      )}
    </MessageActions>
  )
})
