import { IconSettings } from "@tabler/icons-react"

import type { ModelInfo, ModelThinkingLevel } from "@/api/models"
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
import { cn } from "@/lib/utils"
import type { ConnectionState } from "@/store/chat"

interface ChatControlsProps {
  defaultModelName: string
  connectionState: ConnectionState
  models: ModelInfo[]
  thinkingLevel: ModelThinkingLevel
  detailVisibility: AssistantDetailVisibility
  disabled?: boolean
  onModelChange: (modelName: string) => void
  onThinkingLevelChange: (level: ModelThinkingLevel) => void
  onDetailVisibilityChange: (value: AssistantDetailVisibility) => void
}

export function ChatControls({
  defaultModelName,
  connectionState,
  models,
  thinkingLevel,
  detailVisibility,
  disabled = false,
  onModelChange,
  onThinkingLevelChange,
  onDetailVisibilityChange,
}: ChatControlsProps) {
  const thinkingLabels: Record<ModelThinkingLevel, string> = {
    off: "思考关闭",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
  }
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
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-3 bottom-2 size-10 rounded-full"
              aria-label="聊天设置"
            >
              <IconSettings className="size-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            className="border-border/80 w-[min(22rem,calc(100vw-1rem))] space-y-5 rounded-2xl p-4 shadow-2xl"
          >
            <div>
              <h2 className="text-base font-semibold">聊天设置</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                仅影响 MuseC137 当前聊天 Agent
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">模型</label>
              <Select
                value={defaultModelName}
                onValueChange={onModelChange}
                disabled={disabled}
              >
                <SelectTrigger className="h-11 w-full rounded-xl">
                  <SelectValue placeholder="未选择模型" />
                </SelectTrigger>
                <SelectContent className="max-h-[55vh]">
                  {models.map((model) => (
                    <SelectItem key={model.index} value={model.model_name}>
                      {model.model_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">思考强度</label>
              <Select
                value={thinkingLevel}
                onValueChange={(value) =>
                  onThinkingLevelChange(value as ModelThinkingLevel)
                }
                disabled={disabled || !defaultModelName}
              >
                <SelectTrigger className="h-11 w-full rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(thinkingLabels) as ModelThinkingLevel[]).map(
                    (level) => (
                      <SelectItem key={level} value={level}>
                        {thinkingLabels[level]}
                      </SelectItem>
                    ),
                  )}
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
                    onClick={() => onDetailVisibilityChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  )
}
