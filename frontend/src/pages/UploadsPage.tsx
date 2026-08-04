import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Upload,
  ExternalLink,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useProjects } from "@/hooks/use-projects";
import { useChannels } from "@/hooks/use-channels";
import { useTasks } from "@/hooks/use-tasks";
import { useTaskSSE } from "@/hooks/use-sse";
import { STATUS_COLORS } from "@/types/index";
import type { VideoProject, BackgroundTask } from "@/types/index";
import { formatDistanceToNow, format } from "date-fns";
import api from "@/lib/api";

const UPLOAD_STATUSES = [
  "uploading",
  "uploaded",
  "scheduled",
  "failed",
  "composed",
];

function StatusIcon({
  status,
  animated = false,
}: {
  status: string;
  animated?: boolean;
}) {
  switch (status) {
    case "uploading":
      return (
        <Loader2
          className={`size-4 text-orange-400 ${animated ? "animate-spin" : ""}`}
        />
      );
    case "uploaded":
      return <CheckCircle2 className="size-4 text-green-500" />;
    case "scheduled":
      return <Clock className="size-4 text-teal-400" />;
    case "failed":
      return <AlertCircle className="size-4 text-red-500" />;
    case "composed":
      return <Upload className="size-4 text-purple-400" />;
    default:
      return <Upload className="size-4 text-muted-foreground" />;
  }
}

function UploadCard({
  project,
  channelName,
  activeTask,
  onRetry,
}: {
  project: VideoProject;
  channelName: string;
  activeTask?: BackgroundTask;
  onRetry: (id: number) => void;
}) {
  const navigate = useNavigate();

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-accent/50"
      onClick={() => navigate(`/projects/${project.id}`)}
    >
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StatusIcon status={project.status} animated />
              <p className="truncate font-medium">{project.title}</p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {channelName}
            </p>
          </div>
          <Badge
            className={`shrink-0 ${STATUS_COLORS[project.status] ?? "bg-gray-500"} text-white`}
          >
            {project.status.replace(/_/g, " ")}
          </Badge>
        </div>

        {project.status === "uploading" && (
          <Progress value={activeTask?.progress ?? 0}>
            <span className="text-xs text-muted-foreground">
              {activeTask?.status_message ?? "Uploading to YouTube..."}
            </span>
          </Progress>
        )}

        {project.status === "uploaded" && project.youtube_url && (
          <div className="flex items-center gap-2">
            <Video className="size-4 text-red-500" />
            <a
              href={project.youtube_url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-xs text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {project.youtube_url}
            </a>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                e.stopPropagation();
                window.open(project.youtube_url!, "_blank");
              }}
            >
              <ExternalLink className="size-3" />
            </Button>
          </div>
        )}

        {project.status === "scheduled" && project.youtube_scheduled_at && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="size-3" />
            <span>
              Scheduled for{" "}
              {format(new Date(project.youtube_scheduled_at), "PPp")}
            </span>
          </div>
        )}

        {project.status === "failed" && (
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 flex-1 text-xs text-destructive">
              {activeTask?.error
                ? `Upload failed: ${activeTask.error}`
                : "Upload failed. Click retry to try again."}
            </p>
            <Button
              variant="outline"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                onRetry(project.id);
              }}
            >
              <RefreshCw className="size-3" />
              Retry
            </Button>
          </div>
        )}

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {project.uploaded_at && (
            <span>
              Uploaded {formatDistanceToNow(new Date(project.uploaded_at))} ago
            </span>
          )}
          {!project.uploaded_at && (
            <span>
              Updated {formatDistanceToNow(new Date(project.updated_at))} ago
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="flex items-center gap-3">
            <div className="size-4 animate-pulse rounded bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-48 animate-pulse rounded bg-muted" />
              <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function UploadsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const queryClient = useQueryClient();
  const { data: channels } = useChannels();
  const { data: projects, isLoading, error } = useProjects();
  // Fetch the most-recent youtube_upload tasks so we can attach progress/error
  // info to each upload card.
  const { data: uploadTasks } = useTasks({ task_type: "youtube_upload" });

  // Live updates from the task runner: whenever any task_update arrives,
  // refresh projects and tasks so the UI reflects the new state instantly.
  useTaskSSE((event) => {
    if (event.task_type === "youtube_upload") {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });

  const channelList = channels ?? [];
  const allProjects = projects ?? [];

  // Map project_id -> most recent youtube_upload task so cards can render
  // real progress / real error messages.
  const latestTaskByProject = new Map<number, BackgroundTask>();
  for (const task of uploadTasks ?? []) {
    if (!task.project_id) continue;
    const existing = latestTaskByProject.get(task.project_id);
    if (
      !existing ||
      new Date(task.created_at).getTime() >
        new Date(existing.created_at).getTime()
    ) {
      latestTaskByProject.set(task.project_id, task);
    }
  }

  const uploadProjects = allProjects
    .filter((p) => UPLOAD_STATUSES.includes(p.status))
    .filter((p) => !statusFilter || p.status === statusFilter)
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );

  const channelName = (channelId: number) =>
    channelList.find((c) => c.id === channelId)?.name ?? "Unknown";

  const handleRetry = async (projectId: number) => {
    try {
      await api.post("/youtube/upload", { project_id: projectId });
      toast.success("Retry started");
    } catch {
      toast.error("Failed to retry upload");
    }
  };

  const statusCounts = UPLOAD_STATUSES.reduce<Record<string, number>>(
    (acc, status) => {
      acc[status] = allProjects.filter((p) => p.status === status).length;
      return acc;
    },
    {}
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button
          variant={statusFilter === "" ? "default" : "outline"}
          size="sm"
          onClick={() => setStatusFilter("")}
        >
          All ({allProjects.filter((p) => UPLOAD_STATUSES.includes(p.status)).length})
        </Button>
        {UPLOAD_STATUSES.map((status) => (
          <Button
            key={status}
            variant={statusFilter === status ? "default" : "outline"}
            size="sm"
            onClick={() =>
              setStatusFilter(statusFilter === status ? "" : status)
            }
          >
            <StatusIcon status={status} />
            <span className="capitalize">{status.replace(/_/g, " ")}</span>
            {statusCounts[status] > 0 && (
              <span className="ml-1 text-xs">({statusCounts[status]})</span>
            )}
          </Button>
        ))}
      </div>

      {isLoading && <LoadingSkeleton />}

      {error && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-destructive">
              Failed to load uploads. Please try again.
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && uploadProjects.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Upload className="mb-4 size-12 text-muted-foreground" />
            <h3 className="mb-2 text-lg font-medium">No uploads found</h3>
            <p className="text-sm text-muted-foreground">
              {statusFilter
                ? "No uploads match the selected filter."
                : "Videos will appear here once they are composed and uploaded."}
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && uploadProjects.length > 0 && (
        <div className="space-y-3">
          {uploadProjects.map((project) => (
            <UploadCard
              key={project.id}
              project={project}
              channelName={channelName(project.channel_id)}
              activeTask={latestTaskByProject.get(project.id)}
              onRetry={handleRetry}
            />
          ))}
        </div>
      )}
    </div>
  );
}
