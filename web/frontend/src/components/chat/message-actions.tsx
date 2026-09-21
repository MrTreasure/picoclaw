import { IconCode, IconCopy, IconSelect } from "@tabler/icons-react"
import type { ReactNode } from "react"
import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { useLongPress } from "@/hooks/use-long-press"
import { cn } from "@/lib/utils"

function extractCode(content: string) {
  return [...content.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .join("\n\n")
}

export function MessageActions({
  children,
  content,
  className,
}: {
  children: ReactNode
  content: string
  className?: string
}) {
  const { t } = useTranslation()
  const { copy } = useCopyToClipboard()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const code = useMemo(() => extractCode(content), [content])
  const showMenu = useCallback(() => setOpen(true), [])
  const { isTracking, longPressProps } = useLongPress({ onLongPress: showMenu })

  const selectText = () => {
    setOpen(false)
    const root = rootRef.current
    const selection = window.getSelection()
    if (!root || !selection) return
    const range = document.createRange()
    range.selectNodeContents(root)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          ref={rootRef}
          className={cn(
            "touch-pan-y",
            isTracking && "select-none [-webkit-touch-callout:none]",
            className,
          )}
          onContextMenu={(event) => {
            event.preventDefault()
            showMenu()
          }}
          {...longPressProps}
        >
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="center"
        className="grid w-52 gap-1 p-1.5"
        aria-label={t("chat.messageActions")}
      >
        <Button
          variant="ghost"
          className="h-11 justify-start gap-3 px-3"
          onClick={() => {
            void copy(content)
            setOpen(false)
          }}
        >
          <IconCopy className="size-4" aria-hidden="true" />
          {t("chat.copyMessage")}
        </Button>
        {code && (
          <Button
            variant="ghost"
            className="h-11 justify-start gap-3 px-3"
            onClick={() => {
              void copy(code)
              setOpen(false)
            }}
          >
            <IconCode className="size-4" aria-hidden="true" />
            {t("chat.copyCode")}
          </Button>
        )}
        <Button
          variant="ghost"
          className="h-11 justify-start gap-3 px-3"
          onClick={selectText}
        >
          <IconSelect className="size-4" aria-hidden="true" />
          {t("chat.selectText")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
