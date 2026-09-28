import { createFileRoute } from "@tanstack/react-router"
import { Suspense, lazy } from "react"

const CodexPage = lazy(() =>
  import("@/components/codex/codex-page").then((module) => ({
    default: module.CodexPage,
  })),
)

export const Route = createFileRoute("/codex")({
  validateSearch: (search: Record<string, unknown>): { thread?: string } => ({
    ...(typeof search.thread === "string" ? { thread: search.thread } : {}),
  }),
  component: CodexRoute,
})

function CodexRoute() {
  const { thread } = Route.useSearch()
  return (
    <Suspense
      fallback={
        <div role="status" className="p-6 text-center">
          正在打开对话…
        </div>
      }
    >
      <CodexPage threadId={thread} />
    </Suspense>
  )
}
