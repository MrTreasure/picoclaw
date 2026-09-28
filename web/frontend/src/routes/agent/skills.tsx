import { createFileRoute } from "@tanstack/react-router"
import { Suspense, lazy } from "react"

const SkillsPage = lazy(() =>
  import("@/components/agent/skills/skills-page").then((module) => ({
    default: module.SkillsPage,
  })),
)

export const Route = createFileRoute("/agent/skills")({
  component: AgentSkillsRoute,
})

function AgentSkillsRoute() {
  return (
    <Suspense
      fallback={
        <div role="status" className="p-6 text-center">
          正在加载…
        </div>
      }
    >
      <SkillsPage />
    </Suspense>
  )
}
