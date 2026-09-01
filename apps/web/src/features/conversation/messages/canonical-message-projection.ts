import type { AgentItem, AgentModelState, AgentTurn, Message, TurnOutcome } from "@mcode/contracts";
import type { ToolCall } from "@/transport/types";
import type { ThoughtSegment, TurnFooterSummary } from "../narrative/types";
import {
  agentDisplayStateFromCanonicalTurnStatus,
  type AgentDisplayState,
} from "./virtual-items";

/** Live canonical child state adapted to the shared chat timeline inputs. */
export interface CanonicalMessageProjection {
  messages: Message[];
  agentDisplayState: AgentDisplayState;
  agentStartTime?: number;
  toolCalls: ToolCall[];
  thoughtSegments: ThoughtSegment[];
  currentTurnMessageId: string;
  currentTurnResponseKey: string;
  assistantResponseKeys: Record<string, string>;
  turnSummariesByMessageId: Record<string, TurnFooterSummary>;
}

interface CanonicalProjectionInput {
  threadId: string;
  state: AgentModelState;
  messages: readonly Message[];
  toolCalls: readonly ToolCall[];
  thoughtSegments: readonly ThoughtSegment[];
}

function timestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareTurns(left: AgentTurn, right: AgentTurn): number {
  return (timestamp(left.startedAt ?? left.createdAt) ?? 0)
    - (timestamp(right.startedAt ?? right.createdAt) ?? 0)
    || left.id.localeCompare(right.id);
}

function compareItems(left: AgentItem, right: AgentItem): number {
  return (timestamp(left.createdAt) ?? 0) - (timestamp(right.createdAt) ?? 0)
    || left.id.localeCompare(right.id);
}

function canonicalMessage(payload: Record<string, unknown>): Message | undefined {
  if (payload.projection !== "message") return undefined;
  const message = payload.message;
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as Partial<Message>;
  if (!hasCanonicalMessageFields(candidate)) return undefined;
  return candidate as Message;
}

function hasCanonicalMessageFields(candidate: Partial<Message>): boolean {
  const stringFields = [candidate.id, candidate.thread_id, candidate.content, candidate.timestamp];
  return stringFields.every((field) => typeof field === "string")
    && ["user", "assistant", "system"].includes(candidate.role ?? "")
    && typeof candidate.sequence === "number";
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function toolInput(payload: Record<string, unknown>): Record<string, unknown> {
  const value = payload.toolInput;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return value === undefined ? {} : { value };
}

function isTerminalTurn(turn: AgentTurn): boolean {
  return turn.status === "Completed"
    || turn.status === "Cancelled"
    || turn.status === "Interrupted"
    || turn.status === "Errored";
}

function terminalTurnOutcome(turn: AgentTurn): TurnOutcome | undefined {
  switch (turn.status) {
    case "Cancelled":
      return "cancelled";
    case "Interrupted":
      return "interrupted";
    case "Errored":
      return "errored";
    case "Completed":
      return "completed";
    default:
      return undefined;
  }
}

function messageOutcome(message: Message | undefined): TurnOutcome | null | undefined {
  return message
    ? (message as Message & { outcome?: TurnOutcome | null }).outcome
    : undefined;
}

function messageOutcomeExecutionId(message: Message | undefined): string | null | undefined {
  return message
    ? (message as Message & { outcomeExecutionId?: string | null }).outcomeExecutionId
    : undefined;
}

function canonicalTurnSummary(turn: AgentTurn, items: readonly AgentItem[]): TurnFooterSummary {
  const topLevelTools = items.filter((item) =>
    item.kind === "tool-call"
    && item.parentItemId === undefined
    && item.payload.projection === "codexChildToolCall");
  const reasoningItems = items.filter((item) => item.payload.projection === "codexChildReasoning");
  const activityItems = items.filter((item) =>
    item.payload.projection === "codexChildToolCall"
    || item.payload.projection === "codexChildToolResult"
    || item.payload.projection === "codexChildReasoning");
  const answer = latestAssistantMessage(items);
  const outcome = messageOutcome(answer) ?? terminalTurnOutcome(turn);
  const outcomeExecutionId = messageOutcomeExecutionId(answer);
  return {
    counts: {
      steps: topLevelTools.length,
      thoughts: reasoningItems.length,
      subagents: topLevelTools.filter((item) => payloadString(item.payload, "toolName") === "Agent").length,
    },
    durationMs: canonicalTurnDuration(turn, activityItems),
    ...(outcome !== undefined && outcome !== "completed" ? { outcome } : {}),
    ...(outcomeExecutionId !== undefined ? { outcomeExecutionId } : {}),
  };
}

function datedItemValues(items: readonly AgentItem[], field: "createdAt" | "updatedAt"): number[] {
  return items.flatMap((item) => {
    const value = timestamp(item[field]);
    return value === undefined ? [] : [value];
  });
}

function canonicalTurnDuration(turn: AgentTurn, activityItems: readonly AgentItem[]): number | null {
  const turnStartedAt = timestamp(turn.startedAt ?? turn.createdAt);
  const turnEndedAt = timestamp(turn.endedAt ?? turn.updatedAt);
  if (turnStartedAt !== undefined && turnEndedAt !== undefined) {
    return Math.max(0, turnEndedAt - turnStartedAt);
  }
  const starts = datedItemValues(activityItems, "createdAt");
  const ends = datedItemValues(activityItems, "updatedAt");
  if (starts.length > 0 && ends.length > 0) return Math.max(0, Math.max(...ends) - Math.min(...starts));
  return null;
}

function latestAssistantMessage(items: readonly AgentItem[]): Message | undefined {
  return [...items].reverse()
    .map((item) => canonicalMessage(item.payload))
    .find((message) => message?.role === "assistant");
}

function projectedMessages(items: readonly AgentItem[], terminal: boolean): Message[] {
  return items.flatMap((item) => {
    const message = canonicalMessage(item.payload);
    return !message || (message.role === "assistant" && !terminal) ? [] : [message];
  });
}

function mergedMessages(messages: readonly Message[], projected: readonly Message[]): Message[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  for (const message of projected) messagesById.set(message.id, message);
  return [...messagesById.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function projectedToolCallStart(item: AgentItem, nativeItemId: string): ToolCall {
  const startedAt = timestamp(item.createdAt);
  return {
    id: nativeItemId, toolName: payloadString(item.payload, "toolName") ?? "Tool", toolInput: toolInput(item.payload), output: null, isError: false, isComplete: false,
    ...(startedAt === undefined ? {} : { startedAt, lastActivityAt: startedAt }),
  };
}

function projectedToolCallTiming(
  item: AgentItem,
  existing: ToolCall | undefined,
): Pick<ToolCall, "startedAt" | "lastActivityAt" | "durationMs"> {
  const completedAt = timestamp(item.updatedAt) ?? timestamp(item.createdAt);
  const startedAt = existing?.startedAt ?? timestamp(item.createdAt);
  return {
    ...(startedAt === undefined ? {} : { startedAt }), ...(completedAt === undefined ? {} : { lastActivityAt: completedAt }),
    ...(startedAt === undefined || completedAt === undefined ? {} : { durationMs: Math.max(0, completedAt - startedAt) }),
  };
}

function projectedToolCallResult(item: AgentItem, nativeItemId: string, existing: ToolCall | undefined): ToolCall {
  return {
    id: nativeItemId,
    toolName: existing?.toolName ?? "Tool",
    toolInput: existing?.toolInput ?? {},
    output: payloadString(item.payload, "output") ?? "",
    isError: item.payload.isError === true,
    isComplete: true,
    ...projectedToolCallTiming(item, existing),
  };
}

function projectedToolCall(item: AgentItem, calls: Map<string, ToolCall>): void {
  const nativeItemId = payloadString(item.payload, "nativeItemId") ?? item.id;
  if (item.payload.projection === "codexChildToolCall") {
    calls.set(nativeItemId, projectedToolCallStart(item, nativeItemId));
    return;
  }
  if (item.payload.projection === "codexChildToolResult") {
    calls.set(nativeItemId, projectedToolCallResult(item, nativeItemId, calls.get(nativeItemId)));
  }
}

function projectedToolCalls(items: readonly AgentItem[]): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const item of items) projectedToolCall(item, calls);
  return calls;
}

function projectedThoughtSegments(items: readonly AgentItem[], terminal: boolean): ThoughtSegment[] {
  const thoughts: ThoughtSegment[] = [];
  for (const item of items.filter((candidate) => candidate.payload.projection === "codexChildReasoning")) {
    const text = payloadString(item.payload, "content");
    const startedAt = timestamp(item.createdAt);
    if (text === undefined || startedAt === undefined) continue;
    const hasLaterItem = items.some((candidate) => compareItems(candidate, item) > 0);
    const endedAt = terminal || hasLaterItem ? timestamp(item.updatedAt) ?? startedAt : undefined;
    thoughts.push({ text, startedAt, ...(endedAt === undefined ? {} : { endedAt }), isExplicitNonFinal: true });
  }
  return thoughts;
}

function turnSummaries(threadTurns: readonly AgentTurn[], threadItems: readonly AgentItem[]): Record<string, TurnFooterSummary> {
  const summaries: Record<string, TurnFooterSummary> = {};
  for (const turn of threadTurns.filter(isTerminalTurn)) {
    const turnItems = threadItems.filter((item) => item.turnId === turn.id).sort(compareItems);
    const answer = latestAssistantMessage(turnItems);
    if (answer) summaries[answer.id] = canonicalTurnSummary(turn, turnItems);
  }
  return summaries;
}

/** Project the latest canonical child turn over hydrated conversation history. */
export function projectCanonicalMessageList({
  threadId,
  state,
  messages,
  toolCalls,
  thoughtSegments,
}: CanonicalProjectionInput): CanonicalMessageProjection | undefined {
  const threadTurns = Object.values(state.turns)
    .filter((turn) => turn.threadId === threadId)
    .sort(compareTurns);
  const latestTurn = threadTurns.at(-1);
  if (!latestTurn) return undefined;

  const terminal = isTerminalTurn(latestTurn);
  const agentDisplayState = agentDisplayStateFromCanonicalTurnStatus(latestTurn.status);
  const threadItems = Object.values(state.items).filter((item) => item.threadId === threadId);
  const items = threadItems
    .filter((item) => item.turnId === latestTurn.id)
    .sort(compareItems);

  const projected = projectedMessages(items, terminal);
  const projectedCalls = projectedToolCalls(items);
  const projectedThoughts = projectedThoughtSegments(items, terminal);
  const toolCallById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
  for (const toolCall of projectedCalls.values()) toolCallById.set(toolCall.id, toolCall);
  const assistantMessage = [...projected].reverse().find((message) => message.role === "assistant");
  const responseKey = `canonical-turn-response:${latestTurn.id}`;

  return {
    messages: mergedMessages(messages, projected),
    agentDisplayState,
    agentStartTime: timestamp(latestTurn.startedAt ?? latestTurn.createdAt),
    toolCalls: [...toolCallById.values()],
    thoughtSegments: projectedThoughts.length > 0 ? projectedThoughts : [...thoughtSegments],
    currentTurnMessageId: assistantMessage?.id ?? "",
    currentTurnResponseKey: responseKey,
    assistantResponseKeys: assistantMessage ? { [assistantMessage.id]: responseKey } : {},
    turnSummariesByMessageId: turnSummaries(threadTurns, threadItems),
  };
}
