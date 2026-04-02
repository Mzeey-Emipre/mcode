import { ProjectTree } from "./ProjectTree";
import { PanelLeftClose, PanelLeft, Settings } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface SidebarProps {
  /** Called when the user clicks the Settings button. */
  onOpenSettings: () => void;
}

/** Sidebar component that renders app navigation and the project tree. */
export function Sidebar({ onOpenSettings }: SidebarProps) {
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

      {/* Settings at bottom */}
      {!collapsed && (
        <div className="border-t border-border p-3">
          <Button
            variant="ghost"
            className="flex w-full items-center gap-2 rounded p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onOpenSettings}
          >
            <Settings size={16} />
            Settings
          </Button>
        </div>
      )}
    </div>
  );
}
