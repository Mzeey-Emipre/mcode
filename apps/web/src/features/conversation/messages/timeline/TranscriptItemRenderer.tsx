import { memo, type RefObject } from "react";
import { HookActivitySection } from "@/components/chat/HookActivitySection";
import { PermissionRequestCard } from "@/components/chat/PermissionRequestCard";
import { StreamingCard } from "@/components/chat/StreamingCard";
import { StreamingIndicator } from "@/components/chat/StreamingIndicator";
import { ToolCallCard } from "@/components/chat/ToolCallCard";
import { TurnChangeSummary } from "@/components/chat/TurnChangeSummary";
import { NarrativeFlow, type SubagentRosterTarget } from "@/features/conversation/narrative";
import { NarrativeIndicator } from "@/features/conversation/narrative/NarrativeIndicator";
import { PersistedLateHooks } from "@/features/conversation/narrative/PersistedLateHooks";
import { PersistedNarrative } from "@/features/conversation/narrative/PersistedNarrative";
import { PersistedTurnFooter } from "@/features/conversation/narrative/PersistedTurnFooter";
import { MessageBubble } from "../MessageBubble";
import type { ChatVirtualItem } from "../virtual-items";

/** Props for {@link TranscriptItemRenderer}. */
export interface TranscriptItemRendererProps {
  /** The virtual transcript row to render. */
  item: ChatVirtualItem;
  /** Manual expansion state for persisted turn-change summaries. */
  turnExpandRef?: RefObject<Map<string, boolean>>;
  /** Activates branch mode from a message. */
  onBranch?: (messageId: string) => void;
  /** Activates reply mode from a message. */
  onReply?: (messageId: string, content: string, role: "user" | "assistant") => void;
  /** Opens a selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's subagent roster. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
  /** Prefills the composer for an interrupted turn. */
  onContinue?: () => void | Promise<void>;
  /** Retries a turn by execution identity. */
  onRetry?: (executionId: string) => void | Promise<void>;
  /** Scrolls to the referenced message. */
  onScrollToMessage?: (messageId: string) => void;
  /** Current persisted assistant message id for each displayed thread. */
  currentTurnMessageIdByThread: Record<string, string>;
  /** Thread that owns the displayed transcript. */
  threadId: string | null | undefined;
  /** Controls the parent-agent provenance label on child prompts. */
  showParentAgentProvenance: boolean;
}

/** Renders one discriminated transcript item without owning transcript or viewport state. */
export const TranscriptItemRenderer = memo(function TranscriptItemRenderer({
  item,
  turnExpandRef,
  onBranch,
  onReply,
  onSubagentSelect,
  onOpenSubagents,
  onContinue,
  onRetry,
  onScrollToMessage,
  currentTurnMessageIdByThread,
  threadId,
  showParentAgentProvenance,
}: TranscriptItemRendererProps) {
  switch (item.type) {
    case "message": {
      const isJustPersisted =
        item.message.role === "assistant"
        && currentTurnMessageIdByThread[item.message.thread_id] === item.message.id
        && item.agentDisplayState?.phase !== "completed";
      const agentActionsDisabled = item.agentDisplayState != null
        && item.agentDisplayState.phase !== "completed";
      return (
        <div className={isJustPersisted ? "agent-response-just-persisted" : ""}>
          <MessageBubble
            message={item.message}
            onBranch={agentActionsDisabled ? undefined : onBranch}
            onReply={agentActionsDisabled ? undefined : onReply}
            onScrollToMessage={onScrollToMessage}
            agentDisplayState={item.agentDisplayState}
            showParentAgentProvenance={showParentAgentProvenance}
          />
        </div>
      );
    }
    case "active-tools":
      return <ToolCallCard toolCalls={item.toolCalls} />;
    case "indicator":
      return <StreamingIndicator startTime={item.startTime} activeToolCalls={item.activeToolCalls} />;
    case "streaming":
      return <StreamingCard text={item.text} />;
    case "turn-changes":
      return (
        <TurnChangeSummary
          messageId={item.messageId}
          filesChanged={item.filesChanged}
          isLatestTurn={item.isLatestTurn}
          manualExpandRef={turnExpandRef}
        />
      );
    case "permission-request":
      return (
        <PermissionRequestCard
          requestId={item.requestId}
          toolName={item.toolName}
          input={item.input}
          title={item.title}
          settled={item.settled}
          decision={item.decision}
        />
      );
    case "hook-activity":
      return <HookActivitySection hooks={item.hooks} />;
    case "narrative-flow":
      return (
        <NarrativeFlow
          toolCalls={item.toolCalls}
          hooks={item.hooks}
          thoughtSegments={item.thoughtSegments}
          streamingText={item.streamingText}
          isAgentRunning={item.isAgentRunning}
          startTime={item.startTime}
          committedAssistantBody={item.committedAssistantBody}
          onSubagentSelect={onSubagentSelect}
          onOpenSubagents={onOpenSubagents}
        />
      );
    case "persisted-narrative":
      return (
        <PersistedNarrative
          threadId={threadId}
          messageId={item.messageId}
          messageContent={item.messageContent}
          onSubagentSelect={onSubagentSelect}
          onOpenSubagents={onOpenSubagents}
        />
      );
    case "persisted-late-hooks":
      return <PersistedLateHooks threadId={threadId} messageId={item.messageId} />;
    case "persisted-turn-footer":
      return (
        <PersistedTurnFooter
          threadId={threadId}
          messageId={item.messageId}
          summary={item.summary}
          onContinue={onContinue}
          onRetry={onRetry}
        />
      );
    case "narrative-indicator":
      return (
        <NarrativeIndicator
          stepCount={item.stepCount}
          subagentCount={item.subagentCount}
          activeToolCalls={item.activeToolCalls}
          startTime={item.startTime}
          isAgentRunning={item.isAgentRunning}
        />
      );
  }
}, (previous, next) =>
  previous.item.key === next.item.key
  && previous.item === next.item
  && previous.turnExpandRef === next.turnExpandRef
  && previous.onBranch === next.onBranch
  && previous.onReply === next.onReply
  && previous.onSubagentSelect === next.onSubagentSelect
  && previous.onOpenSubagents === next.onOpenSubagents
  && previous.onContinue === next.onContinue
  && previous.onRetry === next.onRetry
  && previous.onScrollToMessage === next.onScrollToMessage
  && previous.currentTurnMessageIdByThread === next.currentTurnMessageIdByThread
  && previous.threadId === next.threadId
  && previous.showParentAgentProvenance === next.showParentAgentProvenance,
);
