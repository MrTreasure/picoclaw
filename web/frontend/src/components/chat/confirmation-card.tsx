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
      className="bg-card text-card-foreground ml-auto w-full max-w-xl rounded-2xl border border-border/70 px-4 py-3.5 shadow-sm sm:px-5 sm:py-4"
    >
      <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide">
        {t("chat.confirmationTitle")}
      </p>
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
        {confirmation.prompt}
      </p>
      {confirmation.status === "submitted" && (
        <p role="status" className="text-muted-foreground mt-2 text-xs">
          {t("chat.confirmationWaiting")}
        </p>
      )}
      {!connected && (
        <p role="status" className="text-muted-foreground mt-2 text-xs">
          {t("chat.confirmationOffline")}
        </p>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 min-w-20 rounded-xl px-4"
          disabled={disabled}
          onClick={() => respondToConfirmation(confirmation.requestId, false)}
        >
          {t("chat.confirmationReject")}
        </Button>
        <Button
          type="button"
          className="min-h-11 min-w-20 rounded-xl px-4"
          disabled={disabled}
          onClick={() => respondToConfirmation(confirmation.requestId, true)}
        >
          {t("chat.confirmationApprove")}
        </Button>
      </div>
    </section>
  )
}
