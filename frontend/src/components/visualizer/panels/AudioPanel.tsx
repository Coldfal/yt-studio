import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { Music } from "lucide-react";

/** Formats seconds as M:SS. */
function fmtDuration(sec: number): string {
  if (!sec || !isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Audio panel — read-only in the embedded editor. The music track is set by
 * the earlier Music step of the project wizard; the editor just displays it.
 */
export function AudioPanel() {
  const audioTracks = useVisualizerEditorStore((s) => s.audioTracks);
  const audioDuration = useVisualizerEditorStore((s) => s.audioDuration);
  const currentTrackIndex = useVisualizerEditorStore((s) => s.currentTrackIndex);
  const setCurrentTrackIndex = useVisualizerEditorStore((s) => s.setCurrentTrackIndex);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Audio</h3>
        <span className="text-xs text-muted-foreground">
          {fmtDuration(audioDuration)}
        </span>
      </div>

      {audioTracks.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
          No audio track attached. Return to the Music step of the wizard
          to pick or upload a track.
        </div>
      ) : (
        <ul className="space-y-1">
          {audioTracks.map((track, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setCurrentTrackIndex(i)}
                className={`flex w-full items-center gap-2 rounded border p-2 text-left text-xs transition ${
                  i === currentTrackIndex
                    ? "border-primary bg-primary/10"
                    : "border-border/50 hover:bg-muted/40"
                }`}
              >
                <Music className="h-3 w-3 text-primary" />
                <span className="flex-1 truncate">{track.name}</span>
                <span className="text-muted-foreground">
                  {fmtDuration(track.duration)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
