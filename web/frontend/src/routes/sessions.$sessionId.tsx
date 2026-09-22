import { IconArrowLeft, IconBrandWechat } from "@tabler/icons-react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useAtomValue } from "jotai"
import { useEffect, useMemo, useRef, useState } from "react"

import { AssistantMessage } from "@/components/chat/assistant-message"
import { UserMessage } from "@/components/chat/user-message"
import { Button } from "@/components/ui/button"
import {
  loadSessionMessages,
  mergeHistoryMessages,
} from "@/features/chat/history"
import {
  type ChatMessage,
  assistantDetailVisibilityAtom,
  shouldShowAssistantMessage,
} from "@/store/chat"

function WeixinSessionPage() {
  const { sessionId } = Route.useParams()
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLElement>(null)
  const loadingRef = useRef(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [before, setBefore] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const detailVisibility = useAtomValue(assistantDetailVisibilityAtom)
  const visibleMessages = useMemo(
    () =>
      messages.filter((message) =>
        shouldShowAssistantMessage(detailVisibility, message.kind),
      ),
    [detailVisibility, messages],
  )

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      visibleMessages[index]?.role === "assistant" ? 180 : 92,
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
    overscan: 6,
  })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    void loadSessionMessages(sessionId)
      .then((page) => {
        if (cancelled) return
        setMessages(page.messages)
        setBefore(page.nextBefore)
        setHasMore(page.hasMore)
        requestAnimationFrame(() => {
          const element = scrollRef.current
          if (element) element.scrollTop = element.scrollHeight
        })
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const loadOlder = async (element: HTMLElement) => {
    if (!hasMore || before === null || loadingRef.current) return
    loadingRef.current = true
    const previousHeight = element.scrollHeight
    const previousTop = element.scrollTop
    try {
      const page = await loadSessionMessages(sessionId, before)
      setMessages((current) => mergeHistoryMessages(page.messages, current))
      setBefore(page.nextBefore)
      setHasMore(page.hasMore)
      requestAnimationFrame(() => {
        const current = scrollRef.current
        if (current) {
          current.scrollTop =
            current.scrollHeight - previousHeight + previousTop
        }
        loadingRef.current = false
      })
    } catch {
      loadingRef.current = false
    }
  }

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <header className="border-border/70 bg-background/92 flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-end border-b px-2 pb-1 backdrop-blur-xl">
        <div className="flex h-14 w-full items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-12 rounded-full"
            onClick={() => void navigate({ to: "/sessions" })}
            aria-label="返回会话列表"
          >
            <IconArrowLeft className="size-6" aria-hidden="true" />
          </Button>
          <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
            <IconBrandWechat className="size-6" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">微信会话</h1>
            <p className="text-muted-foreground text-xs">历史记录 · 只读</p>
          </div>
        </div>
      </header>

      <main
        ref={scrollRef}
        onScroll={(event) => {
          if (event.currentTarget.scrollTop < 160) {
            void loadOlder(event.currentTarget)
          }
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3 md:px-8 lg:px-24 xl:px-48"
      >
        {loading && messages.length === 0 && (
          <p className="text-muted-foreground py-16 text-center text-sm">
            正在加载微信记录…
          </p>
        )}
        {error && (
          <p className="text-destructive py-16 text-center text-sm">
            微信记录加载失败，请稍后重试
          </p>
        )}
        <div className="mx-auto w-full max-w-225">
          <div
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const message = visibleMessages[item.index]
              if (!message) return null
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute top-0 left-0 w-full pb-3"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {message.role === "assistant" ? (
                    <AssistantMessage
                      content={message.content}
                      attachments={message.attachments}
                      kind={message.kind}
                      modelName={message.modelName}
                      toolCalls={message.toolCalls}
                      timestamp={message.timestamp}
                    />
                  ) : (
                    <UserMessage
                      content={message.content}
                      attachments={message.attachments}
                      timestamp={message.timestamp}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </main>
    </div>
  )
}

export const Route = createFileRoute("/sessions/$sessionId")({
  component: WeixinSessionPage,
})
