import { ModeSelector, type ComposerMode, type ModeOption } from "@/components/chat/ModeSelector";
import { TerminalStatusIndicator } from "@/components/chat/TerminalStatusIndicator";
import { cn } from "@/lib/utils";
import type { Thread } from "@/transport";
import { ComposerTargetSelection } from "./execution/ComposerTargetSelection";

interface ComposerStatusStripProps {
  readonly visible: boolean;
  readonly isGitRepo: boolean;
  readonly isNewThread: boolean;
  readonly branchFromMessageId?: string;
  readonly composerMode: ComposerMode;
  readonly branchExecMode: ComposerMode;
  readonly modeOptions: readonly ModeOption[];
  readonly workspaceId?: string;
  readonly activeThread?: Thread;
  readonly onComposerModeChange: (mode: ComposerMode) => void;
  readonly onBranchModeChange: (mode: ComposerMode) => void;
}

function ComposerStatusMode({
  isGitRepo,
  isNewThread,
  branchFromMessageId,
  composerMode,
  branchExecMode,
  modeOptions,
  onComposerModeChange,
  onBranchModeChange,
}: ComposerStatusStripProps) {
  if (!isGitRepo && isNewThread) {
    return (
      <span className="flex h-6 items-center rounded-md px-1.5 py-0.5 text-xs text-muted-foreground/40">
        Not a git repo
      </span>
    );
  }

  return (
    <ModeSelector
      mode={branchFromMessageId ? branchExecMode : composerMode}
      onModeChange={branchFromMessageId ? onBranchModeChange : onComposerModeChange}
      locked={!isNewThread && !branchFromMessageId}
      options={[...modeOptions]}
    />
  );
}

function ComposerStatusTarget({
  isGitRepo,
  isNewThread,
  branchFromMessageId,
  composerMode,
  branchExecMode,
  workspaceId,
  activeThread,
}: ComposerStatusStripProps) {
  if (!isGitRepo) return null;

  if (isNewThread) {
    return (
      <ComposerTargetSelection
        scope="new-thread"
        mode={composerMode}
        workspaceId={workspaceId}
        variant="status-bar"
      />
    );
  }

  if (!branchFromMessageId) return null;

  return (
    <ComposerTargetSelection
      scope="branch"
      mode={branchExecMode}
      sourceThread={activeThread}
      variant="status-bar"
    />
  );
}

function ComposerStatusStripContent(props: ComposerStatusStripProps) {
  if (!props.visible) return null;

  return (
    <div className="min-h-0">
      <div className="flex items-center justify-between px-1 pt-1.5">
        <ComposerStatusMode {...props} />
        <div className="flex items-center gap-3">
          <TerminalStatusIndicator />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <ComposerStatusTarget {...props} />
        </div>
      </div>
    </div>
  );
}

/** Renders the composer status bar below the message input surface. */
export function ComposerStatusStrip(props: ComposerStatusStripProps) {
  return (
    <div
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,transform] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
        props.visible ? "grid-rows-[1fr] opacity-100 translate-y-0" : "grid-rows-[0fr] opacity-0 translate-y-1 pointer-events-none",
      )}
      aria-hidden={!props.visible}
      inert={props.visible ? undefined : true}
    >
      <ComposerStatusStripContent {...props} />
    </div>
  );
}
