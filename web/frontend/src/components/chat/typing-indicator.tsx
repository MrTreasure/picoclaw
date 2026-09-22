import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

export function TypingIndicator() {
  const { t } = useTranslation()
  const thinkingSteps = [
    t("chat.thinking.step1"),
    t("chat.thinking.step2"),
    t("chat.thinking.step3"),
    t("chat.thinking.step4"),
  ]
  const [stepIndex, setStepIndex] = useState(0)

  useEffect(() => {
    const stepsCount = thinkingSteps.length
    const interval = setInterval(() => {
      setStepIndex((prev) => (prev + 1) % stepsCount)
    }, 3000)
    return () => clearInterval(interval)
  }, [thinkingSteps.length])

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="bg-muted text-muted-foreground inline-flex w-fit max-w-xs flex-col gap-2.5 rounded-2xl rounded-tl-[5px] px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="bg-secondary size-1.5 animate-bounce rounded-full [animation-delay:-0.3s]" />
          <span className="bg-secondary size-1.5 animate-bounce rounded-full [animation-delay:-0.15s]" />
          <span className="bg-secondary size-1.5 animate-bounce rounded-full" />
        </div>

        <div className="bg-background/70 relative h-1 w-36 overflow-hidden rounded-full">
          <div className="from-secondary/25 via-secondary/80 to-secondary/25 absolute inset-0 animate-[shimmer_2s_infinite] rounded-full bg-gradient-to-r bg-[length:200%_100%]" />
        </div>

        <p
          key={stepIndex}
          className="text-muted-foreground animate-[fadeSlideIn_0.4s_ease-out] text-xs"
        >
          {thinkingSteps[stepIndex]}
        </p>
      </div>
    </div>
  )
}
