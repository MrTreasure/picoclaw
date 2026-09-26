import {
  IconArrowUp,
  IconCamera,
  IconPhoto,
  IconPlayerStopFilled,
  IconPlus,
  IconX,
} from "@tabler/icons-react"
import { useRef, useState } from "react"
import type { ClipboardEvent, DragEvent, KeyboardEvent } from "react"
import TextareaAutosize from "react-textarea-autosize"

import type { CodexImage } from "@/api/codex"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  getTransferredFiles,
  hasFileTransfer,
} from "@/features/chat/image-input"
import { cn } from "@/lib/utils"

interface CodexComposerProps {
  draft: string
  images: Array<CodexImage & { name: string }>
  connected: boolean
  canSendImage: boolean
  canSend: boolean
  busy: boolean
  running: boolean
  uploading: boolean
  onDraftChange: (value: string) => void
  onImages: (files: File[]) => void
  onRemoveImage: (path: string) => void
  onSend: () => void
  onStop?: () => void
}

export function CodexComposer({
  draft,
  images,
  connected,
  canSendImage,
  canSend,
  busy,
  running,
  uploading,
  onDraftChange,
  onImages,
  onRemoveImage,
  onSend,
  onStop,
}: CodexComposerProps) {
  const galleryRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const dragDepthRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const canInput = connected && !busy

  const addFiles = (files: File[]) => {
    if (canInput && canSendImage && files.length) onImages(files)
  }
  const selectFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []))
    event.target.value = ""
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    addFiles(getTransferredFiles(event.clipboardData))
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    addFiles(getTransferredFiles(event.dataTransfer))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as Event & {
      isComposing?: boolean
      keyCode?: number
    }
    if (composingRef.current || native.isComposing || native.keyCode === 229)
      return
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (canSend) onSend()
    }
  }

  return (
    <div className="border-border/70 bg-card relative z-10 shrink-0 border-t px-2 pt-2 pb-[calc(.5rem+env(safe-area-inset-bottom))] md:px-8 md:pt-3 md:pb-4 lg:px-24 xl:px-48">
      <input
        ref={galleryRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={selectFiles}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={selectFiles}
      />
      <div className="mx-auto flex max-w-[900px] flex-col items-end">
        <div
          className={cn(
            "relative flex w-full flex-col transition-colors",
            dragging && "bg-accent/50 ring-ring/70 rounded-xl ring-2",
          )}
          onDragEnter={(event) => {
            if (!hasFileTransfer(event.dataTransfer)) return
            event.preventDefault()
            dragDepthRef.current += 1
            if (canInput && canSendImage) setDragging(true)
          }}
          onDragLeave={(event) => {
            if (!hasFileTransfer(event.dataTransfer)) return
            event.preventDefault()
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
            if (!dragDepthRef.current) setDragging(false)
          }}
          onDragOver={(event) => {
            if (!hasFileTransfer(event.dataTransfer)) return
            event.preventDefault()
            event.dataTransfer.dropEffect =
              canInput && canSendImage ? "copy" : "none"
          }}
          onDrop={onDrop}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-violet-400/70 bg-violet-500/10">
              <span className="bg-background/95 text-foreground rounded-full px-4 py-2 text-sm font-medium shadow-sm">
                拖放图片到这里
              </span>
            </div>
          )}
          {images.length > 0 && (
            <div
              className="mb-2 flex flex-wrap gap-2 px-1"
              aria-label="待发送图片"
            >
              {images.map((image) => (
                <div
                  key={image.path}
                  className="bg-background relative flex size-20 items-center justify-center overflow-hidden rounded-xl border"
                >
                  <img
                    src={image.url}
                    alt={image.name}
                    className="size-full object-cover"
                  />
                  <button
                    type="button"
                    className="bg-background/85 text-foreground absolute top-1 right-1 flex size-7 items-center justify-center rounded-full border shadow-sm"
                    aria-label={`移除 ${image.name}`}
                    onClick={() => onRemoveImage(image.path)}
                  >
                    <IconX className="size-4" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex w-full items-end gap-1.5">
            <div className="bg-muted/80 focus-within:border-ring/70 focus-within:bg-background flex min-h-12 min-w-0 flex-1 items-end rounded-xl border border-transparent px-1 transition-colors">
              <TextareaAutosize
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={() => {
                  composingRef.current = false
                }}
                onPaste={onPaste}
                onKeyDown={onKeyDown}
                placeholder={connected ? "继续和 Codex 对话…" : "Codex 连接中…"}
                disabled={!canInput}
                aria-label="Codex 消息"
                className="placeholder:text-muted-foreground/65 min-h-11 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-2.5 text-base leading-6 shadow-none focus-visible:ring-0 focus-visible:outline-none"
                minRows={1}
                maxRows={6}
              />
            </div>
            {canSend ? (
              <Button
                type="button"
                size="icon"
                className="bg-secondary text-secondary-foreground hover:bg-secondary/85 size-12 shrink-0 rounded-full shadow-none"
                onClick={onSend}
                aria-label={running ? "插入当前回复" : "发送消息"}
              >
                <IconArrowUp className="size-5" aria-hidden="true" />
              </Button>
            ) : (
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="text-foreground border-border hover:bg-muted size-12 shrink-0 rounded-full bg-transparent shadow-none"
                    aria-label="打开更多操作"
                    aria-expanded={menuOpen}
                    disabled={!canInput}
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
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      className="hover:bg-muted focus-visible:ring-ring flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl text-xs focus-visible:ring-2 disabled:opacity-40"
                      disabled={!canSendImage}
                      onClick={() => {
                        setMenuOpen(false)
                        galleryRef.current?.click()
                      }}
                    >
                      <span className="bg-muted/80 flex size-11 items-center justify-center rounded-xl">
                        <IconPhoto className="size-5" aria-hidden="true" />
                      </span>
                      相册
                    </button>
                    <button
                      type="button"
                      className="hover:bg-muted focus-visible:ring-ring flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl text-xs focus-visible:ring-2 disabled:opacity-40"
                      disabled={!canSendImage}
                      onClick={() => {
                        setMenuOpen(false)
                        cameraRef.current?.click()
                      }}
                    >
                      <span className="bg-muted/80 flex size-11 items-center justify-center rounded-xl">
                        <IconCamera className="size-5" aria-hidden="true" />
                      </span>
                      拍照
                    </button>
                    <button
                      type="button"
                      className="text-destructive hover:bg-destructive/10 focus-visible:ring-ring flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl text-xs focus-visible:ring-2 disabled:opacity-40"
                      disabled={!running || !onStop}
                      onClick={() => {
                        setMenuOpen(false)
                        onStop?.()
                      }}
                    >
                      <span className="bg-muted/80 flex size-11 items-center justify-center rounded-xl">
                        <IconPlayerStopFilled
                          className="size-5"
                          aria-hidden="true"
                        />
                      </span>
                      停止任务
                    </button>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
          {uploading && (
            <p
              className="text-muted-foreground mt-1 px-1 text-xs"
              role="status"
            >
              图片上传中…
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
