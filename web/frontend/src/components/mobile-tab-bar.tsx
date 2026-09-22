import { IconClock, IconMessageCircle, IconUser } from "@tabler/icons-react"
import { Link, useRouterState } from "@tanstack/react-router"

import { cn } from "@/lib/utils"

const tabs = [
  { label: "会话", to: "/sessions" as const, icon: IconMessageCircle },
  { label: "任务", to: "/tasks" as const, icon: IconClock },
  { label: "我的", to: "/me" as const, icon: IconUser },
]

export function MobileTabBar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  return (
    <nav className="border-border/70 bg-background/95 z-50 grid h-[calc(3.75rem+env(safe-area-inset-bottom))] shrink-0 grid-cols-3 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
      {tabs.map((tab) => {
        const active =
          tab.to === "/sessions"
            ? pathname === "/" || pathname.startsWith("/sessions")
            : tab.to === "/me"
              ? pathname.startsWith("/me") || pathname.startsWith("/documents/")
              : pathname.startsWith(tab.to)
        const Icon = tab.icon
        return (
          <Link
            key={tab.to}
            to={tab.to}
            replace
            className={cn(
              "text-muted-foreground focus-visible:ring-ring flex min-h-12 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
              active && "text-foreground",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Icon
              className={cn("size-6", active && "stroke-[2.4]")}
              aria-hidden="true"
            />
            <span>{tab.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
