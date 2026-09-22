import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router"

import { SessionListPage } from "@/components/chat/session-list-page"

export const Route = createFileRoute("/sessions")({
  component: SessionsRouteLayout,
})

function SessionsRouteLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  if (pathname === "/sessions") {
    return <SessionListPage />
  }

  return <Outlet />
}
