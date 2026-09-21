import {
  IconAdjustments,
  IconMessagePlus,
  IconSettings,
} from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import { type RefObject, useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type { ModelInfo } from "@/api/models"
import type { SessionSummary } from "@/api/sessions"
import { ModelSelector } from "@/components/chat/model-selector"
import { PushNotificationControl } from "@/components/chat/push-notification-control"
import { SessionHistoryMenu } from "@/components/chat/session-history-menu"
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
import type { AssistantDetailVisibility } from "@/store/chat"

interface ChatControlsProps {
  defaultModelName: string
  apiKeyModels: ModelInfo[]
  oauthModels: ModelInfo[]
  localModels: ModelInfo[]
  settingDefault: boolean
  onSetDefault: (modelName: string) => void
  detailVisibility: AssistantDetailVisibility
  onDetailVisibilityChange: (value: AssistantDetailVisibility) => void
  sessions: SessionSummary[]
  activeSessionId: string
  hasMoreSessions: boolean
  historyLoadError: boolean
  historyLoadErrorMessage: string
  historyObserverRef: RefObject<HTMLDivElement | null>
  onHistoryOpenChange: (open: boolean) => void
  onSwitchSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  onNewChat: () => void
}

export function ChatControls(props: ChatControlsProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const overlayHistoryEntry = useRef(false)

  useEffect(() => {
    const handlePopState = () => {
      if (!overlayHistoryEntry.current) return
      overlayHistoryEntry.current = false
      setOpen(false)
    }
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && !open) {
        window.history.pushState(
          { ...window.history.state, museOverlay: "chat-controls" },
          "",
          window.location.href,
        )
        overlayHistoryEntry.current = true
      } else if (!nextOpen && open && overlayHistoryEntry.current) {
        overlayHistoryEntry.current = false
        window.history.back()
      }
      setOpen(nextOpen)
    },
    [open],
  )

  const detailOptions: Array<{
    value: AssistantDetailVisibility
    label: string
  }> = [
    { value: "none", label: t("chat.assistantDetailVisibility.none") },
    { value: "thought", label: t("chat.assistantDetailVisibility.thought") },
    {
      value: "tool_calls",
      label: t("chat.assistantDetailVisibility.toolCalls"),
    },
    { value: "all", label: t("chat.assistantDetailVisibility.all") },
  ]

  return (
    <div className="pointer-events-none absolute top-[max(.75rem,env(safe-area-inset-top))] right-3 z-40">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            className="pointer-events-auto size-11 rounded-full border shadow-md backdrop-blur-xl"
            aria-label={t("chat.openControls")}
            aria-expanded={open}
          >
            <IconSettings className="size-5" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={8}
          className="pointer-events-auto w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl p-3 shadow-xl"
        >
          <div className="mb-3 flex items-center justify-between gap-3 px-1">
            <div>
              <p className="font-semibold tracking-tight">MuseC137</p>
              <p className="text-muted-foreground text-xs">
                {t("chat.controlsDescription")}
              </p>
            </div>
            <Button variant="ghost" className="h-11" asChild>
              <Link to="/config">{t("navigation.config")}</Link>
            </Button>
          </div>
          <div className="bg-muted/40 space-y-3 rounded-xl p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-sm">
                {t("navigation.models")}
              </span>
              <ModelSelector
                defaultModelName={props.defaultModelName}
                apiKeyModels={props.apiKeyModels}
                oauthModels={props.oauthModels}
                localModels={props.localModels}
                disabled={props.settingDefault}
                onValueChange={props.onSetDefault}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground flex items-center gap-2 text-sm">
                <IconAdjustments className="size-4" aria-hidden="true" />
                {t("chat.showAssistantDetails")}
              </span>
              <Select
                value={props.detailVisibility}
                onValueChange={(value) =>
                  props.onDetailVisibilityChange(
                    value as AssistantDetailVisibility,
                  )
                }
              >
                <SelectTrigger className="bg-background h-11 w-[132px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {detailOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <PushNotificationControl />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              className="h-11 gap-2"
              onClick={props.onNewChat}
            >
              <IconMessagePlus className="size-4" aria-hidden="true" />
              {t("chat.newChat")}
            </Button>
            <SessionHistoryMenu
              sessions={props.sessions}
              activeSessionId={props.activeSessionId}
              hasMore={props.hasMoreSessions}
              loadError={props.historyLoadError}
              loadErrorMessage={props.historyLoadErrorMessage}
              observerRef={props.historyObserverRef}
              onOpenChange={props.onHistoryOpenChange}
              onSwitchSession={props.onSwitchSession}
              onDeleteSession={props.onDeleteSession}
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
