const CACHE_VERSION = "musec137-shell-v24"
const APP_SHELL = [
  "/",
  "/sessions",
  "/offline.html",
  "/site.webmanifest?v=musec137-5",
  "/favicon-96x96.png?v=musec137-5",
  "/apple-touch-icon.png?v=musec137-5",
  "/web-app-manifest-192x192.png?v=musec137-5",
  "/web-app-manifest-512x512.png?v=musec137-5",
]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      ),
  )
  self.clients.claim()
})

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = {}
      try {
        payload = event.data?.json() ?? {}
      } catch {
        payload = { body: event.data?.text() ?? "收到一条新消息" }
      }
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      if (windows.some((client) => client.visibilityState === "visible")) return
      const sessionId = payload.session_id || ""
      await self.registration.showNotification(payload.title || "MuseC137", {
        body: payload.body || "收到一条新消息",
        icon: "/web-app-manifest-192x192.png",
        badge: "/favicon-96x96.png",
        tag: sessionId ? `musec137-${sessionId}` : "musec137-message",
        renotify: true,
        data: { url: payload.url || "/", sessionId },
      })
      if (self.navigator.setAppBadge) await self.navigator.setAppBadge()
    })(),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const sessionId = (event.notification.data?.sessionId || "").replace(
        /^(pico_\d{8})T(?=\d{9}_main$)/,
        "$1t",
      )
      const target = new URL(
        event.notification.data?.url || "/",
        self.location.origin,
      )
      if (sessionId) {
        target.searchParams.set("session_id", sessionId)
      }
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      const existing = windows.find(
        (client) => new URL(client.url).origin === target.origin,
      )
      if (existing) {
        const navigated = (await existing.navigate(target.href)) || existing
        return navigated.focus()
      }
      return self.clients.openWindow(target.href)
    })(),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/pico/")
  )
    return
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")))
    return
  }
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && response.type === "basic")
            void caches
              .open(CACHE_VERSION)
              .then((cache) => cache.put(request, response.clone()))
          return response
        }),
    ),
  )
})
