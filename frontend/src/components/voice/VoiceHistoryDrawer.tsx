/**
 * Voice history drawer — every save of the voice fields produces a
 * snapshot; this drawer lists them newest-first and lets the operator
 * one-click restore any version. The restore itself snapshots the
 * pre-restore state too, so "restore the restore" is also one click.
 */
import { useState } from "react";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import {
  History,
  Loader2,
  RotateCcw,
  ChevronRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useVoiceHistory,
  useRestoreVoiceSnapshot,
  type VoiceHistoryEntry,
} from "@/hooks/use-voice-profiles";
import type { Channel } from "@/types/index";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: Channel;
}

export function VoiceHistoryDrawer({ open, onOpenChange, channel }: Props) {
  const history = useVoiceHistory(channel.id);
  const restore = useRestoreVoiceSnapshot();
  const [selected, setSelected] = useState<VoiceHistoryEntry | null>(null);

  const handleRestore = async (snap: VoiceHistoryEntry) => {
    if (
      !window.confirm(
        `Restore the voice from ${format(new Date(snap.created_at), "PPp")}? ` +
          "Your current voice will be snapshot first so you can revert.",
      )
    ) {
      return;
    }
    try {
      await restore.mutateAsync({
        channelId: channel.id,
        snapshotId: snap.id,
      });
      toast.success("Voice restored — refresh the form to see changes");
      onOpenChange(false);
    } catch {
      toast.error("Restore failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] max-h-[88vh] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b p-4">
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4 text-primary" />
            Voice history · {channel.name}
          </DialogTitle>
          <DialogDescription>
            Every time you save the voice, the previous state is captured
            here. Click a snapshot to compare; click Restore to roll back.
          </DialogDescription>
        </DialogHeader>

        <div className="grid h-[68vh] grid-cols-[280px_1fr] gap-0 overflow-hidden">
          {/* Snapshot list */}
          <ScrollArea className="border-r">
            <div className="p-2">
              {history.isLoading && (
                <div className="flex h-32 items-center justify-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              )}
              {history.data && history.data.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No snapshots yet. Save the voice once to start the
                  timeline.
                </p>
              )}
              {(history.data ?? []).map((snap) => {
                const isSel = selected?.id === snap.id;
                return (
                  <button
                    key={snap.id}
                    type="button"
                    onClick={() => setSelected(snap)}
                    className={`group flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs transition ${
                      isSel
                        ? "bg-primary/10 text-foreground"
                        : "hover:bg-muted/60"
                    }`}
                  >
                    <ChevronRight
                      className={`mt-0.5 size-3 shrink-0 transition ${isSel ? "rotate-90" : ""}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="truncate font-medium">
                        {snap.label ?? "Auto save"}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {formatDistanceToNow(new Date(snap.created_at), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </ScrollArea>

          {/* Detail pane */}
          <ScrollArea>
            <div className="p-4">
              {!selected && (
                <div className="flex h-full min-h-[60vh] items-center justify-center text-xs text-muted-foreground">
                  Select a snapshot on the left.
                </div>
              )}
              {selected && (
                <div className="space-y-3 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">
                        {selected.label ?? "Auto save"}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Captured{" "}
                        {format(new Date(selected.created_at), "PPp")}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleRestore(selected)}
                      disabled={restore.isPending}
                    >
                      {restore.isPending ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Restoring…
                        </>
                      ) : (
                        <>
                          <RotateCcw className="size-3.5" />
                          Restore this version
                        </>
                      )}
                    </Button>
                  </div>

                  <FieldDiff
                    label="ai_voice"
                    value={selected.ai_voice}
                  />
                  <FieldDiff
                    label="ai_example_title"
                    value={selected.ai_example_title}
                  />
                  <FieldDiff
                    label="ai_example_description"
                    value={selected.ai_example_description}
                  />
                  <FieldDiff
                    label="ai_example_tags"
                    value={selected.ai_example_tags}
                  />
                  <FieldDiff label="notes" value={selected.notes} />
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FieldDiff({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="text-[10px]">
          {label}
        </Badge>
        {!value && (
          <span className="text-[10px] text-muted-foreground italic">
            (empty)
          </span>
        )}
      </div>
      {value && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-[10px] leading-relaxed">
          {value}
        </pre>
      )}
    </div>
  );
}
