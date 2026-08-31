import type Database from "better-sqlite3";
import { inject, injectable } from "tsyringe";
import {
  AgentEventType,
  isGoalCapable,
  isGoalOpen,
  type AgentEvent,
  type GoalLookupResult,
  type GoalState,
  type IGoalCapable,
  type IAgentProvider,
  type IProviderRegistry,
  type ProviderId,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { broadcast } from "../../../application/transport/push.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { GoalCommand } from "../commands/goal-command.js";
import type {
  CommandContext,
  CommandOutcome,
  GoalCommandEffectIntent,
} from "../commands/command-router.js";
import { AgentRuntimeCommandPort } from "../orchestration/agent-turn-command-port.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";

type AgentMessage = Extract<AgentEvent, { type: "message" }>;

type NativeGoalProvider = {
  hasNativeGoalCommand(sessionId: string): boolean;
  setNativeGoalMirror(sessionId: string, objective: string): GoalState;
  clearNativeGoalMirror(sessionId: string): boolean;
  runNativeGoalCommand(
    sessionId: string,
    command: "/goal" | "/goal off",
  ): Promise<{ kind: "active"; objective: string } | { kind: "cleared"; objective: string } | { kind: "empty" } | { kind: "unavailable" } | null>;
};

const GOAL_ACHIEVED_RECEIPT_RE = /^Goal achieved in \d+s\.$/;
const DIRECT_RESPONSE_GOAL_RE = /^\s*(?:say|reply|respond|answer)(?:\s+with)?\s+(.+?)\s*$/i;
const MAX_PENDING_EFFECTS = 64;

/** A stable receipt for a goal effect owned by the goal feature. */
export interface GoalCommandEffectReceipt {
  readonly kind: "goal";
  readonly id: string;
}

type GoalEffectState = "prepared" | "reserved" | "dispatched";

interface GoalEffect {
  readonly threadId: string;
  readonly provider: IGoalCapable;
  readonly native: NativeGoalProvider | null;
  readonly objective: string;
  readonly delivery: GoalCommandEffectIntent["delivery"];
  state: GoalEffectState;
}

/** Owns goal commands, native lifecycle reconciliation, and goal lookups. */
@injectable()
export class GoalLifecycleService {
  private readonly nativeRefreshes = new Set<string>();
  private readonly command: GoalCommand;
  private nextEffectId = 0;
  private readonly effects = new Map<string, GoalEffect>();

  constructor(
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    @inject("IProviderRegistry") private readonly providers: IProviderRegistry,
    @inject(MessageRepo) messages: MessageRepo,
    @inject("Database") database: Database.Database,
    @inject(AgentRuntimeCommandPort) private readonly runtime: AgentRuntimeCommandPort,
  ) {
    this.command = new GoalCommand({ messageRepo: messages, db: database }, broadcast);
  }

  /** Route a goal command before the owning execution facade dispatches a provider turn. */
  async routeCommand(context: CommandContext, objective?: string): Promise<CommandOutcome | { readonly kind: "rewrite"; readonly content: string; readonly commandEffect: GoalCommandEffectReceipt }> {
    const outcome = objective === undefined
      ? this.command.handle(context)
      : this.command.prepareSet(context, objective);
    return this.registerEffect(context, await outcome);
  }

  /** Move a prepared goal effect into the runtime-reserved state. */
  reserveCommandEffect(receipt: GoalCommandEffectReceipt): void {
    const effect = this.requireEffect(receipt);
    if (effect.state !== "prepared") throw new Error(`Goal effect is not prepared: ${receipt.id}`);
    effect.state = "reserved";
  }

  /** Install the goal only after provider dispatch is about to begin. */
  async dispatchCommandEffect(receipt: GoalCommandEffectReceipt): Promise<void> {
    const effect = this.requireEffect(receipt);
    if (effect.state !== "reserved") throw new Error(`Goal effect is not reserved: ${receipt.id}`);
    const sessionId = this.sessionId(effect.threadId);
    if (effect.delivery === "native") {
      if (!effect.native) throw new Error("Native goal effect lost its native provider");
      const goal = effect.native.setNativeGoalMirror(sessionId, effect.objective);
      this.broadcastGoalUpdated(effect.threadId, goal);
    } else {
      const goal = await effect.provider.setGoal(sessionId, effect.objective);
      this.broadcastGoalUpdated(effect.threadId, goal);
    }
    effect.state = "dispatched";
  }

  /** Roll back a goal only after its provider-visible state was installed. */
  async rollbackCommandEffect(receipt: GoalCommandEffectReceipt): Promise<void> {
    const effect = this.takeEffect(receipt);
    if (!effect || effect.state !== "dispatched") return;
    const sessionId = this.sessionId(effect.threadId);
    if (effect.delivery === "native") {
      effect.native?.clearNativeGoalMirror(sessionId);
    } else {
      await effect.provider.clearGoal(sessionId);
    }
    this.broadcastGoalCleared(effect.threadId, "rollback");
  }

  /** Release a terminal goal effect after a successful terminalization. */
  completeCommandEffect(receipt: GoalCommandEffectReceipt): void {
    this.takeEffect(receipt);
  }

  /** Return the lifecycle state used by focused tests and diagnostics. */
  commandEffectState(receipt: GoalCommandEffectReceipt): GoalEffectState | null {
    return this.effects.get(receipt.id)?.state ?? null;
  }

  /** Return the bounded number of prepared goal effects retained by this owner. */
  pendingCommandEffectCount(): number {
    return this.effects.size;
  }

  /** Return a thread's current open goal without starting provider work. */
  async get(threadId: string): Promise<GoalLookupResult> {
    const thread = this.requireThread(threadId);
    const providerId = (thread.provider ?? "claude") as ProviderId;
    const provider = this.providers.resolve(providerId);
    if (!isGoalCapable(provider)) return this.unsupported();
    const result = provider.getGoalLookup
      ? await provider.getGoalLookup(this.sessionId(threadId))
      : {
          goal: await provider.getGoal(this.sessionId(threadId)),
          authoritative: false,
          source: providerId === "codex" ? "codex-cache" as const : "claude-wrapper" as const,
          reason: "missing" as const,
        };
    return { ...result, goal: isGoalOpen(result.goal) ? result.goal : null };
  }

  /** Clear a goal without creating transcript rows or a new provider turn. */
  async clear(threadId: string): Promise<GoalLookupResult> {
    const thread = this.requireThread(threadId);
    const providerId = (thread.provider ?? "claude") as ProviderId;
    const provider = this.providers.resolve(providerId);
    if (!isGoalCapable(provider)) return this.unsupported();
    const native = this.nativeProvider(provider);
    const sessionId = this.sessionId(threadId);
    if (native?.hasNativeGoalCommand(sessionId)) return this.clearNative(threadId, provider, native);
    return this.clearProvider(providerId, provider, sessionId);
  }

  /** Observe one assistant message for a direct-response goal completion. */
  onAssistantMessage(providerId: ProviderId, event: AgentMessage): void {
    const provider = this.providers.resolve(providerId);
    if (!isGoalCapable(provider) || GOAL_ACHIEVED_RECEIPT_RE.test(event.content.trim())) return;
    void this.completeDirectResponse(provider, event).catch((error: unknown) => {
      logger.warn("Direct-response goal completion check failed", {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Reconcile a native goal only after a turn finishes and no turn remains active. */
  refreshAfterTurn(threadId: string): void {
    if (this.nativeRefreshes.has(threadId) || this.isActive(threadId)) return;
    const thread = this.threads.findById(threadId);
    if (!thread || thread.provider !== "claude") return;
    const provider = this.providers.resolve("claude");
    const native = this.nativeProvider(provider);
    const sessionId = this.sessionId(threadId);
    if (!native?.hasNativeGoalCommand(sessionId) || !isGoalCapable(provider)) return;
    this.nativeRefreshes.add(threadId);
    void this.refreshNativeGoal(provider, native, threadId, sessionId).finally(() => {
      this.nativeRefreshes.delete(threadId);
    });
  }

  private async clearNative(
    threadId: string,
    provider: IGoalCapable,
    native: NativeGoalProvider,
  ): Promise<GoalLookupResult> {
    const sessionId = this.sessionId(threadId);
    const lookup = await this.lookup(provider, sessionId, "claude-cache");
    const current = isGoalOpen(lookup.goal) ? lookup.goal : null;
    if (current && this.isActive(threadId)) {
      return { goal: current, authoritative: false, source: "claude-cache", reason: "busy" };
    }
    const result = await native.runNativeGoalCommand(sessionId, "/goal off");
    const nativeResult = this.nativeClearResult(result, current);
    if (nativeResult) return nativeResult;
    const after = await this.lookup(provider, sessionId, "claude-cache");
    return { goal: isGoalOpen(after.goal) ? after.goal : current, authoritative: false, source: "claude-cache", reason: "missing" };
  }

  private nativeClearResult(
    result: Awaited<ReturnType<NativeGoalProvider["runNativeGoalCommand"]>>,
    current: GoalState | null,
  ): GoalLookupResult | undefined {
    if (result?.kind === "cleared" || result?.kind === "empty") {
      return { goal: null, authoritative: true, source: "claude-native-command" };
    }
    if (result?.kind === "unavailable") {
      return {
        goal: current,
        authoritative: false,
        source: "claude-cache",
        reason: current ? "missing" : "not-materialized",
      };
    }
    return undefined;
  }

  private async clearProvider(
    providerId: ProviderId,
    provider: IGoalCapable,
    sessionId: string,
  ): Promise<GoalLookupResult> {
    const source = providerId === "codex" ? "codex-native" as const : "claude-wrapper" as const;
    if (await provider.clearGoal(sessionId)) {
      if (providerId !== "codex" || !provider.getGoalLookup) {
        return { goal: null, authoritative: true, source };
      }
      const lookup = await provider.getGoalLookup(sessionId);
      if (lookup.source === "codex-native" && lookup.authoritative) {
        return { goal: null, authoritative: true, source };
      }
      return { ...lookup, goal: isGoalOpen(lookup.goal) ? lookup.goal : null };
    }
    const lookup = await this.lookup(provider, sessionId, providerId === "codex" ? "codex-cache" : "claude-wrapper");
    return { ...lookup, goal: isGoalOpen(lookup.goal) ? lookup.goal : null };
  }

  private async completeDirectResponse(provider: IGoalCapable, event: AgentMessage): Promise<void> {
    const goal = await provider.getGoal(this.sessionId(event.threadId));
    if (!isGoalOpen(goal) || !this.matchesDirectResponse(goal, event.content)) return;
    if (!await provider.clearGoal(this.sessionId(event.threadId))) {
      logger.warn("Direct-response goal matched but provider did not clear it", {
        threadId: event.threadId,
        providerId: goal.providerId,
        objective: goal.objective,
      });
      return;
    }
    const now = Date.now();
    broadcast("agent.event", {
      type: AgentEventType.GoalUpdated,
      threadId: event.threadId,
      goal: { ...goal, status: "complete", timeUsedSeconds: this.elapsedSeconds(goal, now), updatedAt: now, controls: { ...goal.controls, canClear: false } },
    } satisfies AgentEvent);
    broadcast("agent.event", {
      type: AgentEventType.GoalCleared,
      threadId: event.threadId,
      providerId: goal.providerId ?? "unknown",
      reason: "completed",
      turnId: goal.turnId ?? null,
    } satisfies AgentEvent);
  }

  private async refreshNativeGoal(
    provider: IGoalCapable,
    native: NativeGoalProvider,
    threadId: string,
    sessionId: string,
  ): Promise<void> {
    const before = await provider.getGoal(sessionId);
    if (!isGoalOpen(before) || this.isActive(threadId)) return;
    const result = await native.runNativeGoalCommand(sessionId, "/goal");
    if (result?.kind !== "empty") return;
    const now = Date.now();
    broadcast("agent.event", {
      type: AgentEventType.GoalUpdated,
      threadId,
      goal: { ...before, status: "complete", timeUsedSeconds: this.elapsedSeconds(before, now), updatedAt: now, controls: { ...before.controls, canClear: false } },
    } satisfies AgentEvent);
    broadcast("agent.event", {
      type: AgentEventType.GoalCleared,
      threadId,
      providerId: before.providerId ?? "claude",
      reason: "completed",
      turnId: before.turnId ?? null,
    } satisfies AgentEvent);
  }

  private async lookup(
    provider: IGoalCapable,
    sessionId: string,
    source: "claude-cache" | "codex-cache" | "claude-wrapper",
  ): Promise<GoalLookupResult> {
    return provider.getGoalLookup
      ? provider.getGoalLookup(sessionId)
      : { goal: await provider.getGoal(sessionId) ?? null, authoritative: false, source, reason: "missing" };
  }

  private nativeProvider(provider: IAgentProvider): NativeGoalProvider | null {
    const candidate = provider as Partial<NativeGoalProvider>;
    return typeof candidate.hasNativeGoalCommand === "function"
      && typeof candidate.setNativeGoalMirror === "function"
      && typeof candidate.clearNativeGoalMirror === "function"
      && typeof candidate.runNativeGoalCommand === "function"
      ? candidate as NativeGoalProvider
      : null;
  }

  private isActive(threadId: string): boolean {
    return this.runtime.runtimeSnapshots().some((snapshot) => snapshot.threadId === threadId && snapshot.phase !== "idle");
  }

  private registerEffect(
    context: CommandContext,
    outcome: CommandOutcome,
  ): CommandOutcome | { readonly kind: "rewrite"; readonly content: string; readonly commandEffect: GoalCommandEffectReceipt } {
    if (outcome.kind !== "rewrite" || !outcome.effect) return outcome;
    if (this.effects.size >= MAX_PENDING_EFFECTS) throw new Error("Too many pending goal command effects");
    const provider = context.provider;
    if (!isGoalCapable(provider)) throw new Error("The selected provider does not support goals.");
    const id = `goal-effect-${++this.nextEffectId}`;
    this.effects.set(id, {
      threadId: context.threadId,
      provider,
      native: this.nativeProvider(provider),
      objective: outcome.effect.objective,
      delivery: outcome.effect.delivery,
      state: "prepared",
    });
    return { kind: "rewrite", content: outcome.content, commandEffect: { kind: "goal", id } };
  }

  private requireEffect(receipt: GoalCommandEffectReceipt): GoalEffect {
    const effect = this.effects.get(receipt.id);
    if (!effect) throw new Error(`Goal effect not found: ${receipt.id}`);
    return effect;
  }

  private takeEffect(receipt: GoalCommandEffectReceipt): GoalEffect | undefined {
    const effect = this.effects.get(receipt.id);
    this.effects.delete(receipt.id);
    return effect;
  }

  private broadcastGoalUpdated(threadId: string, goal: GoalState): void {
    broadcast("agent.event", {
      type: AgentEventType.GoalUpdated,
      threadId,
      goal,
    } satisfies AgentEvent);
  }

  private broadcastGoalCleared(threadId: string, reason: "rollback"): void {
    broadcast("agent.event", {
      type: AgentEventType.GoalCleared,
      threadId,
      reason,
    } satisfies AgentEvent);
  }

  private requireThread(threadId: string) {
    const thread = this.threads.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private unsupported(): GoalLookupResult {
    return { goal: null, authoritative: true, source: "unsupported", reason: "unsupported-provider" };
  }

  private sessionId(threadId: string): string {
    return `mcode-${threadId}`;
  }

  private matchesDirectResponse(goal: GoalState, content: string): boolean {
    const match = DIRECT_RESPONSE_GOAL_RE.exec(goal.objective);
    if (!match) return false;
    return this.normalizeGoalText(content) === this.normalizeGoalText(match[1]);
  }

  private normalizeGoalText(value: string): string {
    const trimmed = value.trim();
    const unquoted = /^(["'`“‘])(.*)(["'`”’])$/.exec(trimmed)?.[2] ?? trimmed;
    return unquoted.replace(/\s+/g, " ").replace(/[.!?]+$/g, "").trim().toLowerCase();
  }

  private elapsedSeconds(goal: GoalState, now: number): number {
    const created = goal.createdAt < 1_000_000_000_000 ? goal.createdAt * 1000 : goal.createdAt;
    return Math.max(goal.timeUsedSeconds, Math.floor((now - created) / 1000), 0);
  }
}
