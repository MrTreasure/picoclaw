import { useRouterState } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Toaster } from "sonner"

import { AppHeader } from "@/components/app-header"
import { AppSidebar } from "@/components/app-sidebar"
import { TourGuide } from "@/components/tour/tour-guide"
import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"

export function AppLayout({ children }: { children: ReactNode }) {
  const isChatShell = useRouterState({
    select: (state) =>
      state.location.pathname === "/" ||
      state.location.pathname === "/sessions",
  })

  return (
    <TooltipProvider>
      <SidebarProvider className="flex h-dvh min-h-0 flex-col overflow-hidden">
        <a
          href="#main-content"
          className="bg-background text-foreground focus:ring-ring fixed top-2 left-2 z-[100] -translate-y-20 rounded-md px-4 py-2 shadow-lg focus:translate-y-0 focus:ring-2 focus:outline-none"
        >
          跳到主要内容
        </a>
        {!isChatShell && <AppHeader />}

        <div className="flex flex-1 overflow-hidden">
          {!isChatShell && <AppSidebar />}
          <div className="flex w-full flex-col overflow-hidden">
            <main
              id="main-content"
              tabIndex={-1}
              className="flex min-h-0 w-full max-w-full flex-1 flex-col overflow-hidden"
            >
              {children}
            </main>
          </div>
        </div>
        <Toaster position="bottom-center" />
        <TourGuide />
      </SidebarProvider>
    </TooltipProvider>
  )
}
