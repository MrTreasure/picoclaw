import { createFileRoute } from "@tanstack/react-router"

import { SessionListPage } from "@/components/chat/session-list-page"

export const Route = createFileRoute("/sessions")({
  component: SessionListPage,
})
