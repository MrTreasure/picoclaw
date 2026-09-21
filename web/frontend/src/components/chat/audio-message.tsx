import {
  IconDownload,
  IconPlayerPause,
  IconPlayerPlay,
  IconVolume,
} from "@tabler/icons-react"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import type { ChatAttachment } from "@/store/chat"

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${remainder.toString().padStart(2, "0")}`
}

export function AudioMessage({ attachment }: { attachment: ChatAttachment }) {
  const { t } = useTranslation()
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [hasError, setHasError] = useState(false)

  const togglePlayback = async () => {
    const audio = audioRef.current
    if (!audio || hasError) return
    if (audio.paused) {
      try {
        await audio.play()
      } catch {
        setHasError(true)
      }
      return
    }
    audio.pause()
  }

  const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0
  const label = attachment.filename || t("chat.audioMessage")

  return (
    <div className="border-border/60 bg-card flex w-full max-w-sm items-center gap-3 rounded-2xl border p-2.5 shadow-sm">
      <audio
        ref={audioRef}
        src={attachment.url}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false)
          setCurrentTime(0)
        }}
        onError={() => setHasError(true)}
      />
      <Button
        type="button"
        size="icon"
        className="size-11 shrink-0 rounded-full bg-emerald-500 text-white shadow-sm hover:bg-emerald-600"
        onClick={() => void togglePlayback()}
        disabled={hasError}
        aria-label={isPlaying ? t("chat.pauseAudio") : t("chat.playAudio")}
      >
        {isPlaying ? (
          <IconPlayerPause className="size-5" aria-hidden="true" />
        ) : (
          <IconPlayerPlay className="ml-0.5 size-5" aria-hidden="true" />
        )}
      </Button>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-1.5">
          <IconVolume
            className="size-3.5 text-emerald-500"
            aria-hidden="true"
          />
          <span className="truncate text-sm font-medium">{label}</span>
        </div>
        {hasError ? (
          <span className="text-destructive text-xs">
            {t("chat.audioLoadFailed")}
          </span>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              aria-label={t("chat.audioProgress")}
              className="h-11 min-w-0 flex-1 cursor-pointer accent-emerald-500"
              style={{
                background: `linear-gradient(to right, rgb(16 185 129) ${progress * 100}%, transparent ${progress * 100}%)`,
              }}
              onChange={(event) => {
                const nextTime = Number(event.currentTarget.value)
                setCurrentTime(nextTime)
                if (audioRef.current) audioRef.current.currentTime = nextTime
              }}
            />
            <span className="text-muted-foreground w-16 text-right font-mono text-[11px] tabular-nums">
              {formatDuration(currentTime)} / {formatDuration(duration)}
            </span>
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground size-11 shrink-0 rounded-full"
        asChild
      >
        <a
          href={attachment.url}
          download={attachment.filename}
          aria-label={t("chat.downloadAudio")}
        >
          <IconDownload className="size-4" aria-hidden="true" />
        </a>
      </Button>
    </div>
  )
}
