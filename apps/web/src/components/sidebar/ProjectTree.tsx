import {
  useEffect,
  useLayoutEffect,
  useCallback,
  useState,
  useRef,
  useMemo,
  memo,
  type CSSProperties,
} from "react";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/shallow";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { Plus, Trash2, ChevronRight, ChevronDown, GitBranch, GitBranchMinus, Loader2, AlertTriangle, FolderPlus } from "lucide-react";
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
import { schedulePrefetch, cancelPrefetch } from "@/lib/thread-hydrator/prefetch-scheduler";
import { getStatusDisplay, getNotificationDot } from "@/lib/thread-status";
import { isPrable } from "@/lib/is-prable";
import { getBreakdown, getCiVisual, CI_ICON_STROKE } from "@/lib/ci-status";
import type { ChecksStatus } from "@mcode/contracts";
import type { Workspace, Thread } from "@/transport/types";
import type { WorkspaceThread } from "@/lib/workspace-thread";
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
import { ThreadSearchBar } from "./ThreadSearchBar";
import { useSidebarSearchStore, type ThreadSortField } from "@/stores/sidebarSearchStore";

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

/** Stable empty Set used as a sentinel when status filters don't need running/permission state. */
const EMPTY_ID_SET = new Set<string>();
const PROJECT_DND_MODIFIERS = [restrictToVerticalAxis];
const PROJECT_DND_MEASURING = {
  droppable: {
    strategy: MeasuringStrategy.BeforeDragging,
  },
} as const;

/**
 * Returns `prev` if it contains the same elements in the same order as `next`
 * (by reference equality). Avoids new array references when content hasn't changed,
 * which preserves React.memo effectiveness on child components.
 */
function stableArray<T>(prev: T[] | undefined, next: T[]): T[] {
  if (prev === next) return prev;
  if (!prev || prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    if (prev[i] !== next[i]) return next;
  }
  return prev;
}

/** Time window in ms during which a second click on the same thread row is treated as a double-click. */
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

/**
 * Returns the parent directory name from an absolute path, or null if there isn't one
 * worth showing (e.g., the path is at the filesystem root).
 */
function parentDirName(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return segments[segments.length - 2];
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

/** Filter and sort threads based on sidebar search state. */
function filterAndSortThreads(
  threads: WorkspaceThread[],
  query: string,
  filters: { status: string[]; provider: string[] },
  sortField: ThreadSortField,
  sortDirection: "asc" | "desc",
  runningThreadIds: Set<string>,
  pendingPermissionThreadIds: Set<string>,
): WorkspaceThread[] {
  let result = threads;

  // Text search filter
  if (query) {
    const q = query.toLowerCase();
    result = result.filter((t) => t.title.toLowerCase().includes(q));
  }

  // Status filter
  if (filters.status.length > 0) {
    result = result.filter((t) => {
      // "action_required" is a client-side pseudo-status
      if (filters.status.includes("action_required") && pendingPermissionThreadIds.has(t.id)) {
        return true;
      }
      // "active" means currently running
      if (filters.status.includes("active") && t.status === "active" && runningThreadIds.has(t.id)) {
        return true;
      }
      // "paused" means status is active but NOT running
      if (filters.status.includes("paused") && t.status === "active" && !runningThreadIds.has(t.id)) {
        return true;
      }
      // For DB-level statuses (completed, errored, interrupted), match directly
      // but exclude "active" from fallthrough since it's handled above
      if (t.status === "active") return false;
      return filters.status.includes(t.status);
    });
  }

  // Provider filter
  if (filters.provider.length > 0) {
    result = result.filter((t) => filters.provider.includes(t.provider));
  }

  // Sort
  const dir = sortDirection === "asc" ? 1 : -1;
  result = [...result].sort((a, b) => {
    let cmp: number;
    switch (sortField) {
      case "title":
        cmp = a.title.localeCompare(b.title);
        break;
      case "created_at":
        cmp = a.created_at.localeCompare(b.created_at);
        break;
      case "updated_at":
      default:
        cmp = a.updated_at.localeCompare(b.updated_at);
        break;
    }
    return cmp * dir;
  });

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
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const deleteThread = useWorkspaceStore((s) => s.deleteThread);
  const setPendingNewThread = useWorkspaceStore((s) => s.setPendingNewThread);
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

  const searchQuery = useSidebarSearchStore((s) => s.query);
  const searchFilters = useSidebarSearchStore((s) => s.filters);
  const sortField = useSidebarSearchStore((s) => s.sortField);
  const sortDirection = useSidebarSearchStore((s) => s.sortDirection);
  const isSearching = useSidebarSearchStore((s) => s.isSearching);
  const serverResults = useSidebarSearchStore((s) => s.serverResults);
  const setExpandedSnapshot = useSidebarSearchStore((s) => s.setExpandedSnapshot);
  const expandedSnapshot = useSidebarSearchStore((s) => s.expandedSnapshot);
  const isSearchActive = searchQuery.trim().length > 0 || searchFilters.status.length > 0 || searchFilters.provider.length > 0;

  const availableProviders = useMemo(
    () => [...new Set(threads.map((t) => t.provider))].sort(),
    [threads],
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

  // Only include running/permission IDs as dependencies when status filters actually
  // consult them. This prevents the entire filteredThreadsByWorkspace map from being
  // recomputed every time an agent starts/stops (which creates new Set references).
  const statusNeedsRunning = searchFilters.status.length > 0
    && searchFilters.status.some((s) => s === "active" || s === "paused" || s === "action_required");
  const effectiveRunning = statusNeedsRunning ? runningThreadIds : EMPTY_ID_SET;
  const effectivePending = statusNeedsRunning ? pendingPermissionThreadIds : EMPTY_ID_SET;

  const prevFilteredRef = useRef<Map<string, WorkspaceThread[]>>(new Map());

  const filteredThreadsByWorkspace = useMemo(() => {
    const map = new Map<string, WorkspaceThread[]>();
    const prev = prevFilteredRef.current;
    for (const ws of workspaces) {
      const wsThreads = threadsByWorkspace.get(ws.id) ?? EMPTY_THREADS;
      const filtered = isSearchActive
        ? filterAndSortThreads(wsThreads, searchQuery, searchFilters, sortField, sortDirection, effectiveRunning, effectivePending)
        : sortField !== "updated_at" || sortDirection !== "desc"
          ? filterAndSortThreads(wsThreads, "", { status: [], provider: [] }, sortField, sortDirection, effectiveRunning, effectivePending)
          : wsThreads;
      // Reuse the previous array reference when elements haven't changed.
      // Prevents downstream React.memo children from re-rendering when the
      // map recomputes but a workspace's thread list is structurally identical.
      map.set(ws.id, stableArray(prev.get(ws.id), filtered));
    }
    prevFilteredRef.current = map;
    return map;
  }, [workspaces, threadsByWorkspace, isSearchActive, searchQuery, searchFilters, sortField, sortDirection, effectiveRunning, effectivePending]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>(getExpandedState);
  /** Ref mirror of `expanded` so effects can read current state without re-triggering. */
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [threadListExpanded, setThreadListExpandedState] = useState<Record<string, boolean>>(getThreadListExpanded);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  const [wsDeleteDialog, setWsDeleteDialog] = useState<WorkspaceDeleteDialogState | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const workspaceIds = useMemo(() => workspaces.map((w) => w.id), [workspaces]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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

  // Snapshot expanded state when search begins, restore when cleared
  useEffect(() => {
    if (isSearchActive && !expandedSnapshot) {
      setExpandedSnapshot({ ...expandedRef.current });
    }
    if (!isSearchActive && expandedSnapshot) {
      setExpanded(expandedSnapshot);
      useSidebarSearchStore.setState({ expandedSnapshot: null });
    }
  }, [isSearchActive, expandedSnapshot, setExpandedSnapshot]);

  // Auto-expand projects with matching threads during search
  useEffect(() => {
    if (!isSearchActive) return;
    const workspaceIdsWithMatches = new Set<string>();

    for (const ws of workspaces) {
      const wsThreads = filteredThreadsByWorkspace.get(ws.id) ?? [];
      if (wsThreads.length > 0) workspaceIdsWithMatches.add(ws.id);
    }

    for (const t of serverResults) {
      workspaceIdsWithMatches.add(t.workspace_id);
    }

    const prev = expandedRef.current;
    const next: Record<string, boolean> = {};
    const workspacesToLoad: string[] = [];

    for (const ws of workspaces) {
      if (workspaceIdsWithMatches.has(ws.id)) {
        next[ws.id] = true;
        if (!prev[ws.id]) workspacesToLoad.push(ws.id);
      } else {
        next[ws.id] = false;
      }
    }

    // Only update state if expanded values actually changed (prevents infinite loop)
    const changed = workspaces.some(
      (ws) => (prev[ws.id] ?? false) !== (next[ws.id] ?? false),
    );
    if (changed) {
      setExpanded(next);
    }

    for (const wsId of workspacesToLoad) {
      loadThreads(wsId);
    }
  }, [isSearchActive, filteredThreadsByWorkspace, serverResults, workspaces, loadThreads]);

  const checksById = useWorkspaceStore(useShallow((s) => s.checksById));

  const toggleThreadList = useCallback((wsId: string) => {
    setThreadListExpandedState((prev) => ({ ...prev, [wsId]: !prev[wsId] }));
  }, []);

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
    []
  );

  // Stable callbacks that accept wsId to avoid per-workspace closures in the render loop.
  const handleSelectThread = useCallback((wsId: string, threadId: string) => {
    setActiveWorkspace(wsId);
    setActiveThread(threadId);
  }, [setActiveWorkspace, setActiveThread]);

  const handleCreateThread = useCallback((wsId: string) => {
    setActiveWorkspace(wsId);
    setPendingNewThread(true);
    setActiveThread(null);
  }, [setActiveWorkspace, setPendingNewThread, setActiveThread]);

  const handleDeleteWorkspace = useCallback((wsId: string) => {
    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId);
    if (ws) {
      setWsDeleteDialog({ workspaceId: ws.id, workspaceName: ws.name });
    }
  }, []);

  const handleInlineEditChange = useCallback((title: string) => {
    setInlineEdit((prev) => prev ? { ...prev, title } : null);
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

  const handleStartInlineEdit = useCallback((threadId: string, title: string) => {
    setInlineEdit({ threadId, title, originalTitle: title });
  }, []);

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
      {/* Search bar */}
      <ThreadSearchBar providers={availableProviders} />

      <div className="mb-0.5 flex items-center justify-between px-2.5 py-1.5">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/55">
          Projects
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-xs" onClick={handleOpenFolder} aria-label="Open project folder" className="text-muted-foreground/60 hover:text-foreground">
                <Plus size={14} />
              </Button>
            }
          />
          <TooltipContent side="right" className="text-xs">
            Open project folder
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
            <SortableContext items={workspaceIds} strategy={verticalListSortingStrategy}>
              {workspaces.map((ws) => {
                const wsThreads = filteredThreadsByWorkspace.get(ws.id) ?? [];

                // Hide projects with zero matches during active search
                if (isSearchActive && wsThreads.length === 0) return null;

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
                  onThreadContextMenu={handleThreadContextMenu}
                />
                );
              })}
            </SortableContext>
          </DndContext>

          {/* Loading more results from server */}
          {isSearching && (
            <div className="flex items-center gap-1.5 px-4 py-2">
              <Loader2 size={10} className="animate-spin text-muted-foreground/30" />
              <span className="font-mono text-[10px] text-muted-foreground/30">
                loading more...
              </span>
            </div>
          )}

          {/* No results empty state */}
          {isSearchActive && !isSearching && workspaces.every((ws) => {
            return (filteredThreadsByWorkspace.get(ws.id) ?? []).length === 0;
          }) && serverResults.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-8">
              <span className="font-mono text-[28px] text-muted-foreground/15" aria-hidden>&#x2298;</span>
              <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/40">
                No matching threads
              </p>
            </div>
          )}

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
                <FolderPlus size={11} className="opacity-70 group-hover:opacity-100" />
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
 * Sidebar CI status chip — a compact icon+count capsule shown in the thread row.
 *
 * Kept deliberately distinct from the agent-activity dot on the PR icon:
 * it's a shape (capsule), not a dot, and it carries a numeric count + icon
 * so it reads as a labelled "CI widget" rather than a notification pip.
 *
 * Chrome + icon + strokeWidth all come from the shared `getCiVisual()` so the
 * chip stays in lockstep with the chat-header button and the popover.
 */
const CiChip = memo(function CiChip({ checks }: { checks: ChecksStatus }) {
  const b = getBreakdown(checks);
  if (checks.aggregate === "no_checks" || b.total === 0) return null;

  const agg = checks.aggregate;
  const { icon: Icon, chromeClass } = getCiVisual(agg);

  // Text: "1" failing, "2/5" running, "7" passing. The icon carries state;
  // the number carries scale — together they read unmistakably as CI.
  const text =
    agg === "failing"
      ? String(b.failing || b.total)
      : agg === "pending"
        ? `${b.total - b.running}/${b.total}`
        : String(b.total);

  const label =
    agg === "failing"
      ? `${b.failing || b.total} failing`
      : agg === "pending"
        ? `${b.total - b.running} of ${b.total} checks done`
        : `${b.total} checks passing`;

  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        // h-4 (16px) sits on the 4pt scale; text-[10px] stays legible on HiDPI
        // displays and OS text-scale settings above 100%.
        "shrink-0 inline-flex items-center gap-0.5 px-1 h-4 rounded-[3px] border",
        "text-[10px] font-medium tabular-nums leading-none",
        chromeClass,
      )}
    >
      <Icon
        size={9}
        strokeWidth={CI_ICON_STROKE}
        className={cn("shrink-0", agg === "pending" && "status-spin")}
      />
      <span>{text}</span>
    </span>
  );
});

/**
 * Workspace-row CI roll-up chip.
 *
 * Silent-on-healthy: renders nothing when all threads are green (or none have CI).
 * Surfaces a single chip when any thread is failing or pending, so a collapsed
 * project row still shouts when something needs attention but stays quiet when
 * nothing does. Same chrome + glyphs as the per-thread `CiChip`, so the CI
 * language stays consistent between zoom levels.
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
    agg === "failing" ? `${count} ${noun} failing` : `${count} ${noun} with checks running`;

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
      <Icon
        size={9}
        strokeWidth={CI_ICON_STROKE}
        className={cn("shrink-0", agg === "pending" && "status-spin")}
      />
      <span>{count}</span>
    </span>
  );
});

/** Renders a virtualized, scrollable list of threads for a single workspace. */
function VirtualizedThreadList({
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
    () => (Number.isFinite(maxVisible) ? allTreeItems.slice(0, maxVisible) : allTreeItems),
    [allTreeItems, maxVisible],
  );

  // Normalized set of existing worktree paths for stale detection.
  const worktrees = useWorkspaceStore((s) => s.worktrees);
  const worktreesLoadedFor = useWorkspaceStore((s) => s.worktreesLoadedForWorkspace);
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

  const handleThreadClick = useCallback((threadId: string, title: string) => {
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
  }, [inlineEdit, onSelectThread, onStartInlineEdit]);

  const handleThreadDoubleClick = useCallback((threadId: string, title: string) => {
    if (inlineEdit?.threadId === threadId) return;
    lastClickTimeRef.current.delete(threadId);
    onStartInlineEdit(threadId, title);
  }, [inlineEdit, onStartInlineEdit]);

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
    estimateSize: () => 28,
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
        const status = getStatusDisplay(thread, runningThreadIds.has(thread.id), pendingPermissionThreadIds.has(thread.id));
        const isEditing = inlineEdit?.threadId === thread.id;
        // Only PR-able (worktree) threads surface PR affordances. A direct-mode
        // thread shows its branch/agent status, never a PR icon, even if a PR
        // number happens to be attached.
        const prable = isPrable(thread);
        // Worktree thread whose directory no longer exists on disk.
        // Only check threads from the workspace whose worktrees are loaded — comparing
        // against a different workspace's worktree list would produce false positives.
        const isStaleWorktree = worktreesLoadedFor === thread.workspace_id
          && thread.mode === "worktree" && !!thread.worktree_path
          && !validWorktreePaths.has(thread.worktree_path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase());
        // Unusable when the provider is disabled or its CLI binary is missing.
        // "unchecked" is not treated as unusable — the server may not have verified yet.
        const providerRow = availableProviders.find((p) => p.id === thread.provider);
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
        // Opacity on the row would compound onto CiChip; dim only the title cluster and timestamp.
        const scaffoldDim =
          (thread.clientPreparing || thread.clientError) && "opacity-[0.72]";
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
                onDoubleClick={() => handleThreadDoubleClick(thread.id, thread.title)}
                onContextMenu={(e) => onThreadContextMenu(e, thread)}
                onMouseEnter={() => {
                  if (!thread.clientPreparing && !thread.clientError) {
                    schedulePrefetch(thread.id);
                  }
                }}
                onMouseLeave={cancelPrefetch}
                className={cn(
                  "group/row flex items-center gap-2 rounded-md pr-2 py-1 text-[13px] cursor-pointer transition-colors",
                  activeThreadId === thread.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground/85 hover:bg-accent/40 hover:text-foreground"
                )}
                style={{ paddingLeft: `${8 + depth * 12}px` }}
              >
                <div
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2",
                    scaffoldDim,
                  )}
                >
                {prable && thread.pr_number != null ? (() => {
                  const { Icon: PrIcon, color: prColor } = getPrVisual(thread.pr_status);
                  const agentDot = getNotificationDot(thread, runningThreadIds.has(thread.id), pendingPermissionThreadIds.has(thread.id));
                  // Only the agent signal lives on the PR icon — a top-right dot.
                  // CI status is surfaced as a labelled chip in the row's end-section
                  // so it cannot be confused with an agent-activity dot.
                  return (
                    <span
                      title={`PR #${thread.pr_number} \u2013 ${thread.pr_status ?? "open"}`}
                      className="relative shrink-0"
                    >
                      <PrIcon size={12} className={prColor} />
                      {agentDot && (
                        <span
                          aria-label={agentDot.shape === "ring" ? "Action required" : undefined}
                          className={cn(
                            "absolute rounded-full",
                            // Ring variant sizes up slightly and drops the background ring so the
                            // amber ring isn't confused with the 1px separator ring used on dots.
                            agentDot.shape === "ring"
                              ? "-top-1 -right-1 h-2 w-2"
                              : "-top-0.5 -right-0.5 h-1.5 w-1.5 ring-1 ring-background",
                            agentDot.dotClass,
                            agentDot.animate && "status-pulse",
                          )}
                        />
                      )}
                    </span>
                  );
                })() : (
                  <span
                    aria-label={status.shape === "ring" ? "Action required" : undefined}
                    className={cn(
                      "shrink-0 rounded-full",
                      status.shape === "ring" ? "h-2 w-2" : "h-1.5 w-1.5",
                      status.dotClass,
                    )}
                  />
                )}
                {status.label && (
                  <span className={cn("shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em]", status.color)}>
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
                  <span className={cn("truncate flex-1", isStaleWorktree && "text-[var(--diff-remove-strong)]/85 line-through")} data-testid="thread-title">
                    {isStaleWorktree && (
                      <Tooltip>
                        <TooltipTrigger render={<AlertTriangle size={11} className="inline mr-1 align-text-bottom text-[var(--diff-remove-strong)]/80" />} />
                        <TooltipContent side="right" className="text-xs">Worktree directory no longer exists</TooltipContent>
                      </Tooltip>
                    )}
                    {thread.title}
                  </span>
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
                    <TooltipContent side="right" className="text-xs">{unusableReason}</TooltipContent>
                  </Tooltip>
                )}
                </div>
                {!isEditing && prable && thread.pr_number != null && checksById[thread.id] && (
                  <CiChip checks={checksById[thread.id]} />
                )}
                {!isEditing && (
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/45",
                      scaffoldDim,
                    )}
                  >
                    {prable && thread.pr_number != null && (
                      <span className="mr-1 opacity-80">#{thread.pr_number}</span>
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
  onThreadContextMenu: (e: React.MouseEvent, thread: Thread, workspacePath: string) => void;
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
  onThreadContextMenu,
  sortableListeners,
  isProjectDragging = false,
}: ProjectNodeProps) {
  const parentDir = useMemo(() => parentDirName(workspace.path), [workspace.path]);
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
  const activeIndex = activeThreadId ? treeItems.findIndex((item) => item.thread.id === activeThreadId) : -1;
  const forceExpand = activeIndex >= THREAD_LIST_CAP;
  const maxVisible = !needsCap || isThreadListExpanded || forceExpand ? Infinity : THREAD_LIST_CAP;

  const wsId = workspace.id;
  const handleToggle = useCallback(() => onToggle(wsId), [onToggle, wsId]);
  const handleToggleThreadList = useCallback(() => onToggleThreadList(wsId), [onToggleThreadList, wsId]);
  const handleCreateThread = useCallback(() => onCreateThread(wsId), [onCreateThread, wsId]);
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(wsId);
  }, [onDelete, wsId]);
  const handleSelectThread = useCallback((threadId: string) => onSelectThread(wsId, threadId), [onSelectThread, wsId]);
  const handleThreadContextMenu = useCallback(
    (e: React.MouseEvent, thread: Thread) => onThreadContextMenu(e, thread, workspace.path),
    [onThreadContextMenu, workspace.path],
  );

  return (
    <div>
      {/* Workspace row — typographic anchor. No folder icon; a quiet caret + name + parent caption. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        data-testid={`project-row-${workspace.id}`}
        className={cn(
          "group/ws relative flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[12.5px] cursor-pointer transition-colors touch-none",
          isProjectDragging && "cursor-grabbing",
          isActive
            ? "text-foreground"
            : "text-muted-foreground/85 hover:text-foreground",
        )}
        {...sortableListeners}
        onKeyDown={(e) => {
          sortableListeners?.onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            handleToggle();
          }
        }}
        onClick={handleToggle}
      >
        {isExpanded ? (
          <ChevronDown size={12} className="shrink-0 text-muted-foreground/55 transition-transform" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-muted-foreground/55 transition-transform" />
        )}

        <span className="truncate font-medium tracking-tight">{workspace.name}</span>

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

        {parentDir && (
          <span
            aria-hidden="true"
            className="hidden min-w-0 truncate font-mono text-[9.5px] tracking-tight text-muted-foreground/35 group-hover/ws:inline"
            title={workspace.path}
          >
            · {parentDir}
          </span>
        )}

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
          <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground/40">
            {threads.length}
          </span>
        )}

        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete ${workspace.name}`}
          onClick={handleDelete}
          className="opacity-0 text-muted-foreground/60 hover:text-destructive group-hover/ws:opacity-100 focus:opacity-100"
        >
          <Trash2 size={11} />
        </Button>
      </div>

      {/* Threads (when expanded) — indented, no guide rail. */}
      {isExpanded && (
        <div className="pl-2">
          {threads.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-2">
              <span aria-hidden="true" className="font-mono text-[12px] leading-none text-muted-foreground/25">
                ◌
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/40">
                Empty
              </span>
            </div>
          ) : (
            <VirtualizedThreadList
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
          )}

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

          {/* New thread action — quiet typographic button, not a filled CTA. */}
          <Button
            variant="ghost"
            size="xs"
            onClick={handleCreateThread}
            className="mt-0.5 h-auto w-full justify-start gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-normal text-muted-foreground/55 hover:bg-accent/40 hover:text-foreground"
          >
            <Plus size={11} className="opacity-70" />
            New thread
          </Button>
        </div>
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging
      ? { opacity: 0.92, zIndex: 2, boxShadow: "0 2px 10px rgba(0,0,0,0.08)" }
      : {}),
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
