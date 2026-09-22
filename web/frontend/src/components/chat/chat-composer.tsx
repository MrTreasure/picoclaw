import {
  IconArrowLeft,
  IconArrowUp,
  IconArrowsMinimize,
  IconCamera,
  IconFile,
  IconLoader2,
  IconPhoto,
  IconPlayerStopFilled,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react"
import { useTranslation } from "react-i18next"
import TextareaAutosize from "react-textarea-autosize"

import { type SkillSupportItem, getSkills } from "@/api/skills"
import { ContextUsageRing } from "@/components/chat/context-usage-ring"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
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
  onOpenGallery: () => void
  onOpenCamera: () => void
  onOpenFiles: () => void
  onCompactContext: () => void
  onClearContext: () => void
  onSelectSkill: (name: string) => void
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
  isDragActive: boolean
  contextUsage?: ContextUsage
}

export function ChatComposer({
  input,
  attachments,
  onInputChange,
  onOpenGallery,
  onOpenCamera,
  onOpenFiles,
  onCompactContext,
  onClearContext,
  onSelectSkill,
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
  isDragActive,
  contextUsage,
}: ChatComposerProps) {
  const { t } = useTranslation()
  const canInput = inputDisabledReason === null
  const composingRef = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  const [skills, setSkills] = useState<SkillSupportItem[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState(false)
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

  const runMenuAction = (action: () => void) => {
    setMenuOpen(false)
    action()
  }

  const loadSkills = async () => {
    if (skills.length > 0 || skillsLoading) return
    setSkillsLoading(true)
    setSkillsError(false)
    try {
      const response = await getSkills()
      setSkills(response.skills)
    } catch {
      setSkillsError(true)
    } finally {
      setSkillsLoading(false)
    }
  }

  const openSkillPicker = () => {
    setSkillPickerOpen(true)
    void loadSkills()
  }

  useEffect(() => {
    if (menuOpen) void loadSkills()
    // Opening the menu is the prefetch boundary; state changes inside
    // loadSkills must not restart the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen])

  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open)
    if (!open) setSkillPickerOpen(false)
  }

  const selectSkill = (name: string) => {
    setMenuOpen(false)
    setSkillPickerOpen(false)
    onSelectSkill(name)
  }

  const menuActions = [
    {
      label: "相册",
      icon: IconPhoto,
      action: onOpenGallery,
    },
    {
      label: "拍照",
      icon: IconCamera,
      action: onOpenCamera,
    },
    {
      label: "文件",
      icon: IconFile,
      action: onOpenFiles,
    },
    {
      label: "压缩上下文",
      icon: IconArrowsMinimize,
      action: onCompactContext,
    },
    {
      label: "清空上下文",
      icon: IconTrash,
      action: onClearContext,
      destructive: true,
    },
    {
      label: "停止任务",
      icon: IconPlayerStopFilled,
      action: onStop,
      destructive: true,
    },
  ]

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
                  className="bg-background relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl border"
                >
                  {attachment.type === "image" ? (
                    <img
                      src={attachment.url}
                      alt={attachment.filename || t("chat.uploadedImage")}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex min-w-0 flex-col items-center gap-1.5 px-2 text-center">
                      <IconFile
                        className="text-muted-foreground size-7"
                        aria-hidden="true"
                      />
                      <span className="w-full truncate text-[11px]">
                        {attachment.filename || "文件"}
                      </span>
                    </div>
                  )}
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

            <div className="flex shrink-0 items-center">
              {canInput && canSend ? (
                <Button
                  type="button"
                  size="icon"
                  className="bg-secondary text-secondary-foreground hover:bg-secondary/85 size-12 rounded-full shadow-none transition-colors"
                  onClick={onSend}
                  aria-label={t("chat.sendMessage")}
                >
                  <IconArrowUp className="size-5" aria-hidden="true" />
                </Button>
              ) : canInput ? (
                <Popover open={menuOpen} onOpenChange={handleMenuOpenChange}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="text-foreground border-border hover:bg-muted size-12 rounded-full bg-transparent shadow-none"
                      aria-label="打开更多操作"
                      aria-expanded={menuOpen}
                    >
                      <IconPlus className="size-6" aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    side="top"
                    sideOffset={10}
                    className="border-border/80 w-[min(22rem,calc(100vw-1rem))] rounded-2xl p-3 shadow-2xl"
                  >
                    {skillPickerOpen ? (
                      <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
                        <div className="bg-popover sticky top-0 z-10 mb-2 flex items-center gap-2 pb-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-10 rounded-full"
                            onClick={() => setSkillPickerOpen(false)}
                            aria-label="返回更多操作"
                          >
                            <IconArrowLeft className="size-5" />
                          </Button>
                          <div>
                            <p className="text-sm font-semibold">选择技能</p>
                            <p className="text-muted-foreground text-xs">
                              强制 MuseC137 在下一条消息使用
                            </p>
                          </div>
                        </div>
                        {skillsLoading ? (
                          <div className="text-muted-foreground flex min-h-24 items-center justify-center gap-2 text-sm">
                            <IconLoader2 className="size-4 animate-spin" />
                            正在加载技能
                          </div>
                        ) : skillsError ? (
                          <div className="flex min-h-28 flex-col items-center justify-center gap-3 text-center">
                            <p className="text-muted-foreground text-sm">
                              技能加载失败
                            </p>
                            <Button
                              type="button"
                              variant="outline"
                              className="rounded-full"
                              onClick={() => void loadSkills()}
                            >
                              重新加载
                            </Button>
                          </div>
                        ) : skills.length > 0 ? (
                          <div className="space-y-1">
                            {skills.map((skill) => (
                              <button
                                key={`${skill.source}:${skill.name}`}
                                type="button"
                                className="hover:bg-muted focus-visible:ring-ring flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left focus-visible:ring-2 focus-visible:outline-none"
                                onClick={() => selectSkill(skill.name)}
                              >
                                <IconSparkles className="text-secondary size-5 shrink-0" />
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium">
                                    {skill.name}
                                  </span>
                                  {skill.description && (
                                    <span className="text-muted-foreground block truncate text-xs">
                                      {skill.description}
                                    </span>
                                  )}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-muted-foreground py-8 text-center text-sm">
                            暂无可用技能
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="grid grid-cols-4 gap-x-2 gap-y-3">
                        {[
                          ...menuActions,
                          {
                            label: "技能",
                            icon: IconSparkles,
                            action: openSkillPicker,
                            keepOpen: true,
                          },
                        ].map((item) => {
                          const Icon = item.icon
                          return (
                            <button
                              key={item.label}
                              type="button"
                              className={cn(
                                "focus-visible:ring-ring flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl px-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-35",
                                "destructive" in item && item.destructive
                                  ? "text-destructive enabled:hover:bg-destructive/10"
                                  : "text-foreground enabled:hover:bg-muted",
                              )}
                              onClick={() =>
                                "keepOpen" in item && item.keepOpen
                                  ? item.action()
                                  : runMenuAction(item.action)
                              }
                            >
                              <span className="bg-muted/80 flex size-11 items-center justify-center rounded-xl">
                                <Icon className="size-5" aria-hidden="true" />
                              </span>
                              <span className="whitespace-nowrap">
                                {item.label}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
