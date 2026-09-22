import {
  IconChevronRight,
  IconClock,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react"
import { createFileRoute } from "@tanstack/react-router"
import dayjs from "dayjs"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { type CronJob, deleteCronJob, getCronJobs } from "@/api/cron"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

function describeSchedule(job: CronJob) {
  if (job.schedule.kind === "cron") {
    return `${job.schedule.expr || "Cron"}${job.schedule.tz ? ` · ${job.schedule.tz}` : ""}`
  }
  if (job.schedule.kind === "every" && job.schedule.everyMs) {
    const minutes = Math.round(job.schedule.everyMs / 60_000)
    if (minutes < 60) return `每 ${minutes} 分钟`
    const hours = job.schedule.everyMs / 3_600_000
    return `每 ${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`
  }
  if (job.schedule.atMs)
    return dayjs(job.schedule.atMs).format("YYYY-MM-DD HH:mm")
  return job.schedule.kind
}

function formatTime(value?: number) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "—"
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{value}</dd>
    </div>
  )
}

function TasksPage() {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [selected, setSelected] = useState<CronJob | null>(null)
  const [deleting, setDeleting] = useState<CronJob | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      setJobs(await getCronJobs())
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  const remove = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await deleteCronJob(deleting.id)
      setJobs((current) => current.filter((job) => job.id !== deleting.id))
      if (selected?.id === deleting.id) setSelected(null)
      setDeleting(null)
      toast.success("定时任务已删除")
    } catch {
      toast.error("删除失败，请确认服务在线后重试")
    } finally {
      setDeleteBusy(false)
    }
  }

  useEffect(() => void load(), [])

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <header className="border-border/70 flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-end border-b px-4 pb-1">
        <div className="flex h-14 w-full items-center justify-between">
          <div className="size-12" />
          <h1 className="text-xl font-semibold tracking-tight">定时任务</h1>
          <Button
            variant="ghost"
            size="icon"
            className="size-12 rounded-full"
            onClick={() => void load()}
            aria-label="刷新"
          >
            <IconRefresh
              className={loading ? "size-5 animate-spin" : "size-5"}
            />
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-6">
        <div className="mx-auto w-full max-w-3xl space-y-3">
          {error && (
            <p className="text-destructive py-12 text-center">任务加载失败</p>
          )}
          {!error && !loading && jobs.length === 0 && (
            <div className="text-muted-foreground flex flex-col items-center py-20">
              <IconClock className="mb-4 size-10" />
              <p>暂无定时任务</p>
            </div>
          )}
          {jobs.map((job) => (
            <article
              key={job.id}
              className="bg-card border-border/70 flex items-stretch overflow-hidden rounded-2xl border"
            >
              <button
                type="button"
                className="min-w-0 flex-1 p-4 text-left active:bg-white/5"
                onClick={() => setSelected(job)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold">
                      {job.name}
                    </h2>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {describeSchedule(job)}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${job.enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"}`}
                  >
                    {job.enabled ? "运行中" : "已停用"}
                  </span>
                </div>
                <p className="text-muted-foreground mt-3 line-clamp-2 text-sm leading-6">
                  {job.payload.message}
                </p>
                <div className="text-muted-foreground mt-3 flex items-center justify-between gap-3 text-xs">
                  <span>
                    {job.state.nextRunAtMs
                      ? `下次：${dayjs(job.state.nextRunAtMs).format("MM-DD HH:mm")}`
                      : "暂无下次执行时间"}
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    查看详情 <IconChevronRight className="size-4" />
                  </span>
                </div>
              </button>
              <button
                type="button"
                className="border-border/70 text-muted-foreground hover:text-destructive w-14 shrink-0 border-l transition-colors"
                onClick={() => setDeleting(job)}
                aria-label={`删除${job.name}`}
              >
                <IconTrash className="mx-auto size-5" />
              </button>
            </article>
          ))}
        </div>
      </main>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent className="max-h-[min(46rem,calc(100dvh-2rem))] gap-4 overflow-y-auto sm:max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="pr-8 text-lg">
                  {selected.name}
                </DialogTitle>
                <DialogDescription>定时任务详细信息</DialogDescription>
              </DialogHeader>
              <dl className="divide-border/70 divide-y text-sm">
                <DetailRow
                  label="状态"
                  value={selected.enabled ? "运行中" : "已停用"}
                />
                <DetailRow
                  label="执行计划"
                  value={describeSchedule(selected)}
                />
                <DetailRow
                  label="下次执行"
                  value={formatTime(selected.state.nextRunAtMs)}
                />
                <DetailRow
                  label="上次执行"
                  value={formatTime(selected.state.lastRunAtMs)}
                />
                <DetailRow
                  label="上次结果"
                  value={selected.state.lastStatus || "—"}
                />
                {selected.state.lastError && (
                  <DetailRow label="错误" value={selected.state.lastError} />
                )}
                <DetailRow
                  label="发送渠道"
                  value={selected.payload.channel || "默认渠道"}
                />
                <DetailRow
                  label="接收方"
                  value={selected.payload.to || "默认接收方"}
                />
                <DetailRow
                  label="单次任务"
                  value={selected.deleteAfterRun ? "执行后自动删除" : "否"}
                />
                <DetailRow
                  label="创建时间"
                  value={formatTime(selected.createdAtMs)}
                />
                <DetailRow
                  label="更新时间"
                  value={formatTime(selected.updatedAtMs)}
                />
                <DetailRow label="任务 ID" value={selected.id} />
              </dl>
              <div>
                <p className="text-muted-foreground mb-2 text-sm">任务内容</p>
                <div className="bg-muted/50 max-h-56 overflow-y-auto rounded-xl p-3 text-sm leading-6 whitespace-pre-wrap">
                  {selected.payload.message || "（无内容）"}
                </div>
              </div>
              <Button
                variant="destructive"
                className="w-full"
                onClick={() => setDeleting(selected)}
              >
                <IconTrash className="size-4" />
                删除任务
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && !deleteBusy && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除定时任务？</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.name}”删除后将不会继续执行，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteBusy}
              onClick={(event) => {
                event.preventDefault()
                void remove()
              }}
            >
              {deleteBusy ? "删除中…" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export const Route = createFileRoute("/tasks")({ component: TasksPage })
