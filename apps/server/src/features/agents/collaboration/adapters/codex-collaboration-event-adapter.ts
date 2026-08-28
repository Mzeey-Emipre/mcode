import { createHash, randomUUID } from "node:crypto";
import { inject, injectable } from "tsyringe";
import {
  AgentEventType,
  type CodexChildEvidence,
  type CodexCollaborationEvidence,
  type CodexContinuationEvidence,
  type AgentEvent,
  type CollaborationAction,
  type CollaborationActionKind,
  type ProviderRuntimeExtension,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";

import {
  CODEX_COLLABORATION_DURABILITY,
  type CodexChildDelegation,
  type CodexChildRoutingDiagnosticInput,
  type CodexCollaborationDurability,
} from "../codex-collaboration-durability.js";
import type {
  ProviderEventAdapter,
  ProviderEventProjection,
} from "../../../providers/composition/provider-event-adapter.js";
import type { ProviderEventIngressEvent } from "../../../providers/composition/provider-event-ingress.js";

type CodexRuntimeEvidence = {
  codexChild?: CodexChildEvidence;
  codexContinuation?: CodexContinuationEvidence;
};

type CodexRuntimeEvent = AgentEvent & CodexRuntimeEvidence;
type CodexToolEvent = Extract<
  AgentEvent,
  { type: typeof AgentEventType.ToolUse | typeof AgentEventType.ToolResult }
> & CodexRuntimeEvidence;
type CodexTurnStartedEvent = Extract<
  AgentEvent,
  { type: typeof AgentEventType.TurnStarted }
> & CodexRuntimeEvidence;

type ChildRoutingContext = {
  delegation: CodexChildDelegation;
  parentExecutionId: string;
  parentItemId: string;
  parentThreadId: string;
  parentTurnId: string;
};

type DiagnosticContext = {
  threadId: string;
  executionId: string;
  parentItemId?: string;
};

type ContinuationContext = {
  diagnostic: DiagnosticContext;
  parentThreadId: string;
  providerIdentities: readonly import("@mcode/contracts").ProviderIdentity[];
  triggerActionId: string;
};

type ContinuationSource = {
  action: CollaborationAction | null;
  diagnostic: DiagnosticContext;
};

type CollaborationSource = {
  diagnostic: DiagnosticContext;
  evidence: CodexChildEvidence | undefined;
  senderThreadId: string | undefined;
  sourceThreadId: string;
  sourceTurnId: string;
  receiverThreadIds: string[];
};

type CollaborationFailure = {
  diagnostic?: DiagnosticContext;
  reason: string;
};

const CODEX_COLLABORATION_KIND_BY_NATIVE = new Map<string, CollaborationActionKind>([
  ["sendinput", "message"],
  ["sendmessage", "message"],
  ["followup", "follow-up"],
  ["resume", "resume"],
  ["resumeagent", "resume"],
  ["returnresult", "return-result"],
  ["permission", "permission"],
  ["requestpermission", "permission"],
  ["clarification", "clarification"],
  ["requestclarification", "clarification"],
]);

/** Projects Codex-native collaboration evidence before generic turn handling. */
@injectable()
export class CodexCollaborationEventAdapter implements ProviderEventAdapter {
  readonly providerId = "codex" as const;

  constructor(
    @inject(CODEX_COLLABORATION_DURABILITY)
    private readonly durability: CodexCollaborationDurability,
  ) {}

  /** Interpret a Codex event without allowing native child detail into the generic pipeline. */
  project(input: ProviderEventIngressEvent): ProviderEventProjection {
    if (input.providerId !== this.providerId) return { status: "forward", event: input.event };
    const event = this.runtimeEvent(input);
    const childEvidence = this.childEvidence(event);
    if (childEvidence) return this.projectChildEvent(event, childEvidence);
    const parentProjection = this.projectParentToolEvent(event);
    if (parentProjection) return parentProjection;
    const continuationProjection = this.projectProviderContinuation(event);
    if (continuationProjection) return continuationProjection;
    return this.forward(event);
  }

  private runtimeEvent(input: ProviderEventIngressEvent): CodexRuntimeEvent {
    const extension = input.runtimeExtension;
    if (!extension || extension.providerId !== this.providerId) return input.event;
    return this.applyExtension(input.event, extension);
  }

  private applyExtension(event: AgentEvent, extension: ProviderRuntimeExtension): CodexRuntimeEvent {
    if (event.type !== AgentEventType.ToolUse && event.type !== AgentEventType.ToolResult) {
      return {
        ...event,
        ...(extension.child ? { codexChild: extension.child } : {}),
        ...(extension.continuation ? { codexContinuation: extension.continuation } : {}),
      } as CodexRuntimeEvent;
    }
    return {
      ...event,
      toolInput: this.withNativeCollaborationInput(event.toolInput, extension.collaboration),
      ...(extension.child ? { codexChild: extension.child } : {}),
      ...(extension.continuation ? { codexContinuation: extension.continuation } : {}),
    } as CodexRuntimeEvent;
  }

  private withNativeCollaborationInput(
    toolInput: Record<string, unknown> | undefined,
    collaboration: CodexCollaborationEvidence | undefined,
  ): Record<string, unknown> | undefined {
    if (!collaboration) return toolInput;
    return {
      ...(toolInput ?? {}),
      codexCollabKind: collaboration.kind,
      ...(collaboration.senderThreadId ? { senderThreadId: collaboration.senderThreadId } : {}),
      ...(collaboration.receiverThreadIds ? { receiverThreadIds: collaboration.receiverThreadIds } : {}),
      ...(collaboration.prompt ? { prompt: collaboration.prompt } : {}),
      ...(collaboration.agentName ? { agentName: collaboration.agentName } : {}),
      ...(collaboration.agentPath ? { agentPath: collaboration.agentPath } : {}),
      ...(collaboration.model ? { model: collaboration.model } : {}),
      ...(collaboration.reasoningEffort ? { reasoningEffort: collaboration.reasoningEffort } : {}),
    };
  }

  private childEvidence(event: CodexRuntimeEvent): CodexChildEvidence | undefined {
    return event.codexChild;
  }

  private projectParentToolEvent(event: CodexRuntimeEvent): ProviderEventProjection | undefined {
    if (event.type !== AgentEventType.ToolUse && event.type !== AgentEventType.ToolResult) return undefined;
    const toolEvent = event as CodexToolEvent;
    if (!this.isCollaborationEvent(toolEvent)) return undefined;
    if (this.isChildDelegationEvent(toolEvent)) return this.projectChildDelegation(toolEvent);
    return this.projectCollaborationAction(toolEvent);
  }

  private isCollaborationEvent(event: CodexToolEvent): boolean {
    return Boolean(event.toolInput && "codexCollabKind" in event.toolInput);
  }

  private isChildDelegationEvent(event: CodexToolEvent): boolean {
    return (event.type !== AgentEventType.ToolUse || event.toolName === "Agent")
      && this.collaborationCode(event) === "spawnagent";
  }

  private projectChildDelegation(event: CodexToolEvent): ProviderEventProjection {
    const failure = this.startChildDelegation(event);
    if (failure) return this.reject(event, undefined, failure.reason, failure.diagnostic);
    return this.forward(event);
  }

  private projectCollaborationAction(event: CodexToolEvent): ProviderEventProjection {
    const kind = this.collaborationKind(event);
    if (!kind) return this.reject(event, undefined, "unsupported-collaboration-kind");
    const failure = this.recordCollaborationAction(event, kind, `toolCall:${event.toolCallId}`);
    if (failure) return this.reject(event, this.childEvidence(event), failure.reason, failure.diagnostic);
    return this.forward(event);
  }

  private startChildDelegation(
    event: CodexToolEvent,
    parent?: { threadId: string; turnId: string; executionId: string; itemId: string },
  ): CollaborationFailure | undefined {
    const toolInput = event.toolInput;
    if (!toolInput) return { reason: "missing-child-delegation-input" };
    const receiverThreadIds = this.nativeThreadIds(toolInput.receiverThreadIds);
    if (receiverThreadIds.length !== 1) return { reason: "invalid-child-delegation-receivers" };
    const context = this.delegationContext(event, parent);
    if (!context) return { reason: "child-delegation-context-not-found", diagnostic: this.parentDiagnostic(parent) };
    try {
      this.durability.startCodexChildDelegation({
        parentThreadId: context.parentThreadId,
        parentTurnId: context.parentTurnId,
        parentExecutionId: context.parentExecutionId,
        parentItemId: parent?.itemId ?? `toolCall:${event.toolCallId}`,
        receiverThreadIds,
        description: this.stringInput(toolInput.description),
        prompt: this.stringInput(toolInput.prompt),
        identity: this.stringInput(toolInput.agentName),
        model: this.stringInput(toolInput.model),
        reasoningEffort: this.stringInput(toolInput.reasoningEffort),
        providerIdentities: context.providerIdentities,
      });
      return undefined;
    } catch (error) {
      logger.warn("Codex child provisional persistence failed", {
        threadId: event.threadId,
        toolCallId: event.toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { reason: "child-delegation-persistence-failed", diagnostic: this.parentDiagnostic(parent) };
    }
  }

  private parentDiagnostic(
    parent: { threadId: string; turnId: string; executionId: string; itemId: string } | undefined,
  ): DiagnosticContext | undefined {
    return parent && {
      threadId: parent.threadId,
      executionId: parent.executionId,
      parentItemId: parent.itemId,
    };
  }

  private delegationContext(
    event: CodexToolEvent,
    parent: { threadId: string; turnId: string; executionId: string; itemId: string } | undefined,
  ): { parentThreadId: string; parentTurnId: string; parentExecutionId: string; providerIdentities: readonly import("@mcode/contracts").ProviderIdentity[] } | null {
    const executionId = parent?.executionId ?? event.turnExecutionId;
    if (!executionId) return null;
    const parentTurn = parent ? this.durability.loadTurn(parent.turnId) : this.durability.loadTurnByExecution(executionId);
    const parentThread = this.durability.loadThread(parent?.threadId ?? event.threadId);
    if (!parentTurn || !parentThread) return null;
    return {
      parentThreadId: parentThread.id,
      parentTurnId: parentTurn.id,
      parentExecutionId: executionId,
      providerIdentities: parentThread.providerIdentities,
    };
  }

  private nativeThreadIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim().slice(0, 512))
      .slice(0, 32);
  }

  private stringInput(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private projectProviderContinuation(event: CodexRuntimeEvent): ProviderEventProjection | undefined {
    if (event.type !== AgentEventType.TurnStarted || !event.codexContinuation) return undefined;
    const turnStarted = event as CodexTurnStartedEvent;
    if (this.startProviderContinuation(turnStarted)) return;
    logger.warn("Ignoring provider continuation without canonical collaboration action", {
      threadId: event.threadId,
      turnExecutionId: event.turnExecutionId,
    });
    return this.reject(
      event,
      undefined,
      "continuation-evidence-not-found",
      this.continuationDiagnostic(turnStarted),
    );
  }

  private startProviderContinuation(
    event: CodexTurnStartedEvent,
  ): boolean {
    const evidence = event.codexContinuation;
    const executionId = event.turnExecutionId;
    if (!evidence || !executionId) return false;
    try {
      const context = this.continuationContext(event);
      if (!context) return false;
      this.durability.startProviderContinuation({
        parentThreadId: context.parentThreadId,
        turnId: randomUUID(),
        executionId,
        permissionMode: this.durability.loadLatestPermissionMode(context.parentThreadId) ?? "supervised",
        providerIdentities: context.providerIdentities,
        triggerActionId: context.triggerActionId,
      });
      this.durability.activateProviderContinuation(context.parentThreadId);
      return true;
    } catch (error) {
      logger.warn("Codex provider continuation persistence failed", {
        threadId: event.threadId,
        sourceNativeThreadId: evidence.sourceNativeThreadId,
        sourceNativeTurnId: evidence.sourceNativeTurnId,
        sourceNativeItemId: evidence.sourceNativeItemId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private continuationContext(
    event: CodexTurnStartedEvent,
  ): ContinuationContext | null {
    const evidence = event.codexContinuation;
    const source = this.continuationSource(event);
    if (!evidence || !source?.action) return null;
    const targetThread = this.durability.loadThreadByProviderIdentity(this.nativeIdentity("thread", evidence.targetNativeThreadId));
    if (!targetThread || targetThread.id !== event.threadId || source.action.target.threadId !== targetThread.id) return null;
    const parentThread = this.durability.loadThread(event.threadId);
    if (!parentThread || parentThread.id !== targetThread.id) return null;
    return {
      diagnostic: source.diagnostic,
      parentThreadId: parentThread.id,
      providerIdentities: parentThread.providerIdentities,
      triggerActionId: source.action.id,
    };
  }

  private continuationSource(
    event: CodexTurnStartedEvent,
  ): ContinuationSource | undefined {
    const evidence = event.codexContinuation;
    if (!evidence) return undefined;
    const sourceThread = this.durability.loadThreadByProviderIdentity(
      this.nativeIdentity("thread", evidence.sourceNativeThreadId),
    );
    if (!sourceThread) return undefined;
    const sourceTurn = this.durability.loadTurnByProviderIdentity(
      sourceThread.id,
      this.nativeIdentity("turn", evidence.sourceNativeTurnId),
    );
    if (!sourceTurn) return undefined;
    const action = this.durability.loadCollaborationActionBySourceProviderIdentity(
      sourceThread.id,
      sourceTurn.id,
      this.nativeIdentity("item", evidence.sourceNativeItemId),
    );
    return {
      action,
      diagnostic: {
        threadId: sourceThread.id,
        executionId: this.durability.loadExecutionIdForTurn(sourceTurn.id),
        ...(action ? { parentItemId: action.source.itemId } : {}),
      },
    };
  }

  private continuationDiagnostic(
    event: CodexTurnStartedEvent,
  ): DiagnosticContext | undefined {
    try {
      const source = this.continuationSource(event);
      if (source) return source.diagnostic;
    } catch (error) {
      logger.warn("Codex continuation diagnostic context failed", {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.latestThreadDiagnostic(event.threadId);
  }

  private latestThreadDiagnostic(threadId: string): DiagnosticContext | undefined {
    try {
      const thread = this.durability.loadThread(threadId);
      if (!thread) return undefined;
      const turn = this.durability.loadLatestTurn(thread.id);
      if (!turn) return undefined;
      return {
        threadId: thread.id,
        executionId: this.durability.loadExecutionIdForTurn(turn.id),
      };
    } catch (error) {
      logger.warn("Codex continuation fallback diagnostic context failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private projectChildEvent(event: CodexRuntimeEvent, evidence: CodexChildEvidence): ProviderEventProjection {
    try {
      const contradiction = this.receiverParentItemConflict(evidence);
      if (contradiction) {
        return this.reject(event, evidence, "receiver-parent-item-mismatch", contradiction.diagnostic);
      }
      const context = this.childRoutingContext(event, evidence);
      if (!context) return this.reject(event, evidence, this.childRoutingFailure(event));
      if (this.isRejectedDelivery(event, context)) {
        this.markRejectedDelivery(context, evidence);
        return { status: "consumed" };
      }
      if (!evidence.nativeTurnId) return this.reject(event, evidence, "missing-native-turn");
      this.durability.registerCodexReceiverThreadIds({
        ...context,
        nativeThreadId: evidence.nativeThreadId,
        receiverThreadIds: [evidence.nativeThreadId],
      });
      return this.persistChildProjection(event, evidence, context);
    } catch (error) {
      logger.warn("Codex child canonical event rejected", {
        threadId: event.threadId,
        nativeThreadId: evidence.nativeThreadId,
        nativeTurnId: evidence.nativeTurnId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.reject(event, evidence, error instanceof Error ? error.message : String(error));
    }
  }

  private receiverParentItemConflict(
    evidence: CodexChildEvidence,
  ): { diagnostic?: DiagnosticContext } | undefined {
    const delegation = this.durability.loadCodexChildDelegationByReceiverThreadId(evidence.nativeThreadId);
    if (!delegation || delegation.collaborationAction.source.itemId === `toolCall:${evidence.parentCollaborationItemId}`) {
      return undefined;
    }
    const parentTurn = this.durability.loadTurn(delegation.collaborationAction.source.turnId);
    if (!parentTurn) return {};
    return {
      diagnostic: {
        threadId: delegation.collaborationAction.source.threadId,
        executionId: this.durability.loadExecutionIdForTurn(parentTurn.id),
        parentItemId: delegation.collaborationAction.source.itemId,
      },
    };
  }

  private childRoutingContext(event: AgentEvent, evidence: CodexChildEvidence): ChildRoutingContext | null {
    const fallbackTurn = event.turnExecutionId
      ? this.durability.loadTurnByExecution(event.turnExecutionId)
      : null;
    const byReceiver = this.durability.loadCodexChildDelegationByReceiverThreadId(evidence.nativeThreadId);
    const delegation = byReceiver ?? (fallbackTurn
      ? this.durability.loadCodexChildDelegation(event.threadId, `toolCall:${evidence.parentCollaborationItemId}`)
      : null);
    if (!delegation) return null;
    const parentThread = this.durability.loadThread(delegation.collaborationAction.source.threadId);
    const parentTurn = this.durability.loadTurn(delegation.collaborationAction.source.turnId);
    if (!parentThread || !parentTurn) return null;
    return {
      delegation,
      parentExecutionId: this.durability.loadExecutionIdForTurn(parentTurn.id),
      parentItemId: delegation.collaborationAction.source.itemId,
      parentThreadId: parentThread.id,
      parentTurnId: parentTurn.id,
    };
  }

  private childRoutingFailure(event: AgentEvent): string {
    return event.turnExecutionId ? "delegation-not-found" : "missing-parent-execution";
  }

  private isRejectedDelivery(event: AgentEvent, context: ChildRoutingContext): boolean {
    return event.type === AgentEventType.ToolResult
      && event.isError
      && !context.delegation.collaborationAction.target.turnId;
  }

  private markRejectedDelivery(context: ChildRoutingContext, evidence: CodexChildEvidence): void {
    this.durability.markCodexChildDeliveryRejected({
      parentThreadId: context.parentThreadId,
      parentTurnId: context.parentTurnId,
      parentExecutionId: context.parentExecutionId,
      parentItemId: context.parentItemId,
      nativeThreadId: evidence.nativeThreadId,
    });
  }

  private persistChildProjection(
    event: AgentEvent,
    evidence: CodexChildEvidence,
    context: ChildRoutingContext,
  ): ProviderEventProjection {
    switch (event.type) {
      case AgentEventType.TurnStarted:
        this.startChildTurn(evidence, context);
        return { status: "consumed" };
      case AgentEventType.TextDelta:
        this.recordChildReasoning(event, evidence, context);
        return { status: "consumed" };
      case AgentEventType.ToolUse:
        this.recordChildToolUse(event, evidence, context);
        return { status: "consumed" };
      case AgentEventType.ToolResult:
        this.recordChildToolResult(event, evidence, context);
        return { status: "consumed" };
      case AgentEventType.Message:
        this.recordChildMessage(event, evidence, context);
        return { status: "consumed" };
      case AgentEventType.TurnComplete:
      case AgentEventType.Ended:
        this.finishChildTurn(event, evidence, context);
        return { status: "consumed" };
      case AgentEventType.Error:
        this.finishChildWithError(event, evidence, context);
        return { status: "consumed" };
      default:
        return { status: "consumed" };
    }
  }

  private startChildTurn(evidence: CodexChildEvidence, context: ChildRoutingContext): void {
    if (!evidence.nativeTurnId) throw new Error("Codex child turn requires native turn evidence");
    this.durability.startCodexChildTurn({
      ...context,
      nativeThreadId: evidence.nativeThreadId,
      nativeTurnId: evidence.nativeTurnId,
      ...(evidence.prompt ? { prompt: evidence.prompt } : {}),
    });
  }

  private recordChildReasoning(
    event: Extract<AgentEvent, { type: typeof AgentEventType.TextDelta }>,
    evidence: CodexChildEvidence,
    context: ChildRoutingContext,
  ): void {
    if (!evidence.nativeTurnId || !evidence.nativeItemId) return;
    const child = this.bindChild(context, evidence);
    this.durability.recordCodexChildItem({
      childThreadId: child.id,
      nativeTurnId: evidence.nativeTurnId,
      nativeItemId: evidence.nativeItemId,
      eventKey: evidence.itemEventKey ?? "completed",
      kind: "reasoning",
      payload: { projection: "codexChildReasoning", content: event.delta },
    });
  }

  private recordChildToolUse(
    event: Extract<AgentEvent, { type: typeof AgentEventType.ToolUse }>,
    evidence: CodexChildEvidence,
    context: ChildRoutingContext,
  ): void {
    if (!evidence.nativeTurnId) throw new Error("Codex child tool use requires native turn evidence");
    const child = this.bindChild(context, evidence);
    if (this.startKnownNestedChildDelegation(event, child.id)) return;
    const item = this.durability.recordCodexChildItem({
      childThreadId: child.id,
      nativeTurnId: evidence.nativeTurnId,
      nativeItemId: evidence.nativeItemId ?? event.toolCallId,
      eventKey: evidence.itemEventKey ?? "started",
      kind: "tool-call",
      payload: { projection: "codexChildToolCall", toolName: event.toolName, toolInput: event.toolInput },
    });
    if (this.isChildDelegationEvent(event)) {
      this.startChildDelegationFromEmittingChild(event, child.id, evidence.nativeTurnId);
      return;
    }
    this.requireCollaborationAction(event, item.id);
  }

  private startKnownNestedChildDelegation(event: CodexToolEvent, childThreadId: string): boolean {
    if (!this.isChildDelegationEvent(event)) return false;
    const delegation = this.durability.loadCodexChildDelegation(childThreadId, `toolCall:${event.toolCallId}`);
    if (!delegation) return false;
    const failure = this.startChildDelegation(event, this.nestedParent(childThreadId, delegation));
    if (failure) throw new Error(failure.reason);
    return true;
  }

  private startChildDelegationFromEmittingChild(
    event: CodexToolEvent,
    childThreadId: string,
    nativeTurnId: string,
  ): void {
    const childTurn = this.durability.loadTurnByProviderIdentity(
      childThreadId,
      this.nativeIdentity("turn", nativeTurnId),
    );
    if (!childTurn) throw new Error("emitting-child-turn-not-found");
    const failure = this.startChildDelegation(event, {
      threadId: childThreadId,
      turnId: childTurn.id,
      executionId: this.durability.loadExecutionIdForTurn(childTurn.id),
      itemId: `toolCall:${event.toolCallId}`,
    });
    if (failure) throw new Error(failure.reason);
  }

  private nestedParent(parentThreadId: string, delegation: CodexChildDelegation): {
    threadId: string;
    turnId: string;
    executionId: string;
    itemId: string;
  } {
    const source = delegation.collaborationAction.source;
    return {
      threadId: parentThreadId,
      turnId: source.turnId,
      executionId: this.durability.loadExecutionIdForTurn(source.turnId),
      itemId: source.itemId,
    };
  }

  private recordChildToolResult(
    event: Extract<AgentEvent, { type: typeof AgentEventType.ToolResult }>,
    evidence: CodexChildEvidence,
    context: ChildRoutingContext,
  ): void {
    if (!evidence.nativeTurnId) throw new Error("Codex child result requires native turn evidence");
    const child = this.bindChild(context, evidence);
    this.durability.recordCodexChildItem({
      childThreadId: child.id,
      nativeTurnId: evidence.nativeTurnId,
      nativeItemId: evidence.nativeItemId ?? evidence.parentCollaborationItemId,
      eventKey: evidence.itemEventKey ?? "assistant-result",
      kind: evidence.nativeItemId ? "tool-result" : "message",
      payload: evidence.nativeItemId
        ? { projection: "codexChildToolResult", output: event.output, isError: event.isError }
        : this.childAssistantMessage(evidence.nativeTurnId, event.output),
    });
    this.requireCollaborationAction(event);
  }

  private recordChildMessage(
    event: Extract<AgentEvent, { type: typeof AgentEventType.Message }>,
    evidence: CodexChildEvidence,
    context: ChildRoutingContext,
  ): void {
    if (!evidence.nativeTurnId) throw new Error("Codex child message requires native turn evidence");
    const child = this.bindChild(context, evidence);
    const nativeItemId = evidence.nativeItemId ?? evidence.nativeTurnId;
    this.durability.recordCodexChildItem({
      childThreadId: child.id,
      nativeTurnId: evidence.nativeTurnId,
      nativeItemId,
      eventKey: evidence.itemEventKey ?? "completed",
      kind: "message",
      payload: {
        projection: "message",
        message: {
          id: `codex-child-message:${nativeItemId}`,
          thread_id: child.id,
          role: "assistant",
          content: event.content,
          tool_calls: null,
          files_changed: null,
          cost_usd: null,
          tokens_used: event.tokens,
          timestamp: new Date().toISOString(),
          sequence: 0,
          attachments: null,
        },
      },
    });
  }

  private childAssistantMessage(nativeTurnId: string, content: string): Record<string, unknown> {
    return {
      projection: "message",
      message: {
        id: `codex-child-message:${nativeTurnId}`,
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
      },
    };
  }

  private finishChildTurn(
    event: Extract<AgentEvent, { type: typeof AgentEventType.TurnComplete | typeof AgentEventType.Ended }>,
    evidence: CodexChildEvidence,
    context: ChildRoutingContext,
  ): void {
    if (!evidence.nativeTurnId) throw new Error("Codex child terminal requires native turn evidence");
    const child = this.bindChild(context, evidence);
    this.durability.finishCodexChildTurn({
      childThreadId: child.id,
      nativeTurnId: evidence.nativeTurnId,
      outcome: event.type === AgentEventType.Ended
        ? event.outcome ?? "interrupted"
        : evidence.outcome ?? "completed",
    });
  }

  private finishChildWithError(
    event: Extract<AgentEvent, { type: typeof AgentEventType.Error }>,
    evidence: CodexChildEvidence,
    context: ChildRoutingContext,
  ): void {
    if (!evidence.nativeTurnId) throw new Error("Codex child failure requires native turn evidence");
    const child = this.bindChild(context, evidence);
    this.durability.finishCodexChildTurn({
      childThreadId: child.id,
      nativeTurnId: evidence.nativeTurnId,
      outcome: "errored",
      error: event.error,
    });
  }

  private bindChild(context: ChildRoutingContext, evidence: CodexChildEvidence) {
    return this.durability.bindCodexChildIdentity({
      ...context,
      nativeThreadId: evidence.nativeThreadId,
    }).childThread;
  }

  private requireCollaborationAction(event: CodexToolEvent, sourceItemId?: string): void {
    if (!this.isCollaborationEvent(event) || this.isChildDelegationEvent(event)) return;
    const kind = this.collaborationKind(event);
    if (!kind) throw new Error("unsupported-collaboration-kind");
    const failure = this.recordCollaborationAction(event, kind, sourceItemId);
    if (failure) throw new Error(failure.reason);
  }

  private collaborationCode(event: CodexToolEvent): string | undefined {
    const value = event.toolInput?.codexCollabKind;
    return typeof value === "string" ? value.toLowerCase().replace(/[_-]/g, "") : undefined;
  }

  private collaborationKind(event: CodexToolEvent): CollaborationActionKind | undefined {
    const code = this.collaborationCode(event);
    return code ? CODEX_COLLABORATION_KIND_BY_NATIVE.get(code) : undefined;
  }

  private recordCollaborationAction(
    event: CodexToolEvent,
    kind: CollaborationActionKind,
    sourceItemId?: string,
  ): CollaborationFailure | undefined {
    const resolved = this.actionSource(event);
    if ("reason" in resolved) return resolved;
    return event.type === AgentEventType.ToolResult
      ? this.recordCollaborationResult(event, resolved, kind)
      : this.recordCollaborationDispatch(event, resolved, kind, sourceItemId);
  }

  private actionSource(event: CodexToolEvent): CollaborationSource | CollaborationFailure {
    const evidence = this.childEvidence(event);
    const senderThreadId = this.stringInput(event.toolInput?.senderThreadId)?.trim().slice(0, 512)
      ?? evidence?.nativeThreadId;
    const sourceThread = evidence?.nativeThreadId
      ? this.durability.loadThreadByProviderIdentity(this.nativeIdentity("thread", evidence.nativeThreadId))
      : this.durability.loadThread(event.threadId);
    if (!sourceThread) return { reason: "collaboration-source-thread-not-found" };
    const sourceTurn = evidence?.nativeTurnId
      ? this.durability.loadTurnByProviderIdentity(sourceThread.id, this.nativeIdentity("turn", evidence.nativeTurnId))
      : event.turnExecutionId
        ? this.durability.loadTurnByExecution(event.turnExecutionId)
        : null;
    if (!sourceTurn) return { reason: "collaboration-source-turn-not-found" };
    const diagnostic = {
      threadId: sourceTurn.threadId,
      executionId: this.durability.loadExecutionIdForTurn(sourceTurn.id),
    };
    if (sourceTurn.threadId !== sourceThread.id) {
      return { reason: "collaboration-source-turn-mismatch", diagnostic };
    }
    if (senderThreadId && !this.senderMatches(sourceThread.id, senderThreadId)) {
      return { reason: "collaboration-sender-mismatch", diagnostic };
    }
    return {
      diagnostic,
      evidence,
      senderThreadId,
      sourceThreadId: sourceThread.id,
      sourceTurnId: sourceTurn.id,
      receiverThreadIds: [...new Set(this.nativeThreadIds(event.toolInput?.receiverThreadIds))],
    };
  }

  private senderMatches(sourceThreadId: string, senderThreadId: string): boolean {
    return this.durability.loadThreadByProviderIdentity(this.nativeIdentity("thread", senderThreadId))?.id === sourceThreadId;
  }

  private collaborationTarget(source: CollaborationSource): { targetThreadId: string } | CollaborationFailure {
    if (source.receiverThreadIds.length !== 1) {
      return { reason: "invalid-collaboration-receivers", diagnostic: source.diagnostic };
    }
    const target = this.durability.loadThreadByProviderIdentity(
      this.nativeIdentity("thread", source.receiverThreadIds[0]!),
    );
    if (!target) return { reason: "collaboration-target-not-found", diagnostic: source.diagnostic };
    if (target.id === source.sourceThreadId) {
      return { reason: "collaboration-target-matches-source", diagnostic: source.diagnostic };
    }
    return { targetThreadId: target.id };
  }

  private recordCollaborationResult(
    event: Extract<CodexToolEvent, { type: typeof AgentEventType.ToolResult }>,
    source: CollaborationSource,
    kind: CollaborationActionKind,
  ): CollaborationFailure | undefined {
    const target = this.collaborationTarget(source);
    if ("reason" in target) return target;
    const action = this.durability.loadCollaborationActionBySourceProviderIdentity(
      source.sourceThreadId,
      source.sourceTurnId,
      this.nativeIdentity("item", event.toolCallId),
    );
    if (!action) return { reason: "collaboration-action-not-found", diagnostic: source.diagnostic };
    if (action.kind !== kind || action.target.threadId !== target.targetThreadId) {
      return { reason: "collaboration-action-target-mismatch", diagnostic: source.diagnostic };
    }
    try {
      this.durability.recordCollaborationAction({
        actionId: action.id,
        kind: action.kind,
        sourceThreadId: action.source.threadId,
        sourceTurnId: action.source.turnId,
        sourceExecutionId: this.durability.loadExecutionIdForTurn(action.source.turnId),
        sourceItemId: action.source.itemId,
        targetThreadId: action.target.threadId,
        ...(action.target.turnId ? { targetTurnId: action.target.turnId } : {}),
        status: event.isError ? "Failed" : "Acknowledged",
        providerIdentities: action.providerIdentities,
        payload: this.actionPayload(event, kind),
      });
      return undefined;
    } catch (error) {
      logger.warn("Codex collaboration result persistence failed", {
        toolCallId: event.toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { reason: "collaboration-result-persistence-failed", diagnostic: source.diagnostic };
    }
  }

  private recordCollaborationDispatch(
    event: Extract<CodexToolEvent, { type: typeof AgentEventType.ToolUse }>,
    source: CollaborationSource,
    kind: CollaborationActionKind,
    sourceItemId: string | undefined,
  ): CollaborationFailure | undefined {
    if (!sourceItemId) return { reason: "collaboration-source-item-not-found", diagnostic: source.diagnostic };
    const target = this.collaborationTarget(source);
    if ("reason" in target) return target;
    try {
      this.durability.recordCollaborationAction({
        actionId: this.actionId(source.sourceThreadId, source.sourceTurnId, sourceItemId, kind),
        kind,
        sourceThreadId: source.sourceThreadId,
        sourceTurnId: source.sourceTurnId,
        sourceExecutionId: this.durability.loadExecutionIdForTurn(source.sourceTurnId),
        sourceItemId,
        targetThreadId: target.targetThreadId,
        status: "Dispatched",
        providerIdentities: this.actionIdentities(source, event),
        payload: this.actionPayload(event, kind),
      });
      return undefined;
    } catch (error) {
      logger.warn("Codex collaboration action persistence failed", {
        toolCallId: event.toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { reason: "collaboration-dispatch-persistence-failed", diagnostic: source.diagnostic };
    }
  }

  private actionId(sourceThreadId: string, sourceTurnId: string, sourceItemId: string, kind: CollaborationActionKind): string {
    return `collaboration:codex:${createHash("sha256")
      .update(`${sourceThreadId}:${sourceTurnId}:${sourceItemId}:${kind}`)
      .digest("hex")}`;
  }

  private actionIdentities(
    source: CollaborationSource,
    event: Extract<CodexToolEvent, { type: typeof AgentEventType.ToolUse }>,
  ) {
    return [
      ...(source.senderThreadId ? [this.nativeIdentity("thread", source.senderThreadId)] : []),
      ...source.receiverThreadIds.map((value) => this.nativeIdentity("thread", value)),
      this.nativeIdentity("item", event.toolCallId),
      ...(source.evidence?.nativeItemId ? [this.nativeIdentity("item", source.evidence.nativeItemId)] : []),
    ];
  }

  private actionPayload(event: CodexToolEvent, kind: CollaborationActionKind): Record<string, unknown> {
    const input = event.toolInput ?? {};
    const prompt = this.stringInput(input.prompt)?.slice(0, 32_768);
    return {
      projection: "codexCollaboration",
      kind,
      ...(event.type === AgentEventType.ToolUse ? { toolName: event.toolName } : {}),
      toolCallId: event.toolCallId.slice(0, 512),
      ...(typeof input.senderThreadId === "string" ? { senderThreadId: input.senderThreadId.slice(0, 512) } : {}),
      ...(Array.isArray(input.receiverThreadIds)
        ? { receiverThreadIds: input.receiverThreadIds.filter((value): value is string => typeof value === "string").slice(0, 32).map((value) => value.slice(0, 512)) }
        : {}),
      ...(prompt ? { prompt } : {}),
      ...(event.type === AgentEventType.ToolResult ? { isError: event.isError } : {}),
    };
  }

  private nativeIdentity(scope: "thread" | "turn" | "item", value: string) {
    return { providerId: this.providerId, scope, value, provenance: "native" as const };
  }

  private forward(event: CodexRuntimeEvent): ProviderEventProjection {
    return { status: "forward", event: this.sanitize(event) };
  }

  private sanitize(event: CodexRuntimeEvent): AgentEvent {
    const { codexChild: _child, codexContinuation: _continuation, ...genericEvent } = event;
    if (genericEvent.type !== AgentEventType.ToolUse && genericEvent.type !== AgentEventType.ToolResult) {
      return genericEvent;
    }
    const {
      codexCollabKind: _kind,
      senderThreadId: _senderThreadId,
      receiverThreadIds: _receiverThreadIds,
      prompt: _prompt,
      agentName: _agentName,
      agentPath: _agentPath,
      model: _model,
      reasoningEffort: _reasoningEffort,
      ...toolInput
    } = genericEvent.toolInput ?? {};
    return {
      ...genericEvent,
      ...(genericEvent.type === AgentEventType.ToolUse
        ? { toolInput }
        : { ...(Object.keys(toolInput).length > 0 ? { toolInput } : {}) }),
    } as AgentEvent;
  }

  private reject(
    event: CodexRuntimeEvent,
    evidence: CodexChildEvidence | undefined,
    reason: string,
    context?: DiagnosticContext,
  ): ProviderEventProjection {
    return { status: "rejected", diagnostic: this.recordRoutingDiagnostic(event, reason, evidence, context) };
  }

  private recordRoutingDiagnostic(
    event: CodexRuntimeEvent,
    reason: string,
    evidence = this.childEvidence(event),
    context?: DiagnosticContext,
  ): CodexChildRoutingDiagnosticInput {
    const diagnostic = {
      threadId: context?.threadId ?? event.threadId,
      parentItemId: context?.parentItemId ?? (evidence ? `toolCall:${evidence.parentCollaborationItemId}` : undefined),
      executionId: context?.executionId ?? event.turnExecutionId,
      event: this.sanitize(event),
      reason,
    };
    let persisted = false;
    try {
      persisted = this.durability.recordCodexChildRoutingDiagnostic(diagnostic);
    } catch (error) {
      logger.error("Codex child routing diagnostic persistence failed", {
        threadId: diagnostic.threadId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logger.warn("Codex child routing diagnostic", {
      threadId: diagnostic.threadId,
      parentCollaborationItemId: evidence?.parentCollaborationItemId,
      reason,
      persisted,
    });
    return diagnostic;
  }
}
