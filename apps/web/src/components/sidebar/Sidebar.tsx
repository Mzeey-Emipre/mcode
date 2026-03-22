import { useWorkspaceStore } from "@/stores/workspaceStore";
import { WorkspaceList } from "./WorkspaceList";
import { ThreadList } from "./ThreadList";
import { PanelLeftClose, PanelLeft } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  return (
    <div
      className={cn(
        "flex h-full flex-col border-r border-border bg-card transition-all duration-200",
        collapsed ? "w-12" : "w-72"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-3">
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

      {!collapsed && (
        <>
          {/* Workspaces */}
          <div className="flex-1 overflow-hidden">
            <WorkspaceList />
          </div>

          {/* Threads for active workspace */}
          {activeWorkspaceId && (
            <div className="flex-1 overflow-hidden border-t border-border">
              <ThreadList />
            </div>
          )}
        </>
      )}
    </div>
  );
}
