import {
  IconAdjustments,
  IconChevronRight,
  IconFileText,
  IconKey,
  IconListDetails,
  IconMessagePlus,
  IconPlugConnected,
  IconSettings,
  IconSparkles,
  IconTools,
  IconTrash,
} from "@tabler/icons-react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "sonner"

import { clearTaskRunSessions } from "@/api/sessions"
import { PushNotificationControl } from "@/components/chat/push-notification-control"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { usePicoChat } from "@/hooks/use-pico-chat"

const groups = [
  {
    title: "Muse 设定",
    items: [
      {
        label: "SOUL.md",
        to: "/documents/$name",
        params: { name: "soul" },
        icon: IconFileText,
      },
      {
        label: "MEMORY.md",
        to: "/documents/$name",
        params: { name: "memory" },
        icon: IconFileText,
      },
    ],
  },
  {
    title: "对话",
    items: [
      { label: "新建会话", to: "/", icon: IconMessagePlus, action: "new" },
    ],
  },
  {
    title: "MuseC137",
    items: [
      { label: "技能", to: "/agent/skills", icon: IconSparkles },
      { label: "工具", to: "/agent/tools", icon: IconTools },
      { label: "渠道", to: "/channels", icon: IconPlugConnected },
    ],
  },
  {
    title: "系统",
    items: [
      { label: "系统设置", to: "/config", icon: IconSettings },
      { label: "凭据", to: "/credentials", icon: IconKey },
      { label: "运行日志", to: "/logs", icon: IconListDetails },
      { label: "原始配置", to: "/config/raw", icon: IconAdjustments },
    ],
  },
] as const

function MePage() {
  const { newChat } = usePicoChat()
  const [clearDialogOpen, setClearDialogOpen] = useState(false)

  return (
    <div className="bg-background h-full min-h-0 overflow-y-auto">
      <header className="border-border/70 flex h-[calc(4rem+env(safe-area-inset-top))] items-end border-b px-4 pb-1">
        <div className="flex h-14 w-full items-center justify-center">
          <h1 className="text-xl font-semibold tracking-tight">我的</h1>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl space-y-5 px-3 py-4 sm:px-6">
        <section className="bg-card border-border/70 rounded-2xl border p-4">
          <div className="flex items-center gap-3">
            <img
              src="/web-app-manifest-192x192.png"
              alt="MuseC137"
              className="size-14 rounded-2xl"
            />
            <div>
              <h2 className="text-lg font-semibold">MuseC137</h2>
              <p className="text-muted-foreground text-sm">你的研发工作分身</p>
            </div>
          </div>
        </section>

        <section className="bg-card border-border/70 rounded-2xl border px-4">
          <PushNotificationControl />
        </section>

        {groups.map((group) => (
          <section key={group.title}>
            <h2 className="text-muted-foreground mb-2 px-2 text-sm font-medium">
              {group.title}
            </h2>
            <div className="bg-card border-border/70 overflow-hidden rounded-2xl border">
              {group.items.map((item, index) => {
                const Icon = item.icon
                return (
                  <Link
                    key={item.label}
                    to={item.to}
                    {...("params" in item ? { params: item.params } : {})}
                    onClick={() => {
                      if ("action" in item && item.action === "new")
                        void newChat()
                    }}
                    className={`hover:bg-muted/60 focus-visible:ring-ring flex min-h-14 items-center gap-3 px-4 focus-visible:ring-2 focus-visible:outline-none ${index > 0 ? "border-border/60 border-t" : ""}`}
                  >
                    <Icon
                      className="text-muted-foreground size-5"
                      aria-hidden="true"
                    />
                    <span className="flex-1 text-[15px]">{item.label}</span>
                    <IconChevronRight
                      className="text-muted-foreground size-5"
                      aria-hidden="true"
                    />
                  </Link>
                )
              })}
            </div>
          </section>
        ))}

        <section>
          <h2 className="text-muted-foreground mb-2 px-2 text-sm font-medium">
            数据与存储
          </h2>
          <div className="bg-card border-border/70 rounded-2xl border p-2">
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive min-h-14 w-full justify-start gap-3 rounded-xl px-3"
              onClick={() => setClearDialogOpen(true)}
            >
              <IconTrash className="size-5" />
              清除任务记录
            </Button>
          </div>
        </section>
      </main>

      <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清除全部任务记录？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除每日记忆整理、小时汇报等任务运行生成的 agent_cron
              会话，不会删除任务配置和正常聊天。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                void clearTaskRunSessions()
                  .then((count) =>
                    toast.success(`已清理 ${count} 个任务记录文件`),
                  )
                  .catch(() => toast.error("任务记录清理失败"))
              }}
            >
              清除数据
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export const Route = createFileRoute("/me")({ component: MePage })
