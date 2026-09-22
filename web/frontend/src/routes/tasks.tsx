import { IconClock, IconRefresh } from "@tabler/icons-react"
import { createFileRoute } from "@tanstack/react-router"
import dayjs from "dayjs"
import { useEffect, useState } from "react"

import { type CronJob, getCronJobs } from "@/api/cron"
import { Button } from "@/components/ui/button"

function describeSchedule(job: CronJob) {
  if (job.schedule.kind === "cron") {
    return `${job.schedule.expr || "Cron"}${job.schedule.tz ? ` · ${job.schedule.tz}` : ""}`
  }
  if (job.schedule.kind === "every" && job.schedule.everyMs) {
    const minutes = Math.round(job.schedule.everyMs / 60_000)
    return `每 ${minutes} 分钟`
  }
  if (job.schedule.atMs)
    return dayjs(job.schedule.atMs).format("YYYY-MM-DD HH:mm")
  return job.schedule.kind
}

function TasksPage() {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

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

  useEffect(() => void load(), [])

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <header className="border-border/70 flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-end border-b px-4 pb-1">
        <div className="flex h-14 w-full items-center justify-between">
          <div className="size-12" />
          <h1 className="text-xl font-semibold tracking-tight">任务</h1>
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
              <p>暂无任务</p>
            </div>
          )}
          {jobs.map((job) => (
            <article
              key={job.id}
              className="bg-card border-border/70 rounded-2xl border p-4"
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
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${job.enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"}`}
                >
                  {job.enabled ? "运行中" : "已停用"}
                </span>
              </div>
              <p className="text-muted-foreground mt-3 line-clamp-2 text-sm leading-6">
                {job.payload.message}
              </p>
              {job.state.nextRunAtMs && (
                <p className="text-muted-foreground mt-3 text-xs">
                  下次：{dayjs(job.state.nextRunAtMs).format("MM-DD HH:mm")}
                </p>
              )}
            </article>
          ))}
        </div>
      </main>
    </div>
  )
}

export const Route = createFileRoute("/tasks")({ component: TasksPage })
