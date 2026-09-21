import { IconBell, IconBellOff, IconLoader2 } from "@tabler/icons-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  deletePicoPushSubscription,
  getPicoPushConfig,
  savePicoPushSubscription,
} from "@/api/pico"
import { Switch } from "@/components/ui/switch"

function decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index)
  }
  return bytes
}

const pushOperationTimeoutMs = 10_000

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("push-timeout")),
      pushOperationTimeoutMs,
    )
    promise.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

export function PushNotificationControl() {
  const { t } = useTranslation()
  const [supported, setSupported] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    const available =
      window.isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    setSupported(available)
    if (!available) {
      setBusy(false)
      return
    }
    void getPicoPushConfig()
      .then(async (config) => {
        const isConfigured = config.enabled && Boolean(config.public_key)
        setConfigured(isConfigured)
        if (!isConfigured) return

        const registration = await withTimeout(navigator.serviceWorker.ready)
        const subscription = await withTimeout(
          registration.pushManager.getSubscription(),
        )
        setSubscribed(Boolean(subscription))
      })
      .catch(() => setSubscribed(false))
      .finally(() => setBusy(false))
  }, [])

  const handleChange = async (enabled: boolean) => {
    // Notification permission must be requested while the original tap still
    // owns transient user activation. Awaiting serviceWorker.ready first makes
    // Chrome silently reject or suppress the permission prompt.
    setBusy(true)
    let phase: "permission" | "serviceWorker" | "subscription" | "save" =
      "permission"
    try {
      const permission = enabled
        ? await Notification.requestPermission()
        : Notification.permission
      if (enabled && permission !== "granted") {
        throw new Error("permission-denied")
      }

      phase = "serviceWorker"
      const registration = await withTimeout(navigator.serviceWorker.ready)
      const current = await withTimeout(
        registration.pushManager.getSubscription(),
      )
      if (!enabled) {
        if (current) {
          await deletePicoPushSubscription(current.endpoint)
          await withTimeout(current.unsubscribe())
        }
        setSubscribed(false)
        toast.success(t("chat.push.disabled"))
        return
      }
      const config = await getPicoPushConfig()
      if (!config.enabled || !config.public_key)
        throw new Error("not-configured")
      phase = "subscription"
      const subscription =
        current ??
        (await withTimeout(
          registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeApplicationServerKey(config.public_key),
          }),
        ))
      phase = "save"
      await savePicoPushSubscription(subscription)
      setSubscribed(true)
      toast.success(t("chat.push.enabled"))
    } catch (error) {
      const permissionDenied =
        error instanceof Error &&
        (error.message === "permission-denied" ||
          error.name === "NotAllowedError")
      const message = permissionDenied
        ? t("chat.push.permissionDenied")
        : enabled && phase === "serviceWorker"
          ? t("chat.push.serviceWorkerFailed")
          : enabled && phase === "subscription"
            ? t("chat.push.subscriptionFailed")
            : enabled && phase === "save"
              ? t("chat.push.saveFailed")
              : t("chat.push.failed")
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  if (!supported || !configured) return null

  return (
    <div
      className="flex min-h-11 items-center justify-between gap-3"
      aria-busy={busy}
    >
      <span className="text-muted-foreground flex items-center gap-2 text-sm">
        {busy ? (
          <IconLoader2
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : subscribed ? (
          <IconBell className="size-4" aria-hidden="true" />
        ) : (
          <IconBellOff className="size-4" aria-hidden="true" />
        )}
        {t("chat.push.label")}
      </span>
      <Switch
        checked={subscribed}
        disabled={busy}
        aria-label={t("chat.push.label")}
        onCheckedChange={(checked) => void handleChange(checked)}
      />
    </div>
  )
}
