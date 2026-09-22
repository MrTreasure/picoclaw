import { launcherFetch } from "@/api/http"

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  schedule: {
    kind: string
    atMs?: number
    everyMs?: number
    expr?: string
    tz?: string
  }
  payload: { kind: string; message: string; channel?: string; to?: string }
  state: {
    nextRunAtMs?: number
    lastRunAtMs?: number
    lastStatus?: string
    lastError?: string
  }
  createdAtMs?: number
  updatedAtMs?: number
  deleteAfterRun?: boolean
}

export async function deleteCronJob(id: string): Promise<void> {
  const response = await launcherFetch(
    `/api/cron/jobs/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  )
  if (!response.ok) throw new Error(`status ${response.status}`)
}

export async function getCronJobs(): Promise<CronJob[]> {
  const response = await launcherFetch("/api/cron/jobs")
  if (!response.ok) throw new Error(`status ${response.status}`)
  const body = (await response.json()) as { jobs?: CronJob[] }
  return body.jobs ?? []
}
