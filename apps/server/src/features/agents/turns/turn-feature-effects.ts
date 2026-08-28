import type { AgentEvent, ProviderId } from "@mcode/contracts";
import { GoalLifecycleService } from "../goals/goal-lifecycle-service.js";
import { PlanTurnService } from "../planning/plan-turn-service.js";
import { SubagentLifecycleService } from "../collaboration/subagent-lifecycle-service.js";
import { TaskPersistenceService } from "../tasks/task-persistence-service.js";

type AgentMessage = Extract<AgentEvent, { type: "message" }>;

/** Injection token for the explicitly composed feature-effect coordinator. */
export const TURN_FEATURE_EFFECTS = Symbol("TurnFeatureEffects");

/** Coordinates feature-owned reactions to normalized turn lifecycle events. */
export class TurnFeatureEffects {
  constructor(
    private readonly plans: PlanTurnService,
    private readonly goals: GoalLifecycleService,
    private readonly subagents: SubagentLifecycleService,
    private readonly tasks: TaskPersistenceService,
  ) {}

  /** Feed visible text to the plan parser for an active plan turn. */
  onTextDelta(threadId: string, delta: string): void {
    this.plans.onTextDelta(threadId, delta);
  }

  /** Apply plan and goal reactions at an assistant-message boundary. */
  onAssistantMessage(providerId: ProviderId, event: AgentMessage): void {
    this.goals.onAssistantMessage(providerId, event);
  }

  /** Return whether the current assistant message must be materialized before plan persistence. */
  needsAssistantMaterialization(event: AgentMessage): boolean {
    return this.plans.needsAssistantMaterialization(event);
  }

  /** Persist the plan record tied to an already-materialized assistant message. */
  persistAssistantMessage(event: AgentMessage): void {
    this.plans.persistAssistantMessage(event);
  }

  /** Persist one provider task result for reconnect hydration. */
  onToolResult(threadId: string, toolCallId: string, output: string, isError: boolean): void {
    this.tasks.onToolResult(threadId, toolCallId, output, isError);
  }

  /** Persist one provider task request with its resolved narrative parent. */
  onToolUse(
    threadId: string,
    event: Parameters<TaskPersistenceService["onToolUse"]>[1],
  ): void {
    this.tasks.onToolUse(threadId, event);
  }

  /** Refresh goal state after the terminal turn reaches durable completion. */
  refreshAfterTurn(threadId: string): void {
    this.goals.refreshAfterTurn(threadId);
  }

  /** Stop every descendant before the parent provider session is stopped. */
  stopDescendants(threadId: string): Promise<void> | void {
    return this.subagents.stopDescendants(threadId);
  }

  /** Clear feature-local turn state after terminal cleanup. */
  clearTurn(threadId: string): void {
    this.plans.clearTurn(threadId);
  }
}
