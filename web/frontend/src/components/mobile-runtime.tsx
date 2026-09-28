import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { hasPendingCodexWork } from "@/api/codex-socket-manager"
import { Button } from "@/components/ui/button"
import {
  hasPendingChatWork,
  switchChatSession,
} from "@/features/chat/controller"
import { markConversationUnread } from "@/features/chat/unread"

export function MobileRuntime() {
  const navigate = useNavigate()
  const [online, setOnline] = useState(navigator.onLine)
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)
  useEffect(() => {
    let active = true
    const status = () => setOnline(navigator.onLine)
    const viewport = () => {
      const v = window.visualViewport
      if (v && v.scale === 1) {
        document.documentElement.style.setProperty(
          "--app-height",
          v.height + "px",
        )
        document.documentElement.style.setProperty(
          "--app-top",
          v.offsetTop + "px",
        )
      }
    }
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(viewport)
    }
    window.addEventListener("online", status)
    window.addEventListener("offline", status)
    window.visualViewport?.addEventListener("resize", schedule)
    window.visualViewport?.addEventListener("scroll", schedule)
    viewport()
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "OPEN_CONVERSATION") {
        const target = new URL(event.data.url, location.origin)
        if (target.origin !== location.origin) return
        if (target.pathname === "/codex") {
          void navigate({
            to: "/codex",
            search: { thread: target.searchParams.get("thread") || undefined },
          })
        } else if (
          typeof event.data.sessionId === "string" &&
          event.data.sessionId
        ) {
          void switchChatSession(event.data.sessionId)
          void navigate({ to: "/" })
        }
      }
      if (
        event.data?.type === "CONVERSATION_UPDATED" &&
        typeof event.data.sessionId === "string"
      )
        markConversationUnread(
          "muse:" + event.data.sessionId,
          String(event.data.eventId || Date.now()),
        )
    }
    navigator.serviceWorker?.addEventListener("message", onMessage)
    let registration: ServiceWorkerRegistration | undefined
    const inspect = () => {
      if (active && registration?.waiting) setWaiting(registration.waiting)
    }
    const installing = () => {
      registration?.installing?.addEventListener("statechange", inspect)
      inspect()
    }
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker.ready.then((value) => {
        if (!active) return
        registration = value
        void value
          .getNotifications()
          .then((notifications) =>
            notifications.forEach((notification) => {
              const id = notification.data?.sessionId
              if (typeof id === "string" && id)
                markConversationUnread("muse:" + id, notification.tag)
            }),
          )
          .catch(() => {})
        registration.addEventListener("updatefound", installing)
        installing()
      })
    return () => {
      active = false
      navigator.serviceWorker?.removeEventListener("message", onMessage)
      cancelAnimationFrame(frame)
      window.removeEventListener("online", status)
      window.removeEventListener("offline", status)
      window.visualViewport?.removeEventListener("resize", schedule)
      window.visualViewport?.removeEventListener("scroll", schedule)
      registration?.removeEventListener("updatefound", installing)
    }
  }, [navigate])
  return (
    <>
      {!online && (
        <div
          role="status"
          className="bg-amber-100 px-3 py-2 text-center text-xs text-amber-950"
        >
          离线中 · 显示本机缓存，联网后恢复同步
        </div>
      )}
      {waiting && (
        <div
          role="status"
          className="bg-muted flex items-center justify-center gap-3 px-3 text-xs"
        >
          <span>新版本已就绪</span>
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              if (hasPendingChatWork() || hasPendingCodexWork()) {
                toast.info("任务进行中，完成后再更新")
                return
              }
              navigator.serviceWorker.addEventListener(
                "controllerchange",
                () => location.reload(),
                { once: true },
              )
              waiting.postMessage({ type: "ACTIVATE_UPDATE" })
            }}
          >
            更新并重新打开
          </Button>
        </div>
      )}
    </>
  )
}
