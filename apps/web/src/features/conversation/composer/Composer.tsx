import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from "react";
import { useThreadStore, scheduleDrainAfterEdit } from "@/stores/threadStore";
import { useThreadRecord, getThreadRecord, getHandoffStatus } from "../state";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useWorkspaceThread, readWorkspaceThread } from "@/features/projects/state/workspace-selectors";
import { resolveComposerSession, snapshotComposerDraft } from "@/lib/composer-session";
import type { PermissionMode, InteractionMode, AttachmentMeta, Thread } from "@/transport";
import { PERMISSION_MODES, INTERACTION_MODES, getTransport } from "@/transport";
import {
  ArrowUp,
  Goal,
  Lock,
  Unlock,
  ChevronDown,
  Check,
  ListChecks,
  MoreHorizontal,
  Network,
  X,
  Zap,
  Folder,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { isWindows } from "@/lib/platform";
import { isCursorPermissionLockedToFull } from "@/lib/cursor-permission";
import { isGoalControlCommand } from "@/lib/goal-command";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { isDetachedWorktree, normalizeWorktreePath } from "@/lib/worktree";
import { rememberComposerMode } from "@/lib/composer-mode-preference";
import { getDefaultModelId, getDefaultReasoningLevel, getDefaultProviderId, isMaxEffortModel, isXhighEffortModel, supportsEffortParameter, supports1MContextWindow, supportsThinkingToggle, normalizeReasoningLevelForModel, getCodexReasoningLevels, providerSupportsReasoningLevels } from "@/lib/model-registry";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { ModeSelector, ALL_MODE_OPTIONS } from "@/components/chat/ModeSelector";
import type { ComposerMode, ModeOption } from "@/components/chat/ModeSelector";
import { BranchPicker } from "@/components/chat/BranchPicker";
import { NewThreadProjectPicker } from "@/components/chat/NewThreadProjectPicker";
const LazyWorktreePicker = lazy(() => import("@/components/chat/WorktreePicker"));
import { CopilotAgentSelector } from "@/components/chat/CopilotAgentSelector";
import { AttachmentPreview } from "@/components/chat/AttachmentPreview";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import { useFileAutocomplete, clearFileListCache, type MentionSuggestion } from "@/components/chat/useFileAutocomplete";
import { useFileTagPopup, FileTagPopup } from "@/components/chat/FileTagPopup";
import { ComposerAddMenu } from "@/components/chat/ComposerAddMenu";
import { ComposerCapabilityChip } from "@/components/chat/ComposerCapabilityChip";
import {
  resolveComposerCapabilities,
  type ComposerCapabilityId,
} from "./composer-capabilities";
import { SpellcheckContextMenu } from "@/components/chat/SpellcheckContextMenu";
import {
  ComposerEditor,
  $createSlashCommandNode,
  $createTypedMentionNode,
  createMentionId,
  extractComposerMessage,
  insertMentionNode,
  insertSelectedPluginMention,
  insertSlashCommandNode,
  removeSlashCommandTrigger,
  type MentionNodeData,
} from "@/components/chat/lexical";
import { TerminalStatusIndicator } from "@/components/chat/TerminalStatusIndicator";
import { useTaskStore, type TaskItem } from "@/stores/taskStore";
import { usePlanStore } from "@/stores/planStore";

const NEW_THREAD_CONTEXT_CONTROL_CLASS =
  "h-[28px] gap-[6px] rounded-md px-[10px] text-xs font-medium leading-none";
import { useDiffStore } from "@/stores/diffStore";
import {
  hideRightPanelAdaptive,
  showRightPanelAdaptive,
} from "@/lib/right-panel-layout";
import { useSlashCommand } from "@/components/chat/useSlashCommand";
import type { Command } from "@/components/chat/useSlashCommand";
import { SlashCommandPopup } from "@/components/chat/SlashCommandPopup";
import {
  type LexicalEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
} from "lexical";
import { PrDetectedCard } from "@/components/chat/PrDetectedCard";
import type { PrDetail } from "@/transport/types";
import { ComposerQueueList } from "@/components/chat/ComposerQueueList";
import { ContextTracker } from "@/components/chat/ContextTracker";
import { CompactingBanner } from "@/components/chat/CompactingBanner";
import { RetryBanner } from "@/components/chat/RetryBanner";
import { ComposerBranchBar } from "@/components/chat/ComposerBranchBar";
import { ComposerReplyBar } from "@/components/chat/ComposerReplyBar";
import { PlanPreview } from "@/components/chat/PlanPreview";
import { TaskBubble } from "@/components/chat/TaskBubble";
import { useReplyStore } from "@/stores/replyStore";
import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import {
  classifyFile,
  isFileSupported,
  getMaxFileSize,
  inferMimeType,
  MAX_ATTACHMENTS,
  MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
  isVirtualBrowserContextAttachment,
  attachmentAcceptAttribute,
  isGoalOpen,
  ORCHESTRATION_MODES,
} from "@mcode/contracts";
import type {
  AttachedBrowserCapture,
  ContextWindowMode,
  MessageMention,
  PreviewAnnotationBundle,
  ReasoningLevel,
  ProviderId,
  GoalState,
  OrchestrationMode,
} from "@mcode/contracts";
import { getModelContextWindow } from "@mcode/shared/model-context";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { usePreviewReferenceQueueStore } from "@/features/preview/state/previewReferenceQueueStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useElementWidth } from "@/hooks/useElementWidth";
import { ProviderUnavailableBanner } from "@/components/chat/ProviderUnavailableBanner";
import { appendBrowserCaptureFence } from "@/features/preview/capture/browser-capture-append";
import {
  appendPreviewAnnotationFence,
  stripPreviewAnnotationFence,
} from "@/features/preview/capture/preview-annotation-append";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";
import { PreviewAnnotationBundleChip } from "@/components/chat/PreviewAnnotationBundleChip";
import {
  collectBrowserCaptureSpillPaths,
  collectSpillPathsFromPendingAttachments,
  releaseBrowserCaptureSpills,
} from "@/features/preview/capture/browser-capture-spill";

const EMPTY_TASK_BUBBLE_TASKS: readonly TaskItem[] = [];
/** Build structured preview metadata payloads paired with outbound attachment IDs. */
function buildAttachedBrowserCaptures(list: PendingAttachment[]): AttachedBrowserCapture[] {
  const rows: AttachedBrowserCapture[] = [];
  for (const row of list) {
    if (!row.browserCapture) continue;
    rows.push({ attachmentId: row.id, ...row.browserCapture });
  }
  return rows;
}

/** Caption stored in the chat bubble and DB; trims edge whitespace, keeps internal newlines. */
function resolveOutboundDisplayContent(
  rawInput: string,
  displayInjected: string | undefined,
): string {
  return (displayInjected ?? rawInput).trim();
}

function resolveNativeFilePath(file: File): string | null {
  try {
    return window.desktopBridge?.getPathForFile?.(file) ?? null;
  } catch {
    return null;
  }
}

function writeComposerContent(
  editor: LexicalEditor,
  text: string,
  mentionRanges: readonly MessageMention[] = [],
  italic = false,
): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    let paragraph = $createParagraphNode();
    const sortedMentions = [...mentionRanges].sort((a, b) => a.range.start - b.range.start);
    let cursor = 0;

    const appendText = (value: string) => {
      const parts = value.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          root.append(paragraph);
          paragraph = $createParagraphNode();
        }
        if (parts[i]) {
          const node = $createTextNode(parts[i]);
          if (italic) node.setFormat(2);
          paragraph.append(node);
        }
      }
    };

    for (const mention of sortedMentions) {
      const mentionText = mention.kind === "command" ? `/${mention.label}` : `@${mention.label}`;
      if (
        mention.range.start < cursor ||
        mention.range.end > text.length ||
        text.slice(mention.range.start, mention.range.end) !== mentionText
      ) {
        continue;
      }
      appendText(text.slice(cursor, mention.range.start));
      if (mention.kind === "command") {
        paragraph.append($createSlashCommandNode(
          mention.label,
          mention.namespace,
          mention.capabilityIdentity,
        ));
        cursor = mention.range.end;
        continue;
      }
      const nodeMention =
        mention.kind === "file"
          ? {
              id: mention.id,
              kind: mention.kind,
              label: mention.label,
              path: mention.path,
            }
          : {
              id: mention.id,
              kind: mention.kind,
              label: mention.label,
              name: mention.name,
              path: mention.path,
              ...(mention.kind === "agent" ? { provider: mention.provider } : {}),
            };
      paragraph.append($createTypedMentionNode(nodeMention));
      cursor = mention.range.end;
    }

    appendText(text.slice(cursor));
    root.append(paragraph);
  });
}

/**
 * Resolve the running-state used by submit handlers from the latest store
 * snapshot, covering the render gap after reconnect or server push.
 */
export function isThreadRunningForSubmit(
  threadId: string | undefined,
  renderedIsAgentRunning: boolean,
): boolean {
  if (renderedIsAgentRunning) return true;
  return threadId ? useThreadStore.getState().runningThreadIds.has(threadId) : false;
}

/** Decide whether an existing-thread submit should queue behind the active turn. */
export function shouldQueueActiveThreadSubmit(
  threadId: string | undefined,
  renderedIsAgentRunning: boolean,
  branchFromMessageId: string | null | undefined,
  isNewThread: boolean | undefined,
  trimmedContent: string,
): boolean {
  return Boolean(
    isThreadRunningForSubmit(threadId, renderedIsAgentRunning) &&
    threadId &&
    !branchFromMessageId &&
    !isNewThread &&
    !isGoalControlCommand(trimmedContent),
  );
}

/** `accept` list for the composer's hidden file input (mirrors {@link isFileSupported}). */
const ATTACHMENT_INPUT_ACCEPT = attachmentAcceptAttribute();

/** ReasoningLevel values as a Set for O(1) membership checks in the Codex level filter. */
const VALID_REASONING_LEVELS_SET = new Set<string>([
  "none", "minimal", "low", "medium", "high", "xhigh", "max",
]);

/** Display label for a reasoning level value. */
function reasoningLabel(level: string): string {
  if (level === "xhigh") return "X-High";
  if (level === "none") return "None";
  if (level === "minimal") return "Minimal";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

interface ComposerProps {
  threadId?: string;
  isNewThread?: boolean;
  workspaceId?: string;
  /** When set, the composer is in fork mode; submit creates a forked thread instead of sending. */
  branchFromMessageId?: string;
  /** Preview content of the message being forked from, shown as a quote. */
  branchFromMessageContent?: string;
  /** Called when the user exits fork mode (X button or Escape). */
  onBranchModeExit?: () => void;
  /** Called after a new-thread submission has created its durable thread. */
  onThreadCreated?: (thread: Thread) => void;
}

interface PendingCheckoutConfirmation {
  currentBranch: string;
  targetBranch: string;
  onConfirm: () => Promise<void>;
}

type AccessMode = PermissionMode;

/**
 * Overflow popover that hosts permission mode and the Plan-panel toggle.
 *
 * Centralizing these behind a single trigger keeps the status bar compact on
 * every viewport — previously each toggle was its own button and they wrapped
 * onto a second row at narrow widths.
 */
function ComposerOptionsMenu({
  threadId,
  access,
  permissionLocked,
  onAccessChange,
}: {
  threadId?: string;
  access: PermissionMode;
  /**
   * When true, the permission toggle is hidden and Full access is shown
   * as a non-interactive badge. Set for cursor on Windows because
   * cursor-agent --print has no interactive permission flow and the OS
   * sandbox is unavailable on Windows. See {@link isCursorPermissionLockedToFull}.
   */
  permissionLocked: boolean;
  onAccessChange: (next: PermissionMode) => void;
}) {
  const hasPlans = usePlanStore(
    (s) => !!(threadId && ((s.plansByThread[threadId]?.length ?? 0) > 0 || s.generatingThreads.has(threadId))),
  );
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const panelVisible = useDiffStore((s) =>
    activeWorkspaceId ? s.getRightPanelVisible(activeWorkspaceId, threadId) : false,
  );

  const togglePlanPanel = () => {
    // Plan is thread-only; the whole panel record is per-thread (ADR-0012).
    if (!threadId || !activeWorkspaceId) return;
    if (panelVisible) {
      hideRightPanelAdaptive(activeWorkspaceId, threadId);
    } else {
      showRightPanelAdaptive(activeWorkspaceId, threadId);
      useDiffStore.getState().setRightPanelTab(activeWorkspaceId, threadId, "tasks");
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Composer options"
        title="Composer options"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground data-[popup-open]:bg-muted/40 data-[popup-open]:text-foreground"
      >
        <MoreHorizontal size={14} />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-60 p-2">
        {/* Permissions */}
        <div className="px-1.5 pt-1 pb-1.5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
          Permissions
        </div>
        {permissionLocked ? (
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1.5 text-xs font-medium text-muted-foreground",
              hasPlans && "mb-2",
            )}
            title="Cursor on Windows runs in full access — supervised mode is unavailable because cursor-agent's OS sandbox requires macOS or Linux."
          >
            <Unlock size={12} />
            Full access (Cursor on Windows)
          </div>
        ) : (
          <div className={cn("flex rounded-md bg-muted/40 p-0.5", hasPlans && "mb-2")}>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onAccessChange(PERMISSION_MODES.FULL)}
              aria-pressed={access === PERMISSION_MODES.FULL}
              className={cn(
                "h-auto flex-1 gap-1.5 rounded-[5px] px-2 py-1 text-xs font-medium hover:bg-transparent",
                access === PERMISSION_MODES.FULL
                  ? "bg-background text-foreground shadow-sm hover:bg-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Unlock size={12} />
              Full
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onAccessChange(PERMISSION_MODES.SUPERVISED)}
              aria-pressed={access === PERMISSION_MODES.SUPERVISED}
              className={cn(
                "h-auto flex-1 gap-1.5 rounded-[5px] px-2 py-1 text-xs font-medium hover:bg-transparent",
                access === PERMISSION_MODES.SUPERVISED
                  ? "bg-background text-foreground shadow-sm hover:bg-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Lock size={12} />
              Supervised
            </Button>
          </div>
        )}

        {/* Plan panel — only available when the thread has saved or generating plans. */}
        {hasPlans && (
          <Button
            variant="ghost"
            size="xs"
            onClick={togglePlanPanel}
            aria-pressed={panelVisible}
            className="h-auto w-full justify-between rounded-md px-2 py-1.5 text-xs font-normal text-foreground hover:bg-muted/40"
          >
            <span className="flex items-center gap-2">
              <ListChecks size={13} className={panelVisible ? "text-primary" : "text-muted-foreground"} />
              Plan panel
            </span>
            <span className={cn("text-xs font-medium uppercase tracking-[0.1em]", panelVisible ? "text-primary" : "text-muted-foreground/60")}>
              {panelVisible ? "On" : "Off"}
            </span>
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Inline rendering of Permissions (Full/Supervised) and the Plan-panel toggle.
 * Used at md+ widths where the
 * controls fit comfortably in the model bar; below md the parent renders
 * `ComposerOptionsMenu` instead so they collapse behind a single trigger.
 */
function InlineComposerOptions({
  threadId,
  access,
  permissionLocked,
  onAccessChange,
}: {
  threadId?: string;
  access: PermissionMode;
  /** See {@link ComposerOptionsMenu}. */
  permissionLocked: boolean;
  onAccessChange: (next: PermissionMode) => void;
}) {
  const hasPlans = usePlanStore(
    (s) => !!(threadId && ((s.plansByThread[threadId]?.length ?? 0) > 0 || s.generatingThreads.has(threadId))),
  );
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const panelVisible = useDiffStore((s) =>
    activeWorkspaceId ? s.getRightPanelVisible(activeWorkspaceId, threadId) : false,
  );

  const togglePlanPanel = () => {
    // Plan is thread-only; the whole panel record is per-thread (ADR-0012).
    if (!threadId || !activeWorkspaceId) return;
    if (panelVisible) {
      hideRightPanelAdaptive(activeWorkspaceId, threadId);
    } else {
      showRightPanelAdaptive(activeWorkspaceId, threadId);
      useDiffStore.getState().setRightPanelTab(activeWorkspaceId, threadId, "tasks");
    }
  };

  return (
    <>
      {permissionLocked ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground"
                aria-label="Permission mode locked to Full access"
              >
                <Unlock size={14} />
                <span className="text-sm">Full access</span>
              </span>
            }
          />
          <TooltipContent>
            Cursor on Windows runs in full access — supervised mode is unavailable because cursor-agent's OS sandbox requires macOS or Linux.
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onAccessChange(access === PERMISSION_MODES.FULL ? PERMISSION_MODES.SUPERVISED : PERMISSION_MODES.FULL)}
                className="gap-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                {access === PERMISSION_MODES.FULL ? <Unlock size={14} /> : <Lock size={14} />}
                <span className="text-sm">{access === PERMISSION_MODES.FULL ? "Full access" : "Supervised"}</span>
              </Button>
            }
          />
          <TooltipContent>{access === PERMISSION_MODES.FULL ? "Full access mode" : "Supervised mode"}</TooltipContent>
        </Tooltip>
      )}

      {hasPlans && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                onClick={togglePlanPanel}
                aria-pressed={panelVisible}
                className={cn(
                  "gap-1.5 transition-colors hover:bg-muted/40",
                  panelVisible
                    ? "text-primary hover:text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <ListChecks size={14} />
                <span className="text-sm">Plan</span>
              </Button>
            }
          />
          <TooltipContent>{panelVisible ? "Hide Plan panel" : "Show Plan panel"}</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

function goalTimestampMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function formatGoalElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const remainingSeconds = safe % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatGoalDate(value: number): string {
  return new Date(goalTimestampMs(value)).toLocaleString();
}

function normalizeGoalActionError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Try again.";
}

function goalStatusLabel(status: GoalState["status"]): string {
  switch (status) {
    case "paused":
      return "Goal paused";
    case "blocked":
      return "Goal blocked";
    case "usageLimited":
      return "Usage limited";
    case "budgetLimited":
      return "Budget limited";
    case "complete":
      return "Goal complete";
    case "active":
    default:
      return "Pursuing goal";
  }
}

/** Shows the active provider goal as a compact composer capability chip. */
export function ActiveGoalChip({
  threadId,
  goal,
}: {
  threadId: string;
  goal: GoalState | null | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [isRefreshingGoal, setIsRefreshingGoal] = useState(false);
  const [isClearingGoal, setIsClearingGoal] = useState(false);
  const [lookupSource, setLookupSource] = useState<string | null>(null);
  const [lookupReason, setLookupReason] = useState<string | null>(null);
  const actionScopeRef = useRef({ threadId, refreshRequestId: 0, clearRequestId: 0 });
  const refreshThreadGoal = useThreadStore((s) => s.refreshThreadGoal);
  const clearThreadGoal = useThreadStore((s) => s.clearThreadGoal);

  useEffect(() => {
    actionScopeRef.current = {
      threadId,
      refreshRequestId: actionScopeRef.current.refreshRequestId + 1,
      clearRequestId: actionScopeRef.current.clearRequestId + 1,
    };
    setDetailsOpen(false);
    setRefreshError(false);
    setIsRefreshingGoal(false);
    setIsClearingGoal(false);
    setLookupSource(null);
    setLookupReason(null);
  }, [threadId]);

  useEffect(() => {
    if (!isGoalOpen(goal)) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [goal]);

  if (!isGoalOpen(goal)) return null;

  const createdAt = goalTimestampMs(goal.createdAt);
  const elapsed = Math.max(goal.timeUsedSeconds, Math.floor((now - createdAt) / 1000));
  const canInspect = goal.controls.canInspect === true;
  const canClear = goal.controls.canClear === true;
  const openDetails = (open: boolean) => {
    setDetailsOpen(open);
    if (!open) return;
    const refreshRequestId = actionScopeRef.current.refreshRequestId + 1;
    actionScopeRef.current = { ...actionScopeRef.current, threadId, refreshRequestId };
    setIsRefreshingGoal(true);
    setRefreshError(false);
    void refreshThreadGoal(threadId)
      .then((lookup) => {
        if (
          actionScopeRef.current.threadId !== threadId ||
          actionScopeRef.current.refreshRequestId !== refreshRequestId
        ) return;
        setLookupSource(lookup.source);
        setLookupReason(lookup.reason ?? null);
      })
      .catch(() => {
        if (
          actionScopeRef.current.threadId !== threadId ||
          actionScopeRef.current.refreshRequestId !== refreshRequestId
        ) return;
        setRefreshError(true);
      })
      .finally(() => {
        if (
          actionScopeRef.current.threadId !== threadId ||
          actionScopeRef.current.refreshRequestId !== refreshRequestId
        ) return;
        setIsRefreshingGoal(false);
      });
  };
  const handleClearGoal = () => {
    if (isClearingGoal) return;
    const refreshRequestId = actionScopeRef.current.refreshRequestId + 1;
    const clearRequestId = actionScopeRef.current.clearRequestId + 1;
    actionScopeRef.current = {
      ...actionScopeRef.current,
      threadId,
      refreshRequestId,
      clearRequestId,
    };
    setIsRefreshingGoal(false);
    setRefreshError(false);
    setIsClearingGoal(true);
    void clearThreadGoal(threadId)
      .then((lookup) => {
        if (
          actionScopeRef.current.threadId !== threadId ||
          actionScopeRef.current.clearRequestId !== clearRequestId
        ) return;
        setLookupSource(lookup.source);
        setLookupReason(lookup.reason ?? null);
        if (lookup.source === "unsupported") {
          useToastStore.getState().show(
            "error",
            "Goal controls unavailable",
            "This provider does not support app-level goal controls.",
          );
          return;
        }
        if (lookup.goal && !lookup.authoritative) {
          useToastStore.getState().show(
            "info",
            "Goal was not cleared",
            "The provider did not report an active goal to clear.",
          );
        }
      })
      .catch((error) => {
        if (
          actionScopeRef.current.threadId !== threadId ||
          actionScopeRef.current.clearRequestId !== clearRequestId
        ) return;
        useToastStore.getState().show(
          "error",
          "Could not clear goal",
          normalizeGoalActionError(error),
        );
      })
      .finally(() => {
        if (
          actionScopeRef.current.threadId !== threadId ||
          actionScopeRef.current.clearRequestId !== clearRequestId
        ) return;
        setIsClearingGoal(false);
      });
  };

  const goalLabel = (
    <span className="inline-flex items-center gap-1.5 px-2 text-xs font-semibold text-foreground">
      <Goal size={13} className="text-primary" aria-hidden />
      <span>Goal</span>
    </span>
  );

  return (
    <Popover open={detailsOpen} onOpenChange={openDetails}>
      <span
        data-testid="active-goal-chip"
        className="inline-flex h-7 shrink-0 items-center rounded-lg bg-accent/70 pr-0.5 ring-1 ring-inset ring-primary/30"
      >
        {canInspect ? (
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 gap-0 rounded-md px-0 hover:bg-accent"
                aria-label={`Show active goal: ${goal.objective}`}
              >
                {goalLabel}
              </Button>
            }
          />
        ) : goalLabel}
        {canClear ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-6 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Clear active goal"
            title="Clear active goal"
            disabled={isClearingGoal}
            onClick={handleClearGoal}
          >
            <X size={12} aria-hidden />
          </Button>
        ) : null}
      </span>
      {canInspect ? (
        <PopoverContent align="start" sideOffset={8} className="w-80 space-y-3 p-3 text-xs">
          <div className="space-y-1">
            <div className="font-medium text-foreground">{goal.objective}</div>
            <div className="text-muted-foreground">{goalStatusLabel(goal.status)}</div>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            <span>Elapsed</span>
            <span className="text-foreground">{formatGoalElapsed(elapsed)}</span>
            <span>Tokens used</span>
            <span className="text-foreground tabular-nums">{goal.tokensUsed}</span>
            {goal.tokenBudget != null ? (
              <>
                <span>Token budget</span>
                <span className="text-foreground tabular-nums">{goal.tokenBudget}</span>
              </>
            ) : null}
            <span>Goal source</span>
            <span className="text-foreground">{goal.source}</span>
            <span>Updated</span>
            <span className="text-foreground">{formatGoalDate(goal.updatedAt)}</span>
            <span>Lookup source</span>
            <span className="text-foreground">{lookupSource ?? "Refreshing"}</span>
            {lookupReason ? (
              <>
                <span>Lookup reason</span>
                <span className="text-foreground">{lookupReason}</span>
              </>
            ) : null}
          </div>
          {isRefreshingGoal || refreshError || isClearingGoal ? (
            <div className="text-muted-foreground">
              {isClearingGoal
                ? "Clearing..."
                : refreshError
                  ? "Could not refresh goal details."
                  : "Refreshing..."}
            </div>
          ) : null}
          {canClear ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={isClearingGoal}
              onClick={handleClearGoal}
            >
              {isClearingGoal ? "Clearing..." : "Clear goal"}
            </Button>
          ) : null}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/**
 * Main message composer with model/mode selectors and branch controls.
 *
 * Status bar layout varies by mode:
 * - **Direct:** `[Local v]` … `[From branch v]`
 * - **Worktree:** `[Worktree v]` … `[From branch v] [Auto v] [branch-name]`
 * - **Existing worktree:** `[Worktree v]` … `[Select worktree v]`
 * - **Locked (existing thread):** read-only branch badge
 */
export function Composer({ threadId, isNewThread, workspaceId, branchFromMessageId, branchFromMessageContent, onBranchModeExit, onThreadCreated }: ComposerProps) {
  // Mode/permissions/tasks toggles render inline when the composer's own
  // container is wide enough; below the threshold they collapse behind a
  // single overflow trigger so the send button never wraps to a new row.
  // Container-based (not viewport-based) so the layout responds to the right
  // panel opening, sidebar resizing, etc. — not just window resizes.
  const composerContainerRef = useRef<HTMLDivElement>(null);
  const composerWidth = useElementWidth(composerContainerRef);
  // Threshold tuned so model + reasoning + Chat + Full access + Tasks +
  // token-count badge + send button fit comfortably on one row with the
  // standard gaps and breathing room. Below this the row collapses to a
  // single "Composer options" trigger so the send button never gets clipped.
  // Keep the compact 600px layout behind the overflow trigger while allowing
  // the widened desktop rail to keep its inline controls.
  const COMPOSER_INLINE_OPTIONS_THRESHOLD = 640;
  // Default to inline before the first measurement lands so the first frame
  // doesn't briefly render the popover trigger and snap to inline buttons.
  const showInlineComposerOptions =
    composerWidth === 0 || composerWidth >= COMPOSER_INLINE_OPTIONS_THRESHOLD;

  const replyContext = useReplyStore((s) => threadId ? s.replyByThread[threadId] : undefined);
  const clearReply = useReplyStore((s) => s.clearReply);
  const planPreview = usePlanStore((s) =>
    threadId ? s.livePreviewByThread[threadId] : undefined,
  );
  const planPanelOpen = useDiffStore((s) => {
    if (!workspaceId || !threadId) return false;
    const panel = s.getRightPanel(workspaceId, threadId);
    return panel.visible && panel.activeTab === "tasks" && panel.openTabs.includes("tasks");
  });
  const taskBubbleTasks = useTaskStore((s) =>
    threadId ? s.taskBubbleByThread[threadId] ?? EMPTY_TASK_BUBBLE_TASKS : EMPTY_TASK_BUBBLE_TASKS,
  );
  const fileEffectSummary = useThreadStore((s) =>
    threadId ? s.records.get(threadId)?.fileEffectSummary : undefined,
  );

  const [input, setInput] = useState("");
  const [mentions, setMentions] = useState<MessageMention[]>([]);
  const [modelId, setModelId] = useState(getDefaultModelId());
  // Track provider explicitly: multiple providers share the same model IDs
  // (e.g. "gpt-5.3-codex" exists in both Codex and Copilot), so deriving the
  // provider from the model ID alone is ambiguous and routes to the wrong backend.
  const [provider, setProvider] = useState<string>(getDefaultProviderId());
  const [reasoning, setReasoning] = useState<ReasoningLevel>(getDefaultReasoningLevel());
  const [mode, setMode] = useState<InteractionMode>(INTERACTION_MODES.BUILD);
  const [goalPending, setGoalPending] = useState(false);
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestrationMode>(
    ORCHESTRATION_MODES.STANDARD,
  );
  const [copilotAgent, setCopilotAgent] = useState<string | null>(null);
  // Per-thread overrides; null/undefined means inherit from settings default.
  const [contextWindow, setContextWindow] = useState<ContextWindowMode | null>(null);
  const [thinking, setThinking] = useState<boolean | null>(null);
  /** Per-thread Codex fast mode. `null` follows global settings until the user toggles the switch. */
  const [codexFastMode, setCodexFastMode] = useState<boolean | null>(null);
  const [access, setAccess] = useState<AccessMode>(PERMISSION_MODES.FULL);
  const [showReasoningPicker, setShowReasoningPicker] = useState(false);
  const [composerMode, setComposerModeLocal] = useState<ComposerMode>("direct");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const composerMountedRef = useRef(true);
  const attachmentPreparationGenerationRef = useRef(0);
  const pendingAttachmentPreparationsRef = useRef(new Set<Promise<void>>());
  const pendingPathlessAttachmentCountRef = useRef(0);
  const attachmentPreparationFailureCountRef = useRef(0);
  const sendAfterAttachmentPreparationRef = useRef<{
    failureCount: number;
  } | null>(null);
  const [attachmentPreparationRevision, setAttachmentPreparationRevision] = useState(0);
  const isAttachmentPreparationCurrent = useCallback(
    (generation: number): boolean =>
      composerMountedRef.current && attachmentPreparationGenerationRef.current === generation,
    [],
  );
  const invalidateAttachmentPreparations = useCallback(() => {
    attachmentPreparationGenerationRef.current += 1;
    pendingAttachmentPreparationsRef.current.clear();
    pendingPathlessAttachmentCountRef.current = 0;
    sendAfterAttachmentPreparationRef.current = null;
  }, []);
  const annotationScopeId = threadId ?? workspaceId;
  const annotationRows = usePreviewAnnotationStore((s) =>
    annotationScopeId ? s.byThread[annotationScopeId] : undefined,
  );
  const diffAnnotationRows = usePreviewAnnotationStore((s) =>
    annotationScopeId ? s.diffByThread[annotationScopeId] : undefined,
  );
  const annotationCount =
    (annotationRows?.length ?? 0) + (diffAnnotationRows?.length ?? 0);
  const annotationBundleForDisplay = useMemo(
    () =>
      annotationScopeId
        ? usePreviewAnnotationStore.getState().buildBundle(annotationScopeId)
        : undefined,
    [annotationRows, annotationScopeId, diffAnnotationRows],
  );
  const setPreviewDesignModeActive = usePreviewDesignModeStore((s) => s.setActive);

  useEffect(() => {
    if (threadId && planPanelOpen) {
      usePlanStore.getState().clearLivePreview(threadId);
    }
  }, [planPanelOpen, threadId]);
  /**
   * When the user pulls a queued message back into the composer to edit, we
   * remember which message it was and what slot it held. Saving (send) and
   * cancel both use this to restore the message at its original index instead
   * of appending to the tail. Cleared on successful send, on cancel, or when
   * the user starts a totally fresh draft.
   */
  const [editingFromQueue, setEditingFromQueue] = useState<
    { messageId: string; originalIndex: number } | null
  >(null);
  /**
   * Snapshot of the original popped queued message, retained for the duration
   * of an edit so Cancel can restore the EXACT original payload (not the
   * user's in-progress edits). Cleared on save, cancel, swap, and on any
   * code path that ends edit mode.
   */
  const editingOriginalRef = useRef<QueuedMessage | null>(null);
  const restoredPreviewAnnotationsClearedRef = useRef(false);
  /**
   * Text queued for send while the child thread's handoff context is still generating.
   * Fires automatically when handoff status transitions to ready or fallback.
   */
  const [queuedSend, setQueuedSend] = useState<{
    content: string;
    displayContent: string;
    mentions: MessageMention[];
    previewAnnotations?: PreviewAnnotationBundle;
    goalObjective?: string;
    orchestrationMode?: OrchestrationMode;
  } | null>(null);
  const [pendingCheckoutConfirmation, setPendingCheckoutConfirmation] =
    useState<PendingCheckoutConfirmation | null>(null);
  const [checkoutConfirming, setCheckoutConfirming] = useState(false);
  // Tracks whether we have seen the handoff transition away from "generating"
  // at least once since this thread was opened. Guards against queueing a
  // message when the user types during the server-initiated first turn on a
  // freshly forked child thread (which would produce a duplicate message).
  const [hasSeenHandoffTransition, setHasSeenHandoffTransition] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [detectedPr, setDetectedPr] = useState<PrDetail | null>(null);
  const [prDismissed, setPrDismissed] = useState(false);
  const prDetectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editorRef = useRef<LexicalEditor | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [filePopupAnchorRect, setFilePopupAnchorRect] = useState<DOMRect | null>(null);

  const prevThreadIdRef = useRef<string | undefined>(threadId);
  const draftRef = useRef<{
    input: string;
    mentions: MessageMention[];
    attachments: PendingAttachment[];
    modelId: string;
    provider: string;
    reasoning: ReasoningLevel;
    contextWindow?: ContextWindowMode;
    thinking?: boolean;
    codexFastMode?: boolean | null;
  }>({ input, mentions, attachments, modelId, provider, reasoning });
  /** Tracks whether the user toggled mode/access before settings finished loading. */
  const agentSettingsTouchedRef = useRef(false);
  /** Set to true by the thread-switch effect; cleared by the model-sync effect.
   *  Prevents Effect 2 from overwriting Effect 1's model choice on thread switch. */
  const threadSwitchRef = useRef(false);
  /** Last thread row model or provider applied from the server (for multi-tab sync). */
  const lastServerThreadModelKeyRef = useRef("");

  useEffect(() => {
    invalidateAttachmentPreparations();
    return invalidateAttachmentPreparations;
  }, [invalidateAttachmentPreparations, isNewThread, threadId, workspaceId]);

  useEffect(() => {
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
      invalidateAttachmentPreparations();
    };
  }, [invalidateAttachmentPreparations]);

  // Keep draft ref in sync so the thread-switch effect reads current values
  useEffect(() => {
    draftRef.current = {
      input,
      mentions,
      attachments,
      modelId,
      provider,
      reasoning,
      contextWindow: contextWindow ?? undefined,
      thinking: thinking ?? undefined,
      codexFastMode,
    };
  });

  const saveDraft = useComposerDraftStore((s) => s.saveDraft);
  const getDraft = useComposerDraftStore((s) => s.getDraft);
  const clearDraftFromStore = useComposerDraftStore((s) => s.clearDraft);
  const pendingPrefill = useComposerDraftStore((s) => s.pendingPrefill);
  const clearPendingPrefill = useComposerDraftStore((s) => s.clearPendingPrefill);

  // Reactive settings: sync model/reasoning defaults when settings finish loading
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const settingsDefaultModelId = useSettingsStore((s) => s.settings.model.defaults.id);
  const settingsDefaultProvider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const settingsDefaultReasoning = useSettingsStore((s) => s.settings.model.defaults.reasoning);
  const settingsDefaultMode = useSettingsStore((s) => s.settings.agent.defaults.mode);
  const settingsDefaultPermission = useSettingsStore((s) => s.settings.agent.defaults.permission);
  const settingsDefaultContextWindow = useSettingsStore((s) => s.settings.model.defaults.contextWindow);
  const settingsDefaultThinking = useSettingsStore((s) => s.settings.model.defaults.thinking);
  const settingsGlobalCodexFast = useSettingsStore((s) => s.settings.provider.codex.fastMode === true);

  useEffect(() => {
    if (!settingsLoaded) return;
    // Only sync global defaults for new threads.
    // Existing threads restore settings from the thread record in the thread-switch effect.
    if (threadId) return;

    const validModelId = getDefaultModelId();
    setModelId(validModelId);
    setProvider(settingsDefaultProvider ?? "claude");
    setReasoning(normalizeReasoningLevelForModel(validModelId, settingsDefaultReasoning));

    if (!agentSettingsTouchedRef.current) {
      setMode(settingsDefaultMode === "plan" ? INTERACTION_MODES.PLAN : INTERACTION_MODES.BUILD);
      setAccess(settingsDefaultPermission);
    }
  }, [settingsLoaded, settingsDefaultModelId, settingsDefaultProvider, settingsDefaultReasoning, settingsDefaultMode, settingsDefaultPermission, threadId]);

  const previewReferenceQueueSignal = usePreviewReferenceQueueStore((s) => s.signal);

  // The preview panel scopes captures to `activeThreadId ?? activeWorkspaceId`
  // (RightPanel's panelScopeId), so the threadless new-thread composer must
  // drain under the workspace key or design/screenshot captures never attach.
  const previewReferenceScopeId = threadId ?? workspaceId;

  useEffect(() => {
    if (!previewReferenceScopeId) return;
    const incoming = usePreviewReferenceQueueStore
      .getState()
      .drainPreviewReferences(previewReferenceScopeId);
    if (incoming.length === 0) return;

    setAttachments((prev) => {
      const room = MAX_ATTACHMENTS - prev.length - pendingPathlessAttachmentCountRef.current;
      if (room <= 0) {
        for (const item of incoming) {
          URL.revokeObjectURL(item.previewUrl);
        }
        queueMicrotask(() =>
          useToastStore.getState().show(
            "error",
            "Composer attachment limit reached",
            "Remove an attachment before adding a preview picture reference.",
          ),
        );
        return prev;
      }

      const toAdd = incoming.slice(0, room);
      const dropped = incoming.slice(room);
      for (const item of dropped) {
        URL.revokeObjectURL(item.previewUrl);
      }
      if (dropped.length > 0) {
        queueMicrotask(() =>
          useToastStore.getState().show(
            "error",
            "Composer attachment limit reached",
            `${dropped.length} preview reference(s) were not added.`,
          ),
        );
      }

      return [...prev, ...toAdd];
    });
  }, [previewReferenceScopeId, previewReferenceQueueSignal]);

  // Reset reasoning when the selected model does not support the current level
  useEffect(() => {
    const normalized = normalizeReasoningLevelForModel(modelId, reasoning);
    if (normalized !== reasoning) {
      setReasoning(normalized);
    }
  }, [modelId, reasoning]);

  // Save draft for previous thread, restore draft for new thread
  useEffect(() => {
    const prev = prevThreadIdRef.current;

    // Save current draft for the thread we're leaving (but not if the thread was deleted)
    if (prev && prev !== threadId) {
      const threadStillExists = useWorkspaceStore.getState().threads.some((t) => t.id === prev);
      if (threadStillExists) {
        saveDraft(prev, snapshotComposerDraft(draftRef.current));
      } else {
        // Thread was deleted; revoke any attachment blob URLs from the outgoing draft
        for (const att of draftRef.current.attachments) {
          if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
        }
        const orphanSpills = collectSpillPathsFromPendingAttachments(draftRef.current.attachments);
        if (orphanSpills.length > 0) void releaseBrowserCaptureSpills(orphanSpills);
      }
    }

    const session = resolveComposerSession({
      threadId,
      getDraft,
      threadRow: threadId ? readWorkspaceThread(threadId) : undefined,
      threadSettings: threadId
        ? (() => {
            const s = useThreadStore.getState().getThreadSettings(threadId);
            return {
              interactionMode: s.interactionMode,
              orchestrationMode: s.orchestrationMode,
              permissionMode: s.permissionMode,
              copilotAgent: s.copilotAgent ?? null,
              contextWindow: s.contextWindow ?? null,
              thinking: s.thinking ?? null,
              codexFastMode: s.codexFastMode ?? null,
            };
          })()
        : {
            interactionMode: INTERACTION_MODES.BUILD,
            orchestrationMode: ORCHESTRATION_MODES.STANDARD,
            permissionMode: PERMISSION_MODES.FULL,
            copilotAgent: null,
            contextWindow: null,
            thinking: null,
            codexFastMode: null,
          },
      globalDefaults: (() => {
        const { settings } = useSettingsStore.getState();
        return {
          interactionMode:
            settings.agent.defaults.mode === "plan"
              ? INTERACTION_MODES.PLAN
              : INTERACTION_MODES.BUILD,
          permissionMode: settings.agent.defaults.permission,
        };
      })(),
    });

    setInput(session.input);
    setMentions(session.mentions);
    setAttachments(session.attachments);
    setModelId(session.modelId);
    setProvider(session.provider);
    setReasoning(session.reasoning);
    setMode(session.interactionMode);
    setOrchestrationMode(
      threadId
        ? useThreadStore.getState().getThreadSettings(threadId).orchestrationMode ?? ORCHESTRATION_MODES.STANDARD
        : ORCHESTRATION_MODES.STANDARD,
    );
    setAccess(session.permissionMode);
    setCopilotAgent(session.copilotAgent);
    setContextWindow(session.contextWindow);
    setThinking(session.thinking);
    setCodexFastMode(session.codexFastMode);

    if (editorRef.current) {
      writeComposerContent(editorRef.current, session.input, session.mentions);
    }

    if (!threadId) {
      agentSettingsTouchedRef.current = false;
      if (isNewThread) {
        queueMicrotask(() => {
          editorRef.current?.focus();
        });
      }
    }

    threadSwitchRef.current = true;
    prevThreadIdRef.current = threadId;
  }, [threadId, isNewThread, saveDraft, getDraft]);

  const persistedInteractionMode = useThreadRecord(threadId, (r) => r.settings.interactionMode);
  const persistedOrchestrationMode = useThreadRecord(
    threadId,
    (record) => record.settings.orchestrationMode,
  );
  const threadRecordInteractionMode = useWorkspaceThread(threadId, (t) => {
    const mode = t?.interaction_mode;
    return mode === "plan" || mode === "build" ? mode : undefined;
  });

  // Sync mode when thread settings change in-place (e.g. Plan tab Implement).
  useEffect(() => {
    if (!threadId) return;
    const resolved = persistedInteractionMode ?? threadRecordInteractionMode;
    if (resolved === INTERACTION_MODES.PLAN || resolved === INTERACTION_MODES.BUILD) {
      setMode(resolved);
    }
  }, [threadId, persistedInteractionMode, threadRecordInteractionMode]);

  useEffect(() => {
    if (!threadId || persistedOrchestrationMode === undefined) return;
    setOrchestrationMode(persistedOrchestrationMode);
  }, [threadId, persistedOrchestrationMode]);

  // Selectors needed by the branch-mode effect below — must be declared before the effect
  // to avoid temporal dead zone errors in the dependency array.
  const loadBranches = useWorkspaceStore((s) => s.loadBranches);
  const loadWorktrees = useWorkspaceStore((s) => s.loadWorktrees);
  const initBranchMode = useWorkspaceStore((s) => s.initBranchMode);

  // Reset branch-specific exec state and load branch/worktree data when branch mode activates.
  // loadBranches/loadWorktrees are safe to call unconditionally — the server
  // returns empty results for non-git workspaces via ws-router guards.
  useEffect(() => {
    if (branchFromMessageId && workspaceId) {
      initBranchMode(activeThread);
      loadBranches(workspaceId);
      loadWorktrees(workspaceId);
    }
  // activeThread is intentionally read at call time, not as a dependency.
  // Branch mode only activates via a user gesture on a fully-loaded thread,
  // so activeThread is always current when branchFromMessageId is set.
  }, [branchFromMessageId, workspaceId, loadBranches, loadWorktrees, initBranchMode]);

  // Pre-fill the editor with the parent user message text when forking from a user message.
  // The text is rendered italic to visually distinguish the prefill from fresh input.
  // Assistant-message forks leave the editor empty; the user writes the new prompt from scratch.
  useEffect(() => {
    if (!branchFromMessageId || !branchFromMessageContent || !editorRef.current) return;
    const text = branchFromMessageContent;
    writeComposerContent(editorRef.current, text, [], true);
    setInput(branchFromMessageContent);
    setMentions([]);
    editorRef.current.focus();
  // Only fire when branch mode is newly activated (branchFromMessageId transitions from falsy to truthy).
  }, [branchFromMessageId]);

  // Consume pending prefill set by empty-state prompt chips
  useEffect(() => {
    if (!pendingPrefill) return;
    setInput(pendingPrefill);
    setMentions([]);
    if (editorRef.current) {
      writeComposerContent(editorRef.current, pendingPrefill);
      clearPendingPrefill();
      editorRef.current.focus();
    }
  }, [pendingPrefill, clearPendingPrefill]);

  const composerRecallFromStop = useThreadRecord(threadId, (r) => r.composerRecallFromStop);
  const clearComposerRecallFromStop = useThreadStore((s) => s.clearComposerRecallFromStop);

  useEffect(() => {
    if (!composerRecallFromStop || !threadId) return;
    const text = composerRecallFromStop.text;
    clearComposerRecallFromStop(threadId);
    setInput(text);
    setMentions([]);
    if (editorRef.current) {
      writeComposerContent(editorRef.current, text);
      editorRef.current.focus();
    }
  }, [composerRecallFromStop, threadId, clearComposerRecallFromStop]);

  // Ref to the latest queuedSend value so the handoff-fire effect doesn't need it as
  // a reactive dep (which would re-run the effect on every keystroke while queued).
  const queuedSendRef = useRef<typeof queuedSend>(null);
  queuedSendRef.current = queuedSend;

  const sendMessage = useThreadStore((s) => s.sendMessage);
  const stopAgent = useThreadStore((s) => s.stopAgent);
  const branchThread = useWorkspaceStore((s) => s.branchThread);
  // Subscribe to just the boolean for this thread instead of the full Set.
  // Avoids Composer re-renders when other threads start/stop their agents.
  const isAgentRunning = useThreadStore(
    (s) => threadId ? s.runningThreadIds.has(threadId) : false,
  );
  const setThreadSettings = useThreadStore((s) => s.setThreadSettings);

  // Cursor on Windows has no usable supervised mode (cursor-agent's OS
  // sandbox requires macOS/Linux and `--print` mode has no per-tool
  // prompts). Hide the toggle and force Full access. See
  // {@link isCursorPermissionLockedToFull}.
  const permissionLocked = isCursorPermissionLockedToFull(provider, isWindows);
  useEffect(() => {
    if (permissionLocked && access !== PERMISSION_MODES.FULL) {
      setAccess(PERMISSION_MODES.FULL);
      agentSettingsTouchedRef.current = true;
      if (threadId) void setThreadSettings(threadId, { permissionMode: PERMISSION_MODES.FULL });
    }
  }, [permissionLocked, access, threadId, setThreadSettings]);
  const contextEntry = useThreadRecord(threadId, (r) => r.context);
  const isCompacting = useThreadRecord(threadId, (r) => r.isCompacting);
  const handoffStatus = useThreadStore((s) =>
    threadId ? getHandoffStatus(getThreadRecord(s.records, threadId)) : undefined,
  );
  const hasRetryState = useThreadRecord(
    threadId,
    (r) => !!(r.rateLimit || r.apiRetry),
  );
  const planPending = useThreadRecord(
    threadId,
    (r) => r.planQuestionsStatus === "pending",
  );
  const activeGoal = useThreadRecord(threadId, (r) => r.goal ?? null);

  useEffect(() => {
    if (isGoalOpen(activeGoal)) setGoalPending(false);
  }, [activeGoal]);

  const activeThread = useWorkspaceThread(threadId, (t) => t);
  const isThreadScaffold = !!(
    activeThread?.clientPreparing || activeThread?.clientError
  );

  const activeProviderId = activeThread?.provider ?? "claude";
  const usageInfo = useThreadRecord(threadId, (r) => r.usageByProvider[activeProviderId]);
  const hasLowQuota = usageInfo?.quotaCategories.some((c) => !c.isUnlimited && c.remainingPercent < 0.2) ?? false;

  // Composer selection is authoritative. On existing threads the persisted row
  // updates on send, so reading it here would leave capability menus one switch behind.
  const effectiveProviderId = provider as ProviderId;
  const composerCapabilities = useMemo(
    () => resolveComposerCapabilities({ providerId: effectiveProviderId, modelId }),
    [effectiveProviderId, modelId],
  );
  const planCapability = composerCapabilities.find((capability) => capability.id === "plan");
  const goalCapability = composerCapabilities.find((capability) => capability.id === "goal");
  const orchestrationCapability = composerCapabilities.find(
    (capability) => capability.id === "orchestration",
  );
  const attachedCapabilityIds = useMemo(() => {
    const ids = new Set<ComposerCapabilityId>();
    if (mode === INTERACTION_MODES.PLAN) ids.add("plan");
    if (goalPending || isGoalOpen(activeGoal)) ids.add("goal");
    if (orchestrationMode === ORCHESTRATION_MODES.PROACTIVE) ids.add("orchestration");
    return ids;
  }, [activeGoal, goalPending, mode, orchestrationMode]);
  const goalAvailable = goalCapability !== undefined;
  const orchestrationLabel = orchestrationCapability?.label;
  const availability = useProviderAvailabilityStore((s) => s.getAvailability(effectiveProviderId));
  const providerUnusable = !!availability && (
    !availability.enabled || availability.cli.status === "not_found"
  );
  const providerReason: "disabled" | "cli_missing" | null = providerUnusable
    ? (!availability!.enabled ? "disabled" : "cli_missing")
    : null;
  const selectedCatalogWorktreePath = useWorkspaceStore(
    (state) => state.selectedWorktree?.path,
  );
  // Optimistic thread rows are client-only shells. Provider discovery and file
  // listing must stay at workspace scope until the server row replaces them;
  // otherwise the placeholder ID/path can leak into eager catalog requests.
  const catalogThreadId = activeThread?.clientPreparing || isNewThread
    ? undefined
    : threadId;
  const catalogCwd = activeThread?.clientPreparing
    ? undefined
    : isNewThread && composerMode === "existing-worktree"
      ? selectedCatalogWorktreePath
      : activeThread?.worktree_path ?? undefined;

  const fileAutocomplete = useFileAutocomplete({
    workspaceId,
    threadId: catalogThreadId,
    providerId: effectiveProviderId,
    cwd: catalogCwd,
  });

  const handleMentionSelect = useCallback((item: MentionSuggestion) => {
    fileAutocomplete.selectSuggestion(item);
    if (!editorRef.current) return;

    const mention: MentionNodeData =
      item.kind === "agent"
        ? {
            id: createMentionId(),
            kind: "agent",
            label: item.label,
            name: item.name,
            path: item.path,
            provider: item.provider,
          }
        : item.kind === "plugin"
          ? {
              id: createMentionId(),
              kind: "plugin",
              label: item.label,
              name: item.name,
              path: item.path,
            }
        : {
            id: createMentionId(),
            kind: "file",
            label: item.label,
            path: item.path,
          };

    insertMentionNode(
      editorRef.current,
      mention,
      fileAutocomplete.triggerStart,
      fileAutocomplete.query.length,
    );
  }, [fileAutocomplete]);

  const filePopup = useFileTagPopup({
    items: fileAutocomplete.suggestions,
    query: fileAutocomplete.query,
    isOpen: fileAutocomplete.isOpen,
    onSelect: handleMentionSelect,
    onDismiss: fileAutocomplete.dismiss,
  });

  useEffect(() => {
    if (!fileAutocomplete.isOpen) {
      setFilePopupAnchorRect(null);
      return;
    }
    setFilePopupAnchorRect(composerContainerRef.current?.getBoundingClientRect() ?? null);
  }, [fileAutocomplete.isOpen]);

  const attachPlan = useCallback(() => {
    setMode(INTERACTION_MODES.PLAN);
    agentSettingsTouchedRef.current = true;
    if (threadId) void setThreadSettings(threadId, { interactionMode: INTERACTION_MODES.PLAN });
    editorRef.current?.focus();
  }, [setMode, threadId, setThreadSettings]);

  const detachPlan = useCallback(() => {
    setMode(INTERACTION_MODES.BUILD);
    agentSettingsTouchedRef.current = true;
    if (threadId) void setThreadSettings(threadId, { interactionMode: INTERACTION_MODES.BUILD });
    editorRef.current?.focus();
  }, [setMode, threadId, setThreadSettings]);

  const attachGoal = useCallback(() => {
    if (!goalAvailable || isGoalOpen(activeGoal)) return;
    setGoalPending(true);
    editorRef.current?.focus();
  }, [activeGoal, goalAvailable]);

  const detachPendingGoal = useCallback(() => {
    setGoalPending(false);
    editorRef.current?.focus();
  }, []);

  const attachOrchestration = useCallback(() => {
    if (!orchestrationLabel) return;
    setOrchestrationMode(ORCHESTRATION_MODES.PROACTIVE);
    if (threadId) {
      void setThreadSettings(threadId, {
        orchestrationMode: ORCHESTRATION_MODES.PROACTIVE,
      });
    }
    editorRef.current?.focus();
  }, [orchestrationLabel, setThreadSettings, threadId]);

  const detachOrchestration = useCallback(() => {
    setOrchestrationMode(ORCHESTRATION_MODES.STANDARD);
    if (threadId) {
      void setThreadSettings(threadId, {
        orchestrationMode: ORCHESTRATION_MODES.STANDARD,
      });
    }
    editorRef.current?.focus();
  }, [setThreadSettings, threadId]);

  const attachComposerCapability = useCallback(
    (capabilityId: ComposerCapabilityId) => {
      if (capabilityId === "plan") {
        attachPlan();
      } else if (capabilityId === "goal") {
        attachGoal();
      } else {
        attachOrchestration();
      }
    },
    [attachGoal, attachOrchestration, attachPlan],
  );

  useEffect(() => {
    if (mode !== INTERACTION_MODES.PLAN || planCapability) return;
    detachPlan();
    useToastStore.getState().show(
      "info",
      "Plan removed",
      "The selected provider manages Plan through its own agent selector.",
    );
  }, [detachPlan, mode, planCapability]);

  useEffect(() => {
    if (!goalPending || goalCapability) return;
    setGoalPending(false);
    useToastStore.getState().show(
      "info",
      "Goal removed",
      "The selected provider does not support this capability.",
    );
  }, [goalCapability, goalPending]);

  useEffect(() => {
    if (orchestrationMode !== ORCHESTRATION_MODES.PROACTIVE || orchestrationLabel) return;
    setOrchestrationMode(ORCHESTRATION_MODES.STANDARD);
    if (threadId) {
      void setThreadSettings(threadId, {
        orchestrationMode: ORCHESTRATION_MODES.STANDARD,
      });
    }
    useToastStore.getState().show(
      "info",
      "Orchestration removed",
      "The selected provider or model does not support this capability.",
    );
  }, [orchestrationLabel, orchestrationMode, setThreadSettings, threadId]);

  const branches = useWorkspaceStore((s) => s.branches);
  const branchesLoading = useWorkspaceStore((s) => s.branchesLoading);
  const newThreadMode = useWorkspaceStore((s) => s.newThreadMode);
  const newThreadBranch = useWorkspaceStore((s) => s.newThreadBranch);
  const newThreadBranchSource = useWorkspaceStore((s) => s.newThreadBranchSource);
  const setNewThreadMode = useWorkspaceStore((s) => s.setNewThreadMode);
  const setNewThreadBranch = useWorkspaceStore((s) => s.setNewThreadBranch);
  const setNewThreadBranchFromPr = useWorkspaceStore((s) => s.setNewThreadBranchFromPr);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);

  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const clearActiveProject = useCallback(() => {
    setActiveWorkspace(null);
  }, [setActiveWorkspace]);
  const isGitRepo = activeWorkspace?.is_git_repo ?? false;
  const needsWorkspace = Boolean(isNewThread && !workspaceId);

  const modeOptions = useMemo<ModeOption[]>(
    () => isGitRepo ? ALL_MODE_OPTIONS : ALL_MODE_OPTIONS.filter((o) => o.value === "direct"),
    [isGitRepo],
  );

  const slashCommand = useSlashCommand({
    anchorRef: composerContainerRef,
    workspaceId: workspaceId ?? undefined,
    threadId: catalogThreadId,
    providerId: effectiveProviderId,
    modelId,
    onMcodeCommand: (action) => {
      if (action === "attach-plan") {
        attachPlan();
      } else if (action === "attach-goal") {
        attachGoal();
      } else if (action === "attach-orchestration") {
        attachOrchestration();
      }
    },
  });
  const worktrees = useWorkspaceStore((s) => s.worktrees);
  const worktreesLoading = useWorkspaceStore((s) => s.worktreesLoading);
  const selectedWorktree = useWorkspaceStore((s) => s.selectedWorktree);
  const setSelectedWorktree = useWorkspaceStore((s) => s.setSelectedWorktree);
  const branchExecMode = useWorkspaceStore((s) => s.branchExecMode);
  const branchTargetBranch = useWorkspaceStore((s) => s.branchTargetBranch);
  const branchWorktreePath = useWorkspaceStore((s) => s.branchWorktreePath);
  const setBranchExecMode = useWorkspaceStore((s) => s.setBranchExecMode);
  const setBranchTargetBranch = useWorkspaceStore((s) => s.setBranchTargetBranch);
  const setBranchWorktreePath = useWorkspaceStore((s) => s.setBranchWorktreePath);
  const openPrs = useWorkspaceStore((s) => s.openPrs);
  const openPrsLoading = useWorkspaceStore((s) => s.openPrsLoading);
  const fetchingBranch = useWorkspaceStore((s) => s.fetchingBranch);
  const loadOpenPrs = useWorkspaceStore((s) => s.loadOpenPrs);
  const fetchBranch = useWorkspaceStore((s) => s.fetchBranch);
  const selectedWorktreeIsDetached = isDetachedWorktree(selectedWorktree);
  const branchSelectedWorktree = useMemo(
    () => {
      const normalizedPath = normalizeWorktreePath(branchWorktreePath);
      return worktrees.find((wt) => normalizeWorktreePath(wt.path) === normalizedPath) ?? null;
    },
    [worktrees, branchWorktreePath],
  );
  const branchWorktreeIsDetached = isDetachedWorktree(branchSelectedWorktree);

  // Sync modelId + provider if thread record changes server-side (e.g. from another client).
  // Does NOT fire on SDK model fallback — fallback is stored transiently and does not
  // mutate thread.model, so the picker stays at the user's intended model.
  useEffect(() => {
    if (!activeThread?.model) return;
    if (threadSwitchRef.current) {
      threadSwitchRef.current = false;
      lastServerThreadModelKeyRef.current = `${activeThread.model}\0${(activeThread.provider ?? "claude") as string}`;
      return;
    }
    const hasDraft = threadId ? getDraft(threadId) != null : false;
    const isRunning = threadId ? useThreadStore.getState().runningThreadIds.has(threadId) : false;
    if (hasDraft && !isRunning) return;
    const threadModel = activeThread.model;
    const threadProv = (activeThread.provider ?? "claude") as string;
    const serverKey = `${threadModel}\0${threadProv}`;
    const serverRowChanged = lastServerThreadModelKeyRef.current !== serverKey;
    lastServerThreadModelKeyRef.current = serverKey;
    if (
      !isRunning &&
      !serverRowChanged &&
      (modelId !== threadModel || provider !== threadProv)
    ) {
      return;
    }
    setModelId(threadModel);
    if (activeThread.provider) setProvider(activeThread.provider as string);
    // Intentionally omit modelId/provider: this effect should run when the thread row
    // changes, not when the user edits the picker (local drift while serverKey is stable).
  }, [activeThread?.model, activeThread?.provider, threadId, getDraft]);

  // Combined setter that keeps local + store in sync
  const setComposerMode = useCallback(
    (mode: ComposerMode) => {
      setComposerModeLocal(mode);
      setNewThreadMode(mode);
      rememberComposerMode(mode);
      if (mode === "existing-worktree" && workspaceId) {
        loadWorktrees(workspaceId);
      }
    },
    [setNewThreadMode, loadWorktrees, workspaceId],
  );

  // Resolve capability and thread state together so a remembered worktree mode
  // cannot fight the direct-only constraint of a non-git project.
  useEffect(() => {
    const targetMode = isNewThread
      ? (isGitRepo ? newThreadMode : "direct")
      : (activeThread?.mode === "worktree" ? "worktree" : "direct");
    if (composerMode !== targetMode) {
      setComposerModeLocal(targetMode);
    }
  }, [activeThread?.mode, composerMode, isGitRepo, isNewThread, newThreadMode]);

  // Load branches when entering new thread mode (always refresh to pick up live changes)
  useEffect(() => {
    if (isNewThread && workspaceId && isGitRepo) {
      loadBranches(workspaceId);
    }
  }, [isNewThread, workspaceId, isGitRepo, loadBranches]);

  // Auto-focus the editor when this mounts as a new-thread composer so the
  // user can start typing immediately after picking a project (from the
  // cold-start landing or the palette) without reaching for the mouse.
  // rAF gives Lexical a tick to register the editor ref before we focus.
  useEffect(() => {
    if (!isNewThread) return;
    const id = requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [isNewThread]);

  // Auto-select current branch if none selected
  useEffect(() => {
    if (isNewThread && !newThreadBranch && branches.length > 0) {
      const current = branches.find((b) => b.isCurrent);
      if (current) setNewThreadBranch(current.name);
    }
  }, [isNewThread, newThreadBranch, branches, setNewThreadBranch]);

  // Load open PRs when in worktree mode
  useEffect(() => {
    if (isNewThread && workspaceId && composerMode === "worktree") {
      loadOpenPrs(workspaceId);
    }
  }, [isNewThread, workspaceId, composerMode, loadOpenPrs]);

  // Detect GitHub PR URLs pasted into the input (debounced 500ms)
  useEffect(() => {
    if (prDetectTimeoutRef.current) {
      clearTimeout(prDetectTimeoutRef.current);
    }

    if (prDismissed || !isNewThread || !isGitRepo) {
      return;
    }

    const match = input.match(/https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    if (!match) {
      setDetectedPr(null);
      return;
    }

    const url = match[0];
    prDetectTimeoutRef.current = setTimeout(async () => {
      try {
        const pr = await getTransport().getPrByUrl(url);
        setDetectedPr(pr);
      } catch {
        setDetectedPr(null);
      }
    }, 500);

    return () => {
      if (prDetectTimeoutRef.current) {
        clearTimeout(prDetectTimeoutRef.current);
      }
    };
  }, [input, prDismissed, isNewThread]);

  const hasContent = input.trim().length > 0 || attachments.length > 0 || annotationCount > 0;

  // Detect stale worktree: thread is a worktree thread but its directory no longer exists.
  // Only check when worktrees have been loaded for THIS thread's workspace to avoid
  // false positives from cross-workspace comparisons or pre-load empty state.
  const worktreesLoadedForWorkspace = useWorkspaceStore((s) => s.worktreesLoadedForWorkspace);
  const isStaleWorktree = useMemo(() => {
    if (!activeThread?.worktree_path || activeThread.mode !== "worktree") return false;
    if (worktreesLoadedForWorkspace !== activeThread.workspace_id) return false;
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    return !worktrees.some((wt) => norm(wt.path) === norm(activeThread.worktree_path!));
  }, [activeThread, worktrees, worktreesLoadedForWorkspace]);

  // Full lock when agent running, unless the user is branching (child thread is independent).
  const isModelFullyLocked = isAgentRunning && !branchFromMessageId;
  // Lock provider on any persisted thread except the branching composer. Rows always have
  // `provider`; `model` stays null until the first sendMessage transaction runs, which is easy
  // to race now that createAndSend returns before sendMessage finishes.
  const isProviderLocked =
    Boolean(threadId && !isNewThread && !branchFromMessageId && activeThread?.provider);

  // Close dropdowns on click outside
  useEffect(() => {
    const handleClickOutside = () => {
      setShowReasoningPicker(false);
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  // Dismiss reply when the user clicks outside both the composer and any message bubble.
  // Portaled overlays (popovers, dropdowns) render outside the composer DOM tree,
  // so we also check for popover-content markers to avoid false dismissals.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!threadId) return;
      const target = e.target as Element;
      const composerEl = composerContainerRef.current;
      if (composerEl && !composerEl.contains(target)) {
        if (target.closest?.("[data-message-id]")) return;
        if (target.closest?.('[data-slot="popover-content"], [role="dialog"], [role="listbox"], [role="menu"]')) return;
        clearReply(threadId);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [threadId, clearReply]);

  const handleStop = useCallback(() => {
    if (threadId) {
      stopAgent(threadId);
    }
  }, [threadId, stopAgent]);

  const resolveEditingPreviewAnnotations = useCallback(
    (currentPreviewAnnotations: PreviewAnnotationBundle | undefined) =>
      currentPreviewAnnotations ??
      (editingFromQueue && !restoredPreviewAnnotationsClearedRef.current
        ? editingOriginalRef.current?.previewAnnotations
        : undefined),
    [editingFromQueue],
  );

  /**
   * Build a fresh queue payload from the current composer state. Mirrors the
   * shape that `handleSend`'s queue path constructs - used by the edit-swap
   * code paths so an in-progress edit can be put back into the queue without
   * traversing the full send pipeline.
   */
  const captureComposerForRequeue = useCallback(
    (
      attachmentsSnapshot: PendingAttachment[],
      inputSnapshot: string,
      mentionsSnapshot: MessageMention[],
    ): Omit<QueuedMessage, "id" | "queuedAt"> => {
      const attachmentMetas: AttachmentMeta[] = attachmentsSnapshot.map((att) => ({
        id: att.id,
        name: att.name,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
        sourcePath: att.filePath ?? "",
      }));
      const trimmedInput = inputSnapshot.trim();
      const currentPreviewAnnotations = annotationScopeId
        ? usePreviewAnnotationStore.getState().buildBundle(annotationScopeId)
        : undefined;
      const effectivePreviewAnnotations =
        resolveEditingPreviewAnnotations(currentPreviewAnnotations);
      return {
        content: trimmedInput,
        displayContent: trimmedInput,
        mentions: mentionsSnapshot.length > 0 ? mentionsSnapshot : undefined,
        previewAnnotations: effectivePreviewAnnotations,
        attachments: attachmentMetas,
        model: modelId,
        permissionMode: access,
        reasoningLevel: reasoning,
        orchestrationMode,
        provider,
        copilotAgent: provider === "copilot" ? (copilotAgent ?? undefined) : undefined,
        contextWindow: contextWindow ?? undefined,
        thinking: thinking ?? undefined,
        codexFastMode:
          provider === "codex" ? (codexFastMode === null ? undefined : codexFastMode) : undefined,
        goalObjective: goalPending ? trimmedInput : undefined,
        replyToMessageId: replyContext?.messageId,
        quotedText: replyContext?.quotedText,
      };
    },
    [
      annotationScopeId,
      resolveEditingPreviewAnnotations,
      modelId,
      access,
      reasoning,
      orchestrationMode,
      provider,
      copilotAgent,
      contextWindow,
      thinking,
      codexFastMode,
      goalPending,
      replyContext,
    ],
  );

  /**
   * Move a queued message back into the live composer so the user can edit it
   * (text + attachments + per-turn settings) using the full Lexical editor.
   * Pops the message from the queue; the next submit re-queues at the same
   * slot if the agent is still running, or sends normally if it has gone idle.
   *
   * Swap semantics: if the composer is already editing a different queued
   * message (or just holds non-empty content from a prior edit), the
   * in-progress content is put BACK into the queue at its original slot
   * before the new message is loaded. Nothing is silently destroyed.
   *
   * Attachments are rehydrated AttachmentMeta -> PendingAttachment best-effort:
   * blob preview URLs are not reconstructed (the file still lives at
   * `sourcePath`), and the AttachmentPreview falls through to the file tile.
   * Browser-capture spill JSON is released here - users re-capture if needed.
   */
  const loadIntoComposer = useCallback(
    (msg: QueuedMessage) => {
      if (!threadId) return;

      // Capture the new target's index BEFORE we mutate the queue, so the
      // edited version goes back to the same slot on save.
      const beforeQueue = useQueueStore.getState().queues[threadId] ?? [];
      const targetIndex = beforeQueue.findIndex((m) => m.id === msg.id);
      if (targetIndex === -1) return;

      invalidateAttachmentPreparations();

      // If we were already editing a queued message, hand the in-progress
      // content back to the queue at its original slot before swapping in
      // the new one.
      if (editingFromQueue && (input.trim().length > 0 || attachments.length > 0)) {
        const payload = captureComposerForRequeue(attachments, input, mentions);
        useQueueStore.getState().insertAt(
          threadId,
          editingFromQueue.originalIndex,
          payload,
        );
      }

      const popped = useQueueStore.getState().popMessage(threadId, msg.id);
      if (!popped) return;

      editingOriginalRef.current = popped;
      restoredPreviewAnnotationsClearedRef.current = false;
      setEditingFromQueue({ messageId: popped.id, originalIndex: targetIndex });
      useQueueStore.getState().setEditingThreadId(threadId);

      const text = stripPreviewAnnotationFence(popped.displayContent || popped.content);
      const poppedMentions = popped.mentions ?? [];
      setInput(text);
      setMentions(poppedMentions);
      if (editorRef.current) {
        writeComposerContent(editorRef.current, text, poppedMentions);
      }

      if (popped.attachments.length > 0) {
        const pending: PendingAttachment[] = popped.attachments.map((meta) => ({
          id: meta.id,
          name: meta.name,
          mimeType: meta.mimeType,
          sizeBytes: meta.sizeBytes,
          previewUrl: "",
          filePath: meta.sourcePath || null,
          contextOnly: isVirtualBrowserContextAttachment(meta.mimeType),
        }));
        setAttachments(pending);
      } else {
        setAttachments([]);
      }

      if (popped.model) setModelId(popped.model);
      if (popped.provider) setProvider(popped.provider);
      if (popped.reasoningLevel) setReasoning(popped.reasoningLevel);
      if (popped.orchestrationMode) setOrchestrationMode(popped.orchestrationMode);
      if (popped.permissionMode) setAccess(popped.permissionMode);
      setCopilotAgent(popped.copilotAgent ?? null);
      setContextWindow(popped.contextWindow ?? null);
      setThinking(popped.thinking ?? null);
      setCodexFastMode(popped.codexFastMode !== undefined ? popped.codexFastMode : null);
      setGoalPending(Boolean(popped.goalObjective));

      if (popped.browserCaptureSpillPaths?.length) {
        void releaseBrowserCaptureSpills(popped.browserCaptureSpillPaths);
      }

      if (annotationScopeId) {
        const restored = usePreviewAnnotationStore
          .getState()
          .restoreBundle(annotationScopeId, popped.previewAnnotations);
        setPreviewDesignModeActive(
          annotationScopeId,
          restored && Boolean(popped.previewAnnotations?.annotations.length),
        );
      }

      editorRef.current?.focus();
    },
    [
      threadId,
      annotationScopeId,
      editingFromQueue,
      input,
      attachments,
      mentions,
      captureComposerForRequeue,
      invalidateAttachmentPreparations,
      setInput,
      setAttachments,
      setModelId,
      setProvider,
      setReasoning,
      setAccess,
      setCopilotAgent,
      setContextWindow,
      setThinking,
      setCodexFastMode,
      setPreviewDesignModeActive,
    ],
  );

  /**
   * Exit edit mode without saving changes: restore the ORIGINAL queued
   * message (discarding any in-progress edits) at its original slot and
   * clear the composer. Matches the typical "Cancel = discard changes"
   * affordance. The snapshot of the original payload was captured by
   * loadIntoComposer; if it is missing we degrade to a no-op rather than
   * persisting the user's half-written edits as if they were authoritative.
   */
  const cancelEditFromQueue = useCallback(() => {
    if (!threadId || !editingFromQueue) return;
    invalidateAttachmentPreparations();
    const original = editingOriginalRef.current;
    if (original) {
      useQueueStore.getState().insertAt(threadId, editingFromQueue.originalIndex, {
        content: original.content,
        displayContent: original.displayContent,
        mentions: original.mentions,
        previewAnnotations: original.previewAnnotations,
        attachments: original.attachments,
        model: original.model,
        permissionMode: original.permissionMode,
        reasoningLevel: original.reasoningLevel,
        provider: original.provider,
        copilotAgent: original.copilotAgent,
        contextWindow: original.contextWindow,
        thinking: original.thinking,
        codexFastMode: original.codexFastMode,
        replyToMessageId: original.replyToMessageId,
        quotedText: original.quotedText,
        browserCaptureSpillPaths: original.browserCaptureSpillPaths,
      });
    }
    editingOriginalRef.current = null;
    restoredPreviewAnnotationsClearedRef.current = false;
    setEditingFromQueue(null);
    useQueueStore.getState().setEditingThreadId(null);
    if (annotationScopeId) {
      usePreviewAnnotationStore.getState().clearThread(annotationScopeId);
      setPreviewDesignModeActive(annotationScopeId, false);
    }
    scheduleDrainAfterEdit(threadId);
    setInput("");
    setMentions([]);
    setAttachments([]);
    if (editorRef.current) {
      editorRef.current.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
      });
    }
  }, [
    threadId,
    annotationScopeId,
    editingFromQueue,
    invalidateAttachmentPreparations,
    setInput,
    setAttachments,
    setPreviewDesignModeActive,
  ]);

  const handleFetchAndSelect = useCallback(async (branch: string, prNumber: number) => {
    if (!workspaceId) return;
    await fetchBranch(workspaceId, branch, prNumber);
    setNewThreadBranchFromPr(branch);
  }, [workspaceId, fetchBranch, setNewThreadBranchFromPr]);

  const handlePrReview = useCallback(async () => {
    if (!detectedPr || !workspaceId) return;
    setComposerMode("worktree");
    await fetchBranch(workspaceId, detectedPr.branch, detectedPr.number);
    setNewThreadBranchFromPr(detectedPr.branch);
    const prefill = `Review PR #${detectedPr.number}: ${detectedPr.title}`;
    setInput(prefill);
    setMentions([]);
    // Also populate the Lexical editor so the user sees the prefilled text
    if (editorRef.current) writeComposerContent(editorRef.current, prefill);
    setDetectedPr(null);
    setPrDismissed(false);
  }, [detectedPr, workspaceId, setComposerMode, fetchBranch, setNewThreadBranchFromPr]);

  const appendAttachments = useCallback((nextAttachments: PendingAttachment[]) => {
    if (nextAttachments.length === 0) return;
    setAttachments((prev) => {
      const remaining = MAX_ATTACHMENTS - prev.length;
      const accepted = remaining > 0 ? nextAttachments.slice(0, remaining) : [];
      for (const attachment of nextAttachments.slice(accepted.length)) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      return accepted.length > 0 ? [...prev, ...accepted] : prev;
    });
  }, []);

  const preparePathlessAttachments = useCallback((files: File[]) => {
    const generation = attachmentPreparationGenerationRef.current;
    const reservedAttachmentCount = files.length;
    pendingPathlessAttachmentCountRef.current += reservedAttachmentCount;
    const preparation = (async () => {
      const prepared: PendingAttachment[] = [];

      for (const file of files) {
        const mimeType = file.type || inferMimeType(file.name);
        try {
          const arrayBuffer = await file.arrayBuffer();
          const bridge = window.desktopBridge;
          const meta = bridge?.saveClipboardFile
            ? await bridge.saveClipboardFile(new Uint8Array(arrayBuffer), mimeType, file.name)
            : await getTransport().saveClipboardFile(arrayBuffer, mimeType, file.name);
          if (!meta?.sourcePath) {
            throw new Error("Attachment persistence returned no source path");
          }
          if (!isAttachmentPreparationCurrent(generation)) continue;
          const previewUrl = classifyFile(file.name) === "image" ? URL.createObjectURL(file) : "";
          if (!isAttachmentPreparationCurrent(generation)) {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            continue;
          }
          prepared.push({
            id: meta.id,
            name: meta.name,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
            previewUrl,
            filePath: meta.sourcePath,
          });
        } catch {
          if (!isAttachmentPreparationCurrent(generation)) continue;
          attachmentPreparationFailureCountRef.current += 1;
          useToastStore.getState().show(
            "error",
            "Could not attach file",
            "The file was not saved. Try again.",
          );
        }
      }

      if (!isAttachmentPreparationCurrent(generation)) {
        for (const attachment of prepared) {
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        }
        return;
      }
      appendAttachments(prepared);
    })();

    pendingAttachmentPreparationsRef.current.add(preparation);
    setAttachmentPreparationRevision((revision) => revision + 1);
    void preparation.finally(() => {
      if (!isAttachmentPreparationCurrent(generation)) return;
      pendingAttachmentPreparationsRef.current.delete(preparation);
      pendingPathlessAttachmentCountRef.current -= reservedAttachmentCount;
      setAttachmentPreparationRevision((revision) => revision + 1);
    });
  }, [appendAttachments, isAttachmentPreparationCurrent]);

  const addFiles = useCallback((files: File[], filePaths?: (string | null)[]) => {
    const remaining = MAX_ATTACHMENTS - attachments.length - pendingPathlessAttachmentCountRef.current;
    if (remaining <= 0) return;

    const nativeAttachments: PendingAttachment[] = [];
    const pathlessFiles: File[] = [];
    for (let index = 0; index < files.length && nativeAttachments.length + pathlessFiles.length < remaining; index++) {
      const file = files[index];
      if (!isFileSupported(file.name) || file.size > getMaxFileSize(file.name)) continue;

      const nativePath = filePaths?.[index] ?? null;
      if (nativePath) {
        const mimeType = file.type || inferMimeType(file.name);
        nativeAttachments.push({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType,
          sizeBytes: file.size,
          previewUrl: classifyFile(file.name) === "image" ? URL.createObjectURL(file) : "",
          filePath: nativePath,
        });
      } else {
        pathlessFiles.push(file);
      }
    }

    appendAttachments(nativeAttachments);
    if (pathlessFiles.length > 0) preparePathlessAttachments(pathlessFiles);
  }, [appendAttachments, attachments.length, preparePathlessAttachments]);

  const handleAttachmentInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (!list?.length) return;
      const files = Array.from(list);
      const paths = files.map(resolveNativeFilePath);
      addFiles(files, paths);
      e.target.value = "";
    },
    [addFiles],
  );

  const handleAttachPick = useCallback(() => {
    attachmentInputRef.current?.click();
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      const spillPaths = collectSpillPathsFromPendingAttachments(removed ? [removed] : []);
      if (spillPaths.length > 0) void releaseBrowserCaptureSpills(spillPaths);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const fromFiles = Array.from(e.clipboardData.files);
    const fromItems: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind !== "file") continue;
      const f = item.getAsFile();
      if (!f) continue;
      if (!fromFiles.some((x) => x.name === f.name && x.size === f.size)) {
        fromItems.push(f);
      }
    }
    const merged = [...fromFiles, ...fromItems];
    const supported = merged.filter((f) => isFileSupported(f.name));
    if (supported.length === 0) return;

    e.preventDefault();

    addFiles(supported, supported.map(resolveNativeFilePath));
  }, [addFiles]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    const supported = files.filter((f) => isFileSupported(f.name));
    if (supported.length === 0) return;
    addFiles(supported, supported.map(resolveNativeFilePath));
    editorRef.current?.focus();
  }, [addFiles]);

  /** Collect attachment metadata for RPC and revoke preview URLs. */
  const collectAndClearAttachments = useCallback((): AttachmentMeta[] => {
    invalidateAttachmentPreparations();
    const metas: AttachmentMeta[] = [];
    for (const a of attachments) {
      const fenceOnlyNoFile =
        !!a.browserCapture &&
        a.filePath == null &&
        (a.contextOnly === true ||
          isVirtualBrowserContextAttachment(a.mimeType) ||
          a.name === "Page context");
      if (fenceOnlyNoFile) {
        metas.push({
          id: a.id,
          name: a.name,
          mimeType: MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
          sizeBytes: 0,
          sourcePath: "",
        });
        continue;
      }
      if (a.filePath != null) {
        metas.push({
          id: a.id,
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          sourcePath: a.filePath,
        });
      }
    }
    for (const att of attachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    setAttachments([]);
    return metas;
  }, [attachments, invalidateAttachmentPreparations]);

  const handleSend = useCallback(async () => {
    if (isNewThread && !workspaceId) return;

    const pendingPreparations = [...pendingAttachmentPreparationsRef.current];
    if (pendingPreparations.length > 0) {
      sendAfterAttachmentPreparationRef.current = {
        failureCount: attachmentPreparationFailureCountRef.current,
      };
      await Promise.all(pendingPreparations);
      return;
    }

    const composerMessage = editorRef.current
      ? extractComposerMessage(editorRef.current)
      : { text: input, mentions };
    const rawInput = composerMessage.text;
    const selectedMentions = composerMessage.mentions;
    const trimmed = rawInput.trim();
    const submittedGoalObjective = goalPending ? trimmed : undefined;
    const outboundPreviewAnnotations = annotationScopeId
      ? usePreviewAnnotationStore.getState().buildBundle(annotationScopeId)
      : undefined;
    const effectivePreviewAnnotations =
      resolveEditingPreviewAnnotations(outboundPreviewAnnotations);
    if (trimmed.length === 0 && attachments.length === 0 && !effectivePreviewAnnotations) {
      // Empty submit while editing a queued message = the user emptied it
      // intentionally. Treat as "remove from queue" instead of silently
      // doing nothing (the message has already been popped on edit start).
      if (editingFromQueue) {
        const slot = editingFromQueue.originalIndex;
        editingOriginalRef.current = null;
        restoredPreviewAnnotationsClearedRef.current = false;
        setEditingFromQueue(null);
        useQueueStore.getState().setEditingThreadId(null);
        if (annotationScopeId) {
          usePreviewAnnotationStore.getState().clearThread(annotationScopeId);
          setPreviewDesignModeActive(annotationScopeId, false);
        }
        if (threadId) scheduleDrainAfterEdit(threadId);
        useToastStore
          .getState()
          .show("info", "Removed from queue", `Slot ${String(slot + 1).padStart(2, "0")}`);
      }
      return;
    }
    // Avoid duplicate submissions while a placeholder thread is still materializing.
    if (isThreadScaffold) return;

    // ---- Handoff queue path: child thread context is still being generated ----
    // When the handoff document hasn't landed yet, queue the message locally and
    // fire it automatically once the status transitions to ready or fallback.
    //
    // Only queue AFTER the first transition away from "generating" has been seen.
    // The server fires the user's prompt as the first turn on the child thread
    // automatically; if the user types during that window before we've seen the
    // transition, queueing here would produce a duplicate message.
    if (threadId && !branchFromMessageId && !isNewThread) {
      const status = threadId
        ? getHandoffStatus(getThreadRecord(useThreadStore.getState().records, threadId))
        : undefined;
      if (status === "generating" && hasSeenHandoffTransition) {
        setQueuedSend({
          content: trimmed,
          displayContent: trimmed,
          mentions: selectedMentions,
          previewAnnotations: effectivePreviewAnnotations,
          goalObjective: submittedGoalObjective,
          orchestrationMode,
        });
        return;
      }
    }

    const enqueueCurrentComposerMessage = (
      content: string,
      displayContentResolved: string,
      captureRows: AttachedBrowserCapture[],
    ) => {
      if (!threadId) return;
      const currentAttachments = collectAndClearAttachments();
      const browserCaptureSpillPaths = collectBrowserCaptureSpillPaths(captureRows);

      const payload = {
        content,
        displayContent: displayContentResolved,
        mentions: selectedMentions.length > 0 ? selectedMentions : undefined,
        previewAnnotations: effectivePreviewAnnotations,
        attachments: currentAttachments,
        model: modelId,
        permissionMode: access,
        reasoningLevel: reasoning,
        orchestrationMode,
        provider,
        copilotAgent: provider === "copilot" ? (copilotAgent ?? undefined) : undefined,
        contextWindow: contextWindow ?? undefined,
        thinking: thinking ?? undefined,
        codexFastMode:
          provider === "codex" ? (codexFastMode === null ? undefined : codexFastMode) : undefined,
        goalObjective: submittedGoalObjective,
        replyToMessageId: replyContext?.messageId,
        quotedText: replyContext?.quotedText,
        browserCaptureSpillPaths:
          browserCaptureSpillPaths.length > 0 ? browserCaptureSpillPaths : undefined,
      };
      const enqueued = editingFromQueue
        ? useQueueStore.getState().insertAt(threadId, editingFromQueue.originalIndex, payload)
        : useQueueStore.getState().enqueue(threadId, payload);
      if (!enqueued) {
        void releaseBrowserCaptureSpills(browserCaptureSpillPaths);
      }
      if (enqueued && annotationScopeId && outboundPreviewAnnotations) {
        usePreviewAnnotationStore.getState().clearThread(annotationScopeId);
        setPreviewDesignModeActive(annotationScopeId, false);
      }
      if (enqueued && submittedGoalObjective) setGoalPending(false);
      if (editingFromQueue && enqueued) {
        useToastStore
          .getState()
          .show(
            "info",
            "Saved to queue",
            `Slot ${String(editingFromQueue.originalIndex + 1).padStart(2, "0")}`,
          );
      }
      editingOriginalRef.current = null;
      restoredPreviewAnnotationsClearedRef.current = false;
      setEditingFromQueue(null);
      useQueueStore.getState().setEditingThreadId(null);

      setInput("");
      setMentions([]);
      if (threadId) clearDraftFromStore(threadId);
      if (threadId) clearReply(threadId);
      if (editorRef.current) {
        editorRef.current.update(() => {
          const root = $getRoot();
          root.clear();
          root.append($createParagraphNode());
        });
      }
      editorRef.current?.focus();
    };

    // ---- Queue path: agent is running on THIS thread ----
    // Skip when composing a branch (`branchFromMessageId`) or a brand-new thread
    // (`isNewThread`) - both target a *different* thread and must not enqueue
    // on the parent thread that happens to be currently running.
    //
    // Also skip for `/goal` control-form commands (`clear`, `reset`, `show`,
    // bare `/goal`). When a goal is active the agent's Stop hook blocks the
    // turn from ending until the goal is met - which means `session.turnComplete`
    // never fires and the queue never drains. Queueing `/goal clear` here would
    // deadlock: the only way to clear the goal is to send `/goal clear`, but
    // that message would sit in the queue waiting for a turn that cannot
    // complete. The server intercept handles these control forms synchronously
    // without invoking the provider, so they are safe to send mid-turn.
    if (
      shouldQueueActiveThreadSubmit(
        threadId,
        isAgentRunning,
        branchFromMessageId,
        isNewThread,
        trimmed,
      )
    ) {
      const captureRows = buildAttachedBrowserCaptures(attachments);
      let content: string;
      try {
        content =
          captureRows.length === 0 ? rawInput : appendBrowserCaptureFence(rawInput, captureRows);
        content = appendPreviewAnnotationFence(content, effectivePreviewAnnotations);
        content = content.trim();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Invalid page preview payload";
        useToastStore.getState().show("error", "Could not send message", msg);
        return;
      }
      const displayContentResolved = resolveOutboundDisplayContent(rawInput, undefined);
      enqueueCurrentComposerMessage(content, displayContentResolved, captureRows);
      return;
    }

    const submittedNewThreadMode = composerMode;
    const submittedNewThreadBranch = newThreadBranch;
    const submittedNewThreadBranchSource = newThreadBranchSource;

    // Validate worktree mode requirements
    if (isNewThread && submittedNewThreadMode === "existing-worktree" && !selectedWorktree) {
      return;
    }

    const captureRows = buildAttachedBrowserCaptures(attachments);
    let messageContent: string;
    try {
      messageContent =
        captureRows.length === 0 ? rawInput : appendBrowserCaptureFence(rawInput, captureRows);
      messageContent = appendPreviewAnnotationFence(messageContent, effectivePreviewAnnotations);
      messageContent = messageContent.trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid page preview payload";
      useToastStore.getState().show("error", "Could not send message", msg);
      return;
    }
    const outboundDisplay = resolveOutboundDisplayContent(rawInput, undefined);

    const continueSend = async () => {
      // ---- Normal send path ----

      if (
        shouldQueueActiveThreadSubmit(
          threadId,
          isAgentRunning,
          branchFromMessageId,
          isNewThread,
          trimmed,
        )
      ) {
        enqueueCurrentComposerMessage(messageContent, outboundDisplay, captureRows);
        return;
      }

      setInput("");
      setMentions([]);
      if (editorRef.current) {
        editorRef.current.update(() => {
          const root = $getRoot();
          root.clear();
          root.append($createParagraphNode());
        });
      }
      setDetectedPr(null);
      setPrDismissed(false);
      // Edit mode ends on send regardless of which path we took.
      editingOriginalRef.current = null;
      restoredPreviewAnnotationsClearedRef.current = false;
      setEditingFromQueue(null);
      useQueueStore.getState().setEditingThreadId(null);
      const currentAttachments = collectAndClearAttachments();
      if (threadId) clearDraftFromStore(threadId);
      // Hide the reply bar with the composer reset; sendMessage still receives reply IDs from this render.
      if (threadId) clearReply(threadId);
      if (annotationScopeId && outboundPreviewAnnotations) {
        usePreviewAnnotationStore.getState().clearThread(annotationScopeId);
        setPreviewDesignModeActive(annotationScopeId, false);
      }

      if (isNewThread && workspaceId) {
        setNewThreadMode(submittedNewThreadMode);
        if (submittedNewThreadMode === "worktree" && submittedNewThreadBranchSource === "pr") {
          setNewThreadBranchFromPr(submittedNewThreadBranch);
        } else {
          setNewThreadBranch(submittedNewThreadBranch);
        }
        const createdThread = await useWorkspaceStore
          .getState()
          .createAndSendMessage(
            messageContent,
            modelId,
            access,
            currentAttachments.length > 0 ? currentAttachments : undefined,
            reasoning,
            provider,
            mode,
            provider === "copilot" ? (copilotAgent ?? undefined) : undefined,
            contextWindow ?? undefined,
            thinking ?? undefined,
            provider === "codex" && codexFastMode !== null ? codexFastMode : undefined,
            outboundDisplay,
            selectedMentions,
            effectivePreviewAnnotations,
            submittedGoalObjective,
            orchestrationMode,
          );
        onThreadCreated?.(createdThread);
      } else if (branchFromMessageId && threadId) {
      // Branch mode: create a child thread from the quoted message instead of sending.
      let branchMode: "direct" | "worktree" | "existing-worktree" = "direct";
      let branchBranch = branchTargetBranch || activeThread?.branch || "";
      let branchWorktree: string | undefined;
      let branchExistingWorktreeBaseBranch: string | undefined;

      if (branchExecMode === "worktree") {
        branchMode = "worktree";
        branchBranch = branchTargetBranch || activeThread?.branch || "";
      } else if (branchExecMode === "existing-worktree") {
        branchMode = "existing-worktree";
        branchWorktree = branchWorktreePath;
        if (!branchWorktreePath) return;
        if (branchWorktreeIsDetached) {
          branchBranch = branchTargetBranch || activeThread?.base_branch || activeThread?.branch || "main";
          branchExistingWorktreeBaseBranch = branchBranch;
        }
      }

      await branchThread({
        sourceThreadId: threadId,
        content: messageContent,
        displayContent: outboundDisplay,
        model: modelId,
        provider,
        permissionMode: access,
        reasoningLevel: reasoning,
        attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
        mode: branchMode,
        branch: branchBranch,
        existingWorktreePath: branchWorktree,
        existingWorktreeBaseBranch: branchExistingWorktreeBaseBranch,
        forkedFromMessageId: branchFromMessageId,
        copilotAgent: provider === "copilot" ? (copilotAgent ?? undefined) : undefined,
        contextWindow: contextWindow ?? undefined,
        thinking: thinking ?? undefined,
        codexFastMode: provider === "codex" && codexFastMode !== null ? codexFastMode : undefined,
        mentions: selectedMentions,
        previewAnnotations: effectivePreviewAnnotations,
        goalObjective: submittedGoalObjective,
        orchestrationMode,
      });
      onBranchModeExit?.();
      } else if (threadId) {
        await sendMessage(
          threadId,
          messageContent,
          modelId,
          access,
          currentAttachments.length > 0 ? currentAttachments : undefined,
          outboundDisplay,
          reasoning,
          provider,
          provider === "copilot" ? (copilotAgent ?? undefined) : undefined,
          contextWindow ?? undefined,
          thinking ?? undefined,
          provider === "codex" && codexFastMode !== null ? codexFastMode : undefined,
          replyContext?.messageId,
          replyContext?.quotedText,
          undefined,
          selectedMentions,
          effectivePreviewAnnotations,
          submittedGoalObjective,
          orchestrationMode,
        );
      }

      if (submittedGoalObjective) setGoalPending(false);

      // Auto-save last-used mode and access as defaults (model defaults are managed in Settings)
      const { settings, loaded, update: updateSettings } = useSettingsStore.getState();
      if (loaded && (mode !== settings.agent.defaults.mode || access !== settings.agent.defaults.permission)) {
        void updateSettings({
          agent: {
            defaults: {
              mode,
              permission: access,
            },
          },
        });
      }

      editorRef.current?.focus();
    };

    // Checkout confirmation for Direct mode when a different branch is selected.
    if (isNewThread && isGitRepo && submittedNewThreadMode === "direct" && submittedNewThreadBranch && workspaceId) {
      const currentBranch = await useWorkspaceStore.getState().getCurrentBranch(workspaceId);
      if (currentBranch && submittedNewThreadBranch !== currentBranch) {
        setPendingCheckoutConfirmation({
          currentBranch,
          targetBranch: submittedNewThreadBranch,
          onConfirm: async () => {
            await useWorkspaceStore.getState().checkoutBranch(workspaceId, submittedNewThreadBranch);
            clearFileListCache(workspaceId);
            await continueSend();
          },
        });
        return;
      }
    }

    await continueSend();
  }, [input, mentions, attachments, annotationCount, annotationScopeId, isAgentRunning, isNewThread, composerMode, newThreadBranch, newThreadBranchSource, workspaceId, threadId, sendMessage, modelId, provider, reasoning, orchestrationMode, mode, access, copilotAgent, contextWindow, thinking, codexFastMode, selectedWorktree, collectAndClearAttachments, clearDraftFromStore, isThreadScaffold, branchFromMessageId, branchExecMode, branchTargetBranch, branchWorktreePath, branchWorktreeIsDetached, activeThread, branchThread, onBranchModeExit, onThreadCreated, replyContext, clearReply, editingFromQueue, slashCommand, isGitRepo, setNewThreadMode, setNewThreadBranch, setNewThreadBranchFromPr, setPreviewDesignModeActive, resolveEditingPreviewAnnotations, goalPending]);

  useEffect(() => {
    const pendingSend = sendAfterAttachmentPreparationRef.current;
    if (!pendingSend || pendingAttachmentPreparationsRef.current.size > 0) return;

    sendAfterAttachmentPreparationRef.current = null;
    if (attachmentPreparationFailureCountRef.current !== pendingSend.failureCount) return;
    void handleSend();
  }, [attachmentPreparationRevision, handleSend]);

  useEffect(() => {
    if (!annotationScopeId) return;
    const onSubmitComposer = (event: Event): void => {
      const detail = (event as CustomEvent<{ readonly threadId?: string }>).detail;
      if (detail?.threadId && detail.threadId !== annotationScopeId) return;
      void handleSend();
    };
    window.addEventListener("mcode:submit-composer", onSubmitComposer);
    return () =>
      window.removeEventListener("mcode:submit-composer", onSubmitComposer);
  }, [handleSend, annotationScopeId]);

  // Reset the handoff-transition-seen flag whenever the user switches threads
  // so the guard below evaluates correctly for each new child thread.
  useEffect(() => {
    setHasSeenHandoffTransition(false);
  }, [threadId]);

  // Track the first time handoff status leaves "generating" so we can
  // distinguish the server-initiated first turn from user-typed queued sends.
  // TODO: handoff status is not persisted server-side; clients reconnecting between
  // "generating" and "ready" will miss the spinner state until the artifact lands.
  useEffect(() => {
    if (handoffStatus && handoffStatus !== "generating") {
      setHasSeenHandoffTransition(true);
    }
  }, [handoffStatus]);

  // Fire a locally queued message when the handoff context finishes generating.
  // Calls sendMessage directly with current model/provider/access to avoid stale handleSend closures.
  useEffect(() => {
    if (!threadId) return;
    if (handoffStatus !== "ready" && handoffStatus !== "fallback") return;
    const queued = queuedSendRef.current;
    if (!queued) return;
    setQueuedSend(null);
    setInput("");
    setMentions([]);
    clearDraftFromStore(threadId);
    const currentAttachments = collectAndClearAttachments();
    if (annotationScopeId && queued.previewAnnotations) {
      usePreviewAnnotationStore.getState().clearThread(annotationScopeId);
      setPreviewDesignModeActive(annotationScopeId, false);
    }
    if (editorRef.current) {
      editorRef.current.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
      });
    }
    useThreadStore.getState().sendMessage(
      threadId,
      queued.content,
      modelId,
      access,
      currentAttachments.length > 0 ? currentAttachments : undefined,
      queued.displayContent,
      reasoning,
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      queued.mentions,
      queued.previewAnnotations,
      queued.goalObjective,
      queued.orchestrationMode,
    );
  // modelId/access/reasoning/provider intentionally read from render-time values via closure;
  // handoffStatus is the sole reactive trigger so we don't re-fire on unrelated changes.
  }, [handoffStatus, threadId]);

  const handleEditorChange = useCallback((text: string, nextMentions: MessageMention[]) => {
    setInput(text);
    setMentions(nextMentions);
  }, []);

  const handleSlashSelect = useCallback((cmd: Command) => {
    // No-op replaceText: Lexical handles text replacement via insertSlashCommandNode
    slashCommand.onSelect(cmd, () => {});
    if (editorRef.current) {
      if (cmd.action) {
        removeSlashCommandTrigger(editorRef.current);
      } else if (!insertSelectedPluginMention(editorRef.current, cmd)) {
        insertSlashCommandNode(editorRef.current, cmd.name, cmd.namespace, cmd.identity);
      }
    }
  }, [slashCommand]);

  // Unified popup keyboard handler for Lexical's KeyboardPlugin.
  // Delegates to the file tag popup or slash command popup depending on which is open.
  const isAnyPopupOpen = fileAutocomplete.isOpen || slashCommand.isOpen;

  const handlePopupKeyDown = useCallback((key: string): boolean => {
    if (fileAutocomplete.isOpen) {
      // Synthesize a minimal React.KeyboardEvent for the file popup handler
      const fakeEvent = {
        key,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.KeyboardEvent;
      return filePopup.handleKeyDown(fakeEvent);
    }
    if (slashCommand.isOpen) {
      if (key === "Enter" || key === "Tab") {
        const cmd = slashCommand.items[slashCommand.selectedIndex];
        if (cmd) {
          handleSlashSelect(cmd);
          return true;
        }
      }
      if (key === "Escape") {
        slashCommand.onDismiss();
        return true;
      }
      const fakeEvent = {
        key,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.KeyboardEvent;
      slashCommand.onKeyDown(fakeEvent);
      return key === "ArrowDown" || key === "ArrowUp";
    }
    if (key === "Escape" && branchFromMessageId) {
      onBranchModeExit?.();
      return true;
    }
    return false;
  }, [fileAutocomplete.isOpen, filePopup, slashCommand, handleSlashSelect, branchFromMessageId, onBranchModeExit]);

  const toast = useQueueStore((s) => s.toast);

  const reasoningLevels = useMemo<ReasoningLevel[]>(() => {
    // Some providers pick reasoning effort internally (e.g. cursor's
    // Composer mode) and have no per-call knob to surface. Hide the pill
    // entirely for those — a model-id-only check would mis-fire when a
    // model id is shared across providers.
    if (!providerSupportsReasoningLevels(provider)) return [];
    // Gate on provider to prevent Copilot models sharing Codex IDs from taking Codex branch.
    const codexLvls = provider === "codex" ? getCodexReasoningLevels(modelId) : null;
    if (codexLvls) {
      // Drop registry entries that are not valid shared ReasoningLevel values (defensive).
      return codexLvls.filter((l) => VALID_REASONING_LEVELS_SET.has(l)) as ReasoningLevel[];
    }
    if (!supportsEffortParameter(modelId)) return [];
    return [
      "low",
      "medium",
      "high",
      ...(isXhighEffortModel(modelId) ? (["xhigh"] as const) : []),
      ...(isMaxEffortModel(modelId)   ? (["max"]   as const) : []),
    ];
  }, [modelId, provider]);

  // Close the unified preferences picker when the active model exposes no
  // knobs at all (no reasoning tiers, no 1M opt-in, no thinking toggle).
  // Without this the popover would stay open pointing at an empty container.
  const has1MCapability = supports1MContextWindow(modelId);
  const hasThinkingCapability = supportsThinkingToggle(modelId);
  useEffect(() => {
    if (reasoningLevels.length === 0 && !has1MCapability && !hasThinkingCapability && provider !== "codex") {
      setShowReasoningPicker(false);
    }
  }, [reasoningLevels.length, has1MCapability, hasThinkingCapability, provider]);

  const cancelCheckoutConfirmation = useCallback(() => {
    if (checkoutConfirming) return;
    setPendingCheckoutConfirmation(null);
    editorRef.current?.focus();
  }, [checkoutConfirming]);

  const confirmCheckoutAndSend = useCallback(async () => {
    const pending = pendingCheckoutConfirmation;
    if (!pending || checkoutConfirming) return;
    setCheckoutConfirming(true);
    try {
      await pending.onConfirm();
      setPendingCheckoutConfirmation(null);
    } finally {
      setCheckoutConfirming(false);
      editorRef.current?.focus();
    }
  }, [pendingCheckoutConfirmation, checkoutConfirming]);

  const showComposerStatusBar = !!branchFromMessageId;

  return (
    <div className="relative px-4 py-4 sm:px-8">
      {/* Soft gradient hint above the composer — short enough that it doesn't
          bury the last line of content (e.g. the turn footer) when the chat is
          scrolled to its tail. Reduced from h-5/opaque to h-3/70% so the band
          reads as edge-softening rather than a mask. */}
      {!isNewThread && (
        <div className="pointer-events-none absolute inset-x-0 -top-3 h-3 bg-gradient-to-t from-background/70 to-transparent" />
      )}
      {/* Queue toast */}
      {toast && (
        <div className="pointer-events-none absolute -top-8 right-4 z-20 flex items-center gap-1.5 rounded-full bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/50 backdrop-blur-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-150">
          <Check size={10} className="text-primary" />
          {toast}
        </div>
      )}

      {/* Max-width wrapper to align with message list column */}
      <div className={PRIMARY_CONTENT_RAIL_CLASS}>
      {threadId && workspaceId && planPreview && !planPanelOpen && !branchFromMessageId && !isNewThread && (
        <div className="mb-2">
          <PlanPreview workspaceId={workspaceId} threadId={threadId} preview={planPreview} />
        </div>
      )}

      {threadId && taskBubbleTasks.length > 0 && !branchFromMessageId && !isNewThread && (
        <div className="mb-2 flex justify-center">
          <TaskBubble tasks={taskBubbleTasks} fileEffects={fileEffectSummary} />
        </div>
      )}

      {/* Inline queued-message stack (above the composer; Cursor-style).
          Auto-hides when the queue is empty. Editing a row pops the message
          and rehydrates it into this composer via loadIntoComposer. */}
      {threadId && !branchFromMessageId && !isNewThread && (
        <ComposerQueueList
          threadId={threadId}
          isAgentRunning={isAgentRunning}
          provider={provider}
          isEditing={!!editingFromQueue}
          isPaused={planPending}
          onLoadIntoComposer={loadIntoComposer}
          onResume={async () => {
            if (planPending) return;
            const next = useQueueStore.getState().dequeueNext(threadId);
            if (!next) return;
            try {
              await sendMessage(
                threadId,
                next.content,
                next.model,
                next.permissionMode,
                next.attachments.length > 0 ? next.attachments : undefined,
                next.displayContent,
                next.reasoningLevel,
                next.provider,
                next.copilotAgent,
                next.contextWindow,
                next.thinking,
                next.codexFastMode,
                next.replyToMessageId,
                next.quotedText,
                undefined,
                next.mentions,
                next.previewAnnotations,
              );
              const activeReply = useReplyStore.getState().getReply(threadId);
              if (
                next.replyToMessageId &&
                activeReply?.messageId === next.replyToMessageId
              ) {
                clearReply(threadId);
              }
            } catch {
              void releaseBrowserCaptureSpills(next.browserCaptureSpillPaths ?? []);
            }
          }}
          onSendNow={async (msg) => {
            if (planPending) return;
            if (useThreadStore.getState().runningThreadIds.has(threadId)) {
              useQueueStore.getState().moveMessage(threadId, msg.id, 0);
              return;
            }
            const popped = useQueueStore.getState().popMessage(threadId, msg.id);
            if (!popped) return;
            try {
              await sendMessage(
                threadId,
                popped.content,
                popped.model,
                popped.permissionMode,
                popped.attachments.length > 0 ? popped.attachments : undefined,
                popped.displayContent,
                popped.reasoningLevel,
                popped.provider,
                popped.copilotAgent,
                popped.contextWindow,
                popped.thinking,
                popped.codexFastMode,
                popped.replyToMessageId,
                popped.quotedText,
                undefined,
                popped.mentions,
                popped.previewAnnotations,
              );
              const activeReply = useReplyStore.getState().getReply(threadId);
              if (
                popped.replyToMessageId &&
                activeReply?.messageId === popped.replyToMessageId
              ) {
                clearReply(threadId);
              }
            } catch {
              void releaseBrowserCaptureSpills(popped.browserCaptureSpillPaths ?? []);
            }
          }}
        />
      )}

      {isNewThread && (
        <div
          data-testid="new-thread-context-strip"
          className="relative z-0 mx-[14px] flex h-[40px] min-w-0 items-center gap-1 overflow-x-auto rounded-t-xl bg-muted/45 px-[16px] ring-1 ring-inset ring-border/60"
        >
          {activeWorkspace ? (
            <>
              <div
                className="inline-flex h-[28px] min-w-0 shrink items-center gap-[6px] rounded-md pl-[10px] text-xs font-medium leading-none text-foreground/90"
              >
                <Folder size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                <span className="max-w-40 truncate" title={activeWorkspace.path}>
                  {activeWorkspace.name}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Clear ${activeWorkspace.name} project`}
                  title="Clear project"
                  onClick={clearActiveProject}
                  className="-mr-0.5 size-7 rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:border-destructive/40 focus-visible:ring-destructive/20"
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
              {isGitRepo ? (
                <ModeSelector
                  mode={composerMode}
                  onModeChange={setComposerMode}
                  locked={false}
                  options={modeOptions}
                  className={NEW_THREAD_CONTEXT_CONTROL_CLASS}
                  iconSize={14}
                />
              ) : (
                <span
                  data-testid="local-environment-label"
                  className="flex h-[28px] items-center gap-[6px] rounded-md px-[10px] text-xs font-medium leading-none text-muted-foreground/70"
                >
                  <FolderOpen size={14} aria-hidden />
                  Local
                </span>
              )}
              {isGitRepo && composerMode === "direct" && (
                <BranchPicker
                  branches={branches}
                  selectedBranch={newThreadBranch || "main"}
                  onSelect={setNewThreadBranch}
                  loading={branchesLoading}
                  locked={false}
                  triggerClassName={NEW_THREAD_CONTEXT_CONTROL_CLASS}
                  iconSize={14}
                />
              )}
              {isGitRepo && composerMode === "worktree" && (
                <BranchPicker
                  branches={branches}
                  selectedBranch={newThreadBranch || "main"}
                  onSelect={setNewThreadBranch}
                  loading={branchesLoading}
                  locked={false}
                  pullRequests={openPrs}
                  prsLoading={openPrsLoading}
                  fetchingBranch={fetchingBranch}
                  onFetchAndSelect={handleFetchAndSelect}
                  triggerClassName={NEW_THREAD_CONTEXT_CONTROL_CLASS}
                  iconSize={14}
                />
              )}
              {isGitRepo && composerMode === "existing-worktree" && (
                <>
                  {selectedWorktreeIsDetached && (
                    <BranchPicker
                      branches={branches}
                      selectedBranch={newThreadBranch || "main"}
                      onSelect={setNewThreadBranch}
                      loading={branchesLoading}
                      locked={false}
                      triggerClassName={NEW_THREAD_CONTEXT_CONTROL_CLASS}
                      iconSize={14}
                    />
                  )}
                  <Suspense fallback={<div className="h-7 w-28 animate-pulse rounded-md bg-accent" />}>
                    <LazyWorktreePicker
                      worktrees={worktrees}
                      selectedPath={selectedWorktree?.path ?? ""}
                      onSelect={setSelectedWorktree}
                      loading={worktreesLoading}
                      triggerClassName={NEW_THREAD_CONTEXT_CONTROL_CLASS}
                      iconSize={14}
                    />
                  </Suspense>
                </>
              )}
            </>
          ) : (
            <NewThreadProjectPicker />
          )}
        </div>
      )}

      {/* Main composer container - dark bg, rounded */}
      <div
        ref={composerContainerRef}
        data-testid="composer-surface"
        className={cn(
          "relative z-10 bg-muted/50 ring-1 ring-inset ring-border/60 focus-within:ring-2 focus-within:ring-primary/70",
          isNewThread
            ? "-mt-px rounded-xl shadow-none"
            : "rounded-xl shadow-lg shadow-black/20",
          isDragOver && "ring-2 ring-primary"
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Branch mode quote bar */}
        <ComposerBranchBar
          branchFromMessageId={branchFromMessageId}
          branchFromMessageContent={branchFromMessageContent}
          onBranchModeExit={onBranchModeExit}
        />

        {/* Reply quote bar — hidden during branch mode since branches ignore reply context */}
        {replyContext && threadId && !branchFromMessageId && (
          <ComposerReplyBar
            sourceRole={replyContext.sourceRole}
            previewText={replyContext.previewText}
            onDismiss={() => clearReply(threadId)}
          />
        )}

        {/* PR URL detection card */}
        {detectedPr && !prDismissed && (
          <PrDetectedCard
            number={detectedPr.number}
            title={detectedPr.title}
            branch={detectedPr.branch}
            author={detectedPr.author}
            onReview={handlePrReview}
            onDismiss={() => {
              setDetectedPr(null);
              setPrDismissed(true);
            }}
            loading={!!fetchingBranch}
          />
        )}

        {/* Provider unavailable banner — shown when the thread's active provider is
            disabled by the user or its CLI binary is missing. Branch initiation is
            owned by ChatView (it controls branchFromMessageId), so we omit onBranch
            here and the banner renders only the "Open Settings" CTA. */}
        {providerReason && (
          <ProviderUnavailableBanner
            providerId={effectiveProviderId}
            reason={providerReason}
            onOpenSettings={() =>
              window.dispatchEvent(new CustomEvent("mcode:open-settings", { detail: { section: "model" } }))
            }
          />
        )}

        {/* Inline indicator that the composer holds a queued message pulled
            out for editing. Cancel returns it to its original slot. */}
        {editingFromQueue && (
          <div className="flex items-center justify-between gap-2 border-b border-primary/20 bg-primary/5 px-3 py-1.5">
            <span className="font-mono text-xs uppercase tracking-[0.18em] text-primary/85">
              Editing
              <span className="ml-1.5 tabular-nums text-primary/55">
                {String(editingFromQueue.originalIndex + 1).padStart(2, "0")}
              </span>
              <span className="ml-2 normal-case tracking-normal text-primary/55">
                Send to save - changes return to the same slot.
              </span>
            </span>
            <button
              type="button"
              onClick={cancelEditFromQueue}
              aria-label="Discard edits and restore the original queued message"
              title="Discard changes (restores the original message at its slot)"
              className="rounded-sm p-1 text-primary/55 transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <X size={11} strokeWidth={1.75} />
            </button>
          </div>
        )}

        {/* Lexical editor with file tag popup */}
        <div className="relative" ref={editorContainerRef} onPaste={handlePaste}>
          <ComposerEditor
            onChange={handleEditorChange}
            onSubmit={handleSend}
            onMentionTrigger={fileAutocomplete.handleInputChange}
            onMentionDismiss={fileAutocomplete.dismiss}
            isMentionPopupOpen={fileAutocomplete.isOpen}
            onSlashTrigger={slashCommand.onInputChange}
            onSlashDismiss={slashCommand.onDismiss}
            isSlashPopupOpen={slashCommand.isOpen}
            editorRef={editorRef}
            disabled={planPending || isStaleWorktree || !!providerReason}
            isPopupOpen={isAnyPopupOpen}
            onPopupKeyDown={handlePopupKeyDown}
            placeholder={isStaleWorktree ? "Worktree directory no longer exists. This thread is read-only." : planPending ? "Answer the planning questions above" : goalPending ? "Describe the goal..." : branchFromMessageId ? "What should the branch work on?" : editingFromQueue ? "Edit the queued message - send to save." : replyContext ? "Type your reply..." : isAgentRunning ? "Queue a follow-up..." : isNewThread ? "Do anything" : "Message Mcode..."}
          />
          <FileTagPopup
            items={fileAutocomplete.suggestions}
            isOpen={fileAutocomplete.isOpen}
            onSelect={handleMentionSelect}
            listRef={filePopup.listRef}
            selectedIndex={filePopup.selectedIndex}
            anchorRect={filePopupAnchorRect}
            presentation="composer"
          />
          <SpellcheckContextMenu editorRef={editorContainerRef} />
        </div>

        {/* Attachment previews */}
        {annotationScopeId && annotationBundleForDisplay ? (
          <div className="px-3 pt-2">
            <PreviewAnnotationBundleChip
              bundle={annotationBundleForDisplay}
              threadId={threadId}
              testId="composer-annotation-bundle"
              onRemove={() => {
                if (editingFromQueue && editingOriginalRef.current?.previewAnnotations) {
                  restoredPreviewAnnotationsClearedRef.current = true;
                }
                usePreviewAnnotationStore.getState().clearThread(annotationScopeId);
              }}
            />
          </div>
        ) : null}
        <AttachmentPreview attachments={attachments} onRemove={removeAttachment} />

        {/* Compacting banner — shown while the SDK is summarising the context window */}
        {isCompacting && <CompactingBanner />}
        {!isCompacting && hasRetryState && threadId && <RetryBanner threadId={threadId} />}

        {/* Drag overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/10 backdrop-blur-sm">
            <span className="text-sm font-medium text-primary">Drop files here</span>
          </div>
        )}

        {/* Controls row - inside the container. The container-width hook above
            collapses Mode/Permissions/Tasks into a popover before this row would
            need to wrap, so the send button stays anchored on the right. */}
        <div className="flex items-center gap-x-1.5 sm:gap-x-2.5 border-t border-border/20 px-3 py-1.5">
          <input
            ref={attachmentInputRef}
            type="file"
            multiple
            className="hidden"
            accept={ATTACHMENT_INPUT_ACCEPT}
            data-testid="composer-attachment-input"
            onChange={handleAttachmentInputChange}
          />
          <ComposerAddMenu
            disabled={planPending || isStaleWorktree || !!providerReason}
            onAttachFiles={handleAttachPick}
            capabilities={composerCapabilities}
            attachedCapabilityIds={attachedCapabilityIds}
            onAttachCapability={attachComposerCapability}
            getComposerRect={() => composerContainerRef.current?.getBoundingClientRect() ?? null}
          />
          {/* Model picker */}
          <ModelSelector
            selectedModelId={modelId}
            selectedProviderId={provider}
            onSelect={(mid, pid) => { setModelId(mid); setProvider(pid); }}
            locked={isModelFullyLocked}
            providerLocked={isProviderLocked}
          />

          {/*
            Unified model-preferences popover. Combines reasoning effort,
            context window (1M opt-in), and the Haiku thinking toggle into a
            single trigger so the composer toolbar stays compact. The trigger
            is hidden when the active model exposes none of these knobs.
            Sections render conditionally based on model capability.
          */}
          {(() => {
            const hasReasoning = reasoningLevels.length > 0;
            const has1M = provider === "claude" && supports1MContextWindow(modelId);
            const hasThinking = provider === "claude" && supportsThinkingToggle(modelId);
            const hasCodexFast = provider === "codex";
            if (!hasReasoning && !has1M && !hasThinking && !hasCodexFast) return null;

            const ctxMode: ContextWindowMode = contextWindow ?? settingsDefaultContextWindow ?? "200k";
            const thinkingOn: boolean = thinking ?? settingsDefaultThinking ?? false;
            const effectiveCodexFast: boolean =
              codexFastMode === null ? settingsGlobalCodexFast : codexFastMode;
            const triggerLabel = hasReasoning
              ? reasoningLabel(reasoning)
              : hasThinking
                ? "Thinking"
                : hasCodexFast
                  ? (effectiveCodexFast ? "Fast" : "Off")
                  : ctxMode === "1m" ? "1M" : "200K";

            const activeChipLabel =
              hasReasoning && has1M && ctxMode === "1m"
                ? "1M"
                : !hasReasoning && hasThinking && thinkingOn
                  ? "ON"
                  : null;
            const showFastIcon = hasCodexFast && effectiveCodexFast;

            const tooltipLabel = hasReasoning
              ? has1M || hasThinking || hasCodexFast ? "Reasoning & model options" : "Reasoning level"
              : hasThinking
                ? "Thinking"
                : hasCodexFast
                  ? "Fast mode"
                  : "Context window";

            const sectionHeaderClass = "px-3 pt-1.5 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/60 select-none";
            const itemClass = (active: boolean) => cn(
              "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
              active
                ? "bg-accent text-foreground"
                : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
            );

            return (
              <div className="relative">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowReasoningPicker(!showReasoningPicker);
                        }}
                        className="gap-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
                      >
                        {showFastIcon && (
                          <Zap
                            size={12}
                            strokeWidth={2.5}
                            aria-hidden="true"
                            data-testid="composer-fast-mode-icon"
                            className="shrink-0 text-foreground/80"
                          />
                        )}
                        <span className="text-sm">{triggerLabel}</span>
                        {activeChipLabel && (
                          <span
                            data-testid="composer-1m-badge"
                            className="rounded-sm bg-foreground/5 px-1 py-px text-xs font-medium uppercase tracking-wide text-foreground/80 ring-1 ring-inset ring-foreground/10 tabular-nums"
                          >
                            {activeChipLabel}
                          </span>
                        )}
                        <ChevronDown size={11} />
                      </Button>
                    }
                  />
                  <TooltipContent>{tooltipLabel}</TooltipContent>
                </Tooltip>
                {showReasoningPicker && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute bottom-full left-0 z-20 mb-1 min-w-[224px] rounded-md border border-border bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 duration-150"
                  >
                    {hasReasoning && (
                      <>
                        <div className={sectionHeaderClass}>Reasoning effort</div>
                        {reasoningLevels.map((level) => (
                          <button
                            key={level}
                            onClick={() => {
                              setReasoning(level);
                              if (threadId) void setThreadSettings(threadId, { reasoningLevel: level });
                            }}
                            className={itemClass(reasoning === level)}
                          >
                            <span>{reasoningLabel(level)}</span>
                            {reasoning === level && <Check size={10} className="shrink-0 text-foreground" />}
                          </button>
                        ))}
                      </>
                    )}

                    {has1M && (
                      <>
                        {hasReasoning && <div className="my-1 h-px bg-border/60" />}
                        <div className={sectionHeaderClass}>Context window</div>
                        {(["200k", "1m"] as const).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => {
                              setContextWindow(mode);
                              if (threadId && !branchFromMessageId) void setThreadSettings(threadId, { contextWindow: mode });
                            }}
                            className={itemClass(ctxMode === mode)}
                          >
                            <span className="tabular-nums">{mode === "1m" ? "1M tokens" : "200K tokens"}</span>
                            {ctxMode === mode && <Check size={10} className="shrink-0 text-foreground" />}
                          </button>
                        ))}
                      </>
                    )}

                    {hasThinking && (
                      <>
                        {(hasReasoning || has1M) && <div className="my-1 h-px bg-border/60" />}
                        <div className={sectionHeaderClass}>Thinking</div>
                        {[
                          { value: false, label: "Off" },
                          { value: true, label: "On" },
                        ].map(({ value, label }) => (
                          <button
                            key={String(value)}
                            onClick={() => {
                              setThinking(value);
                              if (threadId && !branchFromMessageId) void setThreadSettings(threadId, { thinking: value });
                            }}
                            className={itemClass(thinkingOn === value)}
                          >
                            <span>{label}</span>
                            {thinkingOn === value && <Check size={10} className="shrink-0 text-foreground" />}
                          </button>
                        ))}
                      </>
                    )}

                    {hasCodexFast && (
                      <>
                        {(hasReasoning || has1M || hasThinking) && <div className="my-1 h-px bg-border/60" />}
                        <div className={sectionHeaderClass}>Fast mode</div>
                        <label
                          className={cn(
                            "flex w-full cursor-pointer items-center justify-between rounded px-3 py-1.5 text-xs",
                            effectiveCodexFast
                              ? "bg-accent/50 text-foreground"
                              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
                          )}
                        >
                          <span>Fast</span>
                          <Switch
                            data-testid="composer-codex-fast-switch"
                            checked={effectiveCodexFast}
                            onCheckedChange={(checked) => {
                              const next =
                                checked === settingsGlobalCodexFast ? null : checked;
                              setCodexFastMode(next);
                              if (threadId && !branchFromMessageId) {
                                void setThreadSettings(threadId, { codexFastMode: next });
                              }
                            }}
                            aria-label="Fast mode"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </label>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/*
            Copilot exposes a per-agent selector inline (replaces Chat/Plan
            toggle, since Copilot agents don't share that mode dimension).
            All other providers use the responsive Mode/Permissions/Tasks
            popover: inline at md+, collapsed behind a single overflow
            trigger below the threshold so the send button never wraps.
          */}
          {provider === "copilot" ? (
            <>
              <CopilotAgentSelector
                selected={copilotAgent}
                workspaceId={workspaceId ?? ""}
                disabled={isModelFullyLocked}
                onChange={(agentName) => {
                  setCopilotAgent(agentName);
                  // Don't persist to parent thread when in branch mode — the
                  // selection only applies to the branch being created.
                  if (threadId && !branchFromMessageId) void setThreadSettings(threadId, { copilotAgent: agentName });
                }}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        const next: AccessMode = access === PERMISSION_MODES.FULL ? PERMISSION_MODES.SUPERVISED : PERMISSION_MODES.FULL;
                        setAccess(next);
                        agentSettingsTouchedRef.current = true;
                        if (threadId) void setThreadSettings(threadId, { permissionMode: next });
                      }}
                      className="gap-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
                    >
                      {access === PERMISSION_MODES.FULL ? <Unlock size={14} /> : <Lock size={14} />}
                      <span className="text-sm">{access === PERMISSION_MODES.FULL ? "Full access" : "Supervised"}</span>
                    </Button>
                  }
                />
                <TooltipContent>{access === PERMISSION_MODES.FULL ? "Full access mode" : "Supervised mode"}</TooltipContent>
              </Tooltip>
            </>
          ) : showInlineComposerOptions ? (
            <InlineComposerOptions
              threadId={threadId}
              access={access}
              permissionLocked={permissionLocked}
              onAccessChange={(next) => {
                setAccess(next);
                agentSettingsTouchedRef.current = true;
                if (threadId) void setThreadSettings(threadId, { permissionMode: next });
              }}
            />
          ) : (
            <ComposerOptionsMenu
              threadId={threadId}
              access={access}
              permissionLocked={permissionLocked}
              onAccessChange={(next) => {
                setAccess(next);
                agentSettingsTouchedRef.current = true;
                if (threadId) void setThreadSettings(threadId, { permissionMode: next });
              }}
            />
          )}

          {mode === INTERACTION_MODES.PLAN && planCapability ? (
            <ComposerCapabilityChip
              label={planCapability.label}
              icon={ListChecks}
              removeLabel={`Remove ${planCapability.label}`}
              onRemove={detachPlan}
              testId="composer-capability-plan"
            />
          ) : null}

          {goalPending && goalCapability ? (
            <ComposerCapabilityChip
              label={goalCapability.label}
              icon={Goal}
              removeLabel={`Remove ${goalCapability.label}`}
              onRemove={detachPendingGoal}
              testId="composer-capability-goal-pending"
            />
          ) : threadId && !isNewThread ? (
            <ActiveGoalChip threadId={threadId} goal={activeGoal} />
          ) : null}

          {orchestrationMode === ORCHESTRATION_MODES.PROACTIVE && orchestrationCapability ? (
            <ComposerCapabilityChip
              label={orchestrationCapability.label}
              icon={Network}
              removeLabel={`Remove ${orchestrationCapability.label}`}
              onRemove={detachOrchestration}
              testId="composer-capability-orchestration"
            />
          ) : null}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Preparing worktree indicator */}
          {isThreadScaffold && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Preparing thread…
            </span>
          )}

          {/* Inline stop button: visible when agent running AND user has input AND wizard not pending */}
          {isAgentRunning && hasContent && !planPending && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleStop}
              className="text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
              title="Stop agent"
              aria-label="Stop agent"
            >
              <div className="h-2.5 w-2.5 rounded-sm bg-current" />
            </Button>
          )}

          {/* Context window tracker — live data from turnComplete, fallback to persisted thread record.
              Always resolve the denominator against the current model + mode so switching from a 1M model
              to Haiku immediately reflects 200K rather than the stale SDK-reported 1M value. */}
          {threadId && (() => {
            const effectiveCtxMode: ContextWindowMode = contextWindow ?? settingsDefaultContextWindow ?? "200k";
            const trackerContextWindow =
              getModelContextWindow(modelId, effectiveCtxMode) ??
              contextEntry?.contextWindow ??
              activeThread?.context_window ??
              undefined;
            return (
              <ContextTracker
                tokensIn={contextEntry?.lastTokensIn ?? activeThread?.last_context_tokens ?? 0}
                contextWindow={trackerContextWindow}
                totalProcessedTokens={contextEntry?.totalProcessedTokens}
                hasLowQuota={hasLowQuota}
              />
            );
          })()}

          {/* Send / Queue / Stop button */}
          <Button
            type="button"
            size="icon-sm"
            onClick={
              isThreadScaffold
                ? undefined
                : isAgentRunning && hasContent
                  ? handleSend
                  : isAgentRunning
                    ? handleStop
                    : handleSend
            }
            disabled={
              needsWorkspace ||
              !!providerReason ||
              isStaleWorktree ||
              planPending ||
              isThreadScaffold ||
              (!isAgentRunning && !hasContent)
            }
            className={cn(
              "rounded-full transition-colors",
              isThreadScaffold
                ? "bg-primary text-primary-foreground"
                : isAgentRunning && hasContent
                  ? "bg-primary/60 text-primary-foreground hover:bg-primary/75"
                  : isAgentRunning
                    ? "bg-destructive text-white hover:bg-destructive/90"
                    : hasContent
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "bg-muted text-muted-foreground opacity-40"
            )}
            title={
              needsWorkspace
                ? "Choose a project"
                : isThreadScaffold
                ? "Starting thread"
                : isAgentRunning && hasContent
                  ? "Queue message"
                  : isAgentRunning
                    ? "Stop agent"
                    : "Send message"
            }
            aria-label={
              needsWorkspace
                ? "Choose a project"
                : isThreadScaffold
                ? "Starting thread"
                : isAgentRunning && hasContent
                  ? "Queue message"
                  : isAgentRunning
                    ? "Stop agent"
                    : "Send message"
            }
          >
            {isThreadScaffold ? (
              <Spinner size={14} className="text-current" />
            ) : isAgentRunning && hasContent ? (
              <ArrowUp />
            ) : isAgentRunning ? (
              <div className="h-4 w-4 rounded-sm bg-current" />
            ) : (
              <ArrowUp />
            )}
          </Button>
        </div>
      </div>

      {/* Queued-send hint: shown while the child thread handoff is still generating */}
      {queuedSend && (
        <p className="px-1 pt-1 text-xs text-muted-foreground/60">
          queued · sends when handoff lands
        </p>
      )}

      {/* Status bar - below the container */}
      <div
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows,opacity,transform] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
          showComposerStatusBar ? "grid-rows-[1fr] opacity-100 translate-y-0" : "grid-rows-[0fr] opacity-0 translate-y-1 pointer-events-none",
        )}
        aria-hidden={!showComposerStatusBar}
        inert={showComposerStatusBar ? undefined : true}
      >
        {showComposerStatusBar && <div className="min-h-0">
          <div className="flex items-center justify-between px-1 pt-1.5">
            {!isGitRepo && isNewThread ? (
              <span className="flex h-6 items-center rounded-md px-1.5 py-0.5 text-xs text-muted-foreground/40">
                Not a git repo
              </span>
            ) : (
              <ModeSelector
                mode={branchFromMessageId ? branchExecMode : composerMode}
                onModeChange={branchFromMessageId ? setBranchExecMode : setComposerMode}
                locked={!isNewThread && !branchFromMessageId}
                options={modeOptions}
              />
            )}
            <div className="flex items-center gap-3">
              <TerminalStatusIndicator />
            </div>
            <div className="ml-auto flex items-center gap-1">
              {isNewThread ? (
                !isGitRepo ? null :
                composerMode === "direct" ? (
                  <BranchPicker
                    branches={branches}
                    selectedBranch={newThreadBranch || "main"}
                    onSelect={setNewThreadBranch}
                    loading={branchesLoading}
                    locked={false}
                  />
                ) : composerMode === "worktree" ? (
                  <>
                    <BranchPicker
                      branches={branches}
                      selectedBranch={newThreadBranch || "main"}
                      onSelect={setNewThreadBranch}
                      loading={branchesLoading}
                      locked={false}
                      pullRequests={openPrs}
                      prsLoading={openPrsLoading}
                      fetchingBranch={fetchingBranch}
                      onFetchAndSelect={handleFetchAndSelect}
                    />
                  </>
                ) : composerMode === "existing-worktree" ? (
                  <>
                    {selectedWorktreeIsDetached && (
                      <BranchPicker
                        branches={branches}
                        selectedBranch={newThreadBranch || "main"}
                        onSelect={setNewThreadBranch}
                        loading={branchesLoading}
                        locked={false}
                      />
                    )}
                    <Suspense fallback={<div className="h-7" />}><LazyWorktreePicker
                      worktrees={worktrees}
                      selectedPath={selectedWorktree?.path ?? ""}
                      onSelect={setSelectedWorktree}
                      loading={worktreesLoading}
                    /></Suspense>
                  </>
                ) : null
              ) : branchFromMessageId ? (
                // Branch mode: show execution controls for the child thread
                !isGitRepo ? null :
                branchExecMode === "direct" ? (
                  <BranchPicker
                    branches={branches}
                    selectedBranch={branchTargetBranch || activeThread?.branch || ""}
                    onSelect={setBranchTargetBranch}
                    loading={branchesLoading}
                    locked={false}
                  />
                ) : branchExecMode === "worktree" ? (
                  <>
                    <BranchPicker
                      branches={branches}
                      selectedBranch={branchTargetBranch || activeThread?.branch || ""}
                      onSelect={setBranchTargetBranch}
                      loading={branchesLoading}
                      locked={false}
                    />
                  </>
                ) : (
                  <>
                    {branchWorktreeIsDetached && (
                      <BranchPicker
                        branches={branches}
                        selectedBranch={branchTargetBranch || activeThread?.base_branch || activeThread?.branch || "main"}
                        onSelect={setBranchTargetBranch}
                        loading={branchesLoading}
                        locked={false}
                      />
                    )}
                    <Suspense fallback={<div className="h-7" />}><LazyWorktreePicker
                      worktrees={worktrees}
                      selectedPath={branchWorktreePath}
                      onSelect={(wt) => setBranchWorktreePath(wt.path)}
                      loading={worktreesLoading}
                    /></Suspense>
                  </>
                )
              ) : null}
            </div>
          </div>
        </div>}
      </div>
      </div>{/* end max-width wrapper */}

      <SlashCommandPopup
        state={slashCommand.state}
        selectedIndex={slashCommand.selectedIndex}
        anchorRect={slashCommand.anchorRect}
        workspacePath={activeWorkspace?.path}
        onSelect={handleSlashSelect}
        onDismiss={slashCommand.onDismiss}
        onRetry={slashCommand.onRetry}
      />
      <Dialog
        open={pendingCheckoutConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) cancelCheckoutConfirmation();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch branch?</DialogTitle>
            <DialogDescription>
              {pendingCheckoutConfirmation
                ? `You're on "${pendingCheckoutConfirmation.currentBranch}" but selected "${pendingCheckoutConfirmation.targetBranch}". Switch to "${pendingCheckoutConfirmation.targetBranch}" before starting the thread?`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={checkoutConfirming} />}>
              Cancel
            </DialogClose>
            <Button onClick={confirmCheckoutAndSend} disabled={checkoutConfirming}>
              {checkoutConfirming ? "Switching..." : "Switch and send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
