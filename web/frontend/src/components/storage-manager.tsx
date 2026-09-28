import { useEffect, useState } from "react"
import { toast } from "sonner"

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
  type StorageCategory,
  type StorageInfo,
  clearStorageCategory,
  storageOverview,
} from "@/features/chat/storage-management"

const labels: Record<StorageCategory, string> = {
  pico: "Muse / 微信消息缓存",
  codex: "Codex 消息缓存",
  lists: "会话列表缓存",
  titles: "Codex 自定义标题",
}
export function StorageManager() {
  const [data, setData] = useState<Record<StorageCategory, StorageInfo> | null>(
    null,
  )
  const [error, setError] = useState(false)
  const [target, setTarget] = useState<StorageCategory | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () =>
    storageOverview()
      .then(setData)
      .catch(() => setError(true))
  useEffect(() => {
    void load()
  }, [])
  return (
    <section className="bg-card border-border/70 rounded-2xl border p-4">
      <h2 className="font-medium">本机缓存管理</h2>
      <p className="text-muted-foreground mt-1 text-xs">
        清理仅影响本机。消息与列表可重新加载；清除自定义标题会恢复原始名称。
      </p>
      {error && <p role="alert">无法读取本机存储</p>}
      {(Object.keys(labels) as StorageCategory[]).map((key) => (
        <div
          key={key}
          className="flex min-h-16 items-center justify-between gap-3 border-b py-2 last:border-0"
        >
          <div>
            <p className="text-sm">{labels[key]}</p>
            <p className="text-muted-foreground text-xs">
              {data
                ? `${data[key].count} 项 · ${(data[key].bytes / 1024).toFixed(1)} KB`
                : "读取中…"}
              {data?.[key].updated
                ? " · " + new Date(data[key].updated!).toLocaleString()
                : ""}
            </p>
          </div>
          <Button
            variant="ghost"
            disabled={busy || !data?.[key].count}
            className="min-h-11"
            onClick={() => setTarget(key)}
          >
            清理
          </Button>
        </div>
      ))}
      <p className="text-muted-foreground mt-2 text-xs">
        大小为已存内容估算；正在使用的会话可能继续生成缓存。
      </p>
      <AlertDialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !busy) setTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              清理{target ? labels[target] : ""}？
            </AlertDialogTitle>
            <AlertDialogDescription>
              不会删除服务器上的对话。清理后离线可用内容会减少。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                if (!target) return
                setBusy(true)
                void clearStorageCategory(target)
                  .then(async () => {
                    setTarget(null)
                    await load()
                    toast.success("已清理")
                  })
                  .catch(() => toast.error("清理失败，请重试"))
                  .finally(() => setBusy(false))
              }}
            >
              {busy ? "清理中…" : "清理"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
