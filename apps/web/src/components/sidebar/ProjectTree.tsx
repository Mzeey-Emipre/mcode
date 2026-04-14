import { useEffect, useLayoutEffect, useCallback, useState, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/shallow";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { FolderOpen, Plus, Trash2, ChevronRight, ChevronDown, GitBranch, Loader2, AlertTriangle } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
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
import { getStatusDisplay, getNotificationDot } from "@/lib/thread-status";
import { getCiDotClass } from "@/lib/ci-status";
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

/** Maximum threads shown before "Show more" appears. */
const THREAD_LIST_CAP = 6;

/** Time in ms to wait for a potential second click before treating a click as a single-click navigation */
const DOUBLE_CLICK_THRESHOLD_MS = 250;

/** Read per-workspace "show all threads" state from localStorage. */
function getThreadListExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem("mcode-expanded-thread-lists") || "{}");
  } catch {
    return {};
  }
}

/** Persist per-workspace "show all threads" state to localStorage. */
function setThreadListExpanded(state: Record<string, boolean>) {
  localStorage.setItem("mcode-expanded-thread-lists", JSON.stringify(state));
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

/** A thread with its nesting depth in the sidebar tree. */
interface ThreadTreeItem {
  thread: Thread;
  depth: number;
}

/** Builds a depth-first flattened tree from a flat list of threads, ordered by parent-child relationships. */
function buildThreadTree(threads: Thread[]): ThreadTreeItem[] {
  const childrenByParent = new Map<string, Thread[]>();
  const roots: Thread[] = [];
  const threadIds = new Set(threads.map((t) => t.id));

  for (const thread of threads) {
    if (!thread.parent_thread_id || !threadIds.has(thread.parent_thread_id)) {
      // Root thread, or orphan whose parent isn't in this list
      roots.push(thread);
    } else {
      const siblings = childrenByParent.get(thread.parent_thread_id) ?? [];
      siblings.push(thread);
      childrenByParent.set(thread.parent_thread_id, siblings);
    }
  }

  const result: ThreadTreeItem[] = [];
  function walk(thread: Thread, depth: number) {
    result.push({ thread, depth });
    const children = childrenByParent.get(thread.id);
    if (children) {
      for (const child of children) {
        walk(child, depth + 1);
      }
    }
  }

  for (const root of roots) {
    walk(root, 0);
  }

  return result;
}

/** Sidebar tree listing workspaces and their threads with CRUD actions. */
export function ProjectTree() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const threads = useWorkspaceStore((s) => s.threads);
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const loadThreads = useWorkspaceStore((s) => s.loadThreads);
  const loadWorktrees = useWorkspaceStore((s) => s.loadWorktrees);
  const worktreesLoadedForWorkspace = useWorkspaceStore((s) => s.worktreesLoadedForWorkspace);
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
  const [threadListExpanded, setThreadListExpandedState] = useState<Record<string, boolean>>(getThreadListExpanded);
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

  // Persist thread-list expanded state
  useEffect(() => {
    setThreadListExpanded(threadListExpanded);
  }, [threadListExpanded]);

  // Auto-load worktrees for the active workspace so stale-worktree detection has data.
  useEffect(() => {
    if (!activeWorkspaceId || worktreesLoadedForWorkspace === activeWorkspaceId) return;
    const hasWorktreeThreads = threads.some(
      (t) => t.workspace_id === activeWorkspaceId && t.mode === "worktree" && t.worktree_path,
    );
    if (hasWorktreeThreads) {
      loadWorktrees(activeWorkspaceId);
    }
  }, [activeWorkspaceId, threads, worktreesLoadedForWorkspace, loadWorktrees]);

  const toggleThreadList = useCallback((wsId: string) => {
    setThreadListExpandedState((prev) => ({ ...prev, [wsId]: !prev[wsId] }));
  }, []);

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

  const handleStartInlineEdit = useCallback((threadId: string, title: string) => {
    setInlineEdit({ threadId, title, originalTitle: title });
  }, []);

  const scrollViewportRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 mb-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          Projects
        </span>
        <Button variant="ghost" size="icon-xs" disabled={isCreating} onClick={handleOpenFolder} aria-label="Open project folder" className="text-muted-foreground/60 hover:text-foreground">
          <Plus size={14} />
        </Button>
      </div>

      <ScrollArea className="flex-1" viewportRef={scrollViewportRef}>
        <div className="px-1" data-testid="thread-list">
          {workspaces.map((ws) => (
            <ProjectNode
              key={ws.id}
              workspace={ws}
              isExpanded={expanded[ws.id] ?? false}
              isActive={activeWorkspaceId === ws.id}
              activeThreadId={activeThreadId}
              threads={threads.filter((t) => t.workspace_id === ws.id)}
              runningThreadIds={runningThreadIds}
              isThreadListExpanded={threadListExpanded[ws.id] ?? false}
              onToggleThreadList={() => toggleThreadList(ws.id)}
              scrollElementRef={scrollViewportRef}
              inlineEdit={inlineEdit}
              onInlineEditChange={(title) =>
                setInlineEdit((prev) => prev ? { ...prev, title } : null)
              }
              onInlineEditCommit={handleInlineEditCommit}
              onInlineEditCancel={() => setInlineEdit(null)}
              onStartInlineEdit={handleStartInlineEdit}
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

// --- VirtualizedThreadList: only mounts when the workspace is expanded ---

/** Props for the virtualized thread list rendered inside an expanded workspace. */
interface VirtualizedThreadListProps {
  threads: Thread[];
  maxVisible: number;
  activeThreadId: string | null;
  runningThreadIds: Set<string>;
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  inlineEdit: InlineEditState | null;
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  /** Start an inline rename for the given thread. */
  onStartInlineEdit: (threadId: string, title: string) => void;
  onSelectThread: (id: string) => void;
  onThreadContextMenu: (e: React.MouseEvent, thread: Thread) => void;
}

/** Renders a virtualized, scrollable list of threads for a single workspace. */
function VirtualizedThreadList({
  threads,
  maxVisible,
  activeThreadId,
  runningThreadIds,
  scrollElementRef,
  inlineEdit,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
  onStartInlineEdit,
  onSelectThread,
  onThreadContextMenu,
}: VirtualizedThreadListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Build nested tree from flat thread list
  const treeItems = useMemo(() => buildThreadTree(threads), [threads]);

  // Normalized set of existing worktree paths for stale detection.
  const worktrees = useWorkspaceStore((s) => s.worktrees);
  const worktreesLoadedFor = useWorkspaceStore((s) => s.worktreesLoadedForWorkspace);
  const checksById = useWorkspaceStore(useShallow((s) => s.checksById));
  const validWorktreePaths = useMemo(() => {
    const set = new Set<string>();
    for (const wt of worktrees) {
      set.add(wt.path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase());
    }
    return set;
  }, [worktrees]);

  // Per-thread timestamps and pending timeout IDs for the 250ms click-delay pattern.
  const lastClickTimeRef = useRef<Map<string, number>>(new Map());
  const clickTimeoutIdRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clear all pending click timeouts on unmount to prevent stale navigation.
  useEffect(() => {
    return () => {
      clickTimeoutIdRef.current.forEach((id) => clearTimeout(id));
    };
  }, []);

  const handleThreadClick = useCallback((threadId: string, title: string) => {
    // If already editing this thread, clicks are absorbed to avoid conflicting with the input.
    if (inlineEdit?.threadId === threadId) return;

    const now = Date.now();
    const last = lastClickTimeRef.current.get(threadId) ?? 0;
    const elapsed = now - last;

    const existing = clickTimeoutIdRef.current.get(threadId);
    if (existing) clearTimeout(existing);

    if (elapsed < DOUBLE_CLICK_THRESHOLD_MS) {
      // Double-click: cancel the pending navigation and enter inline rename.
      lastClickTimeRef.current.delete(threadId);
      clickTimeoutIdRef.current.delete(threadId);
      onStartInlineEdit(threadId, title);
    } else {
      // Single click: delay navigation so a second click can intercept it.
      lastClickTimeRef.current.set(threadId, now);
      const id = setTimeout(() => {
        onSelectThread(threadId);
        lastClickTimeRef.current.delete(threadId);
        clickTimeoutIdRef.current.delete(threadId);
      }, DOUBLE_CLICK_THRESHOLD_MS);
      clickTimeoutIdRef.current.set(threadId, id);
    }
  }, [inlineEdit, onSelectThread, onStartInlineEdit]);

  // Recompute offset from the outer scroll viewport after each layout pass.
  // Stays in sync when workspaces above expand/collapse.
  useLayoutEffect(() => {
    setScrollMargin((prev) => {
      const next = containerRef.current?.offsetTop ?? 0;
      return prev === next ? prev : next;
    });
  });

  const visibleCount = Math.min(treeItems.length, maxVisible);

  const virtualizer = useVirtualizer({
    count: visibleCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 28,
    overscan: 5,
    scrollMargin,
  });

  return (
    <div
      ref={containerRef}
      style={{ height: virtualizer.getTotalSize(), position: "relative" }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const { thread, depth } = treeItems[virtualItem.index];
        const status = getStatusDisplay(thread, runningThreadIds.has(thread.id));
        const isEditing = inlineEdit?.threadId === thread.id;
        // Worktree thread whose directory no longer exists on disk.
        // Only check threads from the workspace whose worktrees are loaded — comparing
        // against a different workspace's worktree list would produce false positives.
        const isStaleWorktree = worktreesLoadedFor === thread.workspace_id
          && thread.mode === "worktree" && !!thread.worktree_path
          && !validWorktreePaths.has(thread.worktree_path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase());
        return (
          <div
            key={thread.id}
            data-index={virtualItem.index}
            data-testid="thread-item"
            data-thread-id={thread.id}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
            }}
          >
              <div
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (isEditing) return;
                  // Keyboard navigation fires immediately — no double-click semantics for keyboard users.
                  // Enter/Space always navigates; rename must be triggered via mouse double-click.
                  if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                    e.preventDefault();
                    onSelectThread(thread.id);
                  }
                }}
                onClick={() => handleThreadClick(thread.id, thread.title)}
                onContextMenu={(e) => onThreadContextMenu(e, thread)}
                className={cn(
                  "flex items-center gap-2 rounded-md pr-2 py-1 text-sm cursor-pointer transition-colors",
                  activeThreadId === thread.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
                style={{ paddingLeft: `${8 + depth * 16}px` }}
              >
                {thread.pr_number != null ? (() => {
                  const { Icon: PrIcon, color: prColor } = getPrVisual(thread.pr_status);
                  const ciChecks = checksById[thread.id];
                  const ciDotClass = ciChecks ? getCiDotClass(ciChecks.aggregate) : null;
                  const agentDot = getNotificationDot(thread, runningThreadIds.has(thread.id));
                  // CI dot takes priority when present; fall back to agent notification dot
                  const dot = ciDotClass
                    ? { dotClass: ciDotClass, animate: ciChecks!.aggregate === "pending" }
                    : agentDot;
                  return (
                    <span
                      title={`PR #${thread.pr_number} \u2013 ${thread.pr_status ?? "open"}`}
                      className="relative shrink-0"
                    >
                      <PrIcon size={12} className={prColor} />
                      {dot && (
                        <span
                          className={cn(
                            "absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background",
                            dot.dotClass,
                            dot.animate && "animate-pulse",
                          )}
                        />
                      )}
                    </span>
                  );
                })() : (
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", status.dotClass)} />
                )}
                {!thread.pr_number && status.label && (
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
                  <span className={cn("truncate flex-1 text-sm", isStaleWorktree && "text-destructive/80 line-through")} data-testid="thread-title">
                    {isStaleWorktree && (
                      <Tooltip>
                        <TooltipTrigger render={<AlertTriangle size={11} className="inline mr-1 align-text-bottom text-destructive/70" />} />
                        <TooltipContent side="right" className="text-xs">Worktree directory no longer exists</TooltipContent>
                      </Tooltip>
                    )}
                    {thread.title}
                  </span>
                )}
                {!isEditing && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {thread.pr_number != null && (
                      <span className="mr-1 opacity-70">#{thread.pr_number}</span>
                    )}
                    {relativeTime(thread.updated_at)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
  );
}

// --- ProjectNode: a single workspace with its threads ---

/** Props for a single workspace node in the sidebar tree. */
interface ProjectNodeProps {
  workspace: Workspace;
  isExpanded: boolean;
  isActive: boolean;
  activeThreadId: string | null;
  threads: Thread[];
  runningThreadIds: Set<string>;
  /** Whether the thread list is fully expanded (persisted by parent). */
  isThreadListExpanded: boolean;
  /** Callback to toggle the thread list expanded state (persisted by parent). */
  onToggleThreadList: () => void;
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  inlineEdit: InlineEditState | null;
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  /** Start an inline rename for the given thread. */
  onStartInlineEdit: (threadId: string, title: string) => void;
  onToggle: () => void;
  onSelectThread: (id: string) => void;
  onCreateThread: () => void;
  onDelete: () => void;
  onThreadContextMenu: (e: React.MouseEvent, thread: Thread) => void;
}

/** Renders a collapsible workspace row with its virtualized thread list. */
function ProjectNode({
  workspace,
  isExpanded,
  isActive,
  activeThreadId,
  threads,
  runningThreadIds,
  isThreadListExpanded,
  onToggleThreadList,
  scrollElementRef,
  inlineEdit,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
  onStartInlineEdit,
  onToggle,
  onSelectThread,
  onCreateThread,
  onDelete,
  onThreadContextMenu,
}: ProjectNodeProps) {
  // Use the flattened tree order (same order VirtualizedThreadList renders) for cap decisions.
  const treeItems = useMemo(() => buildThreadTree(threads), [threads]);
  const needsCap = treeItems.length > THREAD_LIST_CAP;

  // Auto-expand when the active thread sits beyond the cap (temporary, not persisted).
  const activeIndex = activeThreadId ? treeItems.findIndex((item) => item.thread.id === activeThreadId) : -1;
  const forceExpand = activeIndex >= THREAD_LIST_CAP;
  const maxVisible = (!needsCap || isThreadListExpanded || forceExpand) ? Infinity : THREAD_LIST_CAP;

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
          {threads.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground italic">
              No threads
            </p>
          ) : (
            <VirtualizedThreadList
              threads={threads}
              maxVisible={maxVisible}
              activeThreadId={activeThreadId}
              runningThreadIds={runningThreadIds}
              scrollElementRef={scrollElementRef}
              inlineEdit={inlineEdit}
              onInlineEditChange={onInlineEditChange}
              onInlineEditCommit={onInlineEditCommit}
              onInlineEditCancel={onInlineEditCancel}
              onStartInlineEdit={onStartInlineEdit}
              onSelectThread={onSelectThread}
              onThreadContextMenu={onThreadContextMenu}
            />
          )}

          {needsCap && !forceExpand && (
            <div className="px-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={onToggleThreadList}
                className="w-full justify-start text-muted-foreground/60 hover:text-muted-foreground"
              >
                {isThreadListExpanded
                  ? "Show less"
                  : `Show more (${threads.length - THREAD_LIST_CAP})`}
              </Button>
            </div>
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
