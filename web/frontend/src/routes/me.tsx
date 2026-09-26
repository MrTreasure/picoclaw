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
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { getLauncherAuthStatus } from "@/api/launcher-auth"
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
import {
  type LocalChatCacheStats,
  getLocalChatCacheStats,
} from "@/features/chat/local-storage-stats"
import {
  type HistoryCacheStats,
  codexHistoryCacheStats,
} from "@/features/codex/history-cache"
import { validCacheScope } from "@/hooks/session-list-cache"
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
  return `${(bytes / 1024 ** unit).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`
}

function MePage() {
  const { newChat } = usePicoChat()
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [cacheStats, setCacheStats] = useState<LocalChatCacheStats | null>(null)
  const [codexCacheStats, setCodexCacheStats] =
    useState<HistoryCacheStats | null>(null)
  const [codexCacheError, setCodexCacheError] = useState(false)
  const [cacheError, setCacheError] = useState(false)
  const [originEstimate, setOriginEstimate] = useState<{
    usage: number
    quota?: number
  } | null>(null)

  useEffect(() => {
    let active = true
    void getLocalChatCacheStats()
      .then((stats) => {
        if (active) setCacheStats(stats)
      })
      .catch(() => {
        if (active) setCacheError(true)
      })
    void getLauncherAuthStatus()
      .then((status) => {
        if (!active) return
        if (!status.authenticated || !validCacheScope(status.cache_scope)) {
          setCodexCacheError(true)
          return
        }
        return codexHistoryCacheStats(status.cache_scope).then((stats) => {
          if (active) setCodexCacheStats(stats)
        })
      })
      .catch(() => {
        if (active) setCodexCacheError(true)
      })
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      void navigator.storage
        .estimate()
        .then((estimate) => {
          if (active && typeof estimate.usage === "number")
            setOriginEstimate({ usage: estimate.usage, quota: estimate.quota })
        })
        .catch(() => {})
    }
    return () => {
      active = false
    }
  }, [])

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
            <div className="border-border/60 border-b px-3 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span>Pico / 微信会话本地缓存</span>
                <span className="font-medium tabular-nums">
                  {cacheError
                    ? "读取失败"
                    : cacheStats
                      ? `${formatBytes(cacheStats.bytes)} · ${cacheStats.count} 条`
                      : "读取中…"}
                </span>
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                已缓存记录的 JSON UTF-8 大小，非磁盘实际占用；只读统计。
              </p>
              {originEstimate && (
                <p className="text-muted-foreground mt-2 text-xs">
                  浏览器同源存储估算：{formatBytes(originEstimate.usage)}
                  {typeof originEstimate.quota === "number"
                    ? ` / 配额 ${formatBytes(originEstimate.quota)}`
                    : ""}
                  （包含此站点其他数据，非聊天缓存大小）
                </p>
              )}
            </div>
            <div className="border-border/60 border-b px-3 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span>Codex 对话本地缓存</span>
                <span className="font-medium tabular-nums">
                  {codexCacheError
                    ? "读取失败"
                    : codexCacheStats
                      ? `${formatBytes(codexCacheStats.bytes)} · ${codexCacheStats.count} 条`
                      : "读取中…"}
                </span>
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                本设备已打开过的 Codex 对话文本缓存；不包含图片，非 NAS
                历史文件或磁盘实际占用。
              </p>
            </div>
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
