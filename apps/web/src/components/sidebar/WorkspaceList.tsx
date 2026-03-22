import { useEffect, useCallback, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { isTauri } from "@/transport/tauri";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

export function WorkspaceList() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const error = useWorkspaceStore((s) => s.error);

  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  const handleOpenFolder = useCallback(async () => {
    if (!isTauri() || isCreating) return;
    setIsCreating(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select a project folder",
      });

      if (selected && typeof selected === "string") {
        // If workspace with this path already exists, just activate it
        const existing = workspaces.find((ws) => ws.path === selected);
        if (existing) {
          setActiveWorkspace(existing.id);
          return;
        }

        // Extract folder name from path
        const name = selected
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() || "Untitled";

        const workspace = await createWorkspace(name, selected);
        setActiveWorkspace(workspace.id);
      }
    } catch (e) {
      console.error("Failed to open folder:", e);
    } finally {
      setIsCreating(false);
    }
  }, [createWorkspace, setActiveWorkspace, workspaces, isCreating]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          Projects
        </span>
        <button
          disabled={isCreating}
          onClick={handleOpenFolder}
          aria-label="Open project folder"
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Plus size={14} />
        </button>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-0.5 px-2">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              role="button"
              tabIndex={0}
              aria-pressed={activeWorkspaceId === ws.id}
              onKeyDown={(e) => {
                if (
                  (e.key === "Enter" || e.key === " ") &&
                  e.target === e.currentTarget
                ) {
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
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await deleteWorkspace(ws.id);
                  } catch {
                    // Error already set in store and rendered below
                  }
                }}
                className="opacity-0 rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:opacity-100 focus:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {workspaces.length === 0 && (
            <div className="px-2 py-4 text-center">
              <p className="text-xs text-muted-foreground">No projects yet.</p>
              <button
                disabled={isCreating}
                onClick={handleOpenFolder}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50"
              >
                <FolderOpen size={12} />
                Open a folder
              </button>
            </div>
          )}
        </div>
      </ScrollArea>
      {error && (
        <p className="px-3 py-1 text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
