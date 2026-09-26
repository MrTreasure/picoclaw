import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { respondToConfirmation } from "@/features/chat/controller"
import type { PendingConfirmation } from "@/store/chat"

export function ConfirmationCard({
  confirmation,
  connected,
}: {
  confirmation: PendingConfirmation
  connected: boolean
}) {
  const { t } = useTranslation()
  const disabled = !connected || confirmation.status !== "awaiting"
  return (
    <section
      role="group"
      aria-label={t("chat.confirmationTitle")}
      className="w-full rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
    >
      <p className="mb-2 text-sm font-semibold">
        {t("chat.confirmationTitle")}
      </p>
      <p className="mb-3 text-sm break-words whitespace-pre-wrap">
        {confirmation.prompt}
      </p>
      {confirmation.status === "submitted" && (
        <p role="status" className="text-muted-foreground mb-2 text-xs">
          {t("chat.confirmationWaiting")}
        </p>
      )}
      {!connected && (
        <p role="status" className="text-muted-foreground mb-2 text-xs">
          {t("chat.confirmationOffline")}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={() => respondToConfirmation(confirmation.requestId, true)}
        >
          {t("chat.confirmationApprove")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => respondToConfirmation(confirmation.requestId, false)}
        >
          {t("chat.confirmationReject")}
        </Button>
      </div>
    </section>
  )
}
