import { useEffect, useCallback, useState, useRef } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { FolderOpen, Plus, Trash2, ChevronRight, ChevronDown, GitBranch, Loader2 } from "lucide-react";
import { getPrVisual } from "@/lib/pr-status";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ContextMenu } from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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

interface ContextMenuState {
  x: number;
  y: number;
  threadId: string;
  threadTitle: string;
  workspacePath: string;
  worktreePath: string | null;
}

interface DeleteDialogState {
  threadId: string;
  threadTitle: string;
  worktreePath: string | null;
}

/** State for the workspace (project) delete confirmation dialog. */
interface WorkspaceDeleteDialogState {
  workspaceId: string;
  workspaceName: string;
}

interface InlineEditState {
  threadId: string;
  title: string;
  originalTitle: string;
}

/** Sidebar tree listing workspaces and their threads with CRUD actions. */
export function ProjectTree() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const threads = useWorkspaceStore((s) => s.threads);
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const loadThreads = useWorkspaceStore((s) => s.loadThreads);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const deleteThread = useWorkspaceStore((s) => s.deleteThread);
  const setPendingNewThread = useWorkspaceStore((s) => s.setPendingNewThread);
  const updateThreadTitle = useWorkspaceStore((s) => s.updateThreadTitle);
  const error = useWorkspaceStore((s) => s.error);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);

  const [expanded, setExpanded] = useState<Record<string, boolean>>(getExpandedState);
  const [isCreating, setIsCreating] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  const [wsDeleteDialog, setWsDeleteDialog] = useState<WorkspaceDeleteDialogState | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  // Load threads for workspaces that were expanded in a previous session
  const didLoadExpandedRef = useRef(false);
  useEffect(() => {
    if (workspaces.length === 0 || didLoadExpandedRef.current) return;
    didLoadExpandedRef.current = true;
    for (const ws of workspaces) {
      if (expanded[ws.id]) {
        loadThreads(ws.id);
      }
    }
  }, [workspaces, expanded, loadThreads]);

  // Persist expanded state
  useEffect(() => {
    setExpandedState(expanded);
  }, [expanded]);

  // F2 shortcut: rename the active thread
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "F2") return;
      if (!activeThreadId) return;
      if (inlineEdit) return;

      // Don't trigger when user is in any editable context
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable ||
        target?.closest?.('[contenteditable="true"]') ||
        target?.getAttribute?.("role") === "textbox" ||
        target?.hasAttribute?.("aria-multiline")
      ) return;

      const thread = threads.find((t) => t.id === activeThreadId);
      if (thread) {
        e.preventDefault();
        setInlineEdit({
          threadId: thread.id,
          title: thread.title,
          originalTitle: thread.title,
        });
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeThreadId, threads, inlineEdit]);

  const toggleExpand = useCallback((wsId: string) => {
    setExpanded((prev) => {
      const isExpanding = !prev[wsId];
      const next = { ...prev, [wsId]: isExpanding };
      if (isExpanding) {
        // Load threads independently without changing the active workspace
        loadThreads(wsId);
      }
      return next;
    });
  }, [loadThreads]);

  const handleOpenFolder = useCallback(async () => {
    if (!window.desktopBridge || isCreating) return;
    setIsCreating(true);
    try {
      const selected = await window.desktopBridge.showOpenDialog({
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

  const handleThreadContextMenu = useCallback(
    (e: React.MouseEvent, thread: Thread, workspacePath: string) => {
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        threadId: thread.id,
        threadTitle: thread.title,
        workspacePath,
        worktreePath: thread.worktree_path,
      });
    },
    []
  );

  const handleInlineEditCommit = useCallback(async () => {
    if (!inlineEdit) return;
    const newTitle = inlineEdit.title.trim();
    if (!newTitle || newTitle === inlineEdit.originalTitle) {
      setInlineEdit(null);
      return;
    }
    try {
      await updateThreadTitle(inlineEdit.threadId, newTitle);
      setInlineEdit(null);
    } catch {
      // Error surfaced via store.error; keep editor open so user can retry
    }
  }, [inlineEdit, updateThreadTitle]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteDialog || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteThread(deleteDialog.threadId, deleteWorktree);
      setDeleteDialog(null);
      setDeleteWorktree(false);
    } catch {
      // Error shown via store.error; keep dialog open so user can retry
    } finally {
      setIsDeleting(false);
    }
  }, [deleteDialog, deleteWorktree, deleteThread, isDeleting]);

  const handleWorkspaceDeleteConfirm = useCallback(async () => {
    if (!wsDeleteDialog) return;
    try {
      await deleteWorkspace(wsDeleteDialog.workspaceId);
      setWsDeleteDialog(null);
    } catch {
      // Error shown via store.error; keep dialog open so user can retry
    }
  }, [wsDeleteDialog, deleteWorkspace]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          Projects
        </span>
        <Button variant="ghost" size="icon-xs" disabled={isCreating} onClick={handleOpenFolder} aria-label="Open project folder" className="text-muted-foreground">
          <Plus size={14} />
        </Button>
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
              threads={threads.filter((t) => t.workspace_id === ws.id)}
              runningThreadIds={runningThreadIds}
              inlineEdit={inlineEdit}
              onInlineEditChange={(title) =>
                setInlineEdit((prev) => prev ? { ...prev, title } : null)
              }
              onInlineEditCommit={handleInlineEditCommit}
              onInlineEditCancel={() => setInlineEdit(null)}
              onToggle={() => toggleExpand(ws.id)}
              onSelectThread={(id) => {
                setActiveWorkspace(ws.id);
                setActiveThread(id);
              }}
              onCreateThread={() => {
                setActiveWorkspace(ws.id);
                setPendingNewThread(true);
                setActiveThread(null);
              }}
              onDelete={() => {
                setWsDeleteDialog({
                  workspaceId: ws.id,
                  workspaceName: ws.name,
                });
              }}
              onThreadContextMenu={(e, thread) =>
                handleThreadContextMenu(e, thread, ws.path)
              }
            />
          ))}

          {workspaces.length === 0 && (
            <div className="px-2 py-4 text-center">
              <p className="text-xs text-muted-foreground">No projects yet.</p>
              <Button variant="outline" size="sm" disabled={isCreating} onClick={handleOpenFolder} className="mt-2 w-full border-dashed text-muted-foreground hover:border-primary hover:text-primary">
                <FolderOpen size={12} />
                Open a folder
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>

      {error && (
        <p className="px-3 py-1 text-xs text-destructive">{error}</p>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: "Rename",
              onClick: () => {
                setInlineEdit({
                  threadId: contextMenu.threadId,
                  title: contextMenu.threadTitle,
                  originalTitle: contextMenu.threadTitle,
                });
              },
            },
            {
              label: "Copy Path",
              onClick: () => {
                navigator.clipboard.writeText(contextMenu.workspacePath);
              },
            },
            {
              label: "Copy Thread ID",
              onClick: () => {
                navigator.clipboard.writeText(contextMenu.threadId);
              },
            },
            { label: "", onClick: () => {}, divider: true },
            {
              label: "Delete",
              destructive: true,
              onClick: () => {
                setDeleteDialog({
                  threadId: contextMenu.threadId,
                  threadTitle: contextMenu.threadTitle,
                  worktreePath: contextMenu.worktreePath,
                });
                setDeleteWorktree(false);
              },
            },
          ]}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialog !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setDeleteDialog(null);
            setDeleteWorktree(false);
          }
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md overflow-hidden">
          <div className="flex flex-col gap-2">
            <DialogTitle>Delete thread</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deleteDialog?.threadTitle}&rdquo;?
              This action cannot be undone.
            </DialogDescription>
          </div>
          {deleteDialog?.worktreePath && (
            <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border p-3">
              <GitBranch size={14} className="shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Delete worktree</div>
                <div className="truncate text-xs text-muted-foreground">
                  {deleteDialog.worktreePath}
                </div>
              </div>
              <Switch
                checked={deleteWorktree}
                onCheckedChange={(checked) => {
                  if (isDeleting) return;
                  setDeleteWorktree(checked);
                }}
                disabled={isDeleting}
                className="data-[checked]:bg-destructive"
                aria-label="Delete worktree"
              />
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              className="cursor-pointer"
              disabled={isDeleting}
              onClick={() => {
                setDeleteDialog(null);
                setDeleteWorktree(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="cursor-pointer"
              disabled={isDeleting}
              onClick={handleDeleteConfirm}
            >
              {isDeleting && <Loader2 size={14} className="animate-spin" />}
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Workspace Delete Confirmation Dialog */}
      <Dialog
        open={wsDeleteDialog !== null}
        onOpenChange={(open) => {
          if (!open) setWsDeleteDialog(null);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md overflow-hidden">
          <div className="flex flex-col gap-2">
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{wsDeleteDialog?.workspaceName}&rdquo;?
              All threads in this project will also be removed. This action cannot be undone.
            </DialogDescription>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setWsDeleteDialog(null)}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleWorkspaceDeleteConfirm}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
  runningThreadIds: Set<string>;
  inlineEdit: InlineEditState | null;
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  onToggle: () => void;
  onSelectThread: (id: string) => void;
  onCreateThread: () => void;
  onDelete: () => void;
  onThreadContextMenu: (e: React.MouseEvent, thread: Thread) => void;
}

function ProjectNode({
  workspace,
  isExpanded,
  isActive,
  activeThreadId,
  threads,
  runningThreadIds,
  inlineEdit,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
  onToggle,
  onSelectThread,
  onCreateThread,
  onDelete,
  onThreadContextMenu,
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
        <Button variant="ghost" size="icon-xs" aria-label={`Delete ${workspace.name}`} onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }} className="opacity-0 text-muted-foreground hover:text-destructive group-hover:opacity-100 focus:opacity-100">
          <Trash2 size={12} />
        </Button>
      </div>

      {/* Threads (when expanded) */}
      {isExpanded && (
        <div className="ml-3 border-l border-border/50 pl-2">
          {threads.map((thread) => {
            const status = getStatusDisplay(thread, runningThreadIds.has(thread.id));
            const isEditing = inlineEdit?.threadId === thread.id;
            return (
              <div
                key={thread.id}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (isEditing) return;
                  if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                    e.preventDefault();
                    onSelectThread(thread.id);
                  }
                }}
                onClick={() => {
                  if (!isEditing) onSelectThread(thread.id);
                }}
                onContextMenu={(e) => onThreadContextMenu(e, thread)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-sm cursor-pointer",
                  activeThreadId === thread.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status.dotClass)} />
                {thread.pr_number != null && (() => {
                  const { Icon: PrIcon, color: prColor } = getPrVisual(thread.pr_status);
                  return (
                    <span
                      title={`PR #${thread.pr_number} \u2013 ${thread.pr_status ?? "open"}`}
                      className="shrink-0"
                    >
                      <PrIcon size={11} className={prColor} />
                    </span>
                  );
                })()}
                {status.label && (
                  <span className={cn("shrink-0 text-xs", status.color)}>
                    {status.label}
                  </span>
                )}
                {isEditing ? (
                  <Input
                    type="text"
                    size="xs"
                    value={inlineEdit.title}
                    onChange={(e) => onInlineEditChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (!e.nativeEvent.isComposing) {
                        if (e.key === "Enter") onInlineEditCommit();
                        if (e.key === "Escape") onInlineEditCancel();
                      }
                      e.stopPropagation();
                    }}
                    onBlur={onInlineEditCommit}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 border-ring"
                  />
                ) : (
                  <span className="truncate flex-1 text-xs">
                    {thread.title}
                  </span>
                )}
                {!isEditing && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relativeTime(thread.updated_at)}
                  </span>
                )}
              </div>
            );
          })}

          {threads.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground italic">
              No threads
            </p>
          )}

          {/* New thread button inside expanded project */}
          <div className="mt-0.5 px-1">
            <Button variant="ghost" size="xs" onClick={onCreateThread} className="w-full justify-start text-muted-foreground">
              <Plus size={12} />
              New thread
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
