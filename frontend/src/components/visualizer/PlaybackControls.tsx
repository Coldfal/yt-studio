

import { useRef } from "react";
import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { Button } from "@/components/ui/button";
import { Play, Pause, SkipBack } from "lucide-react";

export function PlaybackControls() {
  const isPlaying = useVisualizerEditorStore((s) => s.isPlaying);
  const setIsPlaying = useVisualizerEditorStore((s) => s.setIsPlaying);
  const currentTime = useVisualizerEditorStore((s) => s.currentTime);
  const audioDuration = useVisualizerEditorStore((s) => s.audioDuration);
  const audioUrl = useVisualizerEditorStore((s) => s.audioUrl);
  const audioTracks = useVisualizerEditorStore((s) => s.audioTracks);
  const currentTrackIndex = useVisualizerEditorStore((s) => s.currentTrackIndex);
  const barRef = useRef<HTMLDivElement>(null);

  function formatTime(seconds: number) {
    if (!isFinite(seconds) || seconds <= 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // Combined elapsed across the whole playlist.
  let priorDuration = 0;
  for (let i = 0; i < currentTrackIndex && i < audioTracks.length; i++) {
    priorDuration += audioTracks[i].duration || 0;
  }
  const combinedCurrent = priorDuration + currentTime;

  // Map a 0..audioDuration target to (trackIndex, timeWithin).
  function globalToLocal(globalSec: number): { trackIndex: number; timeWithin: number } {
    let acc = 0;
    for (let i = 0; i < audioTracks.length; i++) {
      const d = audioTracks[i].duration || 0;
      if (globalSec < acc + d) return { trackIndex: i, timeWithin: globalSec - acc };
      acc += d;
    }
    const last = Math.max(0, audioTracks.length - 1);
    return { trackIndex: last, timeWithin: audioTracks[last]?.duration || 0 };
  }

  function seekFromClientX(clientX: number) {
    if (!barRef.current || audioDuration <= 0) return;
    const rect = barRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const globalSec = ratio * audioDuration;
    const { trackIndex, timeWithin } = globalToLocal(globalSec);
    useVisualizerEditorStore.setState((s) => ({
      currentTrackIndex: trackIndex,
      audioUrl: s.audioTracks[trackIndex]?.url ?? null,
      currentTime: timeWithin,
      seekTo: timeWithin,
    }));
  }

  function onBarMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    seekFromClientX(e.clientX);
    const onMove = (ev: MouseEvent) => seekFromClientX(ev.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const progress = audioDuration > 0 ? (combinedCurrent / audioDuration) * 100 : 0;
  const hasAudio = audioTracks.length > 0 && !!audioUrl;
  const currentTrackName = audioTracks[currentTrackIndex]?.name ?? "";

  // Compute where each track boundary sits on the bar so we can render ticks.
  const ticks: number[] = [];
  if (audioTracks.length > 1 && audioDuration > 0) {
    let acc = 0;
    for (let i = 0; i < audioTracks.length - 1; i++) {
      acc += audioTracks[i].duration || 0;
      ticks.push((acc / audioDuration) * 100);
    }
  }

  return (
    <div className="flex items-center gap-4 border-t border-border/50 bg-card/30 px-4 py-3">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={!hasAudio}
          onClick={() => {
            useVisualizerEditorStore.setState((s) => ({
              currentTrackIndex: 0,
              audioUrl: s.audioTracks[0]?.url ?? null,
              currentTime: 0,
              seekTo: 0,
            }));
          }}
        >
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          disabled={!hasAudio}
          onClick={() => setIsPlaying(!isPlaying)}
        >
          {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </Button>
      </div>

      <div className="flex flex-1 items-center gap-3">
        <span className="w-10 text-xs tabular-nums text-muted-foreground">
          {formatTime(combinedCurrent)}
        </span>
        <div className="flex flex-1 flex-col gap-0.5">
          <div
            ref={barRef}
            className="relative h-1.5 cursor-pointer rounded-full bg-muted"
            onMouseDown={onBarMouseDown}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${progress}%` }}
            />
            {ticks.map((p, i) => (
              <div
                key={i}
                className="absolute top-0 h-full w-px bg-background/70"
                style={{ left: `${p}%` }}
              />
            ))}
            <div
              className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-primary shadow-sm"
              style={{ left: `${progress}%`, marginLeft: "-6px" }}
            />
          </div>
          {audioTracks.length > 1 && currentTrackName && (
            <span className="truncate text-[10px] text-muted-foreground">
              {currentTrackIndex + 1}/{audioTracks.length} · {currentTrackName}
            </span>
          )}
        </div>
        <span className="w-10 text-xs tabular-nums text-muted-foreground">
          {formatTime(audioDuration)}
        </span>
      </div>
    </div>
  );
}
