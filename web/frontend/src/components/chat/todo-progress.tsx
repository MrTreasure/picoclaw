import {
  IconCheck,
  IconChevronRight,
  IconCircle,
  IconProgress,
} from "@tabler/icons-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { SessionTodoList } from "@/store/chat"

export function TodoProgress({
  list,
  connected,
  onClear,
}: {
  list?: SessionTodoList
  connected: boolean
  onClear: () => boolean
}) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  if (!list?.items.length) return null
  const completed = list.items.filter(
    (item) => item.status === "completed",
  ).length
  const current =
    list.items.find((item) => item.status === "in_progress") ??
    list.items.find((item) => item.status === "pending") ??
    list.items.at(-1)
  return (
    <>
      <div className="pointer-events-none relative z-10 mx-auto flex w-full max-w-3xl justify-end px-4 pb-2 sm:px-6">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("chat.todoProgressOpen", {
            completed,
            total: list.items.length,
            task: current?.short || current?.content,
          })}
          className="bg-popover text-popover-foreground border-border/70 pointer-events-auto flex min-h-11 max-w-[min(100%,22rem)] items-center gap-2 rounded-full border px-3.5 shadow-lg shadow-black/8 transition-transform active:scale-[0.97]"
        >
          <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums">
            {completed}/{list.items.length}
          </span>
          <span className="min-w-0 truncate text-left text-sm font-medium">
            {current?.short || current?.content}
          </span>
          <IconChevronRight
            aria-hidden="true"
            className="text-muted-foreground size-4 shrink-0"
          />
        </button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(80dvh,38rem)] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle>{t("chat.todoTitle")}</DialogTitle>
            <DialogDescription>
              {t("chat.todoSummary", { completed, total: list.items.length })}
            </DialogDescription>
          </DialogHeader>
          <ol className="space-y-1.5" aria-label={t("chat.todoTitle")}>
            {list.items.map((item, index) => {
              const done = item.status === "completed"
              const active = item.status === "in_progress"
              return (
                <li
                  key={index}
                  className="flex items-start gap-3 rounded-xl px-2 py-2.5"
                >
                  {done ? (
                    <IconCheck
                      className="text-primary mt-0.5 size-5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : active ? (
                    <IconProgress
                      className="text-primary mt-0.5 size-5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <IconCircle
                      className="text-muted-foreground mt-0.5 size-5 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={
                      done
                        ? "text-muted-foreground break-words line-through"
                        : "break-words"
                    }
                  >
                    {item.content}
                  </span>
                  <span className="sr-only">
                    {t(`chat.todoStatus.${item.status}`)}
                  </span>
                </li>
              )
            })}
          </ol>
          {completed === list.items.length && (
            <Button
              type="button"
              className="min-h-11 w-full rounded-xl"
              disabled={!connected}
              onClick={() => {
                // Do not hide the list until the server broadcasts an empty snapshot.
                // An ambiguous send must not cause an automatic retry.
                if (!onClear()) toast.error(t("chat.todoClearFailed"))
              }}
            >
              {t("chat.todoFinishAndClear")}
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
