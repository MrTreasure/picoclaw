import { IconBrain, IconTool } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import type { AssistantActivity } from "@/store/chat"

export function TypingIndicator({
  activity = "thinking",
}: {
  activity?: AssistantActivity
}) {
  const { t } = useTranslation()

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div
        className={
          activity === "tool"
            ? "inline-flex w-fit max-w-xs flex-col gap-2.5 rounded-2xl rounded-tl-[5px] border border-cyan-800/70 bg-cyan-950/55 px-4 py-3 text-cyan-50"
            : "inline-flex w-fit max-w-xs flex-col gap-2.5 rounded-2xl rounded-tl-[5px] border border-violet-800/70 bg-violet-950/55 px-4 py-3 text-violet-50"
        }
      >
        <div className="flex items-center gap-2">
          {activity === "tool" ? (
            <IconTool className="size-4 text-cyan-300" aria-hidden="true" />
          ) : (
            <IconBrain className="size-4 text-violet-300" aria-hidden="true" />
          )}
          <span className="bg-secondary size-1.5 animate-bounce rounded-full [animation-delay:-0.3s]" />
          <span className="bg-secondary size-1.5 animate-bounce rounded-full [animation-delay:-0.15s]" />
          <span className="bg-secondary size-1.5 animate-bounce rounded-full" />
        </div>

        <div className="bg-background/70 relative h-1 w-36 overflow-hidden rounded-full">
          <div className="from-secondary/25 via-secondary/80 to-secondary/25 absolute inset-0 animate-[shimmer_2s_infinite] rounded-full bg-gradient-to-r bg-[length:200%_100%]" />
        </div>

        <p className="text-xs font-medium">
          {activity === "tool"
            ? t("chat.activity.tool")
            : t("chat.activity.thinking")}
        </p>
      </div>
    </div>
  )
}
