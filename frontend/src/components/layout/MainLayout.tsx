import { Outlet } from "react-router-dom";
import Sidebar from "@/components/layout/Sidebar";
import FooterPlayer from "@/components/layout/FooterPlayer";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { MediaPlayerProvider } from "@/contexts/media-player";

export default function MainLayout() {
  return (
    <MediaPlayerProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <main className="flex-1 overflow-y-auto">
            <div className="w-full p-6">
              <Breadcrumbs />
              <Outlet />
            </div>
          </main>
          <FooterPlayer />
        </div>
      </div>
    </MediaPlayerProvider>
  );
}
