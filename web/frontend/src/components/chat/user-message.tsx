import { IconDownload, IconFile } from "@tabler/icons-react"
import { memo } from "react"
import { useTranslation } from "react-i18next"

import { MessageActions } from "@/components/chat/message-actions"
import { formatMessageTime } from "@/hooks/use-pico-chat"
import { cn } from "@/lib/utils"
import type { ChatAttachment } from "@/store/chat"

interface UserMessageProps {
  content: string
  attachments?: ChatAttachment[]
  timestamp?: string | number
  sendStatus?: "pending" | "failed" | "unconfirmed"
  sendError?: string
  onRestoreText?: () => void
}

export const UserMessage = memo(function UserMessage({
  content,
  attachments = [],
  timestamp = "",
  sendStatus,
  sendError,
  onRestoreText,
}: UserMessageProps) {
  const { t } = useTranslation()
  const hasText = content.trim().length > 0
  const isCommand = content.trim().startsWith("/")
  const imageAttachments = attachments.filter(
    (attachment) => attachment.type === "image",
  )
  const fileAttachments = attachments.filter(
    (attachment) => attachment.type !== "image",
  )
  const formattedTimestamp =
    timestamp !== "" ? formatMessageTime(timestamp) : ""

  return (
    <MessageActions
      content={content}
      className="group flex w-full flex-col items-end gap-1.5"
    >
      {imageAttachments.length > 0 && (
        <div className="flex max-w-[70%] flex-wrap justify-end gap-2">
          {imageAttachments.map((attachment, index) => (
            <img
              key={`${attachment.url}-${index}`}
              src={attachment.url}
              alt={attachment.filename || t("chat.uploadedImage")}
              className="max-h-72 max-w-full object-cover"
            />
          ))}
        </div>
      )}

      {fileAttachments.length > 0 && (
        <div className="flex max-w-[86%] flex-col items-end gap-2 sm:max-w-[72%]">
          {fileAttachments.map((attachment, index) => (
            <a
              key={`${attachment.url}-${index}`}
              href={attachment.url}
              download={attachment.filename}
              className="bg-accent text-accent-foreground flex min-h-14 max-w-full items-center gap-3 rounded-2xl rounded-tr-[5px] px-3 py-2.5"
            >
              <IconFile className="size-6 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {attachment.filename || "文件"}
              </span>
              <IconDownload
                className="size-4 shrink-0 opacity-60"
                aria-hidden="true"
              />
            </a>
          ))}
        </div>
      )}

      {hasText && (
        <div className="relative max-w-[86%] sm:max-w-[72%]">
          <div
            className={cn(
              "wrap-break-word whitespace-pre-wrap shadow-sm",
              isCommand
                ? "border-border bg-card text-foreground rounded-xl border px-3.5 py-2.5 font-mono text-[14px] dark:border-zinc-600"
                : "bg-accent text-accent-foreground rounded-2xl rounded-tr-[5px] border border-emerald-700/30 px-4 py-2.5 text-[15px] leading-relaxed dark:border-emerald-300/35",
            )}
          >
            {isCommand ? (
              <div className="flex items-start gap-2.5">
                <span className="font-bold text-emerald-600 select-none dark:text-emerald-400">
                  ❯
                </span>
                <span className="mt-[1px]">{content}</span>
              </div>
            ) : (
              content
            )}
          </div>
        </div>
      )}

      {(sendStatus === "failed" || sendStatus === "unconfirmed") && (
        <div
          role="status"
          className="flex max-w-[86%] flex-wrap items-center justify-end gap-2 px-1 text-xs text-amber-700 dark:text-amber-300"
        >
          <span>
            {sendStatus === "failed"
              ? `${t("chat.sendFailed")}${sendError ? `: ${sendError}` : ""}`
              : t("chat.sendUnconfirmed")}
          </span>
          {hasText && onRestoreText && (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={onRestoreText}
            >
              {t("chat.restoreMessageDraft")}
            </button>
          )}
        </div>
      )}

      {formattedTimestamp && (
        <span className="text-foreground/70 px-1 text-[11px]">
          {formattedTimestamp}
        </span>
      )}
    </MessageActions>
  )
})
