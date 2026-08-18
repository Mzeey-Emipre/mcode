import type { AgentItem, AgentModelState, AgentTurn, Message } from "@mcode/contracts";
import type { ToolCall } from "@/transport/types";
import type { ThoughtSegment } from "../narrative/types";

/** Live canonical child state adapted to the shared chat timeline inputs. */
export interface CanonicalMessageProjection {
  messages: Message[];
  isAgentRunning: boolean;
  agentStartTime?: number;
  toolCalls: ToolCall[];
  thoughtSegments: ThoughtSegment[];
  currentTurnMessageId: string;
  currentTurnResponseKey: string;
  assistantResponseKeys: Record<string, string>;
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
  if (
    typeof candidate.id !== "string"
    || typeof candidate.thread_id !== "string"
    || (candidate.role !== "user" && candidate.role !== "assistant" && candidate.role !== "system")
    || typeof candidate.content !== "string"
    || typeof candidate.timestamp !== "string"
    || typeof candidate.sequence !== "number"
  ) return undefined;
  return candidate as Message;
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

/** Project the latest canonical child turn over hydrated conversation history. */
export function projectCanonicalMessageList({
  threadId,
  state,
  messages,
  toolCalls,
  thoughtSegments,
}: CanonicalProjectionInput): CanonicalMessageProjection | undefined {
  const latestTurn = Object.values(state.turns)
    .filter((turn) => turn.threadId === threadId)
    .sort(compareTurns)
    .at(-1);
  if (!latestTurn) return undefined;

  const terminal = latestTurn.status === "Completed"
    || latestTurn.status === "Interrupted"
    || latestTurn.status === "Errored";
  const isAgentRunning = latestTurn.status === "Pending" || latestTurn.status === "Running";
  const items = Object.values(state.items)
    .filter((item) => item.threadId === threadId && item.turnId === latestTurn.id)
    .sort(compareItems);

  const projectedMessages = items.flatMap((item) => {
    const message = canonicalMessage(item.payload);
    if (!message || (message.role === "assistant" && !terminal)) return [];
    return [message];
  });
  const messageById = new Map(messages.map((message) => [message.id, message]));
  for (const message of projectedMessages) messageById.set(message.id, message);
  const mergedMessages = [...messageById.values()].sort((left, right) =>
    left.sequence - right.sequence || left.id.localeCompare(right.id));

  const projectedToolCalls = new Map<string, ToolCall>();
  for (const item of items) {
    const projection = item.payload.projection;
    const nativeItemId = payloadString(item.payload, "nativeItemId") ?? item.id;
    if (projection === "codexChildToolCall") {
      const startedAt = timestamp(item.createdAt);
      projectedToolCalls.set(nativeItemId, {
        id: nativeItemId,
        toolName: payloadString(item.payload, "toolName") ?? "Tool",
        toolInput: toolInput(item.payload),
        output: null,
        isError: false,
        isComplete: false,
        ...(startedAt === undefined ? {} : { startedAt, lastActivityAt: startedAt }),
      });
      continue;
    }
    if (projection !== "codexChildToolResult") continue;
    const completedAt = timestamp(item.updatedAt) ?? timestamp(item.createdAt);
    const existing = projectedToolCalls.get(nativeItemId);
    const startedAt = existing?.startedAt ?? timestamp(item.createdAt);
    projectedToolCalls.set(nativeItemId, {
      id: nativeItemId,
      toolName: existing?.toolName ?? "Tool",
      toolInput: existing?.toolInput ?? {},
      output: payloadString(item.payload, "output") ?? "",
      isError: item.payload.isError === true,
      isComplete: true,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { lastActivityAt: completedAt }),
      ...(startedAt === undefined || completedAt === undefined
        ? {}
        : { durationMs: Math.max(0, completedAt - startedAt) }),
    });
  }

  const projectedThoughts: ThoughtSegment[] = [];
  const reasoningItems = items.filter((item) => item.payload.projection === "codexChildReasoning");
  for (const item of reasoningItems) {
    const text = payloadString(item.payload, "content");
    const startedAt = timestamp(item.createdAt);
    if (text === undefined || startedAt === undefined) continue;
    const hasLaterItem = items.some((candidate) => compareItems(candidate, item) > 0);
    const endedAt = terminal || hasLaterItem ? timestamp(item.updatedAt) ?? startedAt : undefined;
    projectedThoughts.push({
      text,
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      isExplicitNonFinal: true,
    });
  }

  const toolCallById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
  for (const toolCall of projectedToolCalls.values()) toolCallById.set(toolCall.id, toolCall);
  const assistantMessage = [...projectedMessages].reverse().find((message) => message.role === "assistant");
  const responseKey = `canonical-turn-response:${latestTurn.id}`;

  return {
    messages: mergedMessages,
    isAgentRunning,
    agentStartTime: timestamp(latestTurn.startedAt ?? latestTurn.createdAt),
    toolCalls: [...toolCallById.values()],
    thoughtSegments: projectedThoughts.length > 0 ? projectedThoughts : [...thoughtSegments],
    currentTurnMessageId: assistantMessage?.id ?? "",
    currentTurnResponseKey: responseKey,
    assistantResponseKeys: assistantMessage ? { [assistantMessage.id]: responseKey } : {},
  };
}
