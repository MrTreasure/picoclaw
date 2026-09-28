import { createFileRoute } from "@tanstack/react-router"
import { Suspense, lazy } from "react"

const LogsPage = lazy(() =>
  import("@/components/logs/logs-page").then((module) => ({
    default: module.LogsPage,
  })),
)

export const Route = createFileRoute("/logs")({
  component: () => (
    <Suspense
      fallback={
        <div role="status" className="p-6">
          正在加载日志…
        </div>
      }
    >
      <LogsPage />
    </Suspense>
  ),
})
