import { ProjectTree } from "./ProjectTree";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { PanelLeftClose, PanelLeft } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** Sidebar component that renders app navigation and the project tree. */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      className={cn(
        "flex h-full flex-col border-r border-border bg-card transition-all duration-200",
        collapsed ? "w-12" : "w-72"
      )}
    >
      {/* Header */}
      <div className="flex h-11 items-center justify-between border-b border-border px-3">
        {!collapsed && (
          <span className="text-sm font-semibold text-foreground">Mcode</span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      {/* Project tree */}
      {!collapsed && <ProjectTree />}

      {/* Settings at bottom - text + icon */}
      {!collapsed && (
        <div className="border-t border-border p-3">
          <SettingsDialog />
        </div>
      )}
    </div>
  );
}
