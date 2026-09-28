import { Button } from "@/components/ui/button"

export interface DeleteProgressItem {
  id: string
  label: string
  status: "pending" | "running" | "deleted" | "failed"
  error?: string
}
export function BatchDeleteStatus({
  items,
  busy,
  onRetry,
  onDismiss,
}: {
  items: DeleteProgressItem[]
  busy: boolean
  onRetry: () => void
  onDismiss: () => void
}) {
  if (!items.length) return null
  const finished = items.filter(
    (item) => item.status === "deleted" || item.status === "failed",
  ).length
  const failed = items.filter((item) => item.status === "failed")
  const current = items.find((item) => item.status === "running")
  return (
    <section
      aria-label="删除进度"
      className="bg-card border-border mb-3 space-y-2 rounded-xl border p-3"
    >
      <div role="status" aria-live="polite" className="text-sm">
        {busy ? "正在删除" : "处理完成"} · {finished} / {items.length}
        {current && (
          <span className="text-muted-foreground block truncate">
            {current.label}
          </span>
        )}
      </div>
      <progress
        value={finished}
        max={items.length}
        className="h-1.5 w-full accent-emerald-500"
      />
      {failed.length > 0 && (
        <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">
          {failed.map((item) => (
            <li key={item.id}>
              <p className="truncate font-medium">{item.label}</p>
              <p className="text-destructive break-words">
                {item.error || "结果未确认，请重试"}
              </p>
            </li>
          ))}
        </ul>
      )}
      {!busy && (
        <div className="flex flex-wrap gap-2">
          {failed.length > 0 && (
            <Button variant="outline" className="min-h-11" onClick={onRetry}>
              仅重试未完成的 {failed.length} 项
            </Button>
          )}
          <Button variant="ghost" className="min-h-11" onClick={onDismiss}>
            收起
          </Button>
        </div>
      )}
    </section>
  )
}
