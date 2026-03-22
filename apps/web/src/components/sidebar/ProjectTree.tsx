import { useEffect, useCallback, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { isTauri } from "@/transport/tauri";
import { FolderOpen, Plus, Trash2, ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { relativeTime } from "@/lib/time";
import { getStatusDisplay } from "@/lib/thread-status";
import type { Workspace, Thread } from "@/transport/types";

// Persist expand/collapse in localStorage
function getExpandedState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem("mcode-expanded-projects") || "{}");
  } catch {
    return {};
  }
}

function setExpandedState(state: Record<string, boolean>) {
  localStorage.setItem("mcode-expanded-projects", JSON.stringify(state));
}

export function ProjectTree() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const threads = useWorkspaceStore((s) => s.threads);
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const createThread = useWorkspaceStore((s) => s.createThread);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const error = useWorkspaceStore((s) => s.error);

  const [expanded, setExpanded] = useState<Record<string, boolean>>(getExpandedState);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  // Persist expanded state
  useEffect(() => {
    setExpandedState(expanded);
  }, [expanded]);

  const toggleExpand = useCallback((wsId: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [wsId]: !prev[wsId] };
      return next;
    });
    // Load threads if expanding and this workspace is being selected
    setActiveWorkspace(wsId);
  }, [setActiveWorkspace]);

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
        const existing = workspaces.find((ws) => ws.path === selected);
        if (existing) {
          setExpanded((prev) => ({ ...prev, [existing.id]: true }));
          setActiveWorkspace(existing.id);
          return;
        }

        const name = selected
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() || "Untitled";

        const workspace = await createWorkspace(name, selected);
        setExpanded((prev) => ({ ...prev, [workspace.id]: true }));
        setActiveWorkspace(workspace.id);
      }
    } catch (e) {
      console.error("Failed to open folder:", e);
    } finally {
      setIsCreating(false);
    }
  }, [createWorkspace, setActiveWorkspace, workspaces, isCreating]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
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
        <div className="px-1">
          {workspaces.map((ws) => (
            <ProjectNode
              key={ws.id}
              workspace={ws}
              isExpanded={expanded[ws.id] ?? false}
              isActive={activeWorkspaceId === ws.id}
              activeThreadId={activeThreadId}
              threads={activeWorkspaceId === ws.id ? threads : []}
              onToggle={() => toggleExpand(ws.id)}
              onSelectThread={(id) => setActiveThread(id)}
              onCreateThread={createThread}
              onDelete={async () => {
                try {
                  await deleteWorkspace(ws.id);
                } catch {
                  // Error already set in store
                }
              }}
            />
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

// --- ProjectNode: a single workspace with its threads ---

interface ProjectNodeProps {
  workspace: Workspace;
  isExpanded: boolean;
  isActive: boolean;
  activeThreadId: string | null;
  threads: Thread[];
  onToggle: () => void;
  onSelectThread: (id: string) => void;
  onCreateThread: (title: string, mode: "direct" | "worktree", branch: string) => Promise<Thread>;
  onDelete: () => void;
}

function ProjectNode({
  workspace,
  isExpanded,
  isActive,
  activeThreadId,
  threads,
  onToggle,
  onSelectThread,
  onCreateThread,
  onDelete,
}: ProjectNodeProps) {
  return (
    <div className="mb-0.5">
      {/* Workspace row */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            onToggle();
          }
        }}
        onClick={onToggle}
        className={cn(
          "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm cursor-pointer",
          isActive
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        {isExpanded ? (
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        )}
        <FolderOpen size={14} className="shrink-0" />
        <span className="truncate flex-1 font-medium">{workspace.name}</span>
        <button
          aria-label={`Delete ${workspace.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:opacity-100 focus:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Threads (when expanded) */}
      {isExpanded && (
        <div className="ml-3 border-l border-border/50 pl-2">
          {threads.map((thread) => {
            const status = getStatusDisplay(thread);
            return (
              <div
                key={thread.id}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                    e.preventDefault();
                    onSelectThread(thread.id);
                  }
                }}
                onClick={() => onSelectThread(thread.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-sm cursor-pointer",
                  activeThreadId === thread.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status.dotClass)} />
                <span className={cn("shrink-0 text-xs", status.color)}>
                  {status.label}
                </span>
                <span className="truncate flex-1 text-xs">
                  {thread.title}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {relativeTime(thread.updated_at)}
                </span>
              </div>
            );
          })}

          {threads.length === 0 && isActive && (
            <p className="px-2 py-1 text-[11px] text-muted-foreground italic">
              No threads
            </p>
          )}

          {/* New thread button inside expanded project */}
          {isActive && (
            <div className="mt-0.5 px-1">
              <button
                onClick={async () => {
                  try {
                    const thread = await onCreateThread("New thread", "direct", "main");
                    onSelectThread(thread.id);
                  } catch (e) {
                    console.error("Failed to create thread:", e);
                  }
                }}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              >
                <Plus size={11} />
                New thread
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
