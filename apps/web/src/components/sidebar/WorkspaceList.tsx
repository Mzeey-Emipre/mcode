import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { FolderOpen, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

export function WorkspaceList() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          Projects
        </span>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-0.5 px-2">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveWorkspace(ws.id);
                }
              }}
              className={cn(
                "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer",
                activeWorkspaceId === ws.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
              onClick={() => setActiveWorkspace(ws.id)}
            >
              <FolderOpen size={14} className="shrink-0" />
              <span className="truncate flex-1">{ws.name}</span>
              <button
                aria-label={`Delete ${ws.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteWorkspace(ws.id);
                }}
                className="invisible rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:visible"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {workspaces.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No projects yet. Open a folder to get started.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
