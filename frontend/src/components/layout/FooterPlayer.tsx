import { useCallback, useRef } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
  Music,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useMediaPlayer } from "@/contexts/media-player";
import { cn } from "@/lib/utils";

function fmt(secs: number) {
  if (!secs || !isFinite(secs)) return "0:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function FooterPlayer() {
  const {
    track,
    playlist,
    playing,
    currentTime,
    duration,
    volume,
    visible,
    togglePlay,
    seek,
    setVolume,
    next,
    prev,
    close,
  } = useMediaPlayer();

  const prevVolume = useRef(volume);

  const handleSeek = useCallback(
    (v: number | readonly number[]) => {
      const val = Array.isArray(v) ? v[0] : v;
      seek(val);
    },
    [seek],
  );

  const handleVolume = useCallback(
    (v: number | readonly number[]) => {
      const val = Array.isArray(v) ? v[0] : v;
      setVolume(val);
    },
    [setVolume],
  );

  const toggleMute = () => {
    if (volume > 0) {
      prevVolume.current = volume;
      setVolume(0);
    } else {
      setVolume(prevVolume.current || 0.8);
    }
  };

  if (!visible || !track) return null;

  const idx = playlist.findIndex((t) => t.id === track.id);
  const hasNext = idx < playlist.length - 1;
  const hasPrev = idx > 0;

  return (
    <div className="border-t border-border bg-card/95 backdrop-blur-sm">
      {/* Progress bar (thin, clickable) — sits right on the border */}
      <div className="px-4">
        <Slider
          min={0}
          max={duration || 1}
          step={0.5}
          value={[currentTime]}
          onValueChange={handleSeek}
          className="h-1"
        />
      </div>

      <div className="flex h-[64px] items-center gap-4 px-4">
        {/* ── Left: Track info ── */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <Music className="size-5 text-blue-400" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{track.title}</p>
            {track.subtitle && (
              <p className="truncate text-xs text-muted-foreground">
                {track.subtitle}
              </p>
            )}
          </div>
        </div>

        {/* ── Center: Controls ── */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={prev}
            disabled={!hasPrev}
          >
            <SkipBack className="size-4" />
          </Button>

          <Button
            variant="default"
            size="icon"
            className="size-9 rounded-full"
            onClick={togglePlay}
          >
            {playing ? (
              <Pause className="size-4" />
            ) : (
              <Play className="size-4 translate-x-px" />
            )}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={next}
            disabled={!hasNext}
          >
            <SkipForward className="size-4" />
          </Button>
        </div>

        {/* ── Right: Time + Volume + Close ── */}
        <div className="flex flex-1 items-center justify-end gap-3">
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {fmt(currentTime)} / {fmt(duration)}
          </span>

          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={toggleMute}
            >
              {volume === 0 ? (
                <VolumeX className="size-3.5" />
              ) : (
                <Volume2 className="size-3.5" />
              )}
            </Button>
            <div className="w-20">
              <Slider
                min={0}
                max={1}
                step={0.02}
                value={[volume]}
                onValueChange={handleVolume}
              />
            </div>
          </div>

          {playlist.length > 1 && (
            <span className="text-xs text-muted-foreground">
              {idx + 1}/{playlist.length}
            </span>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={close}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
