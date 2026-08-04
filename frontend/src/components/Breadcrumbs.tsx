import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronRight, Home } from "lucide-react";
import { useChannel } from "@/hooks/use-channels";
import { useProject } from "@/hooks/use-projects";

/**
 * Light-weight breadcrumbs derived from the current route. The app's IA is
 * shallow so we hard-wire a small set of patterns rather than configuring
 * per-route.
 */
export function Breadcrumbs() {
  const location = useLocation();
  const segs = location.pathname.split("/").filter(Boolean);

  if (segs.length === 0) return null;

  const items: { label: ReactNode; to?: string }[] = [
    { label: <Home className="size-3" />, to: "/" },
  ];

  const section = segs[0];
  if (section === "channels") {
    items.push({ label: "Channels", to: "/channels" });
    if (segs[1]) items.push({ label: <ChannelName id={segs[1]} /> });
  } else if (section === "projects") {
    items.push({ label: "Projects", to: "/" });
    if (segs[1] === "new") {
      items.push({ label: "New" });
    } else if (segs[1]) {
      items.push({ label: <ProjectTitle id={segs[1]} /> });
    }
  } else if (section === "automation") {
    items.push({ label: "Automation" });
  } else if (section === "live") {
    items.push({ label: "Live" });
  } else if (section === "assets") {
    items.push({ label: "Assets" });
  } else if (section === "uploads") {
    items.push({ label: "Uploads" });
  } else if (section === "prompts") {
    items.push({ label: "Prompt library" });
  } else if (section === "settings") {
    items.push({ label: "Settings" });
  } else {
    items.push({ label: section });
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-3 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
    >
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3 shrink-0" />}
          {it.to ? (
            <Link to={it.to} className="hover:text-foreground">
              {it.label}
            </Link>
          ) : (
            <span className="text-foreground">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function ChannelName({ id }: { id: string }) {
  const { data } = useChannel(id);
  return <>{data?.name ?? "Channel"}</>;
}

function ProjectTitle({ id }: { id: string }) {
  const { data } = useProject(id);
  return <>{data?.title ?? "Project"}</>;
}
