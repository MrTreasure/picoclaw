import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router"
import { Suspense, lazy } from "react"

const ConfigPage = lazy(() =>
  import("@/components/config/config-page").then((module) => ({
    default: module.ConfigPage,
  })),
)

export const Route = createFileRoute("/config")({
  component: ConfigRouteLayout,
})

function ConfigRouteLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  if (pathname === "/config") {
    return (
      <Suspense
        fallback={
          <div role="status" className="p-6 text-center">
            正在加载…
          </div>
        }
      >
        <ConfigPage />
      </Suspense>
    )
  }

  return <Outlet />
}
