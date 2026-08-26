import type { ComponentProps, DragEventHandler, RefObject } from "react";
import { ArrowUp, X } from "lucide-react";
import { AttachmentPreview } from "@/components/chat/AttachmentPreview";
import { ComposerAddMenu } from "@/components/chat/ComposerAddMenu";
import { ComposerBranchBar } from "@/components/chat/ComposerBranchBar";
import { ComposerQueueList } from "@/components/chat/ComposerQueueList";
import { ComposerReplyBar } from "@/components/chat/ComposerReplyBar";
import { CompactingBanner } from "@/components/chat/CompactingBanner";
import { ContextTracker } from "@/components/chat/ContextTracker";
import { FileTagPopup, type useFileTagPopup } from "@/components/chat/FileTagPopup";
import { PlanPreview } from "@/components/chat/PlanPreview";
import { PrDetectedCard } from "@/components/chat/PrDetectedCard";
import { PreviewAnnotationBundleChip } from "@/components/chat/PreviewAnnotationBundleChip";
import { ProviderUnavailableBanner } from "@/components/chat/ProviderUnavailableBanner";
import { RetryBanner } from "@/components/chat/RetryBanner";
import { type useSlashCommand } from "@/components/chat/useSlashCommand";
import { SpellcheckContextMenu } from "@/components/chat/SpellcheckContextMenu";
import { TaskBubble } from "@/components/chat/TaskBubble";
import { useFileAutocomplete } from "@/components/chat/useFileAutocomplete";
import { ComposerEditor } from "@/components/chat/lexical";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { getModelContextWindow } from "@mcode/shared/model-context";
import type { ContextWindowMode, MessageMention, ProviderId } from "@mcode/contracts";
import type { Thread } from "@/transport";
import { cn } from "@/lib/utils";
import { ComposerAgentControls } from "./controls/ComposerAgentControls";
import { ComposerNewThreadContext } from "./execution/ComposerNewThreadContext";

type FileAutocomplete = ReturnType<typeof useFileAutocomplete>;
type FilePopup = ReturnType<typeof useFileTagPopup>;
type SlashCommand = ReturnType<typeof useSlashCommand>;
type ComposerEditorProps = ComponentProps<typeof ComposerEditor>;
type ComposerAgentControlsProps = ComponentProps<typeof ComposerAgentControls>;

interface ComposerContentSurfaceProps {
  readonly model: {
    readonly threadId?: string;
    readonly workspaceId?: string;
    readonly isNewThread: boolean;
    readonly branchFromMessageId?: string;
    readonly branchFromMessageContent?: string;
    readonly activeThread?: Thread;
    readonly planPreview?: ComponentProps<typeof PlanPreview>["preview"];
    readonly planPanelOpen: boolean;
    readonly taskBubbleTasks: readonly ComponentProps<typeof TaskBubble>["tasks"][number][];
    readonly fileEffectSummary: ComponentProps<typeof TaskBubble>["fileEffects"];
    readonly isAgentRunning: boolean;
    readonly provider?: string;
    readonly planPending: boolean;
    readonly queuedSend: boolean;
    readonly needsWorkspace: boolean;
    readonly editingFromQueue: {
      readonly originalIndex: number;
    } | null;
    readonly composerMode: ComponentProps<typeof ComposerNewThreadContext>["mode"];
    readonly isDragOver: boolean;
    readonly replyContext?: {
      readonly sourceRole: ComponentProps<typeof ComposerReplyBar>["sourceRole"];
      readonly previewText: ComponentProps<typeof ComposerReplyBar>["previewText"];
    };
    readonly detectedPullRequest: Omit<
      ComponentProps<typeof PrDetectedCard>,
      "onReview" | "onDismiss" | "loading"
    > | null;
    readonly fetchingBranch: boolean;
    readonly effectiveProviderId: ProviderId;
    readonly providerReason: ComponentProps<typeof ProviderUnavailableBanner>["reason"] | null;
    readonly goalPending: boolean;
    readonly isStaleWorktree: boolean;
    readonly fileAutocomplete: FileAutocomplete;
    readonly filePopup: FilePopup;
    readonly filePopupAnchorRect: DOMRect | null;
    readonly slashCommand: SlashCommand;
    readonly attachmentBundle?: ComponentProps<typeof PreviewAnnotationBundleChip>["bundle"];
    readonly annotationScopeId?: string;
    readonly attachments: ComponentProps<typeof AttachmentPreview>["attachments"];
    readonly isCompacting: boolean;
    readonly hasRetryState: boolean;
    readonly isThreadScaffold: boolean;
    readonly hasContent: boolean;
    readonly showInlineComposerOptions: boolean;
    readonly attachmentInputRef: RefObject<HTMLInputElement | null>;
    readonly attachmentInputAccept: string;
    readonly composerContainerRef: RefObject<HTMLDivElement | null>;
    readonly editorContainerRef: RefObject<HTMLDivElement | null>;
    readonly editorRef: ComposerEditorProps["editorRef"];
    readonly selection: ComposerAgentControlsProps["selection"];
    readonly defaults: ComposerAgentControlsProps["defaults"];
    readonly agentControls: {
      readonly reasoningLevels: ComposerAgentControlsProps["reasoningLevels"];
      readonly capabilities: ComposerAgentControlsProps["capabilities"];
      readonly attachedCapabilityIds: ComponentProps<typeof ComposerAddMenu>["attachedCapabilityIds"];
      readonly permissionLocked: ComposerAgentControlsProps["permissionLocked"];
    };
    readonly activeGoal: ComposerAgentControlsProps["activeGoal"];
    readonly isModelFullyLocked: boolean;
    readonly isProviderLocked: boolean;
    readonly contextWindow: ContextWindowMode | null;
    readonly settingsDefaultContextWindow: ContextWindowMode | undefined;
    readonly modelId: ComposerAgentControlsProps["selection"]["modelId"];
    readonly contextEntry?: {
      readonly lastTokensIn?: number;
      readonly contextWindow?: number;
      readonly totalProcessedTokens?: number;
    };
    readonly hasLowQuota: boolean;
  };
  readonly actions: {
    readonly onBranchModeExit?: () => void;
    readonly onComposerModeChange: (mode: ComponentProps<typeof ComposerNewThreadContext>["mode"]) => void;
    readonly onLoadIntoComposer: ComponentProps<typeof ComposerQueueList>["onLoadIntoComposer"];
    readonly onResumeQueuedMessage: () => Promise<void>;
    readonly onSendQueuedMessageNow: NonNullable<ComponentProps<typeof ComposerQueueList>["onSendNow"]>;
    readonly onDragEnter: DragEventHandler<HTMLDivElement>;
    readonly onDragLeave: DragEventHandler<HTMLDivElement>;
    readonly onDragOver: DragEventHandler<HTMLDivElement>;
    readonly onDrop: DragEventHandler<HTMLDivElement>;
    readonly onClearReply: (threadId: string) => void;
    readonly onReviewDetectedPullRequest: () => void;
    readonly onDismissDetectedPullRequest: () => void;
    readonly onCancelEdit: () => void;
    readonly onEditorChange: (text: string, mentions: MessageMention[]) => void;
    readonly onSubmit: () => void;
    readonly onPopupKeyDown: (key: string) => boolean;
    readonly onMentionSelect: ComponentProps<typeof FileTagPopup>["onSelect"];
    readonly onPaste: ComponentProps<"div">["onPaste"];
    readonly onMarkRestoredPreviewAnnotationsCleared: () => void;
    readonly onRemoveAttachment: ComponentProps<typeof AttachmentPreview>["onRemove"];
    readonly onAttachmentInputChange: ComponentProps<"input">["onChange"];
    readonly onAttachPick: () => void;
    readonly onAttachCapability: ComponentProps<typeof ComposerAddMenu>["onAttachCapability"];
    readonly onSelectionChange: ComposerAgentControlsProps["onSelectionChange"];
    readonly onSelectionTouched: ComposerAgentControlsProps["onSelectionTouched"];
    readonly onDetachPlan: ComposerAgentControlsProps["onDetachPlan"];
    readonly onDetachGoal: ComposerAgentControlsProps["onDetachGoal"];
    readonly onDetachOrchestration: ComposerAgentControlsProps["onDetachOrchestration"];
    readonly onStop: () => void;
  };
}

function ComposerPlanPreview({ model }: Pick<ComposerContentSurfaceProps, "model">) {
  const showPlanPreview = Boolean(
    model.threadId && model.workspaceId && model.planPreview && !model.planPanelOpen
      && !model.branchFromMessageId && !model.isNewThread,
  );

  if (!showPlanPreview) return null;

  return (
    <div className="mb-2">
      <PlanPreview
        workspaceId={model.workspaceId!}
        threadId={model.threadId!}
        preview={model.planPreview!}
      />
    </div>
  );
}

function ComposerTaskBubble({ model }: Pick<ComposerContentSurfaceProps, "model">) {
  const showTaskBubble = Boolean(
    model.threadId && model.taskBubbleTasks.length > 0 && !model.branchFromMessageId
      && !model.isNewThread,
  );

  if (!showTaskBubble) return null;

  return (
    <div className="mb-2 flex justify-center">
      <TaskBubble tasks={model.taskBubbleTasks} fileEffects={model.fileEffectSummary} />
    </div>
  );
}

function ComposerQueueSurface({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  const canShowQueue = Boolean(
    model.threadId && !model.branchFromMessageId && !model.isNewThread,
  );

  if (!canShowQueue) return null;

  return (
    <ComposerQueueList
      threadId={model.threadId!}
      isAgentRunning={model.isAgentRunning}
      provider={model.provider}
      isEditing={Boolean(model.editingFromQueue)}
      isPaused={model.planPending}
      onLoadIntoComposer={actions.onLoadIntoComposer}
      onResume={() => model.planPending ? Promise.resolve() : actions.onResumeQueuedMessage()}
      onSendNow={(message) =>
        model.planPending ? Promise.resolve() : actions.onSendQueuedMessageNow(message)
      }
    />
  );
}

function ComposerNewThreadSurface({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  if (!model.isNewThread) return null;

  return (
    <ComposerNewThreadContext
      workspaceId={model.workspaceId}
      mode={model.composerMode}
      onModeChange={actions.onComposerModeChange}
    />
  );
}

function ComposerReplySurface({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  if (!model.replyContext || !model.threadId || model.branchFromMessageId) return null;

  return (
    <ComposerReplyBar
      sourceRole={model.replyContext.sourceRole}
      previewText={model.replyContext.previewText}
      onDismiss={() => actions.onClearReply(model.threadId!)}
    />
  );
}

function ComposerDetectedPullRequest({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  if (!model.detectedPullRequest) return null;

  return (
    <PrDetectedCard
      {...model.detectedPullRequest}
      onReview={actions.onReviewDetectedPullRequest}
      onDismiss={actions.onDismissDetectedPullRequest}
      loading={model.fetchingBranch}
    />
  );
}

function ComposerProviderUnavailableBanner({
  model,
}: Pick<ComposerContentSurfaceProps, "model">) {
  if (!model.providerReason) return null;

  return (
    <ProviderUnavailableBanner
      providerId={model.effectiveProviderId}
      reason={model.providerReason}
      onOpenSettings={() =>
        window.dispatchEvent(new CustomEvent("mcode:open-settings", { detail: { section: "model" } }))
      }
    />
  );
}

function ComposerQueueEditNotice({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  if (!model.editingFromQueue) return null;

  return (
    <div className="flex items-center justify-between gap-2 border-b border-primary/20 bg-primary/5 px-3 py-1.5">
      <span className="font-mono text-xs uppercase tracking-[0.18em] text-primary/85">
        Editing
        <span className="ml-1.5 tabular-nums text-primary/55">
          {String(model.editingFromQueue.originalIndex + 1).padStart(2, "0")}
        </span>
        <span className="ml-2 normal-case tracking-normal text-primary/55">
          Send to save - changes return to the same slot.
        </span>
      </span>
      <button
        type="button"
        onClick={actions.onCancelEdit}
        aria-label="Discard edits and restore the original queued message"
        title="Discard changes (restores the original message at its slot)"
        className="rounded-sm p-1 text-primary/55 transition-colors hover:bg-primary/10 hover:text-primary"
      >
        <X size={11} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function getEditorPlaceholder(model: ComposerContentSurfaceProps["model"]) {
  if (model.isStaleWorktree) return "Worktree directory no longer exists. This thread is read-only.";
  if (model.planPending) return "Answer the planning questions above";
  if (model.goalPending) return "Describe the goal...";
  if (model.branchFromMessageId) return "What should the branch work on?";
  if (model.editingFromQueue) return "Edit the queued message - send to save.";
  if (model.replyContext) return "Type your reply...";
  if (model.isAgentRunning) return "Queue a follow-up...";
  return model.isNewThread ? "Do anything" : "Message Mcode...";
}

function ComposerEditorSurface({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  const disabled = model.planPending || model.isStaleWorktree || Boolean(model.providerReason);

  return (
    <div className="relative" ref={model.editorContainerRef} onPaste={actions.onPaste}>
      <ComposerEditor
        onChange={actions.onEditorChange}
        onSubmit={actions.onSubmit}
        onMentionTrigger={model.fileAutocomplete.handleInputChange}
        onMentionDismiss={model.fileAutocomplete.dismiss}
        isMentionPopupOpen={model.fileAutocomplete.isOpen}
        onSlashTrigger={model.slashCommand.onInputChange}
        onSlashDismiss={model.slashCommand.onDismiss}
        isSlashPopupOpen={model.slashCommand.isOpen}
        editorRef={model.editorRef}
        disabled={disabled}
        isPopupOpen={model.fileAutocomplete.isOpen || model.slashCommand.isOpen}
        onPopupKeyDown={actions.onPopupKeyDown}
        placeholder={getEditorPlaceholder(model)}
      />
      <FileTagPopup
        items={model.fileAutocomplete.suggestions}
        isOpen={model.fileAutocomplete.isOpen}
        onSelect={actions.onMentionSelect}
        listRef={model.filePopup.listRef}
        selectedIndex={model.filePopup.selectedIndex}
        anchorRect={model.filePopupAnchorRect}
        presentation="composer"
      />
      <SpellcheckContextMenu editorRef={model.editorContainerRef} />
    </div>
  );
}

function ComposerAttachmentSurface({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  return (
    <>
      {model.annotationScopeId && model.attachmentBundle ? (
        <div className="px-3 pt-2">
          <PreviewAnnotationBundleChip
            bundle={model.attachmentBundle}
            threadId={model.threadId}
            testId="composer-annotation-bundle"
            onRemove={() => {
              actions.onMarkRestoredPreviewAnnotationsCleared();
              usePreviewAnnotationStore.getState().clearThread(model.annotationScopeId!);
            }}
          />
        </div>
      ) : null}
      <AttachmentPreview attachments={model.attachments} onRemove={actions.onRemoveAttachment} />
      {model.isCompacting && <CompactingBanner />}
      {!model.isCompacting && model.hasRetryState && model.threadId && (
        <RetryBanner threadId={model.threadId} />
      )}
      {model.isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/10 backdrop-blur-sm">
          <span className="text-sm font-medium text-primary">Drop files here</span>
        </div>
      )}
    </>
  );
}

function ComposerThreadScaffoldStatus({
  isThreadScaffold,
}: Pick<ComposerContentSurfaceProps["model"], "isThreadScaffold">) {
  if (!isThreadScaffold) return null;

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      Preparing thread…
    </span>
  );
}

function ComposerInlineStopButton({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  if (!model.isAgentRunning || !model.hasContent || model.planPending) return null;

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={actions.onStop}
      className="text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
      title="Stop agent"
      aria-label="Stop agent"
    >
      <div className="h-2.5 w-2.5 rounded-sm bg-current" />
    </Button>
  );
}

function getTrackerContextWindow(
  modelId: ComposerAgentControlsProps["selection"]["modelId"],
  contextWindow: ContextWindowMode | null,
  settingsDefaultContextWindow: ContextWindowMode | undefined,
  contextEntry: ComposerContentSurfaceProps["model"]["contextEntry"],
  activeThread: Thread | undefined,
) {
  const mode = contextWindow ?? settingsDefaultContextWindow ?? "200k";
  return getModelContextWindow(modelId, mode)
    ?? contextEntry?.contextWindow
    ?? activeThread?.context_window
    ?? undefined;
}

function ComposerContextWindowTracker({
  model,
}: Pick<ComposerContentSurfaceProps, "model">) {
  if (!model.threadId) return null;

  const contextWindow = getTrackerContextWindow(
    model.modelId,
    model.contextWindow,
    model.settingsDefaultContextWindow,
    model.contextEntry,
    model.activeThread,
  );

  return (
    <ContextTracker
      tokensIn={model.contextEntry?.lastTokensIn ?? model.activeThread?.last_context_tokens ?? 0}
      contextWindow={contextWindow}
      totalProcessedTokens={model.contextEntry?.totalProcessedTokens}
      hasLowQuota={model.hasLowQuota}
    />
  );
}

type ComposerSendButtonVisualState = "scaffold" | "queue" | "stop" | "send" | "empty";
type ComposerSendButtonCopy = "choose-project" | "starting-thread" | "queue-message" | "stop-agent" | "send-message";

function getComposerSendButtonVisualState({
  isThreadScaffold,
  isAgentRunning,
  hasContent,
}: Pick<ComposerContentSurfaceProps["model"], "isThreadScaffold" | "isAgentRunning" | "hasContent">): ComposerSendButtonVisualState {
  if (isThreadScaffold) return "scaffold";
  if (isAgentRunning) return hasContent ? "queue" : "stop";
  return hasContent ? "send" : "empty";
}

function getComposerSendButtonCopy({
  needsWorkspace,
  isThreadScaffold,
  isAgentRunning,
  hasContent,
}: {
  readonly needsWorkspace: boolean;
  readonly isThreadScaffold: boolean;
  readonly isAgentRunning: boolean;
  readonly hasContent: boolean;
}): ComposerSendButtonCopy {
  if (needsWorkspace) return "choose-project";
  if (isThreadScaffold) return "starting-thread";
  if (isAgentRunning) return hasContent ? "queue-message" : "stop-agent";
  return "send-message";
}

function isComposerSendButtonDisabled({
  needsWorkspace,
  providerReason,
  isStaleWorktree,
  planPending,
  isThreadScaffold,
  isAgentRunning,
  hasContent,
}: {
  readonly needsWorkspace: boolean;
  readonly providerReason: ComposerContentSurfaceProps["model"]["providerReason"];
  readonly isStaleWorktree: boolean;
  readonly planPending: boolean;
  readonly isThreadScaffold: boolean;
  readonly isAgentRunning: boolean;
  readonly hasContent: boolean;
}) {
  return needsWorkspace || Boolean(providerReason) || isStaleWorktree || planPending
    || isThreadScaffold || (!isAgentRunning && !hasContent);
}

const SEND_BUTTON_CLASS_NAMES: Record<ComposerSendButtonVisualState, string> = {
  scaffold: "bg-primary text-primary-foreground",
  queue: "bg-primary/60 text-primary-foreground hover:bg-primary/75",
  stop: "bg-destructive text-white hover:bg-destructive/90",
  send: "bg-primary text-primary-foreground hover:bg-primary/90",
  empty: "bg-muted text-muted-foreground opacity-40",
};

const SEND_BUTTON_COPY: Record<ComposerSendButtonCopy, string> = {
  "choose-project": "Choose a project",
  "starting-thread": "Starting thread",
  "queue-message": "Queue message",
  "stop-agent": "Stop agent",
  "send-message": "Send message",
};

function ComposerSendButton({
  model,
  actions,
  needsWorkspace,
}: Pick<ComposerContentSurfaceProps, "model" | "actions"> & { readonly needsWorkspace: boolean }) {
  const visualState = getComposerSendButtonVisualState(model);
  const copy = getComposerSendButtonCopy({ ...model, needsWorkspace });
  const disabled = isComposerSendButtonDisabled({ ...model, needsWorkspace });
  const onClick = model.isThreadScaffold
    ? undefined
    : model.isAgentRunning && !model.hasContent
      ? actions.onStop
      : actions.onSubmit;

  return (
    <Button
      type="button"
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      className={cn("rounded-full transition-colors", SEND_BUTTON_CLASS_NAMES[visualState])}
      title={SEND_BUTTON_COPY[copy]}
      aria-label={SEND_BUTTON_COPY[copy]}
    >
      {visualState === "scaffold" ? (
        <Spinner size={14} className="text-current" />
      ) : visualState === "stop" ? (
        <div className="h-4 w-4 rounded-sm bg-current" />
      ) : (
        <ArrowUp />
      )}
    </Button>
  );
}

function ComposerControlBar({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  const disabled = model.planPending || model.isStaleWorktree || Boolean(model.providerReason);

  return (
    <div className="flex items-center gap-x-1.5 sm:gap-x-2.5 border-t border-border/20 px-3 py-1.5">
      <input
        ref={model.attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        accept={model.attachmentInputAccept}
        data-testid="composer-attachment-input"
        onChange={actions.onAttachmentInputChange}
      />
      <ComposerAddMenu
        disabled={disabled}
        onAttachFiles={actions.onAttachPick}
        capabilities={model.agentControls.capabilities}
        attachedCapabilityIds={model.agentControls.attachedCapabilityIds}
        onAttachCapability={actions.onAttachCapability}
        getComposerRect={() => model.composerContainerRef.current?.getBoundingClientRect() ?? null}
      />
      <ComposerAgentControls
        threadId={model.threadId}
        workspaceId={model.workspaceId}
        branchFromMessageId={model.branchFromMessageId}
        isNewThread={model.isNewThread}
        selection={model.selection}
        defaults={model.defaults}
        reasoningLevels={model.agentControls.reasoningLevels}
        capabilities={model.agentControls.capabilities}
        activeGoal={model.activeGoal}
        goalPending={model.goalPending}
        isModelLocked={model.isModelFullyLocked}
        isProviderLocked={model.isProviderLocked}
        permissionLocked={model.agentControls.permissionLocked}
        showInlineOptions={model.showInlineComposerOptions}
        showModelPreferences
        onSelectionChange={actions.onSelectionChange}
        onSelectionTouched={actions.onSelectionTouched}
        onDetachPlan={actions.onDetachPlan}
        onDetachGoal={actions.onDetachGoal}
        onDetachOrchestration={actions.onDetachOrchestration}
      />
      <div className="flex-1" />
      <ComposerThreadScaffoldStatus isThreadScaffold={model.isThreadScaffold} />
      <ComposerInlineStopButton model={model} actions={actions} />
      <ComposerContextWindowTracker model={model} />
      <ComposerSendButton
        model={model}
        actions={actions}
        needsWorkspace={model.needsWorkspace}
      />
    </div>
  );
}

function ComposerInputSurface({
  model,
  actions,
}: ComposerContentSurfaceProps) {
  return (
    <div
      ref={model.composerContainerRef}
      data-testid="composer-surface"
      className={cn(
        "relative z-10 bg-muted/50 ring-1 ring-inset ring-border/60 focus-within:ring-2 focus-within:ring-primary/70",
        model.isNewThread
          ? "-mt-px rounded-xl shadow-none"
          : "rounded-xl shadow-lg shadow-black/20",
        model.isDragOver && "ring-2 ring-primary",
      )}
      onDragEnter={actions.onDragEnter}
      onDragLeave={actions.onDragLeave}
      onDragOver={actions.onDragOver}
      onDrop={actions.onDrop}
    >
      <ComposerBranchBar
        branchFromMessageId={model.branchFromMessageId}
        branchFromMessageContent={model.branchFromMessageContent}
        onBranchModeExit={actions.onBranchModeExit}
      />
      <ComposerReplySurface model={model} actions={actions} />
      <ComposerDetectedPullRequest model={model} actions={actions} />
      <ComposerProviderUnavailableBanner model={model} />
      <ComposerQueueEditNotice model={model} actions={actions} />
      <ComposerEditorSurface model={model} actions={actions} />
      <ComposerAttachmentSurface model={model} actions={actions} />
      <ComposerControlBar model={model} actions={actions} />
    </div>
  );
}

/** Renders the composer content rail, input surface, and queued-send hint. */
export function ComposerContentSurface(props: ComposerContentSurfaceProps) {
  return (
    <>
      <ComposerPlanPreview {...props} />
      <ComposerTaskBubble {...props} />
      <ComposerQueueSurface {...props} />
      <ComposerNewThreadSurface {...props} />
      <ComposerInputSurface {...props} />
      {props.model.queuedSend && (
        <p className="px-1 pt-1 text-xs text-muted-foreground/60">
          queued · sends when handoff lands
        </p>
      )}
    </>
  );
}
