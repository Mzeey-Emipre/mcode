import { memo, type ComponentType, type RefObject } from "react";
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

type TranscriptItemComponent = ComponentType<TranscriptItemRendererProps>;

type MessageTranscriptItem = Extract<ChatVirtualItem, { type: "message" }>;

/** Renders a message virtual item and withholds actions while its agent response remains active. */
function MessageTranscriptItemRenderer({
  item,
  onBranch,
  onReply,
  onScrollToMessage,
  currentTurnMessageIdByThread,
  showParentAgentProvenance,
}: TranscriptItemRendererProps) {
  const messageItem = item as MessageTranscriptItem;
  const isJustPersisted =
    messageItem.message.role === "assistant"
    && currentTurnMessageIdByThread[messageItem.message.thread_id] === messageItem.message.id
    && messageItem.agentDisplayState?.phase !== "completed";
  const agentActionsDisabled = messageItem.agentDisplayState != null
    && messageItem.agentDisplayState.phase !== "completed";
  return (
    <div className={isJustPersisted ? "agent-response-just-persisted" : ""}>
      <MessageBubble
        message={messageItem.message}
        onBranch={agentActionsDisabled ? undefined : onBranch}
        onReply={agentActionsDisabled ? undefined : onReply}
        onScrollToMessage={onScrollToMessage}
        agentDisplayState={messageItem.agentDisplayState}
        showParentAgentProvenance={showParentAgentProvenance}
      />
    </div>
  );
}

/** Renders active tool calls. */
function ActiveToolsTranscriptItemRenderer({ item }: TranscriptItemRendererProps) {
  return <ToolCallCard toolCalls={(item as Extract<ChatVirtualItem, { type: "active-tools" }>).toolCalls} />;
}

/** Renders the legacy streaming indicator. */
function IndicatorTranscriptItemRenderer({ item }: TranscriptItemRendererProps) {
  const indicator = item as Extract<ChatVirtualItem, { type: "indicator" }>;
  return <StreamingIndicator startTime={indicator.startTime} activeToolCalls={indicator.activeToolCalls} />;
}

/** Renders legacy streamed text. */
function StreamingTranscriptItemRenderer({ item }: TranscriptItemRendererProps) {
  return <StreamingCard text={(item as Extract<ChatVirtualItem, { type: "streaming" }>).text} />;
}

/** Renders the persisted turn-change summary. */
function TurnChangesTranscriptItemRenderer({ item, turnExpandRef }: TranscriptItemRendererProps) {
  const changes = item as Extract<ChatVirtualItem, { type: "turn-changes" }>;
  return (
    <TurnChangeSummary
      messageId={changes.messageId}
      filesChanged={changes.filesChanged}
      isLatestTurn={changes.isLatestTurn}
      manualExpandRef={turnExpandRef}
    />
  );
}

/** Renders a permission request row. */
function PermissionRequestTranscriptItemRenderer({ item }: TranscriptItemRendererProps) {
  const request = item as Extract<ChatVirtualItem, { type: "permission-request" }>;
  return (
    <PermissionRequestCard
      requestId={request.requestId}
      toolName={request.toolName}
      input={request.input}
      title={request.title}
      settled={request.settled}
      decision={request.decision}
    />
  );
}

/** Renders hook activity. */
function HookActivityTranscriptItemRenderer({ item }: TranscriptItemRendererProps) {
  return <HookActivitySection hooks={(item as Extract<ChatVirtualItem, { type: "hook-activity" }>).hooks} />;
}

/** Renders the live narrative flow. */
function NarrativeFlowTranscriptItemRenderer({ item, onSubagentSelect, onOpenSubagents }: TranscriptItemRendererProps) {
  const flow = item as Extract<ChatVirtualItem, { type: "narrative-flow" }>;
  return (
    <NarrativeFlow
      toolCalls={flow.toolCalls}
      hooks={flow.hooks}
      thoughtSegments={flow.thoughtSegments}
      streamingText={flow.streamingText}
      isAgentRunning={flow.isAgentRunning}
      startTime={flow.startTime}
      committedAssistantBody={flow.committedAssistantBody}
      onSubagentSelect={onSubagentSelect}
      onOpenSubagents={onOpenSubagents}
    />
  );
}

/** Renders durable narrative records. */
function PersistedNarrativeTranscriptItemRenderer({ item, threadId, onSubagentSelect, onOpenSubagents }: TranscriptItemRendererProps) {
  const narrative = item as Extract<ChatVirtualItem, { type: "persisted-narrative" }>;
  return (
    <PersistedNarrative
      threadId={threadId}
      messageId={narrative.messageId}
      messageContent={narrative.messageContent}
      onSubagentSelect={onSubagentSelect}
      onOpenSubagents={onOpenSubagents}
    />
  );
}

/** Renders durable hooks that arrived after turn persistence. */
function PersistedLateHooksTranscriptItemRenderer({ item, threadId }: TranscriptItemRendererProps) {
  const hooks = item as Extract<ChatVirtualItem, { type: "persisted-late-hooks" }>;
  return <PersistedLateHooks threadId={threadId} messageId={hooks.messageId} />;
}

/** Renders the durable turn footer. */
function PersistedTurnFooterTranscriptItemRenderer({ item, threadId, onContinue, onRetry }: TranscriptItemRendererProps) {
  const footer = item as Extract<ChatVirtualItem, { type: "persisted-turn-footer" }>;
  return (
    <PersistedTurnFooter
      threadId={threadId}
      messageId={footer.messageId}
      summary={footer.summary}
      onContinue={onContinue}
      onRetry={onRetry}
    />
  );
}

/** Renders live narrative progress below the response. */
function NarrativeIndicatorTranscriptItemRenderer({ item }: TranscriptItemRendererProps) {
  const indicator = item as Extract<ChatVirtualItem, { type: "narrative-indicator" }>;
  return (
    <NarrativeIndicator
      stepCount={indicator.stepCount}
      subagentCount={indicator.subagentCount}
      activeToolCalls={indicator.activeToolCalls}
      startTime={indicator.startTime}
      isAgentRunning={indicator.isAgentRunning}
    />
  );
}

const TRANSCRIPT_ITEM_COMPONENTS: Record<ChatVirtualItem["type"], TranscriptItemComponent> = {
  message: MessageTranscriptItemRenderer,
  "active-tools": ActiveToolsTranscriptItemRenderer,
  indicator: IndicatorTranscriptItemRenderer,
  streaming: StreamingTranscriptItemRenderer,
  "turn-changes": TurnChangesTranscriptItemRenderer,
  "permission-request": PermissionRequestTranscriptItemRenderer,
  "hook-activity": HookActivityTranscriptItemRenderer,
  "narrative-flow": NarrativeFlowTranscriptItemRenderer,
  "persisted-narrative": PersistedNarrativeTranscriptItemRenderer,
  "persisted-late-hooks": PersistedLateHooksTranscriptItemRenderer,
  "persisted-turn-footer": PersistedTurnFooterTranscriptItemRenderer,
  "narrative-indicator": NarrativeIndicatorTranscriptItemRenderer,
};

/** Compares render props that determine the selected virtual item subtree. */
function sameTranscriptItemContext(
  previous: TranscriptItemRendererProps,
  next: TranscriptItemRendererProps,
): boolean {
  return previous.turnExpandRef === next.turnExpandRef
    && previous.threadId === next.threadId
    && previous.showParentAgentProvenance === next.showParentAgentProvenance
    && previous.currentTurnMessageIdByThread === next.currentTurnMessageIdByThread;
}

/** Compares event handlers that may affect a virtual item subtree. */
function sameTranscriptItemHandlers(
  previous: TranscriptItemRendererProps,
  next: TranscriptItemRendererProps,
): boolean {
  return previous.onBranch === next.onBranch
    && previous.onReply === next.onReply
    && previous.onSubagentSelect === next.onSubagentSelect
    && previous.onOpenSubagents === next.onOpenSubagents
    && previous.onContinue === next.onContinue
    && previous.onRetry === next.onRetry
    && previous.onScrollToMessage === next.onScrollToMessage;
}

/** Compares all render inputs without deep-checking an immutable virtual item. */
function sameTranscriptItemRendererProps(
  previous: TranscriptItemRendererProps,
  next: TranscriptItemRendererProps,
): boolean {
  return previous.item.key === next.item.key
    && previous.item === next.item
    && sameTranscriptItemContext(previous, next)
    && sameTranscriptItemHandlers(previous, next);
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
  const ItemComponent = TRANSCRIPT_ITEM_COMPONENTS[item.type];
  return (
    <ItemComponent
      item={item}
      turnExpandRef={turnExpandRef}
      onBranch={onBranch}
      onReply={onReply}
      onSubagentSelect={onSubagentSelect}
      onOpenSubagents={onOpenSubagents}
      onContinue={onContinue}
      onRetry={onRetry}
      onScrollToMessage={onScrollToMessage}
      currentTurnMessageIdByThread={currentTurnMessageIdByThread}
      threadId={threadId}
      showParentAgentProvenance={showParentAgentProvenance}
    />
  );
}, sameTranscriptItemRendererProps);
