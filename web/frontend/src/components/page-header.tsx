import { IconMenu2 } from "@tabler/icons-react"
import type { ReactNode } from "react"

import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

interface PageHeaderProps {
  title: string
  titleExtra?: ReactNode
  children?: ReactNode
  className?: string
}

export function PageHeader({
  title,
  titleExtra,
  children,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "border-border/70 bg-background/92 z-40 flex min-h-16 shrink-0 items-center justify-between border-b px-4 backdrop-blur-xl sm:px-6",
        className,
      )}
    >
      <div className="flex items-center gap-4">
        <SidebarTrigger className="border-border/60 bg-background text-muted-foreground hover:bg-accent hover:text-foreground hidden h-9 w-9 rounded-lg border sm:flex [&>svg]:size-5">
          <IconMenu2 />
        </SidebarTrigger>
        <h2 className="text-foreground text-xl font-semibold tracking-tight">
          {title}
        </h2>
        {titleExtra}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  )
}
