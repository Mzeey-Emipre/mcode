import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from "react";
import { useThreadStore, scheduleDrainAfterEdit, getHandoffStatus } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { getThreadRecord } from "@/stores/thread-record";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useWorkspaceThread, readWorkspaceThread } from "@/stores/workspace-selectors";
import { resolveComposerSession, snapshotComposerDraft } from "@/lib/composer-session";
import type { PermissionMode, InteractionMode, AttachmentMeta } from "@/transport";
import { PERMISSION_MODES, INTERACTION_MODES, getTransport } from "@/transport";
import {
  ArrowUp,
  Hammer,
  FileEdit,
  Lock,
  Unlock,
  ChevronDown,
  Loader2,
  Check,
  ListTodo,
  MoreHorizontal,
  Paperclip,
  Target,
  Info,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { isWindows } from "@/lib/platform";
import { isCursorPermissionLockedToFull } from "@/lib/cursor-permission";
import { isGoalControlCommand } from "@/lib/goal-command";
import { isDetachedWorktree } from "@/lib/worktree";
import { getDefaultModelId, getDefaultReasoningLevel, getDefaultProviderId, isMaxEffortModel, isXhighEffortModel, supportsEffortParameter, supportsUltrathink, supports1MContextWindow, supportsThinkingToggle, normalizeReasoningLevelForModel, getCodexReasoningLevels, providerSupportsReasoningLevels } from "@/lib/model-registry";
import { ModelSelector } from "./ModelSelector";
import { ModeSelector, ALL_MODE_OPTIONS } from "./ModeSelector";
import type { ComposerMode, ModeOption } from "./ModeSelector";
import { BranchPicker } from "./BranchPicker";
const LazyWorktreePicker = lazy(() => import("./WorktreePicker"));
import { CopilotAgentSelector } from "./CopilotAgentSelector";
import { AttachmentPreview } from "./AttachmentPreview";
import type { PendingAttachment } from "./AttachmentPreview";
import { useFileAutocomplete, clearFileListCache, type MentionSuggestion } from "./useFileAutocomplete";
import { useFileTagPopup, FileTagPopup } from "./FileTagPopup";
import { SpellcheckContextMenu } from "./SpellcheckContextMenu";
import {
  ComposerEditor,
  $createTypedMentionNode,
  extractComposerMessage,
  insertMentionNode,
  insertSlashCommandNode,
  type MentionNodeData,
} from "./lexical";
import { TerminalStatusIndicator } from "./TerminalStatusIndicator";
import { useTaskStore } from "@/stores/taskStore";
import { useDiffStore } from "@/stores/diffStore";
import {
  hideRightPanelAdaptive,
  showRightPanelAdaptive,
} from "@/lib/right-panel-layout";
import { useSlashCommand } from "./useSlashCommand";
import type { Command } from "./useSlashCommand";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { type LexicalEditor, $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { PrDetectedCard } from "./PrDetectedCard";
import type { PrDetail } from "@/transport/types";
import { ComposerQueueList } from "./ComposerQueueList";
import { ContextTracker } from "./ContextTracker";
import { CompactingBanner } from "./CompactingBanner";
import { RetryBanner } from "./RetryBanner";
import { InterruptStopBanner } from "./InterruptStopBanner";
import { ComposerBranchBar } from "./ComposerBranchBar";
import { ComposerReplyBar } from "./ComposerReplyBar";
import { useReplyStore } from "@/stores/replyStore";
import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import {
  classifyFile,
  isFileSupported,
  getMaxFileSize,
  inferMimeType,
  storedAttachmentSuffix,
  MAX_ATTACHMENTS,
  MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
  isVirtualBrowserContextAttachment,
  attachmentAcceptAttribute,
} from "@mcode/contracts";
import type {
  AttachedBrowserCapture,
  ContextWindowMode,
  MessageMention,
  ReasoningLevel,
  ProviderId,
  GoalState,
} from "@mcode/contracts";
import { getModelContextWindow } from "@mcode/shared/model-context";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { usePreviewReferenceQueueStore } from "@/stores/previewReferenceQueueStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useElementWidth } from "@/hooks/useElementWidth";
import { ProviderUnavailableBanner } from "./ProviderUnavailableBanner";
import { appendBrowserCaptureFence } from "@/lib/browser-capture-append";
import {
  collectBrowserCaptureSpillPaths,
  collectSpillPathsFromPendingAttachments,
  releaseBrowserCaptureSpills,
} from "@/lib/browser-capture-spill";

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
      if (
        mention.range.start < cursor ||
        mention.range.end > text.length ||
        text.slice(mention.range.start, mention.range.end) !== `@${mention.label}`
      ) {
        continue;
      }
      appendText(text.slice(cursor, mention.range.start));
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
              provider: mention.provider,
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
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultrathink",
]);

/** Display label for a reasoning level value. */
function reasoningLabel(level: string): string {
  if (level === "xhigh") return "X-High";
  if (level === "ultrathink") return "Ultrathink";
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
}

type AccessMode = PermissionMode;

/**
 * Overflow popover that hosts secondary composer controls (interaction mode,
 * permission mode, and the Tasks-panel toggle when applicable).
 *
 * Centralizing these behind a single trigger keeps the status bar compact on
 * every viewport — previously each toggle was its own button and they wrapped
 * onto a second row at narrow widths.
 */
function ComposerOptionsMenu({
  threadId,
  mode,
  access,
  permissionLocked,
  onModeChange,
  onAccessChange,
}: {
  threadId?: string;
  mode: InteractionMode;
  access: PermissionMode;
  /**
   * When true, the permission toggle is hidden and Full access is shown
   * as a non-interactive badge. Set for cursor on Windows because
   * cursor-agent --print has no interactive permission flow and the OS
   * sandbox is unavailable on Windows. See {@link isCursorPermissionLockedToFull}.
   */
  permissionLocked: boolean;
  onModeChange: (next: InteractionMode) => void;
  onAccessChange: (next: PermissionMode) => void;
}) {
  const hasTasks = useTaskStore(
    (s) => !!(threadId && s.tasksByThread[threadId]?.length),
  );
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const panelVisible = useDiffStore((s) =>
    activeWorkspaceId ? s.getRightPanelVisible(activeWorkspaceId, threadId) : false,
  );

  const toggleTasksPanel = () => {
    // Scope is thread-only; the whole panel record is per-thread (ADR-0012).
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
        {/* Mode */}
        <div className="px-1.5 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
          Mode
        </div>
        <div className="mb-2 flex rounded-md bg-muted/40 p-0.5">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onModeChange(INTERACTION_MODES.BUILD)}
            aria-pressed={mode === INTERACTION_MODES.BUILD}
            className={cn(
              "h-auto flex-1 gap-1.5 rounded-[5px] px-2 py-1 text-xs font-medium hover:bg-transparent",
              mode === INTERACTION_MODES.BUILD
                ? "bg-background text-foreground shadow-sm hover:bg-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Hammer size={12} />
            Build
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onModeChange(INTERACTION_MODES.PLAN)}
            aria-pressed={mode === INTERACTION_MODES.PLAN}
            className={cn(
              "h-auto flex-1 gap-1.5 rounded-[5px] px-2 py-1 text-xs font-medium hover:bg-transparent",
              mode === INTERACTION_MODES.PLAN
                ? "bg-background text-foreground shadow-sm hover:bg-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <FileEdit size={12} />
            Plan
          </Button>
        </div>

        {/* Permissions */}
        <div className="px-1.5 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
          Permissions
        </div>
        {permissionLocked ? (
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1.5 text-xs font-medium text-muted-foreground",
              hasTasks && "mb-2",
            )}
            title="Cursor on Windows runs in full access — supervised mode is unavailable because cursor-agent's OS sandbox requires macOS or Linux."
          >
            <Unlock size={12} />
            Full access (Cursor on Windows)
          </div>
        ) : (
          <div className={cn("flex rounded-md bg-muted/40 p-0.5", hasTasks && "mb-2")}>
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

        {/* Tasks panel — only available when the thread has tasks. */}
        {hasTasks && (
          <Button
            variant="ghost"
            size="xs"
            onClick={toggleTasksPanel}
            aria-pressed={panelVisible}
            className="h-auto w-full justify-between rounded-md px-2 py-1.5 text-xs font-normal text-foreground hover:bg-muted/40"
          >
            <span className="flex items-center gap-2">
              <ListTodo size={13} className={panelVisible ? "text-primary" : "text-muted-foreground"} />
              Tasks panel
            </span>
            <span className={cn("text-[10px] font-medium uppercase tracking-[0.1em]", panelVisible ? "text-primary" : "text-muted-foreground/60")}>
              {panelVisible ? "On" : "Off"}
            </span>
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Inline rendering of the same controls — Mode (Chat/Plan), Permissions
 * (Full/Supervised), and the Tasks-panel toggle. Used at md+ widths where the
 * controls fit comfortably in the model bar; below md the parent renders
 * `ComposerOptionsMenu` instead so they collapse behind a single trigger.
 */
function InlineComposerOptions({
  threadId,
  mode,
  access,
  permissionLocked,
  onModeChange,
  onAccessChange,
}: {
  threadId?: string;
  mode: InteractionMode;
  access: PermissionMode;
  /** See {@link ComposerOptionsMenu}. */
  permissionLocked: boolean;
  onModeChange: (next: InteractionMode) => void;
  onAccessChange: (next: PermissionMode) => void;
}) {
  const hasTasks = useTaskStore(
    (s) => !!(threadId && s.tasksByThread[threadId]?.length),
  );
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const panelVisible = useDiffStore((s) =>
    activeWorkspaceId ? s.getRightPanelVisible(activeWorkspaceId, threadId) : false,
  );

  const toggleTasksPanel = () => {
    // Scope is thread-only; the whole panel record is per-thread (ADR-0012).
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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onModeChange(mode === INTERACTION_MODES.BUILD ? INTERACTION_MODES.PLAN : INTERACTION_MODES.BUILD)}
              className="gap-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              {mode === INTERACTION_MODES.BUILD ? <Hammer size={14} /> : <FileEdit size={14} />}
              <span className="text-sm">{mode === INTERACTION_MODES.BUILD ? "Build" : "Plan"}</span>
            </Button>
          }
        />
        <TooltipContent>{mode === INTERACTION_MODES.BUILD ? "Build mode" : "Plan mode"}</TooltipContent>
      </Tooltip>

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

      {hasTasks && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                onClick={toggleTasksPanel}
                aria-pressed={panelVisible}
                className={cn(
                  "gap-1.5 transition-colors hover:bg-muted/40",
                  panelVisible
                    ? "text-primary hover:text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <ListTodo size={14} />
                <span className="text-sm">Scope</span>
              </Button>
            }
          />
          <TooltipContent>{panelVisible ? "Hide scope panel" : "Show scope panel"}</TooltipContent>
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

function ActiveGoalBar({
  threadId,
  goal,
}: {
  threadId: string;
  goal: GoalState | null | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());
  const sendMessage = useThreadStore((s) => s.sendMessage);

  useEffect(() => {
    if (!goal || goal.status === "complete") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [goal?.createdAt, goal?.status]);

  if (!goal || goal.status === "complete") return null;

  const createdAt = goalTimestampMs(goal.createdAt);
  const elapsed = Math.max(goal.timeUsedSeconds, Math.floor((now - createdAt) / 1000));
  const canInspect = goal.controls.canInspect === true;
  const canClear = goal.controls.canClear === true;

  return (
    <div
      className="mb-2 flex min-h-9 items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/35 px-3 py-2 text-xs text-muted-foreground shadow-sm"
      data-testid="active-goal-bar"
    >
      <div className="min-w-0 flex items-center gap-2">
        <Target size={13} className="shrink-0 text-primary" aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground">
          {goalStatusLabel(goal.status)}
        </span>
        <span className="shrink-0 text-muted-foreground/80">·</span>
        <span className="shrink-0 tabular-nums">{formatGoalElapsed(elapsed)}</span>
        <span className="truncate text-muted-foreground/80">{goal.objective}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canInspect && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  aria-label="Show active goal"
                  onClick={() => void sendMessage(threadId, "/goal show")}
                >
                  <Info size={13} />
                </Button>
              }
            />
            <TooltipContent>Show active goal</TooltipContent>
          </Tooltip>
        )}
        {canClear && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  aria-label="Clear active goal"
                  onClick={() => void sendMessage(threadId, "/goal clear")}
                >
                  <Trash2 size={13} />
                </Button>
              }
            />
            <TooltipContent>Clear active goal</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
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
export function Composer({ threadId, isNewThread, workspaceId, branchFromMessageId, branchFromMessageContent, onBranchModeExit }: ComposerProps) {
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
  // Empirically the row needs roughly 720–740px of container width to render
  // without crowding; 760 leaves a small safety margin for longer model names.
  const COMPOSER_INLINE_OPTIONS_THRESHOLD = 760;
  // Default to inline before the first measurement lands so the first frame
  // doesn't briefly render the popover trigger and snap to inline buttons.
  const showInlineComposerOptions =
    composerWidth === 0 || composerWidth >= COMPOSER_INLINE_OPTIONS_THRESHOLD;

  const replyContext = useReplyStore((s) => threadId ? s.replyByThread[threadId] : undefined);
  const clearReply = useReplyStore((s) => s.clearReply);

  const [input, setInput] = useState("");
  const [mentions, setMentions] = useState<MessageMention[]>([]);
  const [modelId, setModelId] = useState(getDefaultModelId());
  // Track provider explicitly: multiple providers share the same model IDs
  // (e.g. "gpt-5.3-codex" exists in both Codex and Copilot), so deriving the
  // provider from the model ID alone is ambiguous and routes to the wrong backend.
  const [provider, setProvider] = useState<string>(getDefaultProviderId());
  const [reasoning, setReasoning] = useState<ReasoningLevel>(getDefaultReasoningLevel());
  const [mode, setMode] = useState<InteractionMode>(INTERACTION_MODES.BUILD);
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
  /**
   * Text queued for send while the child thread's handoff context is still generating.
   * Fires automatically when handoff status transitions to ready or fallback.
   */
  const [queuedSend, setQueuedSend] = useState<{
    content: string;
    displayContent: string;
    mentions: MessageMention[];
  } | null>(null);
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
      const room = MAX_ATTACHMENTS - prev.length;
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
              permissionMode: s.permissionMode,
              copilotAgent: s.copilotAgent ?? null,
              contextWindow: s.contextWindow ?? null,
              thinking: s.thinking ?? null,
              codexFastMode: s.codexFastMode ?? null,
            };
          })()
        : {
            interactionMode: INTERACTION_MODES.BUILD,
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

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const workspacePath = workspaces.find((w) => w.id === workspaceId)?.path;

  const activeThread = useWorkspaceThread(threadId, (t) => t);
  const isThreadScaffold = !!(
    activeThread?.clientPreparing || activeThread?.clientError
  );

  const activeProviderId = activeThread?.provider ?? "claude";
  const usageInfo = useThreadRecord(threadId, (r) => r.usageByProvider[activeProviderId]);
  const hasLowQuota = usageInfo?.quotaCategories.some((c) => !c.isUnlimited && c.remainingPercent < 0.2) ?? false;

  // For new threads (no active thread yet), fall back to the composer-selected
  // provider so the availability banner tracks what the user is about to submit.
  const effectiveProviderId = (activeThread?.provider ?? provider) as ProviderId;
  const availability = useProviderAvailabilityStore((s) => s.getAvailability(effectiveProviderId));
  const providerUnusable = !!availability && (
    !availability.enabled || availability.cli.status === "not_found"
  );
  const providerReason: "disabled" | "cli_missing" | null = providerUnusable
    ? (!availability!.enabled ? "disabled" : "cli_missing")
    : null;

  const fileAutocomplete = useFileAutocomplete({
    workspaceId,
    threadId,
    providerId: effectiveProviderId,
  });

  const handleMentionSelect = useCallback((item: MentionSuggestion) => {
    fileAutocomplete.selectSuggestion(item);
    if (!editorRef.current) return;

    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `mention-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const mention: MentionNodeData =
      item.kind === "agent"
        ? {
            id,
            kind: "agent",
            label: item.label,
            name: item.name,
            path: item.path,
            provider: item.provider,
          }
        : {
            id,
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

  const branches = useWorkspaceStore((s) => s.branches);
  const branchesLoading = useWorkspaceStore((s) => s.branchesLoading);
  const newThreadMode = useWorkspaceStore((s) => s.newThreadMode);
  const newThreadBranch = useWorkspaceStore((s) => s.newThreadBranch);
  const setNewThreadMode = useWorkspaceStore((s) => s.setNewThreadMode);
  const setNewThreadBranch = useWorkspaceStore((s) => s.setNewThreadBranch);

  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const isGitRepo = activeWorkspace?.is_git_repo ?? true;

  const modeOptions = useMemo<ModeOption[]>(
    () => isGitRepo ? ALL_MODE_OPTIONS : ALL_MODE_OPTIONS.filter((o) => o.value === "direct"),
    [isGitRepo],
  );

  const slashCommand = useSlashCommand({
    anchorRef: editorContainerRef,
    cwd: workspacePath,
    providerId: effectiveProviderId,
    onMcodeCommand: (action) => {
      if (action === "toggle-plan") {
        const next =
          mode === INTERACTION_MODES.PLAN
            ? INTERACTION_MODES.BUILD
            : INTERACTION_MODES.PLAN;
        setMode(next);
        if (threadId) void setThreadSettings(threadId, { interactionMode: next });
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
    () => worktrees.find((wt) => wt.path === branchWorktreePath) ?? null,
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
      if (mode === "existing-worktree" && workspaceId) {
        loadWorktrees(workspaceId);
      }
    },
    [setNewThreadMode, loadWorktrees, workspaceId],
  );

  // Sync composerMode with thread's persisted mode when switching threads
  useEffect(() => {
    const mode = activeThread?.mode === "worktree" ? "worktree" : "direct";
    setComposerModeLocal(mode);
    setNewThreadMode(mode);
  }, [activeThread?.mode, setNewThreadMode]);

  // Force direct mode for non-git workspaces — worktree modes are not available without git
  useEffect(() => {
    if (!isGitRepo && composerMode !== "direct") {
      setComposerModeLocal("direct");
      setNewThreadMode("direct");
    }
  }, [isGitRepo, composerMode, setNewThreadMode]);

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

  const hasContent = input.trim().length > 0 || attachments.length > 0;

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
      return {
        content: trimmedInput,
        displayContent: trimmedInput,
        mentions: mentionsSnapshot.length > 0 ? mentionsSnapshot : undefined,
        attachments: attachmentMetas,
        model: modelId,
        permissionMode: access,
        reasoningLevel: reasoning,
        provider,
        copilotAgent: provider === "copilot" ? (copilotAgent ?? undefined) : undefined,
        contextWindow: contextWindow ?? undefined,
        thinking: thinking ?? undefined,
        codexFastMode:
          provider === "codex" ? (codexFastMode === null ? undefined : codexFastMode) : undefined,
        replyToMessageId: replyContext?.messageId,
        quotedText: replyContext?.quotedText,
      };
    },
    [modelId, access, reasoning, provider, copilotAgent, contextWindow, thinking, codexFastMode, replyContext],
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
      setEditingFromQueue({ messageId: popped.id, originalIndex: targetIndex });
      useQueueStore.getState().setEditingThreadId(threadId);

      const text = popped.displayContent || popped.content;
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
      if (popped.permissionMode) setAccess(popped.permissionMode);
      setCopilotAgent(popped.copilotAgent ?? null);
      setContextWindow(popped.contextWindow ?? null);
      setThinking(popped.thinking ?? null);
      setCodexFastMode(popped.codexFastMode !== undefined ? popped.codexFastMode : null);

      if (popped.browserCaptureSpillPaths?.length) {
        void releaseBrowserCaptureSpills(popped.browserCaptureSpillPaths);
      }

      editorRef.current?.focus();
    },
    [
      threadId,
      editingFromQueue,
      input,
      attachments,
      mentions,
      captureComposerForRequeue,
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
    const original = editingOriginalRef.current;
    if (original) {
      useQueueStore.getState().insertAt(threadId, editingFromQueue.originalIndex, {
        content: original.content,
        displayContent: original.displayContent,
        mentions: original.mentions,
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
    setEditingFromQueue(null);
    useQueueStore.getState().setEditingThreadId(null);
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
  }, [threadId, editingFromQueue, setInput, setAttachments]);

  const handleFetchAndSelect = useCallback(async (branch: string, prNumber: number) => {
    if (!workspaceId) return;
    await fetchBranch(workspaceId, branch, prNumber);
    setNewThreadBranch(branch);
  }, [workspaceId, fetchBranch, setNewThreadBranch]);

  const handlePrReview = useCallback(async () => {
    if (!detectedPr || !workspaceId) return;
    setComposerMode("worktree");
    await fetchBranch(workspaceId, detectedPr.branch, detectedPr.number);
    setNewThreadBranch(detectedPr.branch);
    const prefill = `Review PR #${detectedPr.number}: ${detectedPr.title}`;
    setInput(prefill);
    setMentions([]);
    // Also populate the Lexical editor so the user sees the prefilled text
    if (editorRef.current) writeComposerContent(editorRef.current, prefill);
    setDetectedPr(null);
    setPrDismissed(false);
  }, [detectedPr, workspaceId, setComposerMode, fetchBranch, setNewThreadBranch]);

  const addFiles = useCallback((files: File[], filePaths?: (string | null)[]) => {
    setAttachments((prev) => {
      const remaining = MAX_ATTACHMENTS - prev.length;
      if (remaining <= 0) return prev;

      const newAttachments: PendingAttachment[] = [];
      for (let i = 0; i < Math.min(files.length, remaining); i++) {
        const file = files[i];
        if (!isFileSupported(file.name)) continue;
        if (file.size > getMaxFileSize(file.name)) continue;

        const mimeType = file.type || inferMimeType(file.name);
        const previewUrl = classifyFile(file.name) === "image"
          ? URL.createObjectURL(file)
          : "";

        newAttachments.push({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType,
          sizeBytes: file.size,
          previewUrl,
          filePath: filePaths?.[i] || null,
        });
      }

      return [...prev, ...newAttachments];
    });
  }, []);

  const handleAttachmentInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (!list?.length) return;
      const files = Array.from(list);
      const bridge = window.desktopBridge;
      const paths = files.map((f) => {
        try {
          return bridge?.getPathForFile?.(f) ?? null;
        } catch {
          return null;
        }
      });
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

    const bridge = window.desktopBridge;

    // Attempt to resolve real file paths for all supported files
    const paths = supported.map((f) => {
      try { return bridge?.getPathForFile?.(f) || null; } catch { return null; }
    });

    // Partition into files with and without real paths
    const withPaths: File[] = [];
    const withPathPaths: (string | null)[] = [];
    const withoutPaths: File[] = [];

    for (let i = 0; i < supported.length; i++) {
      if (paths[i]) {
        withPaths.push(supported[i]);
        withPathPaths.push(paths[i]);
      } else {
        withoutPaths.push(supported[i]);
      }
    }

    // Files with real paths go straight to addFiles
    if (withPaths.length > 0) {
      addFiles(withPaths, withPathPaths);
    }

    // Files without paths need fallback handling
    for (const file of withoutPaths) {
      if (classifyFile(file.name) === "image") {
        try {
          let meta: AttachmentMeta | null = bridge?.readClipboardImage
            ? await bridge.readClipboardImage()
            : await getTransport().readClipboardImage();
          if (!meta) {
            const arrayBuffer = await file.arrayBuffer();
            const mimeType = file.type || inferMimeType(file.name || "image/png");
            const ext = storedAttachmentSuffix(mimeType) || ".bin";
            const safeName =
              file.name && isFileSupported(file.name)
                ? file.name
                : `clipboard-${Date.now()}${ext}`;
            if (bridge?.saveClipboardFile) {
              meta = await bridge.saveClipboardFile(
                new Uint8Array(arrayBuffer),
                mimeType,
                safeName,
              );
            } else {
              meta = await getTransport().saveClipboardFile(arrayBuffer, mimeType, safeName);
            }
          }
          if (meta) {
            setAttachments((prev) => {
              if (prev.length >= MAX_ATTACHMENTS) return prev;
              const previewUrl = URL.createObjectURL(file);
              return [...prev, {
                id: meta.id,
                name: meta.name,
                mimeType: meta.mimeType,
                sizeBytes: meta.sizeBytes,
                previewUrl,
                filePath: meta.sourcePath,
              }];
            });
          }
        } catch {
          addFiles([file]);
        }
      } else {
        // Non-images (PDF, text): read blob and save via bridge or transport
        if (file.size > getMaxFileSize(file.name)) continue;
        const mimeType = file.type || inferMimeType(file.name);
        try {
          let meta: AttachmentMeta | null = null;
          if (bridge?.saveClipboardFile) {
            const arrayBuffer = await file.arrayBuffer();
            meta = await bridge.saveClipboardFile(
              new Uint8Array(arrayBuffer),
              mimeType,
              file.name,
            );
          } else {
            // Send binary data directly over WebSocket (no base64 encoding)
            const arrayBuffer = await file.arrayBuffer();
            meta = await getTransport().saveClipboardFile(arrayBuffer, mimeType, file.name);
          }
          if (meta) {
            const resolved = meta;
            setAttachments((prev) => {
              if (prev.length >= MAX_ATTACHMENTS) return prev;
              return [...prev, {
                id: resolved.id,
                name: resolved.name,
                mimeType: resolved.mimeType,
                sizeBytes: resolved.sizeBytes,
                previewUrl: "",
                filePath: resolved.sourcePath,
              }];
            });
          }
        } catch {
          addFiles([file]);
        }
      }
    }
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
    const bridge = window.desktopBridge;
    const paths = supported.map((f) => {
      try { return bridge?.getPathForFile?.(f) ?? null; } catch { return null; }
    });
    addFiles(supported, paths);
    editorRef.current?.focus();
  }, [addFiles]);

  /** Collect attachment metadata for RPC and revoke preview URLs. */
  const collectAndClearAttachments = useCallback((): AttachmentMeta[] => {
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
  }, [attachments]);

  const handleSend = useCallback(async () => {
    const composerMessage = editorRef.current
      ? extractComposerMessage(editorRef.current)
      : { text: input, mentions };
    const rawInput = composerMessage.text;
    const selectedMentions = composerMessage.mentions;
    const trimmed = rawInput.trim();
    if (trimmed.length === 0 && attachments.length === 0) {
      // Empty submit while editing a queued message = the user emptied it
      // intentionally. Treat as "remove from queue" instead of silently
      // doing nothing (the message has already been popped on edit start).
      if (editingFromQueue) {
        const slot = editingFromQueue.originalIndex;
        editingOriginalRef.current = null;
        setEditingFromQueue(null);
        useQueueStore.getState().setEditingThreadId(null);
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
        attachments: currentAttachments,
        model: modelId,
        permissionMode: access,
        reasoningLevel: reasoning,
        provider,
        copilotAgent: provider === "copilot" ? (copilotAgent ?? undefined) : undefined,
        contextWindow: contextWindow ?? undefined,
        thinking: thinking ?? undefined,
        codexFastMode:
          provider === "codex" ? (codexFastMode === null ? undefined : codexFastMode) : undefined,
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

    // Validate worktree mode requirements
    if (isNewThread && newThreadMode === "existing-worktree" && !selectedWorktree) {
      return;
    }

    // Checkout confirmation for local mode when a different branch is selected
    if (isNewThread && isGitRepo && newThreadMode === "direct" && newThreadBranch && workspaceId) {
      const currentBranch = await useWorkspaceStore.getState().getCurrentBranch(workspaceId);
      if (currentBranch && newThreadBranch !== currentBranch) {
        const confirmed = window.confirm(
          `You're on "${currentBranch}" but selected "${newThreadBranch}". Switch to "${newThreadBranch}"? This will checkout the branch.`,
        );
        if (!confirmed) return;
        await useWorkspaceStore.getState().checkoutBranch(workspaceId, newThreadBranch);
        clearFileListCache(workspaceId);
      }
    }

    const captureRows = buildAttachedBrowserCaptures(attachments);
    let messageContent: string;
    try {
      messageContent =
        captureRows.length === 0 ? rawInput : appendBrowserCaptureFence(rawInput, captureRows);
      messageContent = messageContent.trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid page preview payload";
      useToastStore.getState().show("error", "Could not send message", msg);
      return;
    }
    const outboundDisplay = resolveOutboundDisplayContent(rawInput, undefined);

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
    setEditingFromQueue(null);
    useQueueStore.getState().setEditingThreadId(null);
    const currentAttachments = collectAndClearAttachments();
    if (threadId) clearDraftFromStore(threadId);
    // Hide the reply bar with the composer reset; sendMessage still receives reply IDs from this render.
    if (threadId) clearReply(threadId);

    if (isNewThread && workspaceId) {
      await useWorkspaceStore
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
        );
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
      );
    }

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
  }, [input, mentions, attachments, isAgentRunning, isNewThread, newThreadMode, newThreadBranch, workspaceId, threadId, sendMessage, modelId, provider, reasoning, mode, access, copilotAgent, contextWindow, thinking, codexFastMode, selectedWorktree, collectAndClearAttachments, clearDraftFromStore, isThreadScaffold, branchFromMessageId, branchExecMode, branchTargetBranch, branchWorktreePath, branchWorktreeIsDetached, activeThread, branchThread, onBranchModeExit, replyContext, clearReply, editingFromQueue, slashCommand]);

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
    useThreadStore.getState().sendMessage(
      threadId,
      queued.content,
      modelId,
      access,
      undefined,
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
    // Action-only commands (e.g. /plan toggle) should not insert a chip
    if (!cmd.action && editorRef.current) {
      insertSlashCommandNode(editorRef.current, cmd.name, cmd.namespace);
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
      ...(supportsUltrathink(modelId) ? (["ultrathink"] as const) : []),
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

  return (
    <div className="relative px-8 py-4">
      {/* Soft gradient hint above the composer — short enough that it doesn't
          bury the last line of content (e.g. the turn footer) when the chat is
          scrolled to its tail. Reduced from h-5/opaque to h-3/70% so the band
          reads as edge-softening rather than a mask. */}
      <div className="pointer-events-none absolute inset-x-0 -top-3 h-3 bg-gradient-to-t from-background/70 to-transparent" />
      {/* Queue toast */}
      {toast && (
        <div className="pointer-events-none absolute -top-8 right-4 z-20 flex items-center gap-1.5 rounded-full bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/50 backdrop-blur-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-150">
          <Check size={10} className="text-primary" />
          {toast}
        </div>
      )}

      {/* Max-width wrapper to align with message list column */}
      <div className="mx-auto w-full max-w-4xl">

      {/* Inline queued-message stack (above the composer; Cursor-style).
          Auto-hides when the queue is empty. Editing a row pops the message
          and rehydrates it into this composer via loadIntoComposer. */}
      {threadId && !branchFromMessageId && !isNewThread && (
        <ComposerQueueList
          threadId={threadId}
          isAgentRunning={isAgentRunning}
          provider={provider}
          isEditing={!!editingFromQueue}
          onLoadIntoComposer={loadIntoComposer}
          onResume={async () => {
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

      {threadId && !isNewThread && (
        <ActiveGoalBar threadId={threadId} goal={activeGoal} />
      )}

      {/* Main composer container - dark bg, rounded */}
      <div
        ref={composerContainerRef}
        className={cn(
          "relative rounded-xl bg-muted/50 ring-1 ring-inset ring-border/60 shadow-lg shadow-black/20 focus-within:ring-2 focus-within:ring-primary/70",
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
            <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-primary/85">
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
            placeholder={isStaleWorktree ? "Worktree directory no longer exists. This thread is read-only." : planPending ? "Answer the planning questions above" : branchFromMessageId ? "What should the branch work on?" : editingFromQueue ? "Edit the queued message - send to save." : replyContext ? "Type your reply..." : isAgentRunning ? "Queue a follow-up..." : "Message Mcode..."}
          />
          <FileTagPopup
            items={fileAutocomplete.suggestions}
            isOpen={fileAutocomplete.isOpen}
            onSelect={handleMentionSelect}
            listRef={filePopup.listRef}
            selectedIndex={filePopup.selectedIndex}
          />
          <SpellcheckContextMenu editorRef={editorContainerRef} />
        </div>

        {/* Attachment previews */}
        <AttachmentPreview attachments={attachments} onRemove={removeAttachment} />

        {/* Compacting banner — shown while the SDK is summarising the context window */}
        {isCompacting && <CompactingBanner />}
        {!isCompacting && hasRetryState && threadId && <RetryBanner threadId={threadId} />}
        {threadId && <InterruptStopBanner threadId={threadId} />}

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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Attach files"
                  data-testid="composer-attach"
                  onClick={handleAttachPick}
                  className="text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  disabled={planPending || isStaleWorktree || !!providerReason}
                >
                  <Paperclip size={14} />
                </Button>
              }
            />
            <TooltipContent>Attach files</TooltipContent>
          </Tooltip>
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
                : hasReasoning && hasCodexFast && effectiveCodexFast
                  ? "FAST"
                  : !hasReasoning && hasThinking && thinkingOn
                    ? "ON"
                    : hasCodexFast && codexFastMode === null && effectiveCodexFast
                      ? "FAST"
                      : null;

            const tooltipLabel = hasReasoning
              ? has1M || hasThinking || hasCodexFast ? "Reasoning & model options" : "Reasoning level"
              : hasThinking
                ? "Thinking"
                : hasCodexFast
                  ? "Fast mode"
                  : "Context window";

            const sectionHeaderClass = "px-3 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none";
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
                        <span className="text-sm">{triggerLabel}</span>
                        {activeChipLabel && (
                          <span
                            data-testid="composer-1m-badge"
                            className="rounded-sm bg-foreground/5 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-foreground/80 ring-1 ring-inset ring-foreground/10 tabular-nums"
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
              mode={mode}
              access={access}
              permissionLocked={permissionLocked}
              onModeChange={(next) => {
                setMode(next);
                agentSettingsTouchedRef.current = true;
                if (threadId) void setThreadSettings(threadId, { interactionMode: next });
              }}
              onAccessChange={(next) => {
                setAccess(next);
                agentSettingsTouchedRef.current = true;
                if (threadId) void setThreadSettings(threadId, { permissionMode: next });
              }}
            />
          ) : (
            <ComposerOptionsMenu
              threadId={threadId}
              mode={mode}
              access={access}
              permissionLocked={permissionLocked}
              onModeChange={(next) => {
                setMode(next);
                agentSettingsTouchedRef.current = true;
                if (threadId) void setThreadSettings(threadId, { interactionMode: next });
              }}
              onAccessChange={(next) => {
                setAccess(next);
                agentSettingsTouchedRef.current = true;
                if (threadId) void setThreadSettings(threadId, { permissionMode: next });
              }}
            />
          )}

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
          <button
            type="button"
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
              !!providerReason ||
              isStaleWorktree ||
              planPending ||
              isThreadScaffold ||
              (!isAgentRunning && !hasContent)
            }
            className={cn(
              "rounded-full p-1.5 transition-colors",
              isThreadScaffold
                ? "bg-primary text-primary-foreground animate-spin"
                : isAgentRunning && hasContent
                  ? "bg-primary/60 text-primary-foreground hover:bg-primary/75"
                  : isAgentRunning
                    ? "bg-destructive text-white hover:bg-destructive/90"
                    : hasContent
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "bg-muted text-muted-foreground opacity-40"
            )}
            title={
              isThreadScaffold
                ? "Starting thread"
                : isAgentRunning && hasContent
                  ? "Queue message"
                  : isAgentRunning
                    ? "Stop agent"
                    : "Send message"
            }
            aria-label={
              isThreadScaffold
                ? "Starting thread"
                : isAgentRunning && hasContent
                  ? "Queue message"
                  : isAgentRunning
                    ? "Stop agent"
                    : "Send message"
            }
          >
            {isThreadScaffold ? (
              <Loader2 size={14} />
            ) : isAgentRunning && hasContent ? (
              <ArrowUp size={14} />
            ) : isAgentRunning ? (
              <div className="h-3 w-3 rounded-sm bg-current" />
            ) : (
              <ArrowUp size={14} />
            )}
          </button>
        </div>
      </div>

      {/* Queued-send hint: shown while the child thread handoff is still generating */}
      {queuedSend && (
        <p className="px-1 pt-1 text-[10px] text-muted-foreground/60">
          queued · sends when handoff lands
        </p>
      )}

      {/* Status bar - below the container */}
      <div className="flex items-center justify-between px-1 pt-1.5">
        {!isGitRepo && isNewThread ? (
          <span className="flex h-6 items-center rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground/40">
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
          ) : activeThread?.branch && isGitRepo ? (
            <BranchPicker
              branches={[]}
              selectedBranch={activeThread.branch}
              onSelect={() => {}}
              loading={false}
              locked={true}
            />
          ) : null}
        </div>
      </div>
      </div>{/* end max-width wrapper */}

      <SlashCommandPopup
        state={slashCommand.state}
        selectedIndex={slashCommand.selectedIndex}
        anchorRect={slashCommand.anchorRect}
        onSelect={handleSlashSelect}
        onDismiss={slashCommand.onDismiss}
        onRetry={slashCommand.onRetry}
      />
    </div>
  );
}
