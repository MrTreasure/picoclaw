import { Outlet, createRootRoute, useRouterState } from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools"
import { useEffect, useState } from "react"

import { getLauncherAuthStatus } from "@/api/launcher-auth"
import { AppLayout } from "@/components/app-layout"
import {
  initializeChatStore,
  setChatDetailVisible,
} from "@/features/chat/controller"
import { clearChatModelPreference } from "@/features/chat/model-preference-cache"
import {
  rememberAuthenticatedListScope,
  validCacheScope,
} from "@/hooks/session-list-cache"
import { isLauncherAuthPathname } from "@/lib/launcher-login-path"

const RootLayout = () => {
  // Prefer the real address bar path: stale embedded bundles may not register
  // /launcher-login or /launcher-setup in the route tree, which would otherwise
  // keep AppLayout + gateway polling → 401 → launcherFetch redirect loop.
  const routerState = useRouterState({
    select: (s) => ({
      pathname: s.location.pathname,
      matches: s.matches,
    }),
  })

  const windowPath =
    typeof globalThis.location !== "undefined"
      ? globalThis.location.pathname || "/"
      : routerState.pathname

  const isAuthPage =
    isLauncherAuthPathname(windowPath) ||
    isLauncherAuthPathname(routerState.pathname) ||
    routerState.matches.some(
      (m) => m.routeId === "/launcher-login" || m.routeId === "/launcher-setup",
    )

  const [authError, setAuthError] = useState<string | null>(null)

  // Session guard: proactively check auth status on every page load.
  useEffect(() => {
    if (isAuthPage) return
    void getLauncherAuthStatus()
      .then((s) => {
        if (s.authenticated && validCacheScope(s.cache_scope))
          rememberAuthenticatedListScope(s.cache_scope)
        if (!s.initialized) {
          clearChatModelPreference()
          globalThis.location.assign("/launcher-setup")
        } else if (!s.authenticated) {
          clearChatModelPreference()
          globalThis.location.assign("/launcher-login")
        }
      })
      .catch((err: unknown) => {
        // On 401/403, redirect to login — the session is invalid.
        // On 5xx (e.g. 503 when the auth store is unavailable) or network errors,
        // do NOT redirect: a subsequent successful login would loop straight back here.
        // launcherFetch handles 401 on real API calls regardless.
        if (err instanceof Error && /^status 40[13]$/.test(err.message)) {
          clearChatModelPreference()
          globalThis.location.assign("/launcher-login")
        } else if (navigator.onLine) {
          setAuthError(
            err instanceof Error
              ? err.message
              : "Auth service unavailable. Reset dashboard password storage and restart the application.",
          )
        }
      })
  }, [isAuthPage])

  useEffect(() => {
    if (isAuthPage) {
      return
    }
    initializeChatStore()
  }, [isAuthPage])

  useEffect(() => {
    if (isAuthPage) return
    setChatDetailVisible(routerState.pathname === "/")
  }, [isAuthPage, routerState.pathname])

  if (isAuthPage) {
    return (
      <>
        <Outlet />
        {import.meta.env.DEV ? <TanStackRouterDevtools /> : null}
      </>
    )
  }

  return (
    <>
      {authError && (
        <div className="bg-destructive text-destructive-foreground fixed inset-x-0 top-0 z-[100] flex items-center justify-between px-4 py-2 text-sm shadow-md">
          <span>Auth service error: {authError}</span>
          <button
            className="ml-4 opacity-70 hover:opacity-100"
            onClick={() => setAuthError(null)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      <AppLayout>
        <Outlet />
        {import.meta.env.DEV ? <TanStackRouterDevtools /> : null}
      </AppLayout>
    </>
  )
}

export const Route = createRootRoute({ component: RootLayout })
