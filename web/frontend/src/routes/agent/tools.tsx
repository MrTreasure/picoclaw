import { createFileRoute } from "@tanstack/react-router"
import { Suspense, lazy } from "react"

const ToolsPage = lazy(() =>
  import("@/components/agent/tools/tools-page").then((module) => ({
    default: module.ToolsPage,
  })),
)

export const Route = createFileRoute("/agent/tools")({
  component: AgentToolsRoute,
})

function AgentToolsRoute() {
  return (
    <Suspense
      fallback={
        <div role="status" className="p-6 text-center">
          正在加载…
        </div>
      }
    >
      <ToolsPage />
    </Suspense>
  )
}
