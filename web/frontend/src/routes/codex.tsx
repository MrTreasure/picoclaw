import { createFileRoute } from "@tanstack/react-router"

import { CodexPage } from "@/components/codex/codex-page"

export const Route = createFileRoute("/codex")({
  validateSearch: (search: Record<string, unknown>): { thread?: string } => ({
    ...(typeof search.thread === "string" ? { thread: search.thread } : {}),
  }),
  component: CodexRoute,
})

function CodexRoute() {
  const { thread } = Route.useSearch()
  return <CodexPage threadId={thread} />
}
