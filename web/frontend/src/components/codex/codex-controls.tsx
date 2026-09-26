import { IconArrowLeft, IconSettings } from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"

import type { CodexModel } from "@/api/codex"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AssistantDetailVisibility } from "@/features/chat/detail-visibility"
import { returnToSessions } from "@/lib/edge-swipe"
import { cn } from "@/lib/utils"

const effortLabels: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "超高",
}

interface CodexControlsProps {
  title: string
  workspace: string
  newConversation: boolean
  connected: boolean
  running: boolean
  busy: boolean
  model: string
  effort: string
  models: CodexModel[]
  detailVisibility: AssistantDetailVisibility
  onModelChange: (model: string) => void
  onEffortChange: (effort: string) => void
  onDetailVisibilityChange: (visibility: AssistantDetailVisibility) => void
}

export function CodexControls({
  title,
  workspace,
  newConversation,
  connected,
  running,
  busy,
  model,
  effort,
  models,
  detailVisibility,
  onModelChange,
  onEffortChange,
  onDetailVisibilityChange,
}: CodexControlsProps) {
  const navigate = useNavigate()
  const selected = models.find((entry) => entry.model === model)
  const efforts = selected?.supportedReasoningEfforts ?? []
  const settingsDisabled = !connected || running || busy
  const detailOptions: Array<{
    value: AssistantDetailVisibility
    label: string
  }> = [
    { value: "none", label: "仅回答" },
    { value: "thought", label: "思考" },
    { value: "tool_calls", label: "工具" },
    { value: "all", label: "全部" },
  ]

  return (
    <header className="border-border/70 bg-background/92 absolute inset-x-0 top-0 z-40 flex h-[calc(4rem+env(safe-area-inset-top))] items-end border-b px-4 pb-1 backdrop-blur-xl">
      <div className="flex h-14 w-full items-center justify-center">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute bottom-1 left-2 size-12 rounded-full"
          onClick={() =>
            returnToSessions(() => {
              void navigate({ to: "/sessions", replace: true })
            })
          }
          aria-label="返回会话列表"
        >
          <IconArrowLeft className="size-6" aria-hidden="true" />
        </Button>
        <div className="flex max-w-[70vw] min-w-0 flex-col items-center justify-center text-center">
          <span className="flex max-w-full items-center gap-2 text-[17px] leading-5 font-semibold tracking-tight">
            <span className="truncate">{title}</span>
            <span
              className={`size-2.5 shrink-0 rounded-full ${connected ? "bg-secondary" : "bg-destructive"}`}
              aria-label={connected ? "Codex 已连接" : "Codex 未连接"}
            />
          </span>
          <span className="text-muted-foreground mt-0.5 max-w-[70vw] truncate text-xs">
            {[selected?.displayName ?? model, workspace.split("/").pop()]
              .filter(Boolean)
              .join(" · ") || (connected ? "选择模型" : "连接中")}
          </span>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-3 bottom-2 size-10 rounded-full"
              aria-label="Codex 对话设置"
            >
              <IconSettings className="size-5" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            className="border-border/80 w-[min(22rem,calc(100vw-1rem))] space-y-5 rounded-2xl p-4 shadow-2xl"
          >
            <div>
              <h2 className="text-base font-semibold">Codex 对话设置</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {newConversation
                  ? "用于新对话，后续回合沿用"
                  : "设置在当前对话的下一回合生效"}
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="codex-model">
                模型
              </label>
              <Select
                value={model}
                onValueChange={onModelChange}
                disabled={settingsDisabled}
              >
                <SelectTrigger
                  id="codex-model"
                  className="h-11 w-full rounded-xl"
                >
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent className="max-h-[55vh]">
                  {model && !selected && (
                    <SelectItem value={model}>{model}</SelectItem>
                  )}
                  {models.map((entry) => (
                    <SelectItem key={entry.id} value={entry.model}>
                      {entry.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="codex-effort">
                思考强度
              </label>
              <Select
                value={effort}
                onValueChange={onEffortChange}
                disabled={settingsDisabled || !selected}
              >
                <SelectTrigger
                  id="codex-effort"
                  className="h-11 w-full rounded-xl"
                >
                  <SelectValue placeholder="选择强度" />
                </SelectTrigger>
                <SelectContent>
                  {effort &&
                    !efforts.some(
                      (entry) => entry.reasoningEffort === effort,
                    ) && <SelectItem value={effort}>{effort}</SelectItem>}
                  {efforts.map((entry) => (
                    <SelectItem
                      key={entry.reasoningEffort}
                      value={entry.reasoningEffort}
                    >
                      {effortLabels[entry.reasoningEffort] ??
                        entry.reasoningEffort}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">输出展示</label>
              <div className="bg-muted grid grid-cols-4 gap-1 rounded-xl p-1">
                {detailOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={cn(
                      "min-h-9 rounded-lg px-1 text-xs font-medium transition-colors",
                      detailVisibility === option.value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    aria-pressed={detailVisibility === option.value}
                    onClick={() => onDetailVisibilityChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {running && (
              <p className="text-muted-foreground text-xs">
                当前回复结束后可修改设置
              </p>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </header>
  )
}
