import { NavLink } from "react-router-dom";
import {
  Play,
  LayoutDashboard,
  Tv,
  PlusCircle,
  Library,
  BarChart3,
  Settings,
  Loader2,
  Radio,
  Tractor,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTasks } from "@/hooks/use-tasks";

// Prompts → Settings tab, Automation → Channel detail tab, Uploads → Library tab
const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/channels", label: "Channels", icon: Tv },
  { to: "/projects/new", label: "New Video", icon: PlusCircle, accent: true },
  { to: "/assets", label: "Library", icon: Library },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/farm", label: "Farm", icon: Tractor },
  { to: "/live", label: "Live", icon: Radio },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function Sidebar() {
  const { data: runningTasks } = useTasks({ status: "running" });
  const runningCount = runningTasks?.length ?? 0;

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-border bg-card">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
          <Play className="h-4 w-4 fill-primary-foreground text-primary-foreground" />
        </div>
        <span className="text-lg font-semibold tracking-tight text-foreground">
          Tube AI
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-2">
        {navItems.map(({ to, label, icon: Icon, accent, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                accent &&
                  !isActive &&
                  "text-primary hover:text-primary"
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Task activity indicator */}
      {runningCount > 0 && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span>
              {runningCount} task{runningCount !== 1 ? "s" : ""} running
            </span>
          </div>
        </div>
      )}
    </aside>
  );
}
