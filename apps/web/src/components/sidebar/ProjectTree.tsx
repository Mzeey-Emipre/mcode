import {
  useEffect,
  useLayoutEffect,
  useCallback,
  useState,
  useRef,
  useMemo,
  memo,
  type CSSProperties,
  type ComponentType,
} from "react";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/shallow";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useUiStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import {
  Trash2,
  GitBranch,
  GitBranchMinus,
  AlertTriangle,
  ChevronRight,
  FolderPlus,
  Folder,
  FolderOpen,
  Activity,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { WorktreeModeIcon } from "@/components/icons/WorktreeModeIcon";
import {
  ClaudeIcon,
  CodexIcon,
  CopilotIcon,
  CursorProviderIcon,
  GeminiIcon,
  OpenCodeIcon,
} from "@/components/chat/ProviderIcons";
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
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  schedulePrefetch,
  cancelPrefetch,
} from "@/lib/thread-hydrator/prefetch-scheduler";
import { isPrable } from "@/lib/is-prable";
import { getCiVisual, CI_ICON_STROKE } from "@/lib/ci-status";
import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import { FILE_EXPLORER_ID } from "@/lib/resolveDefaultOpenInApp";
import { getTransport } from "@/transport";
import { useToastStore } from "@/stores/toastStore";
import type { ChecksStatus } from "@mcode/contracts";
import type { Workspace, Thread } from "@/transport/types";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { getThreadStateMarker, ThreadStateMarker } from "./ThreadStateMarker";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";

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

/** Maximum threads shown per workspace before "Show more" appears. */
const THREAD_LIST_CAP = 6;

/** Stable empty array used as default when a workspace has no threads. */
const EMPTY_THREADS: WorkspaceThread[] = [];

const PROJECT_DND_MODIFIERS = [restrictToVerticalAxis];
const PROJECT_DND_MEASURING = {
  droppable: {
    strategy: MeasuringStrategy.BeforeDragging,
  },
} as const;

/** Time window in ms during which a second click on the same thread row is treated as a double-click. */
const DOUBLE_CLICK_THRESHOLD_MS = 250;

/** Read per-workspace "show all threads" state from localStorage. */
function getThreadListExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(
      localStorage.getItem("mcode-expanded-thread-lists") || "{}",
    );
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

/** State for the workspace rename dialog. */
interface WorkspaceRenameDialogState {
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
  thread: WorkspaceThread;
  depth: number;
}

/** Builds a depth-first flattened tree from a flat list of threads, ordered by parent-child relationships. */
function buildThreadTree(threads: WorkspaceThread[]): ThreadTreeItem[] {
  const childrenByParent = new Map<string, WorkspaceThread[]>();
  const roots: WorkspaceThread[] = [];
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
  function walk(thread: WorkspaceThread, depth: number) {
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
  const worktreesLoadedForWorkspace = useWorkspaceStore(
    (s) => s.worktreesLoadedForWorkspace,
  );
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const deleteThread = useWorkspaceStore((s) => s.deleteThread);
  const beginNewThread = useWorkspaceStore((s) => s.beginNewThread);
  const setPrimarySurface = useUiStore((s) => s.setPrimarySurface);
  const updateThreadTitle = useWorkspaceStore((s) => s.updateThreadTitle);
  const reorderWorkspace = useWorkspaceStore((s) => s.reorderWorkspace);
  const error = useWorkspaceStore((s) => s.error);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  // Derive pending permission thread IDs directly in the selector with useShallow
  // so the component only re-renders when the actual set of IDs changes, not on
  // every unrelated threadStore update that creates a new permissionsByThread ref.
  const pendingPermissionIds = useThreadStore(
    useShallow((s) => {
      const ids: string[] = [];
      for (const [id, rec] of s.records) {
        if (rec.permissions.some((p) => !p.settled)) ids.push(id);
      }
      return ids;
    }),
  );
  const pendingPermissionThreadIds = useMemo(
    () => new Set(pendingPermissionIds),
    [pendingPermissionIds],
  );

  // Pre-group threads by workspace in one pass instead of filtering all threads per workspace.
  const threadsByWorkspace = useMemo(() => {
    const map = new Map<string, WorkspaceThread[]>();
    for (const t of threads) {
      const arr = map.get(t.workspace_id);
      if (arr) arr.push(t);
      else map.set(t.workspace_id, [t]);
    }
    return map;
  }, [threads]);

  const [expanded, setExpanded] =
    useState<Record<string, boolean>>(getExpandedState);
  const [threadListExpanded, setThreadListExpandedState] = useState<
    Record<string, boolean>
  >(getThreadListExpanded);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(
    null,
  );
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  const [wsDeleteDialog, setWsDeleteDialog] =
    useState<WorkspaceDeleteDialogState | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [wsRenameDialog, setWsRenameDialog] =
    useState<WorkspaceRenameDialogState | null>(null);
  const [workspaceRenameValue, setWorkspaceRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const workspaceIds = useMemo(() => workspaces.map((w) => w.id), [workspaces]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

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

  const checksById = useWorkspaceStore(useShallow((s) => s.checksById));

  const toggleThreadList = useCallback((wsId: string) => {
    setThreadListExpandedState((prev) => ({ ...prev, [wsId]: !prev[wsId] }));
  }, []);

  // Auto-load worktrees for the active workspace so stale-worktree detection has data.
  useEffect(() => {
    if (!activeWorkspaceId || worktreesLoadedForWorkspace === activeWorkspaceId)
      return;
    const hasWorktreeThreads = threads.some(
      (t) =>
        t.workspace_id === activeWorkspaceId &&
        t.mode === "worktree" &&
        t.worktree_path,
    );
    if (hasWorktreeThreads) {
      loadWorktrees(activeWorkspaceId);
    }
  }, [activeWorkspaceId, threads, worktreesLoadedForWorkspace, loadWorktrees]);

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
      )
        return;

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

  const toggleExpand = useCallback(
    (wsId: string) => {
      setExpanded((prev) => {
        const isExpanding = !prev[wsId];
        const next = { ...prev, [wsId]: isExpanding };
        if (isExpanding) {
          // Load threads independently without changing the active workspace
          loadThreads(wsId);
        }
        return next;
      });
    },
    [loadThreads],
  );

  // Open the palette's folder-browse view instead of using the native OS dialog.
  // This works across Electron and standalone web, and avoids the desktopBridge dependency.
  const handleOpenFolder = useCallback(() => {
    useCommandPaletteStore.getState().open({ intent: "addProject" });
  }, []);

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
    [],
  );

  // Stable callbacks that accept wsId to avoid per-workspace closures in the render loop.
  const handleSelectThread = useCallback(
    (wsId: string, threadId: string) => {
      setActiveWorkspace(wsId);
      setActiveThread(threadId);
    },
    [setActiveWorkspace, setActiveThread],
  );

  const handleCreateThread = useCallback(
    (wsId: string) => {
      setPrimarySurface("chat");
      beginNewThread(wsId);
    },
    [beginNewThread, setPrimarySurface],
  );

  const handleDeleteWorkspace = useCallback((wsId: string) => {
    const ws = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === wsId);
    if (ws) {
      setWsDeleteDialog({ workspaceId: ws.id, workspaceName: ws.name });
    }
  }, []);

  const handleRenameWorkspace = useCallback((workspace: Workspace) => {
    setWorkspaceRenameValue(workspace.name);
    setWsRenameDialog({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    });
  }, []);

  const handleInlineEditChange = useCallback((title: string) => {
    setInlineEdit((prev) => (prev ? { ...prev, title } : null));
  }, []);

  const handleInlineEditCancel = useCallback(() => {
    setInlineEdit(null);
  }, []);

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

  const handleWorkspaceRenameConfirm = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!wsRenameDialog || isRenaming) return;

      const name = workspaceRenameValue.trim();
      if (!name || name === wsRenameDialog.workspaceName) {
        setWsRenameDialog(null);
        return;
      }

      setIsRenaming(true);
      try {
        await renameWorkspace(wsRenameDialog.workspaceId, name);
        setWsRenameDialog(null);
      } catch {
        // The workspace store retains the failure message for the sidebar error rail.
      } finally {
        setIsRenaming(false);
      }
    },
    [isRenaming, renameWorkspace, workspaceRenameValue, wsRenameDialog],
  );

  const handleStartInlineEdit = useCallback(
    (threadId: string, title: string) => {
      setInlineEdit({ threadId, title, originalTitle: title });
    },
    [],
  );

  const handleProjectDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = workspaceIds.indexOf(active.id as string);
      const newIndex = workspaceIds.indexOf(over.id as string);
      if (oldIndex < 0 || newIndex < 0) return;
      void reorderWorkspace(active.id as string, newIndex);
    },
    [workspaceIds, reorderWorkspace],
  );

  const handleProjectDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  const scrollViewportRef = useRef<HTMLDivElement>(null);

  /**
   * Only the project list viewport may autoscroll during drag so outer sidebar
   * regions (or the document) are not pulled by `@dnd-kit` when reordering.
   */
  const projectTreeAutoScroll = useMemo(
    () => ({
      canScroll(element: Element) {
        const vp = scrollViewportRef.current;
        return vp != null && element === vp;
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    if (!activeDragId) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [activeDragId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="mb-1 flex items-center justify-between px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Projects
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleOpenFolder}
                aria-label="Add project"
                className="text-muted-foreground hover:text-foreground"
              >
                <Plus size={15} />
              </Button>
            }
          />
          <TooltipContent side="right" className="text-xs">
            Add project
          </TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportRef={scrollViewportRef}>
        <div className="px-1.5" data-testid="thread-list">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={PROJECT_DND_MODIFIERS}
            measuring={PROJECT_DND_MEASURING}
            autoScroll={projectTreeAutoScroll}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SortableContext
              items={workspaceIds}
              strategy={verticalListSortingStrategy}
            >
              {workspaces.map((ws) => {
                const wsThreads =
                  threadsByWorkspace.get(ws.id) ?? EMPTY_THREADS;

                return (
                  <SortableProjectShell
                    key={ws.id}
                    sortableId={ws.id}
                    activeDragId={activeDragId}
                    workspace={ws}
                    isExpanded={expanded[ws.id] ?? false}
                    isActive={activeWorkspaceId === ws.id}
                    activeThreadId={activeThreadId}
                    threads={wsThreads}
                    runningThreadIds={runningThreadIds}
                    pendingPermissionThreadIds={pendingPermissionThreadIds}
                    isThreadListExpanded={threadListExpanded[ws.id] ?? false}
                    checksById={checksById}
                    onToggleThreadList={toggleThreadList}
                    scrollElementRef={scrollViewportRef}
                    inlineEdit={inlineEdit}
                    onInlineEditChange={handleInlineEditChange}
                    onInlineEditCommit={handleInlineEditCommit}
                    onInlineEditCancel={handleInlineEditCancel}
                    onStartInlineEdit={handleStartInlineEdit}
                    onToggle={toggleExpand}
                    onSelectThread={handleSelectThread}
                    onCreateThread={handleCreateThread}
                    onDelete={handleDeleteWorkspace}
                    onRename={handleRenameWorkspace}
                    onThreadContextMenu={handleThreadContextMenu}
                  />
                );
              })}
            </SortableContext>
          </DndContext>

          {workspaces.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 px-4 py-12">
              {/* Lucide FolderPlus echoes the action below — keeps the empty state on-brand
                  with the rest of the picker (no unicode glyphs). Larger/quieter than the CTA. */}
              <FolderPlus
                size={28}
                strokeWidth={1.25}
                aria-hidden
                className="text-muted-foreground/25"
              />
              <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/45">
                No projects yet
              </p>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleOpenFolder}
                className="group h-auto gap-1.5 rounded-md border border-border/50 px-2.5 py-1 text-[11.5px] font-normal text-muted-foreground/80 hover:border-border hover:bg-accent/50 hover:text-foreground"
              >
                <FolderPlus
                  size={11}
                  className="opacity-70 group-hover:opacity-100"
                />
                Open a folder
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>

      {error && <p className="px-3 py-1 text-xs text-destructive">{error}</p>}

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
                // Prefer the worktree path when the thread lives in one,
                // so the copied path matches the thread's actual checkout.
                navigator.clipboard.writeText(
                  contextMenu.worktreePath ?? contextMenu.workspacePath,
                );
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
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md overflow-hidden"
        >
          <div className="flex flex-col gap-2">
            <DialogTitle>Delete thread</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deleteDialog?.threadTitle}
              &rdquo;? This action cannot be undone.
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
              {isDeleting && <Spinner size={14} className="text-current" />}
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
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md overflow-hidden"
        >
          <div className="flex flex-col gap-2">
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;
              {wsDeleteDialog?.workspaceName}&rdquo;? All threads in this
              project will also be removed. This action cannot be undone.
            </DialogDescription>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setWsDeleteDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleWorkspaceDeleteConfirm}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={wsRenameDialog !== null}
        onOpenChange={(open) => {
          if (!open && !isRenaming) setWsRenameDialog(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md overflow-hidden"
        >
          <form
            onSubmit={handleWorkspaceRenameConfirm}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-2">
              <DialogTitle>Rename project</DialogTitle>
              <DialogDescription>
                Choose a new name for {wsRenameDialog?.workspaceName}.
              </DialogDescription>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="workspace-rename">Project name</Label>
              <Input
                id="workspace-rename"
                value={workspaceRenameValue}
                onChange={(event) =>
                  setWorkspaceRenameValue(event.target.value)
                }
                maxLength={120}
                autoFocus
                disabled={isRenaming}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isRenaming}
                onClick={() => setWsRenameDialog(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  isRenaming || workspaceRenameValue.trim().length === 0
                }
              >
                {isRenaming && <Spinner size={14} className="text-current" />}
                {isRenaming ? "Renaming..." : "Rename"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- VirtualizedThreadList: only mounts when the workspace is expanded ---

/** Props for the virtualized thread list rendered inside an expanded workspace. */
interface VirtualizedThreadListProps {
  /** Workspace name displayed in read-only thread previews. */
  workspaceName: string;
  /** Pre-computed tree items from the parent to avoid duplicate buildThreadTree calls. */
  treeItems: ThreadTreeItem[];
  /** Maximum number of tree rows to render. Used by the parent to enforce the THREAD_LIST_CAP. */
  maxVisible: number;
  activeThreadId: string | null;
  runningThreadIds: Set<string>;
  /** Thread IDs with at least one unsettled permission request. */
  pendingPermissionThreadIds: Set<string>;
  /** Per-thread CI check status. Passed from parent to avoid duplicate store subscriptions. */
  checksById: Record<string, ChecksStatus>;
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

/**
 * Workspace-row CI roll-up chip.
 *
 * Silent-on-healthy: renders nothing when all threads are green (or none have CI).
 * Surfaces a single chip when any thread is failing or pending, so a collapsed
 * project row still shouts when something needs attention but stays quiet when
 * nothing does. Uses the shared CI chrome so it stays consistent with the
 * chat-header button and overview popover.
 */
const WorkspaceCiRollupChip = memo(function WorkspaceCiRollupChip({
  threads,
  checksById,
}: {
  threads: WorkspaceThread[];
  checksById: Record<string, ChecksStatus>;
}) {
  // Count threads by their CI aggregate — one per thread, regardless of how many
  // individual checks each has. "Failing" dominates; then "pending"; otherwise silent.
  let failingCount = 0;
  let pendingCount = 0;
  for (const t of threads) {
    const checks = checksById[t.id];
    if (!checks || checks.aggregate === "no_checks") continue;
    if (checks.aggregate === "failing") failingCount += 1;
    else if (checks.aggregate === "pending") pendingCount += 1;
  }

  const agg: ChecksStatus["aggregate"] | null =
    failingCount > 0 ? "failing" : pendingCount > 0 ? "pending" : null;
  if (!agg) return null;

  const { icon: Icon, chromeClass } = getCiVisual(agg);
  const count = agg === "failing" ? failingCount : pendingCount;
  const noun = count === 1 ? "thread" : "threads";
  const label =
    agg === "failing"
      ? `${count} ${noun} failing`
      : `${count} ${noun} with checks running`;

  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "shrink-0 inline-flex items-center gap-0.5 px-1 h-4 rounded-[3px] border",
        "text-[10px] font-medium tabular-nums leading-none",
        chromeClass,
      )}
    >
      {agg === "pending" ? (
        <Spinner size={9} className="text-current" />
      ) : (
        <Icon size={9} strokeWidth={CI_ICON_STROKE} className="shrink-0" />
      )}
      <span>{count}</span>
    </span>
  );
});

type IconComponent = ComponentType<{ size?: number; className?: string }>;

const PROVIDER_META: Record<
  string,
  { icon: IconComponent; label: string; color: string }
> = {
  claude: { icon: ClaudeIcon, label: "Claude", color: "" },
  codex: { icon: CodexIcon, label: "Codex", color: "text-foreground" },
  copilot: {
    icon: CopilotIcon,
    label: "GitHub Copilot",
    color: "text-violet-400 dark:text-violet-300",
  },
  cursor: { icon: CursorProviderIcon, label: "Cursor", color: "" },
  gemini: { icon: GeminiIcon, label: "Gemini", color: "text-sky-400" },
  opencode: { icon: OpenCodeIcon, label: "OpenCode", color: "text-violet-400" },
};

function getProviderMeta(provider: string) {
  return (
    PROVIDER_META[provider] ?? {
      icon: Activity,
      label: provider || "Provider",
      color: "text-muted-foreground",
    }
  );
}

function SidebarThreadPreview({
  workspaceName,
  thread,
}: {
  workspaceName: string;
  thread: WorkspaceThread;
}) {
  const checkoutLabel = resolveThreadCheckoutLabel(thread);

  return (
    <div
      data-testid={`thread-preview-${thread.id}`}
      className="w-64 space-y-2 text-popover-foreground"
    >
      <div className="min-w-0 font-medium text-xs leading-5">
        {thread.title}
      </div>
      <div className="grid gap-1.5">
        <div
          aria-label={`Project, ${workspaceName}`}
          className="flex min-w-0 items-center gap-2"
        >
          <Folder size={13} aria-hidden className="shrink-0 opacity-75" />
          <span className="truncate text-xs">{workspaceName}</span>
        </div>
        <div
          aria-label={`Branch, ${checkoutLabel}`}
          className="flex min-w-0 items-center gap-2"
        >
          <GitBranch size={13} aria-hidden className="shrink-0 opacity-75" />
          <span className="truncate font-mono text-xs">{checkoutLabel}</span>
        </div>
      </div>
    </div>
  );
}

interface ThreadPrIndicatorProps {
  threadId: string;
  prNumber: number;
  prStatus: string | null;
  checks: ChecksStatus | undefined;
  showCi: boolean;
}

/** Renders an optically aligned PR glyph with its CI state attached as a status dot. */
const ThreadPrIndicator = memo(function ThreadPrIndicator({
  threadId,
  prNumber,
  prStatus,
  checks,
  showCi,
}: ThreadPrIndicatorProps) {
  const { Icon: PrIcon, color: prColor } = getPrVisual(prStatus);
  const ciVisual =
    showCi && checks && checks.aggregate !== "no_checks"
      ? getCiVisual(checks.aggregate)
      : null;
  const label = `PR #${prNumber}, ${prStatus ?? "open"}${ciVisual ? `. ${ciVisual.label}` : ""}`;

  return (
    <span
      title={label}
      aria-label={label}
      data-testid={`thread-pr-indicator-${threadId}`}
      className="absolute left-1.5 top-1/2 -mt-px flex h-4 w-4 -translate-y-1/2 items-center justify-center"
    >
      <span className="relative flex size-4 items-center justify-center">
        <PrIcon
          size={13}
          aria-hidden
          className={cn("shrink-0", prColor)}
        />
        {ciVisual ? (
          <span
            data-testid={`thread-pr-ci-${threadId}`}
            aria-hidden
            className={cn(
              "absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-current ring-1 ring-page",
              ciVisual.color,
              checks?.aggregate === "pending" && "status-pulse",
            )}
          />
        ) : null}
      </span>
    </span>
  );
});

/** Renders a virtualized, scrollable list of threads for a single workspace. */
function VirtualizedThreadList({
  workspaceName,
  treeItems: allTreeItems,
  maxVisible,
  activeThreadId,
  runningThreadIds,
  pendingPermissionThreadIds,
  checksById,
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

  // Cap to `maxVisible` so the sidebar isn't dominated by a single busy workspace.
  const treeItems = useMemo(
    () =>
      Number.isFinite(maxVisible)
        ? allTreeItems.slice(0, maxVisible)
        : allTreeItems,
    [allTreeItems, maxVisible],
  );

  // Normalized set of existing worktree paths for stale detection.
  const worktrees = useWorkspaceStore((s) => s.worktrees);
  const worktreesLoadedFor = useWorkspaceStore(
    (s) => s.worktreesLoadedForWorkspace,
  );
  // Subscribe once at the list level so we can derive unusable state per-thread
  // inside the map without violating Rules of Hooks.
  const availableProviders = useProviderAvailabilityStore((s) => s.providers);
  const validWorktreePaths = useMemo(() => {
    const set = new Set<string>();
    for (const wt of worktrees) {
      set.add(wt.path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase());
    }
    return set;
  }, [worktrees]);

  // Per-thread last-click timestamp. Used to detect a second click within the
  // double-click window without delaying the first click's navigation.
  const lastClickTimeRef = useRef<Map<string, number>>(new Map());

  const handleThreadClick = useCallback(
    (threadId: string, title: string) => {
      // If already editing this thread, clicks are absorbed to avoid conflicting with the input.
      if (inlineEdit?.threadId === threadId) return;

      const now = Date.now();
      const hadPrevious = lastClickTimeRef.current.has(threadId);
      const last = lastClickTimeRef.current.get(threadId) ?? 0;
      const elapsed = now - last;
      lastClickTimeRef.current.set(threadId, now);

      if (hadPrevious && elapsed < DOUBLE_CLICK_THRESHOLD_MS) {
        // Double-click: enter inline rename. The first click has already navigated,
        // which is fine — the row is now active and rename happens in place.
        lastClickTimeRef.current.delete(threadId);
        onStartInlineEdit(threadId, title);
      } else {
        // Single click navigates immediately. No artificial delay.
        onSelectThread(threadId);
      }
    },
    [inlineEdit, onSelectThread, onStartInlineEdit],
  );

  const handleThreadDoubleClick = useCallback(
    (threadId: string, title: string) => {
      if (inlineEdit?.threadId === threadId) return;
      lastClickTimeRef.current.delete(threadId);
      onStartInlineEdit(threadId, title);
    },
    [inlineEdit, onStartInlineEdit],
  );

  // Recompute offset from the outer scroll viewport after each layout pass.
  // Stays in sync when workspaces above expand/collapse.
  useLayoutEffect(() => {
    setScrollMargin((prev) => {
      const next = containerRef.current?.offsetTop ?? 0;
      return prev === next ? prev : next;
    });
  });

  const virtualizer = useVirtualizer({
    count: treeItems.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 32,
    overscan: 5,
    scrollMargin,
    // Opt out of react-virtual's flushSync(rerender) on sync measurement; it
    // fires inside the library's commit-phase layout effect and trips React's
    // "flushSync called from inside a lifecycle method" warning. The tree does
    // not need a synchronous re-render.
    useFlushSync: false,
  });

  return (
    <div
      ref={containerRef}
      style={{ height: virtualizer.getTotalSize(), position: "relative" }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const { thread, depth } = treeItems[virtualItem.index];
        const isRunning = runningThreadIds.has(thread.id);
        const hasPendingPermission = pendingPermissionThreadIds.has(thread.id);
        const checks = checksById[thread.id];
        const marker = getThreadStateMarker({
          thread,
          checks,
          isRunning,
          hasPendingPermission,
        });
        const isEditing = inlineEdit?.threadId === thread.id;
        // Only PR-able (worktree) threads surface PR affordances. A direct-mode
        // thread shows its branch/agent status, never a PR icon, even if a PR
        // number happens to be attached.
        const prable = isPrable(thread);
        const showPrCi = Boolean(
          prable &&
            thread.pr_number != null &&
            checks &&
            checks.aggregate !== "no_checks" &&
            marker.kind !== "action" &&
            marker.kind !== "running",
        );
        const showEndMarker = !showPrCi;
        // Worktree thread whose directory no longer exists on disk.
        // Only check threads from the workspace whose worktrees are loaded — comparing
        // against a different workspace's worktree list would produce false positives.
        const isStaleWorktree =
          worktreesLoadedFor === thread.workspace_id &&
          thread.mode === "worktree" &&
          !!thread.worktree_path &&
          !validWorktreePaths.has(
            thread.worktree_path
              .replace(/\\/g, "/")
              .replace(/\/$/, "")
              .toLowerCase(),
          );
        // Unusable when the provider is disabled or its CLI binary is missing.
        // "unchecked" is not treated as unusable — the server may not have verified yet.
        const providerRow = availableProviders.find(
          (p) => p.id === thread.provider,
        );
        const unusable = providerRow
          ? !providerRow.enabled || providerRow.cli.status === "not_found"
          : false;
        // Only compute a reason when the thread is actually unusable. A missing
        // providerRow means availability hasn't arrived yet — don't label those as "disabled".
        const unusableReason = !providerRow
          ? ""
          : !providerRow.enabled
            ? "Provider disabled"
            : "CLI not found";
        // Opacity on the row would compound onto status markers; dim only the title cluster and timestamp.
        const scaffoldDim =
          (thread.clientPreparing || thread.clientError) && "opacity-[0.72]";
        const providerMeta = getProviderMeta(thread.provider);
        const RowProviderIcon = providerMeta.icon;
        const row = (
          <div
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (isEditing) return;
              // Keyboard navigation fires immediately — no double-click semantics for keyboard users.
              // Enter/Space always navigates; rename must be triggered via mouse double-click.
              if (
                (e.key === "Enter" || e.key === " ") &&
                e.target === e.currentTarget
              ) {
                e.preventDefault();
                onSelectThread(thread.id);
              }
            }}
            onClick={() => handleThreadClick(thread.id, thread.title)}
            onDoubleClick={() =>
              handleThreadDoubleClick(thread.id, thread.title)
            }
            onContextMenu={(e) => onThreadContextMenu(e, thread)}
            onMouseEnter={() => {
              if (!thread.clientPreparing && !thread.clientError) {
                schedulePrefetch(thread.id);
              }
            }}
            onMouseLeave={cancelPrefetch}
            className={cn(
              "group/row relative flex min-h-8 items-center gap-2 rounded-md pr-2 text-[13px] cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
              activeThreadId === thread.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground/85 hover:bg-accent/40 hover:text-foreground",
            )}
            style={{ paddingLeft: `${42 + depth * 12}px` }}
          >
            {prable && thread.pr_number != null ? (
              <ThreadPrIndicator
                threadId={thread.id}
                prNumber={thread.pr_number}
                prStatus={thread.pr_status}
                checks={checks}
                showCi={showPrCi}
              />
            ) : null}
            <span
              aria-label={`Provider, ${providerMeta.label}`}
              className={cn(
                "absolute top-1/2 -mt-px flex h-4 w-4 -translate-y-1/2 items-center justify-center",
                providerMeta.color,
                scaffoldDim,
              )}
              style={{ left: `${22 + depth * 12}px` }}
            >
              <RowProviderIcon size={12} />
            </span>
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2",
                scaffoldDim,
              )}
            >
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
                <>
                  <span
                    className={cn(
                      "truncate flex-1",
                      isStaleWorktree &&
                        "text-[var(--diff-remove-strong)]/85 line-through",
                    )}
                    data-testid="thread-title"
                  >
                    {isStaleWorktree && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <AlertTriangle
                              size={11}
                              className="inline mr-1 align-text-bottom text-[var(--diff-remove-strong)]/80"
                            />
                          }
                        />
                        <TooltipContent side="right" className="text-xs">
                          Worktree directory no longer exists
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {thread.title}
                  </span>
                  {thread.mode === "worktree" && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <WorktreeModeIcon
                            size={12}
                            data-testid={`thread-worktree-indicator-${thread.id}`}
                            aria-label="Worktree mode"
                            className="text-muted-foreground/65"
                          />
                        }
                      />
                      <TooltipContent side="right" className="text-xs">
                        Worktree
                      </TooltipContent>
                    </Tooltip>
                  )}
                </>
              )}
              {!isEditing && unusable && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        data-testid={`sidebar-unusable-${thread.id}`}
                        className="ml-1 shrink-0 inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60"
                        aria-label={unusableReason}
                      />
                    }
                  />
                  <TooltipContent side="right" className="text-xs">
                    {unusableReason}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {!isEditing && showEndMarker && (
              <ThreadStateMarker marker={marker} dim={Boolean(scaffoldDim)} />
            )}
          </div>
        );
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
            {isEditing ? (
              row
            ) : (
              <Tooltip>
                <TooltipTrigger render={row} />
                <TooltipContent
                  side="right"
                  align="start"
                  sideOffset={8}
                  variant="surface"
                  className="max-w-none p-3"
                >
                  <SidebarThreadPreview
                    workspaceName={workspaceName}
                    thread={thread}
                  />
                </TooltipContent>
              </Tooltip>
            )}
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
  threads: WorkspaceThread[];
  runningThreadIds: Set<string>;
  /** Thread IDs with at least one unsettled permission request. */
  pendingPermissionThreadIds: Set<string>;
  /** Whether the thread list is fully expanded (persisted by parent). */
  isThreadListExpanded: boolean;
  /** Per-thread CI check status. Passed from parent to avoid duplicate store subscriptions. */
  checksById: Record<string, ChecksStatus>;
  /** Callback to toggle the thread list expanded state (persisted by parent). */
  onToggleThreadList: (wsId: string) => void;
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  inlineEdit: InlineEditState | null;
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  /** Start an inline rename for the given thread. */
  onStartInlineEdit: (threadId: string, title: string) => void;
  onToggle: (wsId: string) => void;
  onSelectThread: (wsId: string, threadId: string) => void;
  onCreateThread: (wsId: string) => void;
  onDelete: (wsId: string) => void;
  onRename: (workspace: Workspace) => void;
  onThreadContextMenu: (
    e: React.MouseEvent,
    thread: Thread,
    workspacePath: string,
  ) => void;
  /** When set, forwards drag-handle listeners from `@dnd-kit/sortable` onto the project row. */
  sortableListeners?: DraggableSyntheticListeners;
  /** True while this project row is the item being dragged. */
  isProjectDragging?: boolean;
}

/** Renders a collapsible workspace row with its virtualized thread list. */
const ProjectNode = memo(function ProjectNode({
  workspace,
  isExpanded,
  isActive,
  activeThreadId,
  threads,
  runningThreadIds,
  pendingPermissionThreadIds,
  isThreadListExpanded,
  checksById,
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
  onRename,
  onThreadContextMenu,
  sortableListeners,
  isProjectDragging = false,
}: ProjectNodeProps) {
  const hasRunning = useMemo(
    () => threads.some((t) => runningThreadIds.has(t.id)),
    [threads, runningThreadIds],
  );
  // Cap logic: show THREAD_LIST_CAP rows unless the user opted in, or the
  // active thread sits beyond the cap (force expand so the active row is
  // always visible without requiring the user to click Show more).
  // Use the flattened tree order (same order VirtualizedThreadList renders) for cap decisions.
  const treeItems = useMemo(() => buildThreadTree(threads), [threads]);
  const needsCap = treeItems.length > THREAD_LIST_CAP;
  const activeIndex = activeThreadId
    ? treeItems.findIndex((item) => item.thread.id === activeThreadId)
    : -1;
  const forceExpand = activeIndex >= THREAD_LIST_CAP;
  const maxVisible =
    !needsCap || isThreadListExpanded || forceExpand
      ? Infinity
      : THREAD_LIST_CAP;

  const wsId = workspace.id;
  const handleToggle = useCallback(() => onToggle(wsId), [onToggle, wsId]);
  const handleToggleThreadList = useCallback(
    () => onToggleThreadList(wsId),
    [onToggleThreadList, wsId],
  );
  const handleCreateThread = useCallback(
    () => onCreateThread(wsId),
    [onCreateThread, wsId],
  );
  const handleOpenProject = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      handleToggle();
    },
    [handleToggle],
  );
  const handleCreateThreadClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      handleCreateThread();
    },
    [handleCreateThread],
  );
  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(wsId);
    },
    [onDelete, wsId],
  );
  const handleRename = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onRename(workspace);
    },
    [onRename, workspace],
  );
  const handleOpenInExplorer = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      getTransport()
        .openIn(FILE_EXPLORER_ID, workspace.path)
        .catch((error: unknown) => {
          useToastStore
            .getState()
            .show(
              "error",
              "Couldn't open File Explorer",
              String((error as { message?: string })?.message ?? error),
            );
        });
    },
    [workspace.path],
  );
  const handleSelectThread = useCallback(
    (threadId: string) => onSelectThread(wsId, threadId),
    [onSelectThread, wsId],
  );
  const handleThreadContextMenu = useCallback(
    (e: React.MouseEvent, thread: Thread) =>
      onThreadContextMenu(e, thread, workspace.path),
    [onThreadContextMenu, workspace.path],
  );

  return (
    <div>
      {/* Workspace row keeps project controls quiet until the row is engaged. */}
      <div
        role="group"
        tabIndex={0}
        aria-label={`${workspace.name} project`}
        data-testid={`project-row-${workspace.id}`}
        onClick={handleToggle}
        className={cn(
          "group/ws relative flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          isProjectDragging && "cursor-grabbing",
          isActive
            ? "text-foreground"
            : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
        )}
        {...sortableListeners}
      >
        <button
          type="button"
          aria-label={`Open project ${workspace.name}`}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={handleOpenProject}
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <Folder
            size={14}
            className="shrink-0 text-muted-foreground/80"
            aria-hidden
          />
          <span className="truncate font-medium tracking-tight">
            {workspace.name}
          </span>
        </button>

        {!workspace.is_git_repo && (
          <Tooltip>
            <TooltipTrigger
              render={
                <GitBranchMinus
                  size={12}
                  strokeWidth={2}
                  className="shrink-0 text-muted-foreground/45"
                  aria-label="Not a git repository"
                />
              }
            />
            <TooltipContent side="right" className="text-xs">
              Not a git repository
            </TooltipContent>
          </Tooltip>
        )}

        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Toggle threads for ${workspace.name}`}
          aria-expanded={isExpanded}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            handleToggle();
          }}
          className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:bg-background/60 hover:text-foreground group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 focus:opacity-100"
        >
          <ChevronRight
            size={14}
            className={cn(
              "transition-transform duration-150 motion-reduce:transition-none",
              isExpanded && "rotate-90",
            )}
          />
        </Button>

        <span className="flex-1" />

        <WorkspaceCiRollupChip threads={threads} checksById={checksById} />

        {hasRunning && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-hidden="true"
                  className="shrink-0 h-1.5 w-1.5 rounded-full bg-primary status-pulse"
                />
              }
            />
            <TooltipContent side="right" className="text-xs">
              Active agent in this project
            </TooltipContent>
          </Tooltip>
        )}

        {threads.length > 0 && (
          <span className="shrink-0 font-mono text-[9.5px] leading-none tabular-nums text-muted-foreground/40">
            {threads.length}
          </span>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Project options for ${workspace.name}`}
            onClick={(event) => event.stopPropagation()}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-colors hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100"
          >
            <MoreHorizontal size={13} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
            <DropdownMenuItem
              onClick={handleOpenInExplorer}
              className="flex cursor-pointer items-center gap-2"
            >
              <FolderOpen size={13} />
              Open in Explorer
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleRename}
              className="flex cursor-pointer items-center gap-2"
            >
              <Pencil size={13} />
              Rename project
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleDelete}
              className="flex cursor-pointer items-center gap-2 text-destructive focus:text-destructive"
            >
              <Trash2 size={13} />
              Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`New thread in ${workspace.name}`}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={handleCreateThreadClick}
                className="rounded-md text-muted-foreground opacity-0 hover:bg-background/60 hover:text-foreground group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 focus:opacity-100"
              >
                <Plus size={15} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="right" className="text-xs">
            New thread
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Threads (when expanded) — indented, no guide rail. */}
      {isExpanded && threads.length > 0 && (
        <div>
          <VirtualizedThreadList
            workspaceName={workspace.name}
            treeItems={treeItems}
            maxVisible={maxVisible}
            activeThreadId={activeThreadId}
            runningThreadIds={runningThreadIds}
            pendingPermissionThreadIds={pendingPermissionThreadIds}
            checksById={checksById}
            scrollElementRef={scrollElementRef}
            inlineEdit={inlineEdit}
            onInlineEditChange={onInlineEditChange}
            onInlineEditCommit={onInlineEditCommit}
            onInlineEditCancel={onInlineEditCancel}
            onStartInlineEdit={onStartInlineEdit}
            onSelectThread={handleSelectThread}
            onThreadContextMenu={handleThreadContextMenu}
          />

          {needsCap && !forceExpand && (
            <Button
              variant="ghost"
              size="xs"
              onClick={handleToggleThreadList}
              className="mt-0.5 h-auto w-full justify-start rounded-md px-2 py-1 text-[11px] font-normal text-muted-foreground/55 hover:bg-accent/40 hover:text-foreground"
            >
              {isThreadListExpanded
                ? "Show less"
                : `Show more (${treeItems.length - THREAD_LIST_CAP})`}
            </Button>
          )}
        </div>
      )}
      {isExpanded && threads.length === 0 && (
        <p
          data-testid={`project-empty-${workspace.id}`}
          className="px-9 py-1 font-mono text-xs text-muted-foreground/70"
        >
          Empty
        </p>
      )}
    </div>
  );
});

/**
 * Wraps {@link ProjectNode} with `@dnd-kit/sortable` transforms and collapses
 * thread children while the user is dragging this project.
 */
const SortableProjectShell = memo(function SortableProjectShell(
  props: ProjectNodeProps & { sortableId: string; activeDragId: string | null },
) {
  const { sortableId, activeDragId, ...nodeProps } = props;
  const collapseForDrag = activeDragId !== null;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: sortableId,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { opacity: 0.92, zIndex: 2 } : {}),
  };
  // useSortable sets role/tabIndex on the activator; this outer div uses explicit group semantics.
  const { role, tabIndex, ...sortableA11y } = attributes;
  void role;
  void tabIndex;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="mb-1"
      {...sortableA11y}
      role="group"
      tabIndex={-1}
    >
      <ProjectNode
        {...nodeProps}
        isExpanded={nodeProps.isExpanded && !collapseForDrag}
        isProjectDragging={isDragging}
        sortableListeners={listeners}
      />
    </div>
  );
});
