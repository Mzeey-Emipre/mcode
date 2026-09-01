import {
  useEffect,
  useLayoutEffect,
  useCallback,
  useState,
  useRef,
  useMemo,
  memo,
  forwardRef,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ComponentType,
} from "react";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/shallow";
import { useWorkspaceStore } from "./state/workspaceStore";
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
  FolderCheck,
  FolderOpen,
  Activity,
  MoreHorizontal,
  Pencil,
  Plus,
  SquarePen,
  Circle,
  Check,
  RefreshCw,
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
  prefetchOnPointerDown,
} from "@/features/conversation";
import { isPrable } from "@/lib/is-prable";
import { getCiVisual, CI_ICON_STROKE } from "@/lib/ci-status";
import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import { FILE_EXPLORER_ID } from "@/lib/resolveDefaultOpenInApp";
import { getTransport } from "@/transport";
import { useToastStore } from "@/stores/toastStore";
import type { ChecksStatus } from "@mcode/contracts";
import type { Workspace, Thread } from "@/transport/types";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { getThreadStateMarker, ThreadStateMarker } from "@/components/sidebar/ThreadStateMarker";
import { useProjectAutomaticSetup } from "@/features/projects/environment";
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

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT"
    || target.tagName === "TEXTAREA"
    || target.tagName === "SELECT"
    || target.isContentEditable
    || target.closest('[contenteditable="true"]') !== null
    || target.getAttribute("role") === "textbox"
    || target.hasAttribute("aria-multiline");
}

function activeThreadForRename(
  event: KeyboardEvent,
  activeThreadId: string | null,
  inlineEdit: InlineEditState | null,
  threads: WorkspaceThread[],
): WorkspaceThread | undefined {
  if (event.key !== "F2" || !activeThreadId || inlineEdit) return undefined;
  if (isEditableKeyboardTarget(event.target)) return undefined;
  return threads.find((thread) => thread.id === activeThreadId);
}

function ThreadContextMenuOverlay({
  contextMenu,
  onClose,
  onStartRename,
  onDeleteThread,
}: {
  contextMenu: ContextMenuState | null;
  onClose: () => void;
  onStartRename: (state: InlineEditState) => void;
  onDeleteThread: (state: DeleteDialogState) => void;
}) {
  if (!contextMenu) return null;
  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      onClose={onClose}
      items={[
        {
          label: "Rename",
          onClick: () => onStartRename({
            threadId: contextMenu.threadId,
            title: contextMenu.threadTitle,
            originalTitle: contextMenu.threadTitle,
          }),
        },
        {
          label: "Copy Path",
          onClick: () => navigator.clipboard.writeText(
            contextMenu.worktreePath ?? contextMenu.workspacePath,
          ),
        },
        {
          label: "Copy Thread ID",
          onClick: () => navigator.clipboard.writeText(contextMenu.threadId),
        },
        { label: "", onClick: () => {}, divider: true },
        {
          label: "Delete",
          destructive: true,
          onClick: () => onDeleteThread({
            threadId: contextMenu.threadId,
            threadTitle: contextMenu.threadTitle,
            worktreePath: contextMenu.worktreePath,
          }),
        },
      ]}
    />
  );
}

function ThreadDeleteDialog({
  dialog,
  deleteWorktree,
  isDeleting,
  onDeleteWorktreeChange,
  onClose,
  onConfirm,
}: {
  dialog: DeleteDialogState | null;
  deleteWorktree: boolean;
  isDeleting: boolean;
  onDeleteWorktreeChange: (value: boolean) => void;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !isDeleting) onClose(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md overflow-hidden">
        <div className="flex flex-col gap-2">
          <DialogTitle>Delete thread</DialogTitle>
          <DialogDescription>Are you sure you want to delete &ldquo;{dialog?.threadTitle}&rdquo;? This action cannot be undone.</DialogDescription>
        </div>
        <ThreadDeleteWorktreeOption dialog={dialog} deleteWorktree={deleteWorktree} isDeleting={isDeleting} onChange={onDeleteWorktreeChange} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" className="cursor-pointer" disabled={isDeleting} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" className="cursor-pointer" disabled={isDeleting} onClick={onConfirm}>
            {isDeleting && <Spinner size={14} className="text-current" />}
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ThreadDeleteWorktreeOption({
  dialog,
  deleteWorktree,
  isDeleting,
  onChange,
}: {
  dialog: DeleteDialogState | null;
  deleteWorktree: boolean;
  isDeleting: boolean;
  onChange: (value: boolean) => void;
}) {
  if (!dialog?.worktreePath) return null;
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border p-3">
      <GitBranch size={14} className="shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Delete worktree</div>
        <div className="truncate text-xs text-muted-foreground">{dialog.worktreePath}</div>
      </div>
      <Switch checked={deleteWorktree} onCheckedChange={(checked) => { if (!isDeleting) onChange(checked); }} disabled={isDeleting} className="data-[checked]:bg-destructive" aria-label="Delete worktree" />
    </div>
  );
}

function useLoadExpandedWorkspaceThreads(
  workspaces: Workspace[],
  expanded: Record<string, boolean>,
  loadThreads: (workspaceId: string) => Promise<void>,
) {
  const didLoadExpandedRef = useRef(false);
  useEffect(() => {
    if (workspaces.length === 0 || didLoadExpandedRef.current) return;
    didLoadExpandedRef.current = true;
    for (const workspace of workspaces) {
      if (expanded[workspace.id]) loadThreads(workspace.id);
    }
  }, [workspaces, expanded, loadThreads]);
}

function useLoadActiveWorkspaceWorktrees(
  activeWorkspaceId: string | null,
  threads: WorkspaceThread[],
  worktreesLoadedForWorkspace: string | null,
  loadWorktrees: (workspaceId: string) => Promise<void>,
) {
  useEffect(() => {
    if (!shouldLoadActiveWorkspaceWorktrees(activeWorkspaceId, worktreesLoadedForWorkspace, threads)) return;
    loadWorktrees(activeWorkspaceId);
  }, [activeWorkspaceId, threads, worktreesLoadedForWorkspace, loadWorktrees]);
}

function shouldLoadActiveWorkspaceWorktrees(
  activeWorkspaceId: string | null,
  worktreesLoadedForWorkspace: string | null,
  threads: WorkspaceThread[],
): activeWorkspaceId is string {
  if (!activeWorkspaceId || worktreesLoadedForWorkspace === activeWorkspaceId) return false;
  return threads.some((thread) => thread.workspace_id === activeWorkspaceId && thread.mode === "worktree" && Boolean(thread.worktree_path));
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
  const completeThread = useWorkspaceStore((s) => s.completeThread);
  const reopenThread = useWorkspaceStore((s) => s.reopenThread);
  const retryThreadCleanup = useWorkspaceStore((s) => s.retryThreadCleanup);
  const beginNewThread = useWorkspaceStore((s) => s.beginNewThread);
  const setPrimarySurface = useUiStore((s) => s.setPrimarySurface);
  const updateThreadTitle = useWorkspaceStore((s) => s.updateThreadTitle);
  const reorderWorkspace = useWorkspaceStore((s) => s.reorderWorkspace);
  const error = useWorkspaceStore((s) => s.error);
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
  const lifecycleViews = useUiStore((s) => s.projectThreadViews);
  const toggleLifecycleView = useUiStore((s) => s.toggleProjectThreadView);
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

  useLoadExpandedWorkspaceThreads(workspaces, expanded, loadThreads);

  // Persist expanded state
  useEffect(() => {
    setExpandedState(expanded);
  }, [expanded]);

  // Persist thread-list expanded state
  useEffect(() => {
    setThreadListExpanded(threadListExpanded);
  }, [threadListExpanded]);

  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const pendingScrollTopRef = useRef<number | null>(null);

  const checksById = useWorkspaceStore(useShallow((s) => s.checksById));

  const toggleThreadList = useCallback((wsId: string) => {
    setThreadListExpandedState((prev) => ({ ...prev, [wsId]: !prev[wsId] }));
  }, []);
  useLoadActiveWorkspaceWorktrees(
    activeWorkspaceId,
    threads,
    worktreesLoadedForWorkspace,
    loadWorktrees,
  );

  // F2 shortcut: rename the active thread
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const thread = activeThreadForRename(event, activeThreadId, inlineEdit, threads);
      if (!thread) return;
      event.preventDefault();
      setInlineEdit({
        threadId: thread.id,
        title: thread.title,
        originalTitle: thread.title,
      });
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeThreadId, threads, inlineEdit]);

  const toggleExpand = useCallback(
    (wsId: string) => {
      pendingScrollTopRef.current = scrollViewportRef.current?.scrollTop ?? null;
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

  useLayoutEffect(() => {
    const previousScrollTop = pendingScrollTopRef.current;
    if (previousScrollTop === null) return;

    pendingScrollTopRef.current = null;
    if (scrollViewportRef.current) {
      scrollViewportRef.current.scrollTop = previousScrollTop;
    }
  }, [expanded]);

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
                    workspace={ws}
                    isExpanded={expanded[ws.id] ?? false}
                    isActive={activeWorkspaceId === ws.id}
                    threads={wsThreads}
                    lifecycleView={lifecycleViews[ws.id] ?? "active"}
                    onToggleLifecycleView={toggleLifecycleView}
                    onCompleteThread={completeThread}
                    onReopenThread={reopenThread}
                    onRetryThreadCleanup={retryThreadCleanup}
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

      <ThreadContextMenuOverlay
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
        onStartRename={setInlineEdit}
        onDeleteThread={(dialog) => {
          setDeleteDialog(dialog);
          setDeleteWorktree(false);
        }}
      />

      <ThreadDeleteDialog
        dialog={deleteDialog}
        deleteWorktree={deleteWorktree}
        isDeleting={isDeleting}
        onDeleteWorktreeChange={setDeleteWorktree}
        onClose={() => {
          setDeleteDialog(null);
          setDeleteWorktree(false);
        }}
        onConfirm={handleDeleteConfirm}
      />

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
  onCompleteThread: (threadId: string) => Promise<void>;
  onReopenThread: (threadId: string) => Promise<void>;
  onRetryThreadCleanup: (threadId: string) => Promise<void>;
}

interface ThreadRowProps {
  workspaceName: string;
  thread: WorkspaceThread;
  depth: number;
  hasPendingPermission: boolean;
  checks?: ChecksStatus;
  isEditing: boolean;
  inlineEdit: InlineEditState | null;
  worktreesLoadedFor: string | null;
  validWorktreePaths: Set<string>;
  availableProviders: Array<{
    id: string;
    enabled: boolean;
    cli: { status: string };
  }>;
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  onThreadClick: (threadId: string, title: string) => void;
  onThreadDoubleClick: (threadId: string, title: string) => void;
  onSelectThread: (id: string) => void;
  onThreadContextMenu: (e: React.MouseEvent, thread: Thread) => void;
  onCompleteThread: (threadId: string) => Promise<void>;
  onReopenThread: (threadId: string) => Promise<void>;
  onRetryThreadCleanup: (threadId: string) => Promise<void>;
}

/** Renders one sidebar thread row and subscribes only to its own active and running state. */
const ThreadRow = memo(function ThreadRow({
  workspaceName,
  thread,
  depth,
  hasPendingPermission,
  checks,
  isEditing,
  inlineEdit,
  worktreesLoadedFor,
  validWorktreePaths,
  availableProviders,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
  onThreadClick,
  onThreadDoubleClick,
  onSelectThread,
  onThreadContextMenu,
  onCompleteThread,
  onReopenThread,
  onRetryThreadCleanup,
}: ThreadRowProps) {
  const isActive = useWorkspaceStore((s) => s.activeThreadId === thread.id);
  const isRunning = useThreadStore((s) => s.runningThreadIds.has(thread.id));
  const automaticSetup = useProjectAutomaticSetup(
    thread.id,
    thread.mode === "worktree" && thread.worktree_managed === true,
  );
  const automaticSetupState = automaticSetup.snapshot.attempt?.state;
  const isSetupRunning = automaticSetup.snapshot.gate === "blocked"
    && (automaticSetupState === "queued" || automaticSetupState === "running");
  const isSetupAwaitingResponse = automaticSetup.snapshot.gate === "blocked"
    && (automaticSetupState === "failed" || automaticSetupState === "interrupted");
  const isSetupAwaitingApproval = automaticSetup.snapshot.gate === "blocked"
    && automaticSetupState === "awaiting-approval";
  const presentation = createThreadRowPresentation(
    thread,
    checks,
    isRunning,
    isSetupRunning,
    isSetupAwaitingResponse,
    hasPendingPermission,
    isSetupAwaitingApproval,
    worktreesLoadedFor,
    validWorktreePaths,
    availableProviders,
  );
  const lifecycle = useThreadLifecycleActions({
    thread,
    isEditing,
    isRunning,
    hasPendingPermission,
    isUserCompleted: presentation.isUserCompleted,
    cleanupBlocked: presentation.cleanupBlocked,
    onCompleteThread,
    onReopenThread,
    onRetryThreadCleanup,
  });
  return (
    <ThreadRowVisual
      {...{
        workspaceName,
        thread,
        depth,
        checks,
        isEditing,
        inlineEdit,
        onInlineEditChange,
        onInlineEditCommit,
        onInlineEditCancel,
        onThreadClick,
        onThreadDoubleClick,
        onSelectThread,
        onThreadContextMenu,
      }}
      isActive={isActive}
      presentation={presentation}
      lifecycle={lifecycle}
    />
  );
});

interface ThreadRowPresentation {
  marker: ReturnType<typeof getThreadStateMarker>;
  isRunning: boolean;
  showPrCi: boolean;
  isStaleWorktree: boolean;
  providerMeta: ReturnType<typeof getProviderMeta>;
  unusable: boolean;
  unusableReason: string;
  scaffoldDim: string | false | null;
  isUserCompleted: boolean;
  cleanupBlocked: boolean;
  showEndMarker: boolean;
}

interface ThreadRowLifecycleActions {
  isLifecyclePending: boolean;
  isCleanupRetryPending: boolean;
  cleanupStatusLabel: string | null;
  lifecycleUnavailable: boolean;
  handleLifecycleClick: (event: React.MouseEvent) => Promise<void>;
  handleCleanupRetry: (event: React.MouseEvent) => Promise<void>;
}

interface ThreadRowVisualProps {
  workspaceName: string;
  thread: WorkspaceThread;
  depth: number;
  checks: ChecksStatus | undefined;
  isEditing: boolean;
  inlineEdit: InlineEditState | null;
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  onThreadClick: (threadId: string, title: string) => void;
  onThreadDoubleClick: (threadId: string, title: string) => void;
  onSelectThread: (id: string) => void;
  onThreadContextMenu: (event: React.MouseEvent, thread: Thread) => void;
  isActive: boolean;
  presentation: ThreadRowPresentation;
  lifecycle: ThreadRowLifecycleActions;
}

function createThreadRowPresentation(
  thread: WorkspaceThread,
  checks: ChecksStatus | undefined,
  isRunning: boolean,
  isSetupRunning: boolean,
  isSetupAwaitingResponse: boolean,
  hasPendingPermission: boolean,
  isSetupAwaitingApproval: boolean,
  worktreesLoadedFor: string | null,
  validWorktreePaths: Set<string>,
  availableProviders: ThreadRowProps["availableProviders"],
): ThreadRowPresentation {
  const marker = getThreadStateMarker({
    thread,
    checks,
    isRunning,
    isSetupRunning,
    isSetupAwaitingResponse,
    hasPendingPermission: hasPendingPermission || isSetupAwaitingApproval,
  });
  const showPrCi = shouldShowThreadPrCi(thread, checks, marker);
  const isUserCompleted = thread.user_completed_at !== null;
  return {
    marker,
    isRunning,
    showPrCi,
    isStaleWorktree: hasStaleThreadWorktree(thread, worktreesLoadedFor, validWorktreePaths),
    ...threadProviderPresentation(thread.provider, availableProviders),
    scaffoldDim: thread.clientPreparing || thread.clientError ? "opacity-[0.72]" : false,
    isUserCompleted,
    cleanupBlocked: isUserCompleted && thread.cleanup_state === "blocked",
    showEndMarker: marker.kind !== "time" && (!showPrCi || marker.kind !== "ci"),
  };
}

function shouldShowThreadPrCi(
  thread: WorkspaceThread,
  checks: ChecksStatus | undefined,
  marker: ReturnType<typeof getThreadStateMarker>,
): boolean {
  return isPrable(thread)
    && thread.pr_number !== null
    && checks !== undefined
    && checks.aggregate !== "no_checks"
    && marker.kind !== "action"
    && marker.kind !== "setup"
    && marker.kind !== "running";
}

function hasStaleThreadWorktree(
  thread: WorkspaceThread,
  worktreesLoadedFor: string | null,
  validWorktreePaths: Set<string>,
): boolean {
  if (worktreesLoadedFor !== thread.workspace_id || thread.mode !== "worktree") return false;
  if (!thread.worktree_path) return false;
  const path = thread.worktree_path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return !validWorktreePaths.has(path);
}

function threadProviderPresentation(
  provider: string,
  availableProviders: ThreadRowProps["availableProviders"],
): Pick<ThreadRowPresentation, "providerMeta" | "unusable" | "unusableReason"> {
  const providerRow = availableProviders.find((candidate) => candidate.id === provider);
  if (!providerRow) {
    return { providerMeta: getProviderMeta(provider), unusable: false, unusableReason: "" };
  }
  const unusable = !providerRow.enabled || providerRow.cli.status === "not_found";
  const unusableReason = providerRow.enabled ? "CLI not found" : "Provider disabled";
  return { providerMeta: getProviderMeta(provider), unusable, unusableReason };
}

function useThreadLifecycleActions({
  thread,
  isEditing,
  isRunning,
  hasPendingPermission,
  isUserCompleted,
  cleanupBlocked,
  onCompleteThread,
  onReopenThread,
  onRetryThreadCleanup,
}: Pick<ThreadRowProps, "thread" | "isEditing" | "hasPendingPermission" | "onCompleteThread" | "onReopenThread" | "onRetryThreadCleanup"> & {
  isRunning: boolean;
  isUserCompleted: boolean;
  cleanupBlocked: boolean;
}): ThreadRowLifecycleActions {
  const [isLifecyclePending, setIsLifecyclePending] = useState(false);
  const [isCleanupRetryPending, setIsCleanupRetryPending] = useState(false);
  const [cleanupRetryError, setCleanupRetryError] = useState<string | null>(null);
  const lifecycleUnavailable = isLifecyclePending
    || isEditing
    || isRunning
    || hasPendingPermission
    || Boolean(thread.clientPreparing || thread.clientError);
  const handleLifecycleClick = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (lifecycleUnavailable) return;
    setIsLifecyclePending(true);
    try {
      const updateLifecycle = isUserCompleted ? onReopenThread : onCompleteThread;
      await updateLifecycle(thread.id);
    } finally {
      setIsLifecyclePending(false);
    }
  }, [isUserCompleted, lifecycleUnavailable, onCompleteThread, onReopenThread, thread.id]);
  const handleCleanupRetry = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!cleanupBlocked || isCleanupRetryPending) return;
    setCleanupRetryError(null);
    setIsCleanupRetryPending(true);
    try {
      await onRetryThreadCleanup(thread.id);
    } catch (cause: unknown) {
      setCleanupRetryError(String(cause));
    } finally {
      setIsCleanupRetryPending(false);
    }
  }, [cleanupBlocked, isCleanupRetryPending, onRetryThreadCleanup, thread.id]);
  return {
    isLifecyclePending,
    isCleanupRetryPending,
    cleanupStatusLabel: cleanupStatusLabel(cleanupRetryError, thread.cleanup_state),
    lifecycleUnavailable,
    handleLifecycleClick,
    handleCleanupRetry,
  };
}

function cleanupStatusLabel(retryError: string | null, cleanupState: WorkspaceThread["cleanup_state"]): string | null {
  if (retryError) return `Cleanup retry failed: ${retryError}`;
  if (cleanupState === "queued") return "Cleanup queued";
  if (cleanupState === "retrying") return "Retrying cleanup";
  return null;
}

function ThreadRowVisual({
  workspaceName,
  thread,
  depth,
  checks,
  isEditing,
  inlineEdit,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
  onThreadClick,
  onThreadDoubleClick,
  onSelectThread,
  onThreadContextMenu,
  isActive,
  presentation,
  lifecycle,
}: ThreadRowVisualProps) {
  const row = (
    <ThreadRowSurface
      thread={thread}
      depth={depth}
      isActive={isActive}
      isEditing={isEditing}
      onThreadClick={onThreadClick}
      onThreadDoubleClick={onThreadDoubleClick}
      onSelectThread={onSelectThread}
      onThreadContextMenu={onThreadContextMenu}
    >
      <ThreadRowLeading thread={thread} depth={depth} presentation={presentation} lifecycle={lifecycle} />
      <ThreadRowContent
        thread={thread}
        isEditing={isEditing}
        inlineEdit={inlineEdit}
        presentation={presentation}
        cleanupStatusLabel={lifecycle.cleanupStatusLabel}
        onInlineEditChange={onInlineEditChange}
        onInlineEditCommit={onInlineEditCommit}
        onInlineEditCancel={onInlineEditCancel}
      />
      <ThreadCleanupRetry thread={thread} isEditing={isEditing} cleanupBlocked={presentation.cleanupBlocked} lifecycle={lifecycle} />
      <ThreadPrStatus thread={thread} checks={checks} isEditing={isEditing} presentation={presentation} />
      <ThreadEndMarker isEditing={isEditing} presentation={presentation} />
    </ThreadRowSurface>
  );
  return <ThreadRowPreview isEditing={isEditing} row={row} workspaceName={workspaceName} thread={thread} />;
}

type ThreadRowSurfaceProps = Pick<
  ThreadRowVisualProps,
  "thread" | "depth" | "isActive" | "isEditing" | "onThreadClick" | "onThreadDoubleClick" | "onSelectThread" | "onThreadContextMenu"
> & ComponentPropsWithoutRef<"div"> & { children: React.ReactNode };

const ThreadRowSurface = forwardRef<HTMLDivElement, ThreadRowSurfaceProps>(function ThreadRowSurface({
  thread,
  depth,
  isActive,
  isEditing,
  onThreadClick,
  onThreadDoubleClick,
  onSelectThread,
  onThreadContextMenu,
  children,
  className: triggerClassName,
  onMouseEnter: onTriggerMouseEnter,
  onMouseLeave: onTriggerMouseLeave,
  ...triggerProps
}, ref) {
  return (
    <div
      {...triggerProps}
      ref={ref}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => handleThreadRowKeyDown(event, isEditing, onSelectThread, thread.id)}
      onClick={() => onThreadClick(thread.id, thread.title)}
      onPointerDown={(event) => prefetchThreadRowOnPointerDown(event, isEditing, thread)}
      onDoubleClick={() => onThreadDoubleClick(thread.id, thread.title)}
      onContextMenu={(event) => onThreadContextMenu(event, thread)}
      onMouseEnter={(event) => {
        scheduleThreadRowPrefetch(thread);
        onTriggerMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        cancelPrefetch();
        onTriggerMouseLeave?.(event);
      }}
      className={cn(
        "group/row relative flex min-h-8 items-center gap-2 rounded-md pr-2 text-[13px] cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        isActive ? "bg-accent text-foreground" : "text-muted-foreground/85 hover:bg-accent/40 hover:text-foreground",
        triggerClassName,
      )}
      style={{ paddingLeft: `${46 + depth * 12}px` }}
    >
      {children}
    </div>
  );
});

function handleThreadRowKeyDown(
  event: React.KeyboardEvent,
  isEditing: boolean,
  onSelectThread: (id: string) => void,
  threadId: string,
) {
  if (isEditing || !isThreadRowNavigationEvent(event)) return;
  event.preventDefault();
  onSelectThread(threadId);
}

function isThreadRowNavigationEvent(event: React.KeyboardEvent): boolean {
  return (event.key === "Enter" || event.key === " ") && event.target === event.currentTarget;
}

function prefetchThreadRowOnPointerDown(
  event: React.PointerEvent,
  isEditing: boolean,
  thread: WorkspaceThread,
) {
  if (event.button !== 0 || isEditing || thread.clientPreparing || thread.clientError) return;
  prefetchOnPointerDown(thread.id);
}

function scheduleThreadRowPrefetch(thread: WorkspaceThread) {
  if (thread.clientPreparing || thread.clientError) return;
  schedulePrefetch(thread.id);
}

function ThreadRowLeading({
  thread,
  depth,
  presentation,
  lifecycle,
}: Pick<ThreadRowVisualProps, "thread" | "depth" | "presentation" | "lifecycle">) {
  const ProviderIcon = presentation.providerMeta.icon;
  return (
    <span className="absolute left-0.5 top-1/2 flex -translate-y-1/2 items-center justify-end gap-1" style={{ width: `${40 + depth * 12}px` }}>
      <ThreadLifecycleButton thread={thread} isRunning={presentation.isRunning} presentation={presentation} lifecycle={lifecycle} />
      <span
        aria-label={`Provider, ${presentation.providerMeta.label}`}
        className={cn(
          "-mt-px flex h-4 w-4 items-center justify-center",
          presentation.providerMeta.color,
          presentation.scaffoldDim,
          presentation.isUserCompleted && "grayscale opacity-45",
        )}
      >
        <ProviderIcon size={12} />
      </span>
    </span>
  );
}

function ThreadLifecycleButton({
  thread,
  isRunning,
  presentation,
  lifecycle,
}: Pick<ThreadRowVisualProps, "thread" | "presentation" | "lifecycle"> & { isRunning: boolean }) {
  const actionLabel = presentation.isUserCompleted ? `Reopen ${thread.title}` : `Complete ${thread.title}`;
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={actionLabel}
          disabled={lifecycle.lifecycleUnavailable}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={lifecycle.handleLifecycleClick}
          className={cn(
            "size-5 shrink-0 rounded-full p-0 text-muted-foreground/65 opacity-0 transition-opacity shadow-none hover:bg-transparent hover:text-foreground group-hover/row:opacity-100 group-focus-visible/row:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed",
            isRunning && "disabled:opacity-0 group-hover/row:disabled:opacity-100 group-focus-visible/row:disabled:opacity-100",
          )}
        >
          <ThreadLifecycleIcon isPending={lifecycle.isLifecyclePending} isCompleted={presentation.isUserCompleted} />
        </Button>
      } />
      <TooltipContent side="right" className="text-xs">
        {presentation.isUserCompleted ? "Undo completion" : "Complete thread"}
      </TooltipContent>
    </Tooltip>
  );
}

function ThreadLifecycleIcon({ isPending, isCompleted }: { isPending: boolean; isCompleted: boolean }) {
  if (isPending) return <Spinner size={11} />;
  if (isCompleted) return <Check size={13} strokeWidth={2.5} aria-hidden />;
  return <Circle size={13} strokeWidth={1.8} aria-hidden />;
}

function ThreadRowContent({
  thread,
  isEditing,
  inlineEdit,
  presentation,
  cleanupStatusLabel: statusLabel,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
}: Pick<ThreadRowVisualProps, "thread" | "isEditing" | "inlineEdit" | "presentation" | "onInlineEditChange" | "onInlineEditCommit" | "onInlineEditCancel"> & { cleanupStatusLabel: string | null }) {
  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-2", presentation.scaffoldDim)}>
      {isEditing ? (
        <Input
          type="text"
          size="xs"
          value={inlineEdit?.title ?? ""}
          onChange={(event) => onInlineEditChange(event.target.value)}
          onKeyDown={(event) => handleInlineEditKeyDown(event, onInlineEditCommit, onInlineEditCancel)}
          onBlur={onInlineEditCommit}
          autoFocus
          onClick={(event) => event.stopPropagation()}
          className="flex-1 border-ring"
        />
      ) : (
        <ThreadRowTitle thread={thread} presentation={presentation} />
      )}
      <ThreadProviderUnavailable thread={thread} isEditing={isEditing} presentation={presentation} />
      <ThreadCleanupStatus isEditing={isEditing} statusLabel={statusLabel} />
    </div>
  );
}

function handleInlineEditKeyDown(
  event: React.KeyboardEvent<HTMLInputElement>,
  onCommit: () => void,
  onCancel: () => void,
) {
  if (!event.nativeEvent.isComposing && event.key === "Enter") onCommit();
  if (!event.nativeEvent.isComposing && event.key === "Escape") onCancel();
  event.stopPropagation();
}

function ThreadRowTitle({ thread, presentation }: Pick<ThreadRowVisualProps, "thread" | "presentation">) {
  return (
    <>
      <span
        className={cn(
          "truncate flex-1",
          presentation.isUserCompleted && "text-muted-foreground/55 line-through decoration-muted-foreground/55 decoration-1",
          presentation.isStaleWorktree && "text-[var(--diff-remove-strong)]/85 line-through",
        )}
        data-testid="thread-title"
      >
        <StaleWorktreeWarning isStale={presentation.isStaleWorktree} />
        {thread.title}
      </span>
      <ThreadWorktreeIndicator thread={thread} />
    </>
  );
}

function StaleWorktreeWarning({ isStale }: { isStale: boolean }) {
  if (!isStale) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<AlertTriangle size={11} className="inline mr-1 align-text-bottom text-[var(--diff-remove-strong)]/80" />} />
      <TooltipContent side="right" className="text-xs">Worktree directory no longer exists</TooltipContent>
    </Tooltip>
  );
}

function ThreadWorktreeIndicator({ thread }: { thread: WorkspaceThread }) {
  if (thread.mode !== "worktree") return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<WorktreeModeIcon size={12} data-testid={`thread-worktree-indicator-${thread.id}`} aria-label="Worktree mode" className="text-muted-foreground/65" />} />
      <TooltipContent side="right" className="text-xs">Worktree</TooltipContent>
    </Tooltip>
  );
}

function ThreadProviderUnavailable({
  thread,
  isEditing,
  presentation,
}: Pick<ThreadRowVisualProps, "thread" | "isEditing" | "presentation">) {
  if (isEditing || !presentation.unusable) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span data-testid={`sidebar-unusable-${thread.id}`} className="ml-1 shrink-0 inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60" aria-label={presentation.unusableReason} />} />
      <TooltipContent side="right" className="text-xs">{presentation.unusableReason}</TooltipContent>
    </Tooltip>
  );
}

function ThreadCleanupStatus({ isEditing, statusLabel }: { isEditing: boolean; statusLabel: string | null }) {
  if (isEditing || !statusLabel) return null;
  return <span role="status" className="shrink-0 truncate text-xs text-muted-foreground">{statusLabel}</span>;
}

function ThreadCleanupRetry({
  thread,
  isEditing,
  cleanupBlocked,
  lifecycle,
}: Pick<ThreadRowVisualProps, "thread" | "isEditing" | "lifecycle"> & { cleanupBlocked: boolean }) {
  if (isEditing || !cleanupBlocked) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Retry cleanup for ${thread.title}`}
          disabled={lifecycle.isCleanupRetryPending}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={lifecycle.handleCleanupRetry}
          className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:bg-transparent hover:text-foreground group-hover/row:opacity-100 group-focus-visible/row:opacity-100 focus-visible:opacity-100"
        >
          {lifecycle.isCleanupRetryPending ? <Spinner size={12} /> : <RefreshCw size={13} aria-hidden />}
        </Button>
      } />
      <TooltipContent side="right" className="text-xs">Retry cleanup</TooltipContent>
    </Tooltip>
  );
}

function ThreadPrStatus({
  thread,
  checks,
  isEditing,
  presentation,
}: Pick<ThreadRowVisualProps, "thread" | "checks" | "isEditing" | "presentation">) {
  if (isEditing || !isPrable(thread) || thread.pr_number === null) return null;
  return <ThreadPrIndicator threadId={thread.id} prNumber={thread.pr_number} prStatus={thread.pr_status} checks={checks} showCi={presentation.showPrCi} muted={presentation.isUserCompleted} />;
}

function ThreadEndMarker({ isEditing, presentation }: Pick<ThreadRowVisualProps, "isEditing" | "presentation">) {
  if (isEditing || !presentation.showEndMarker) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center", presentation.isUserCompleted && "grayscale opacity-45")}>
      <ThreadStateMarker marker={presentation.marker} dim={Boolean(presentation.scaffoldDim)} />
    </span>
  );
}

function ThreadRowPreview({
  isEditing,
  row,
  workspaceName,
  thread,
}: { isEditing: boolean; row: React.ReactElement; workspaceName: string; thread: WorkspaceThread }) {
  if (isEditing) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent side="right" align="start" sideOffset={8} variant="surface" className="max-w-none p-3">
        <SidebarThreadPreview workspaceName={workspaceName} thread={thread} />
      </TooltipContent>
    </Tooltip>
  );
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
  const rollup = workspaceCiRollup(threads, checksById);
  if (!rollup) return null;
  const { icon: Icon, chromeClass } = getCiVisual(rollup.aggregate);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={rollup.label}
            className={cn(
              "shrink-0 inline-flex items-center gap-0.5 px-1 h-4 rounded-[3px] border transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none",
              "text-[10px] font-medium tabular-nums leading-none",
              chromeClass,
            )}
          >
            {rollup.aggregate === "pending" ? (
              <Spinner size={9} className="text-current" />
            ) : (
              <Icon size={9} strokeWidth={CI_ICON_STROKE} className="shrink-0" />
            )}
            <span>{rollup.count}</span>
          </span>
        }
      />
      <TooltipContent>{rollup.label}</TooltipContent>
    </Tooltip>
  );
});

function workspaceCiRollup(
  threads: WorkspaceThread[],
  checksById: Record<string, ChecksStatus>,
): { aggregate: "failing" | "pending"; count: number; label: string } | null {
  let failingCount = 0;
  let pendingCount = 0;
  for (const thread of threads) {
    const checks = checksById[thread.id];
    if (!checks || checks.aggregate === "no_checks") continue;
    if (checks.aggregate === "failing") failingCount += 1;
    if (checks.aggregate === "pending") pendingCount += 1;
  }
  if (failingCount > 0) return ciRollupStatus("failing", failingCount);
  if (pendingCount > 0) return ciRollupStatus("pending", pendingCount);
  return null;
}

function ciRollupStatus(
  aggregate: "failing" | "pending",
  count: number,
): { aggregate: "failing" | "pending"; count: number; label: string } {
  const noun = count === 1 ? "thread" : "threads";
  const label = aggregate === "failing"
    ? `${count} ${noun} failing`
    : `${count} ${noun} with checks running`;
  return { aggregate, count, label };
}

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
        <div className="text-xs text-muted-foreground">
          Updated {formatLifecycleDate(thread.updated_at)}
        </div>
        {thread.user_completed_at !== null ? (
          <>
            <div className="text-xs text-muted-foreground">
              Completed {formatLifecycleDate(thread.user_completed_at)}
            </div>
            {thread.cleanup_state === "blocked" ? (
              <div className="text-xs text-destructive" role="status">
                Cleanup blocked: {thread.cleanup_reason ?? "User action is required."}
              </div>
            ) : thread.cleanup_state === "queued" ? (
              <div className="text-xs text-muted-foreground" role="status">
                Cleanup queued
              </div>
            ) : thread.cleanup_state === "retrying" ? (
              <div className="text-xs text-muted-foreground" role="status">
                Retrying cleanup
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {thread.scheduled_deletion_at
                  ? `Deletes ${formatLifecycleDate(thread.scheduled_deletion_at)}`
                  : "Automatic deletion disabled"}
              </div>
            )}
          </>
        ) : null}
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
  muted?: boolean;
}

function formatLifecycleDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function threadCountLabel(
  count: number,
  state: "active" | "completed",
): string {
  return `${count} ${state} ${count === 1 ? "thread" : "threads"}`;
}

/** Renders an optically aligned PR glyph with its CI state attached as a status dot. */
const ThreadPrIndicator = memo(function ThreadPrIndicator({
  threadId,
  prNumber,
  prStatus,
  checks,
  showCi,
  muted = false,
}: ThreadPrIndicatorProps) {
  const { Icon: PrIcon, color: prColor } = getPrVisual(prStatus);
  const ciVisual = threadPrCiVisual(showCi, checks);
  const label = `PR #${prNumber}, ${prStatus ?? "open"}${ciVisual ? `. ${ciVisual.label}` : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            data-testid={`thread-pr-indicator-${threadId}`}
            className={cn(
              "-mt-px flex h-4 w-4 items-center justify-center",
              muted && "grayscale opacity-45",
            )}
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
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});

function threadPrCiVisual(showCi: boolean, checks: ChecksStatus | undefined) {
  if (!showCi || !checks || checks.aggregate === "no_checks") return null;
  return getCiVisual(checks.aggregate);
}

/** Renders a virtualized, scrollable list of threads for a single workspace. */
function VirtualizedThreadList({
  workspaceName,
  treeItems: allTreeItems,
  maxVisible,
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
  onCompleteThread,
  onReopenThread,
  onRetryThreadCleanup,
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
  }, [allTreeItems, maxVisible, scrollElementRef]);

  const virtualizer = useVirtualizer({
    count: treeItems.length,
    getItemKey: (index) => treeItems[index].thread.id,
    getScrollElement: () => scrollElementRef.current,
    initialOffset: () => scrollElementRef.current?.scrollTop ?? 0,
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
        const isEditing = inlineEdit?.threadId === thread.id;
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
            <ThreadRow
              workspaceName={workspaceName}
              thread={thread}
              depth={depth}
              hasPendingPermission={pendingPermissionThreadIds.has(thread.id)}
              checks={checksById[thread.id]}
              isEditing={isEditing}
              inlineEdit={isEditing ? inlineEdit : null}
              worktreesLoadedFor={worktreesLoadedFor}
              validWorktreePaths={validWorktreePaths}
              availableProviders={availableProviders}
              onInlineEditChange={onInlineEditChange}
              onInlineEditCommit={onInlineEditCommit}
              onInlineEditCancel={onInlineEditCancel}
              onThreadClick={handleThreadClick}
              onThreadDoubleClick={handleThreadDoubleClick}
              onSelectThread={onSelectThread}
              onThreadContextMenu={onThreadContextMenu}
              onCompleteThread={onCompleteThread}
              onReopenThread={onReopenThread}
              onRetryThreadCleanup={onRetryThreadCleanup}
            />
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
  threads: WorkspaceThread[];
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
  lifecycleView: "active" | "completed";
  onToggleLifecycleView: (workspaceId: string) => void;
  onCompleteThread: (threadId: string) => Promise<void>;
  onReopenThread: (threadId: string) => Promise<void>;
  onRetryThreadCleanup: (threadId: string) => Promise<void>;
}

/** Renders a collapsible workspace row with its virtualized thread list. */
const ProjectNode = memo(function ProjectNode({
  workspace,
  isExpanded,
  isActive,
  threads,
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
  lifecycleView,
  onToggleLifecycleView,
  onCompleteThread,
  onReopenThread,
  onRetryThreadCleanup,
}: ProjectNodeProps) {
  const hasRunning = useThreadStore((s) =>
    threads.some((thread) => s.runningThreadIds.has(thread.id)),
  );
  const threadList = useProjectNodeThreadList(
    threads,
    lifecycleView,
    isThreadListExpanded,
  );

  return (
    <div>
      <ProjectWorkspaceRow
        {...{
          workspace,
          isExpanded,
          isActive,
          isProjectDragging,
          sortableListeners,
          lifecycleView,
          checksById,
          hasRunning,
          onToggle,
          onToggleLifecycleView,
          onCreateThread,
          onDelete,
          onRename,
        }}
        threadList={threadList}
      />
      <ProjectThreadSection
        {...{
          workspace,
          isExpanded,
          isThreadListExpanded,
          pendingPermissionThreadIds,
          checksById,
          scrollElementRef,
          inlineEdit,
          onInlineEditChange,
          onInlineEditCommit,
          onInlineEditCancel,
          onStartInlineEdit,
          onToggleThreadList,
          onSelectThread,
          onThreadContextMenu,
          onCompleteThread,
          onReopenThread,
          onRetryThreadCleanup,
          lifecycleView,
        }}
        threadList={threadList}
      />
    </div>
  );
});

interface ProjectNodeThreadList {
  activeThreadCount: number;
  completedThreadCount: number;
  visibleThreads: WorkspaceThread[];
  treeItems: ThreadTreeItem[];
  needsCap: boolean;
  forceExpand: boolean;
  maxVisible: number;
}

function useProjectNodeThreadList(
  threads: WorkspaceThread[],
  lifecycleView: ProjectNodeProps["lifecycleView"],
  isThreadListExpanded: boolean,
): ProjectNodeThreadList {
  const activeThreadCount = useMemo(
    () => threads.filter((thread) => thread.user_completed_at === null).length,
    [threads],
  );
  const visibleThreads = useMemo(
    () => threads.filter((thread) => isVisibleInLifecycleView(thread, lifecycleView)),
    [lifecycleView, threads],
  );
  const treeItems = useMemo(() => buildThreadTree(visibleThreads), [visibleThreads]);
  const forceExpand = useWorkspaceStore((state) => activeThreadNeedsExpansion(
    state.activeThreadId,
    treeItems,
  ));
  const needsCap = treeItems.length > THREAD_LIST_CAP;
  return {
    activeThreadCount,
    completedThreadCount: threads.length - activeThreadCount,
    visibleThreads,
    treeItems,
    needsCap,
    forceExpand,
    maxVisible: !needsCap || isThreadListExpanded || forceExpand ? Infinity : THREAD_LIST_CAP,
  };
}

function isVisibleInLifecycleView(
  thread: WorkspaceThread,
  lifecycleView: ProjectNodeProps["lifecycleView"],
): boolean {
  return lifecycleView === "completed"
    ? thread.user_completed_at !== null
    : thread.user_completed_at === null;
}

function activeThreadNeedsExpansion(
  activeThreadId: string | null,
  treeItems: ThreadTreeItem[],
): boolean {
  if (!activeThreadId) return false;
  return treeItems.findIndex((item) => item.thread.id === activeThreadId) >= THREAD_LIST_CAP;
}

interface ProjectWorkspaceRowProps {
  workspace: Workspace;
  isExpanded: boolean;
  isActive: boolean;
  isProjectDragging: boolean;
  sortableListeners: DraggableSyntheticListeners | undefined;
  lifecycleView: ProjectNodeProps["lifecycleView"];
  checksById: Record<string, ChecksStatus>;
  hasRunning: boolean;
  threadList: ProjectNodeThreadList;
  onToggle: ProjectNodeProps["onToggle"];
  onToggleLifecycleView: ProjectNodeProps["onToggleLifecycleView"];
  onCreateThread: ProjectNodeProps["onCreateThread"];
  onDelete: ProjectNodeProps["onDelete"];
  onRename: ProjectNodeProps["onRename"];
}

function ProjectWorkspaceRow({
  workspace,
  isExpanded,
  isActive,
  isProjectDragging,
  sortableListeners,
  lifecycleView,
  checksById,
  hasRunning,
  threadList,
  onToggle,
  onToggleLifecycleView,
  onCreateThread,
  onDelete,
  onRename,
}: ProjectWorkspaceRowProps) {
  const lifecycle = projectLifecycleSummary(workspace, lifecycleView, threadList);
  const toggle = useCallback(() => onToggle(workspace.id), [onToggle, workspace.id]);
  const selectLifecycleView = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onToggleLifecycleView(workspace.id);
  }, [onToggleLifecycleView, workspace.id]);
  const createThread = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onCreateThread(workspace.id);
  }, [onCreateThread, workspace.id]);
  const deleteProject = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onDelete(workspace.id);
  }, [onDelete, workspace.id]);
  const renameProject = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onRename(workspace);
  }, [onRename, workspace]);
  const openInExplorer = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    void getTransport().openIn(FILE_EXPLORER_ID, workspace.path).catch((error: unknown) => {
      useToastStore.getState().show(
        "error",
        "Couldn't open File Explorer",
        String((error as { message?: string })?.message ?? error),
      );
    });
  }, [workspace.path]);
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={lifecycle.projectLabel}
      data-testid={`project-row-${workspace.id}`}
      onClick={toggle}
      className={cn(
        "group/ws relative flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        isProjectDragging && "cursor-grabbing",
        isActive ? "text-foreground" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
      {...sortableListeners}
    >
      <ProjectLifecycleToggle lifecycle={lifecycle} lifecycleView={lifecycleView} onClick={selectLifecycleView} />
      <ProjectTitle workspace={workspace} onClick={toggle} />
      <ProjectGitStatus isGitRepository={workspace.is_git_repo} />
      <WorkspaceCiRollupChip threads={threadList.visibleThreads} checksById={checksById} />
      <ProjectRunningStatus hasRunning={hasRunning} />
      <ProjectThreadCount workspaceId={workspace.id} count={threadList.visibleThreads.length} />
      <ProjectRowActions
        workspace={workspace}
        isExpanded={isExpanded}
        onToggle={toggle}
        onOpenInExplorer={openInExplorer}
        onRename={renameProject}
        onDelete={deleteProject}
        onCreateThread={createThread}
      />
    </div>
  );
}

function projectLifecycleSummary(
  workspace: Workspace,
  lifecycleView: ProjectNodeProps["lifecycleView"],
  threadList: ProjectNodeThreadList,
) {
  const destination = lifecycleView === "active" ? "completed" : "active";
  const destinationCount = destination === "completed"
    ? threadList.completedThreadCount
    : threadList.activeThreadCount;
  return {
    label: `View ${threadCountLabel(destinationCount, destination)} for ${workspace.name}`,
    projectLabel: `${workspace.name} project, ${lifecycleView} view, ${threadCountLabel(threadList.activeThreadCount, "active")}, ${threadCountLabel(threadList.completedThreadCount, "completed")}`,
  };
}

function ProjectLifecycleToggle({
  lifecycle,
  lifecycleView,
  onClick,
}: { lifecycle: ReturnType<typeof projectLifecycleSummary>; lifecycleView: ProjectNodeProps["lifecycleView"]; onClick: (event: React.MouseEvent) => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={lifecycle.label}
          aria-pressed={lifecycleView === "completed"}
          data-view={lifecycleView}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={onClick}
          className="relative -m-1.5 mr-0 size-8 shrink-0 rounded-sm text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
        >
          <ProjectLifecycleIcons lifecycleView={lifecycleView} />
        </Button>
      } />
      <TooltipContent side="right" className="text-xs">{lifecycle.label}</TooltipContent>
    </Tooltip>
  );
}

function ProjectLifecycleIcons({ lifecycleView }: { lifecycleView: ProjectNodeProps["lifecycleView"] }) {
  if (lifecycleView === "completed") {
    return <><FolderCheck size={14} className="transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none" aria-hidden /><FolderOpen size={14} className="absolute opacity-0 transition-opacity duration-150 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 motion-reduce:transition-none" aria-hidden /></>;
  }
  return <><FolderOpen size={14} className="transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none" aria-hidden /><FolderCheck size={14} className="absolute opacity-0 transition-opacity duration-150 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 motion-reduce:transition-none" aria-hidden /></>;
}

function ProjectTitle({ workspace, onClick }: { workspace: Workspace; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button type="button" variant="ghost" size="xs" aria-label={`Open project ${workspace.name}`} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClick(); }} className="h-auto min-w-0 flex-1 shrink justify-start rounded-sm p-0 text-left hover:bg-transparent group-hover/ws:pr-24 group-focus-within/ws:pr-24 dark:hover:bg-transparent">
          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-medium tracking-tight group-hover/ws:[mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] group-focus-within/ws:[mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] group-hover/ws:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] group-focus-within/ws:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)]">{workspace.name}</span>
        </Button>
      } />
      <TooltipContent side="right" className="text-xs">{workspace.name}</TooltipContent>
    </Tooltip>
  );
}

function ProjectGitStatus({ isGitRepository }: { isGitRepository: boolean }) {
  if (isGitRepository) return null;
  return <Tooltip><TooltipTrigger render={<GitBranchMinus size={12} strokeWidth={2} className="shrink-0 text-muted-foreground/45" aria-label="Not a git repository" />} /><TooltipContent side="right" className="text-xs">Not a git repository</TooltipContent></Tooltip>;
}

function ProjectRunningStatus({ hasRunning }: { hasRunning: boolean }) {
  if (!hasRunning) return null;
  return <Tooltip><TooltipTrigger render={<span aria-hidden="true" className="shrink-0 h-1.5 w-1.5 rounded-full bg-primary status-pulse transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none" />} /><TooltipContent side="right" className="text-xs">Active agent in this project</TooltipContent></Tooltip>;
}

function ProjectThreadCount({ workspaceId, count }: { workspaceId: string; count: number }) {
  if (count === 0) return null;
  return <span data-testid={`project-thread-count-${workspaceId}`} className="ml-auto flex h-4 min-w-3 shrink-0 items-center justify-end font-mono text-xs leading-4 tabular-nums text-muted-foreground/45 transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none">{count}</span>;
}

function ProjectRowActions({
  workspace,
  isExpanded,
  onToggle,
  onOpenInExplorer,
  onRename,
  onDelete,
  onCreateThread,
}: { workspace: Workspace; isExpanded: boolean; onToggle: () => void; onOpenInExplorer: (event: React.MouseEvent) => void; onRename: (event: React.MouseEvent) => void; onDelete: (event: React.MouseEvent) => void; onCreateThread: (event: React.MouseEvent) => void }) {
  return (
    <div data-testid={`project-row-actions-${workspace.id}`} className="pointer-events-none absolute inset-y-0 right-1.5 z-10 flex items-center justify-end gap-1 bg-transparent px-0.5 opacity-0 transition-opacity duration-150 group-hover/ws:pointer-events-auto group-hover/ws:opacity-100 group-focus-within/ws:pointer-events-auto group-focus-within/ws:opacity-100 motion-reduce:transition-none">
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Toggle threads for ${workspace.name}`} aria-expanded={isExpanded} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onToggle(); }} className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:bg-transparent hover:text-muted-foreground dark:hover:bg-transparent group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 focus:opacity-100">
        <ChevronRight size={14} className={cn("transition-transform duration-150 motion-reduce:transition-none", isExpanded && "rotate-90")} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`Project options for ${workspace.name}`} onClick={(event) => event.stopPropagation()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-colors hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100"><MoreHorizontal size={13} /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
          <DropdownMenuItem onClick={onOpenInExplorer} className="flex cursor-pointer items-center gap-2"><FolderOpen size={13} />Open in Explorer</DropdownMenuItem>
          <DropdownMenuItem onClick={onRename} className="flex cursor-pointer items-center gap-2"><Pencil size={13} />Rename project</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} className="flex cursor-pointer items-center gap-2 text-destructive focus:text-destructive"><Trash2 size={13} />Delete project</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-xs" aria-label={`New thread in ${workspace.name}`} onKeyDown={(event) => event.stopPropagation()} onClick={onCreateThread} className="opacity-0 text-muted-foreground hover:bg-background/60 hover:text-foreground group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 focus:opacity-100"><SquarePen className="size-[1.4rem]" /></Button>}
        />
        <TooltipContent>{`New thread in ${workspace.name}`}</TooltipContent>
      </Tooltip>
    </div>
  );
}

interface ProjectThreadSectionProps {
  workspace: Workspace;
  isExpanded: boolean;
  isThreadListExpanded: boolean;
  pendingPermissionThreadIds: Set<string>;
  checksById: Record<string, ChecksStatus>;
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  inlineEdit: InlineEditState | null;
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  onStartInlineEdit: (threadId: string, title: string) => void;
  onToggleThreadList: (workspaceId: string) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onThreadContextMenu: ProjectNodeProps["onThreadContextMenu"];
  onCompleteThread: ProjectNodeProps["onCompleteThread"];
  onReopenThread: ProjectNodeProps["onReopenThread"];
  onRetryThreadCleanup: ProjectNodeProps["onRetryThreadCleanup"];
  lifecycleView: ProjectNodeProps["lifecycleView"];
  threadList: ProjectNodeThreadList;
}

function ProjectThreadSection({
  workspace,
  isExpanded,
  isThreadListExpanded,
  pendingPermissionThreadIds,
  checksById,
  scrollElementRef,
  inlineEdit,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
  onStartInlineEdit,
  onToggleThreadList,
  onSelectThread,
  onThreadContextMenu,
  onCompleteThread,
  onReopenThread,
  onRetryThreadCleanup,
  lifecycleView,
  threadList,
}: ProjectThreadSectionProps) {
  if (!isExpanded) return null;
  if (threadList.visibleThreads.length === 0) {
    return <p data-testid={`project-empty-${workspace.id}`} className="px-9 py-1 font-mono text-xs text-muted-foreground/70">{lifecycleView === "completed" ? "No completed threads" : "No active threads"}</p>;
  }
  return (
    <div>
      <VirtualizedThreadList
        workspaceName={workspace.name}
        treeItems={threadList.treeItems}
        maxVisible={threadList.maxVisible}
        pendingPermissionThreadIds={pendingPermissionThreadIds}
        checksById={checksById}
        scrollElementRef={scrollElementRef}
        inlineEdit={inlineEdit}
        onInlineEditChange={onInlineEditChange}
        onInlineEditCommit={onInlineEditCommit}
        onInlineEditCancel={onInlineEditCancel}
        onStartInlineEdit={onStartInlineEdit}
        onSelectThread={(threadId) => onSelectThread(workspace.id, threadId)}
        onThreadContextMenu={(event, thread) => onThreadContextMenu(event, thread, workspace.path)}
        onCompleteThread={onCompleteThread}
        onReopenThread={onReopenThread}
        onRetryThreadCleanup={onRetryThreadCleanup}
      />
      <ProjectThreadListToggle workspaceId={workspace.id} isExpanded={isThreadListExpanded} threadList={threadList} onToggleThreadList={onToggleThreadList} />
    </div>
  );
}

function ProjectThreadListToggle({
  workspaceId,
  isExpanded,
  threadList,
  onToggleThreadList,
}: { workspaceId: string; isExpanded: boolean; threadList: ProjectNodeThreadList; onToggleThreadList: (workspaceId: string) => void }) {
  if (!threadList.needsCap || threadList.forceExpand) return null;
  const label = isExpanded ? "Show less" : `Show more (${threadList.treeItems.length - THREAD_LIST_CAP})`;
  return <Button variant="ghost" size="xs" onClick={() => onToggleThreadList(workspaceId)} className="mt-0.5 h-auto w-full justify-start rounded-md px-2 py-1 text-[11px] font-normal text-muted-foreground/55 hover:bg-accent/40 hover:text-foreground">{label}</Button>;
}

/**
 * Preserves project and thread rendering while applying sortable positioning.
 */
const SortableProjectShell = memo(function SortableProjectShell(
  props: ProjectNodeProps & { sortableId: string },
) {
  const { sortableId, ...nodeProps } = props;
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
    transform: transform ? CSS.Translate.toString(transform) : undefined,
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
        isProjectDragging={isDragging}
        sortableListeners={listeners}
      />
    </div>
  );
});
