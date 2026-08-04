import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X, ChevronRight, Activity, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import api from "@/lib/api";
import { useCancelTask } from "@/hooks/use-tasks";
import type { BackgroundTask } from "@/types/index";

/**
 * Persistent task indicator + side drawer. Shows a pill in the top-bar with
 * the count of running tasks; clicking it slides in a drawer listing every
 * active task with progress and a link to its detail page.
 *
 * Polls /api/tasks?status=running every 3 seconds while tasks are active.
 */
export function RunningTasksDrawer() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const { data: tasks } = useQuery<BackgroundTask[]>({
    queryKey: ["running-tasks"],
    queryFn: async () => {
      const { data } = await api.get("/tasks/", {
        params: { status: "running", limit: 20 },
      });
      return data;
    },
    refetchInterval: 3000,
  });

  // Also pick up pending (just-enqueued) tasks for snappier feedback
  const { data: pending } = useQuery<BackgroundTask[]>({
    queryKey: ["pending-tasks"],
    queryFn: async () => {
      const { data } = await api.get("/tasks/", {
        params: { status: "pending", limit: 20 },
      });
      return data;
    },
    refetchInterval: 3000,
  });

  const allTasks = [...(pending ?? []), ...(tasks ?? [])];
  const count = allTasks.length;

  if (count === 0 && !open) {
    // Hide the pill when there's nothing running to keep the bar quiet.
    return null;
  }

  return (
    <>
      {/* Pill in the top-right of the layout — pinned */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed right-4 top-3 z-40 flex items-center gap-2 rounded-full border border-border/60 bg-background/95 px-3 py-1.5 text-xs shadow-md backdrop-blur transition hover:bg-accent",
          count > 0 && "border-primary/50 bg-primary/10 text-primary",
        )}
        title="Running tasks"
      >
        {count > 0 ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Activity className="size-3.5" />
        )}
        {count > 0 ? (
          <span className="font-medium">
            {count} {count === 1 ? "task" : "tasks"}
          </span>
        ) : (
          <span>Tasks</span>
        )}
      </button>

      {/* Drawer overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {/* Drawer panel */}
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 h-full w-full max-w-md transform border-l border-border bg-background shadow-2xl transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Background tasks</h2>
            <p className="text-xs text-muted-foreground">
              {count === 0 ? "Nothing running right now." : `${count} active`}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="space-y-2 overflow-y-auto p-3" style={{ maxHeight: "calc(100vh - 64px)" }}>
          {count === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              All quiet. Trigger a compose or upload to see live progress here.
            </p>
          ) : (
            allTasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                onOpen={() => {
                  setOpen(false);
                  if (t.project_id) navigate(`/projects/${t.project_id}`);
                  else navigate("/uploads");
                }}
              />
            ))
          )}
        </div>
      </aside>
    </>
  );
}

function TaskRow({
  task,
  onOpen,
}: {
  task: BackgroundTask;
  onOpen: () => void;
}) {
  const queryClient = useQueryClient();
  const cancelMutation = useCancelTask();
  const label =
    task.task_type === "video_composition"
      ? "Composing video"
      : task.task_type === "youtube_upload"
        ? "Uploading to YouTube"
        : task.task_type === "video_extend"
          ? "Extending video"
          : task.task_type === "automation_run"
            ? "Automation run"
            : task.task_type === "music_generation"
              ? "Generating music"
              : task.task_type === "image_generation"
                ? "Generating images"
                : task.task_type === "metadata_generation"
                  ? "Generating metadata"
                  : task.task_type;

  const isKillable =
    task.status === "running" || task.status === "pending";

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (
      !window.confirm(
        `Stop "${label}"? This hard-kills any running subprocesses (ffmpeg, visualizer, etc.).`,
      )
    ) {
      return;
    }
    cancelMutation.mutate(task.id, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["running-tasks"] });
        queryClient.invalidateQueries({ queryKey: ["pending-tasks"] });
      },
    });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="block w-full cursor-pointer rounded-lg border border-border/50 bg-card/40 p-3 text-left transition hover:bg-accent/40"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {task.status_message ?? "Working…"}
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {Math.round(task.progress ?? 0)}%
        </Badge>
        {isKillable && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleStop}
            disabled={cancelMutation.isPending}
            title="Stop task (hard-kills subprocesses)"
            className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label="Stop task"
          >
            {cancelMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Square className="size-3.5" fill="currentColor" />
            )}
          </Button>
        )}
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </div>
      <div className="mt-2">
        <Progress value={task.progress ?? 0} />
      </div>
    </div>
  );
}
