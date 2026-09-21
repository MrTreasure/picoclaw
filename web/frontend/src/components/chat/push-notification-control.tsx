import { IconBell, IconBellOff } from "@tabler/icons-react"
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
    void Promise.all([
      getPicoPushConfig(),
      navigator.serviceWorker.ready.then((registration) =>
        registration.pushManager.getSubscription(),
      ),
    ])
      .then(([config, subscription]) => {
        setConfigured(config.enabled && Boolean(config.public_key))
        setSubscribed(Boolean(subscription))
      })
      .catch(() => setConfigured(false))
      .finally(() => setBusy(false))
  }, [])

  const handleChange = async (enabled: boolean) => {
    setBusy(true)
    try {
      const registration = await navigator.serviceWorker.ready
      const current = await registration.pushManager.getSubscription()
      if (!enabled) {
        if (current) {
          await deletePicoPushSubscription(current.endpoint)
          await current.unsubscribe()
        }
        setSubscribed(false)
        toast.success(t("chat.push.disabled"))
        return
      }
      const permission = await Notification.requestPermission()
      if (permission !== "granted") throw new Error("permission-denied")
      const config = await getPicoPushConfig()
      if (!config.enabled || !config.public_key)
        throw new Error("not-configured")
      const subscription =
        current ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeApplicationServerKey(config.public_key),
        }))
      await savePicoPushSubscription(subscription)
      setSubscribed(true)
      toast.success(t("chat.push.enabled"))
    } catch (error) {
      toast.error(
        error instanceof Error && error.message === "permission-denied"
          ? t("chat.push.permissionDenied")
          : t("chat.push.failed"),
      )
    } finally {
      setBusy(false)
    }
  }

  if (!supported || !configured) return null

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground flex items-center gap-2 text-sm">
        {subscribed ? (
          <IconBell className="size-4" />
        ) : (
          <IconBellOff className="size-4" />
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
