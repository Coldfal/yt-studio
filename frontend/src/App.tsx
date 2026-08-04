import { lazy, Suspense, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "sonner";
import MainLayout from "@/components/layout/MainLayout";
import { useTaskSSE } from "@/hooks/use-sse";
import { RunningTasksDrawer } from "@/components/RunningTasksDrawer";
import { FailedTasksDrawer } from "@/components/FailedTasksDrawer";
import { AnalyticsHealthPill } from "@/components/AnalyticsHealthPill";
import { SetupWizard } from "@/components/SetupWizard";
import { Spinner } from "@/components/ui/spinner";
import type { BackgroundTask } from "@/types/index";

const DashboardPage = lazy(() => import("@/pages/DashboardPage"));
const ChannelsPage = lazy(() => import("@/pages/ChannelsPage"));
const ChannelDetailPage = lazy(() => import("@/pages/ChannelDetailPage"));
const NewProjectPage = lazy(() => import("@/pages/new-project/NewProjectPage"));
const AnalyticsPage = lazy(() => import("@/pages/AnalyticsPage"));
const FarmDashboardPage = lazy(() => import("@/pages/FarmDashboardPage"));
const ProjectDetailPage = lazy(() => import("@/pages/ProjectDetailPage"));
// AssetsPage now houses Assets + Uploads tabs (Library)
const AssetsPage = lazy(() => import("@/pages/AssetsPage"));
// SettingsPage now houses API Keys + Prompts tabs
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
// AutomationPage is now embedded as a tab in ChannelDetailPage
const LivePage = lazy(() => import("@/pages/LivePage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

function PageLoader() {
  return <Spinner.Page label="Loading…" />;
}

function SSEHandler() {
  const qc = useQueryClient();

  const handleTaskUpdate = useCallback(
    (update: Record<string, unknown>) => {
      const taskId = update.task_id as number | undefined;

      // Merge progress directly into the cached task (avoids DB round-trip)
      if (taskId) {
        qc.setQueryData<BackgroundTask>(
          ["tasks", taskId],
          (old) => {
            if (!old) return old;
            return {
              ...old,
              progress: (update.progress as number) ?? old.progress,
              status: (update.status as string) ?? old.status,
              status_message:
                (update.status_message as string) ?? old.status_message,
              error: (update.error as string) ?? old.error,
              result: (update.result as Record<string, unknown>) ?? old.result,
            };
          }
        );

        // Also update string-keyed cache (useTask can receive string id)
        qc.setQueryData<BackgroundTask>(
          ["tasks", String(taskId)],
          (old) => {
            if (!old) return old;
            return {
              ...old,
              progress: (update.progress as number) ?? old.progress,
              status: (update.status as string) ?? old.status,
              status_message:
                (update.status_message as string) ?? old.status_message,
              error: (update.error as string) ?? old.error,
              result: (update.result as Record<string, unknown>) ?? old.result,
            };
          }
        );
      }

      // When a task completes or fails, refresh related data from DB
      if (update.status === "completed" || update.status === "failed") {
        qc.invalidateQueries({ queryKey: ["tasks"] });
        if (update.project_id) {
          qc.invalidateQueries({ queryKey: ["projects"] });
          qc.invalidateQueries({
            queryKey: ["projects", update.project_id],
          });
        }
        if (update.channel_id) {
          qc.invalidateQueries({
            queryKey: ["channels", update.channel_id],
          });
        }
        qc.invalidateQueries({ queryKey: ["assets"] });
      }
    },
    [qc]
  );

  useTaskSSE(handleTaskUpdate);
  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SSEHandler />
        <RunningTasksDrawer />
        <FailedTasksDrawer />
        <AnalyticsHealthPill />
        <SetupWizard />
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<MainLayout />}>
              <Route index element={<DashboardPage />} />
              <Route path="channels" element={<ChannelsPage />} />
              <Route path="channels/:id" element={<ChannelDetailPage />} />
              <Route path="projects/new" element={<NewProjectPage />} />
              <Route path="projects/:id" element={<ProjectDetailPage />} />
              <Route path="projects/:id/edit" element={<NewProjectPage />} />
              <Route path="assets" element={<AssetsPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="farm" element={<FarmDashboardPage />} />
              {/* Legacy redirects — old bookmarks still work */}
              <Route path="uploads" element={<Navigate to="/assets?tab=uploads" replace />} />
              <Route path="prompts" element={<Navigate to="/settings?tab=prompts" replace />} />
              <Route path="automation" element={<Navigate to="/channels" replace />} />
              <Route path="live" element={<LivePage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
      <Toaster position="bottom-right" theme="dark" richColors />
    </QueryClientProvider>
  );
}
