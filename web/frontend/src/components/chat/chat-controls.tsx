import type { ConnectionState } from "@/store/chat"

interface ChatControlsProps {
  defaultModelName: string
  connectionState: ConnectionState
}

export function ChatControls({
  defaultModelName,
  connectionState,
}: ChatControlsProps) {
  return (
    <header className="border-border/70 bg-background/92 absolute inset-x-0 top-0 z-40 flex h-[calc(4rem+env(safe-area-inset-top))] items-end border-b px-4 pb-1 backdrop-blur-xl">
      <div className="flex h-14 w-full items-center justify-center">
        <div className="flex min-w-0 flex-col items-center justify-center text-center">
          <span className="flex max-w-full items-center gap-2 text-[17px] leading-5 font-semibold tracking-tight">
            <span className="truncate">MuseC137</span>
            <span
              className={`size-2.5 shrink-0 rounded-full ${connectionState === "connected" ? "bg-secondary" : connectionState === "connecting" ? "bg-amber-400" : "bg-destructive"}`}
              aria-hidden="true"
            />
          </span>
          <span className="text-muted-foreground mt-0.5 max-w-[70vw] truncate text-xs">
            {defaultModelName || "未选择模型"}
          </span>
        </div>
      </div>
    </header>
  )
}
