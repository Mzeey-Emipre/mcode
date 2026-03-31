import { ProjectTree } from "./ProjectTree";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { PanelLeftClose, PanelLeft } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** Sidebar component that renders app navigation and the project tree. */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      className={cn(
        "flex h-full flex-col border-r border-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-12" : "w-72"
      )}
    >
      {/* Header */}
      <div className="flex h-11 items-center justify-between border-b border-border px-3">
        {!collapsed && (
          <span className="text-sm font-semibold tracking-tight text-foreground">Mcode</span>
        )}
        <Button variant="ghost" size="icon-sm" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} className="text-muted-foreground">
          {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        </Button>
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
