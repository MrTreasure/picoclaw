import { IconHistory, IconTrash } from "@tabler/icons-react"
import dayjs from "dayjs"
import type { RefObject } from "react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import type { SessionSummary } from "@/api/sessions"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"

interface SessionHistoryMenuProps {
  sessions: SessionSummary[]
  activeSessionId: string
  hasMore: boolean
  loadError: boolean
  loadErrorMessage: string
  observerRef: RefObject<HTMLDivElement | null>
  onOpenChange: (open: boolean) => void
  onSwitchSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  compact?: boolean
}

export function SessionHistoryMenu({
  sessions,
  activeSessionId,
  hasMore,
  loadError,
  loadErrorMessage,
  observerRef,
  onOpenChange,
  onSwitchSession,
  onDeleteSession,
  compact = false,
}: SessionHistoryMenuProps) {
  const { t } = useTranslation()
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(
    null,
  )

  return (
    <>
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size={compact ? "icon" : "default"}
            className={
              compact
                ? "size-12 rounded-full"
                : "h-12 w-full justify-start gap-3 rounded-xl px-4"
            }
            aria-label={compact ? t("chat.history") : undefined}
          >
            <IconHistory className="size-5" aria-hidden="true" />
            {!compact && <span>{t("chat.history")}</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={compact ? "start" : "end"}
          sideOffset={8}
          className="border-border/80 w-[min(23rem,calc(100vw-1rem))] rounded-2xl p-2 shadow-2xl"
        >
          <div className="px-3 py-2 text-sm font-semibold">
            {t("chat.history")}
          </div>
          <ScrollArea className="max-h-[min(60dvh,32rem)]">
            {loadError && (
              <DropdownMenuItem disabled>
                <span className="text-destructive text-xs">
                  {loadErrorMessage}
                </span>
              </DropdownMenuItem>
            )}
            {sessions.length === 0 && !loadError ? (
              <DropdownMenuItem disabled>
                <span className="text-muted-foreground text-xs">
                  {t("chat.noHistory")}
                </span>
              </DropdownMenuItem>
            ) : (
              sessions.map((session) => (
                <DropdownMenuItem
                  key={session.id}
                  className={`group relative my-1 min-h-16 flex-col items-start justify-center gap-1 rounded-xl py-2 pr-13 pl-3 ${
                    session.id === activeSessionId
                      ? "bg-accent text-accent-foreground"
                      : ""
                  }`}
                  onClick={() => onSwitchSession(session.id)}
                >
                  <span className="line-clamp-1 text-sm font-medium">
                    {session.title}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t("chat.messagesCount", {
                      count: session.message_count,
                    })}{" "}
                    · {dayjs(session.updated).fromNow()}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("chat.deleteSession")}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive absolute top-1/2 right-1 size-11 -translate-y-1/2 rounded-lg transition-colors"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setPendingDelete(session)
                    }}
                  >
                    <IconTrash className="h-4 w-4" />
                  </Button>
                </DropdownMenuItem>
              ))
            )}
            {hasMore && sessions.length > 0 && (
              <div ref={observerRef} className="py-2 text-center">
                <span className="text-muted-foreground animate-pulse text-xs">
                  {t("chat.loadingMore")}
                </span>
              </div>
            )}
          </ScrollArea>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat.deleteSessionTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat.deleteSessionDescription", {
                title: pendingDelete?.title ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) onDeleteSession(pendingDelete.id)
                setPendingDelete(null)
              }}
            >
              {t("chat.deleteSession")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
