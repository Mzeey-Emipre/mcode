import type { Database } from "bun:sqlite";
import {
  type IAgentProvider,
  type AgentEvent,
  AgentEventType,
  type GoalState,
  type IGoalCapable,
  isGoalCapable,
  isGoalOpen,
} from "@mcode/contracts";
import type { MessageRepo } from "../conversation/persistence/message-repo.js";
import type { CommandContext, CommandOutcome, McodeCommand } from "./command-router.js";

/** Broadcast function shape used to push agent events to connected clients. */
type BroadcastFn = (channel: "agent.event", data: AgentEvent) => void;

/** Repositories and database handle the command needs to persist its rows. */
interface GoalCommandDeps {
  readonly messageRepo: MessageRepo;
  readonly db: Database;
}

/** Matches `/goal`, optionally followed by an argument, across newlines. */
const GOAL_COMMAND = /^\s*\/goal\b\s*(.*)$/s;
const MAX_GOAL_OBJECTIVE_CHARS = 4000;
interface ClaudeNativeGoalCommandProvider {
  hasNativeGoalCommand(sessionId: string): boolean;
  setNativeGoalMirror(sessionId: string, condition: string): GoalState;
  clearNativeGoalMirror(sessionId: string): boolean;
}

function asClaudeNativeGoalCommandProvider(
  provider: IAgentProvider,
): ClaudeNativeGoalCommandProvider | null {
  const candidate = provider as Partial<ClaudeNativeGoalCommandProvider>;
  return typeof candidate.hasNativeGoalCommand === "function" &&
    typeof candidate.setNativeGoalMirror === "function" &&
    typeof candidate.clearNativeGoalMirror === "function"
    ? (candidate as ClaudeNativeGoalCommandProvider)
    : null;
}

/**
 * The `/goal` app-native command. Holds only server-lifetime deps; the resolved
 * provider arrives per send via {@link CommandContext}. Any provider that
 * implements the goal capability gets `/goal` for free, which the router gates
 * through {@link requiredCapability}; on a provider without it the router passes
 * the command through so the model still sees what the user typed.
 */
export class GoalCommand implements McodeCommand {
  constructor(
    private readonly deps: GoalCommandDeps,
    private readonly broadcast: BroadcastFn,
  ) {}

  /** The session id the goal hook keys on, derived from the thread id. */
  private sessionName(threadId: string): string {
    return `mcode-${threadId}`;
  }

  /** Whether the content is a `/goal` invocation. */
  matches(content: string): boolean {
    return GOAL_COMMAND.test(content);
  }

  /** `/goal` is only meaningful on a provider that supports goal gating. */
  requiredCapability(provider: IAgentProvider): boolean {
    return isGoalCapable(provider);
  }

  /** Prepare a typed goal objective for atomic install, dispatch, and rollback. */
  async prepareSet(ctx: CommandContext, objective: string): Promise<CommandOutcome> {
    const arg = objective.trim();
    if (!isGoalCapable(ctx.provider)) {
      throw new Error("The selected provider does not support goals.");
    }
    if (arg.length === 0 || arg.length > MAX_GOAL_OBJECTIVE_CHARS) {
      throw new Error(`Goal objectives must contain 1-${MAX_GOAL_OBJECTIVE_CHARS} characters.`);
    }

    const session = this.sessionName(ctx.threadId);
    const native = asClaudeNativeGoalCommandProvider(ctx.provider);
    const useNative = native?.hasNativeGoalCommand(session) === true;

    if (useNative) {
      return {
        kind: "rewrite",
        content: `/goal ${arg}`,
        effect: { kind: "goal", objective: arg, delivery: "native" },
      };
    }

    return {
      kind: "rewrite",
      content:
        `A goal has been set for this session: "${arg}". Treat this exactly ` +
        `as your directive: start working toward it now. The session will not ` +
        `stop until the goal is satisfied.`,
      effect: { kind: "goal", objective: arg, delivery: "provider" },
    };
  }

  /**
   * Route a `/goal` message. Returns {@link CommandOutcome} describing how the
   * caller should proceed. The SET form rewrites the wire payload and defers the
   * actual goal install to the goal lifecycle owner so a send failure cannot
   * leave a stale goal in the provider.
   */
  async handle(ctx: CommandContext): Promise<CommandOutcome> {
    const match = GOAL_COMMAND.exec(ctx.content);
    const provider = isGoalCapable(ctx.provider) ? ctx.provider : null;
    if (!match || !provider) return { kind: "passthrough" };
    return this.handleGoal(ctx, provider, match[1].trim());
  }

  private async handleGoal(
    ctx: CommandContext,
    provider: IGoalCapable,
    arg: string,
  ): Promise<CommandOutcome> {
    const lower = arg.toLowerCase();
    if (this.isControlArgument(arg, lower)) return this.handleControl(ctx, provider, arg, lower);
    if (arg.length > MAX_GOAL_OBJECTIVE_CHARS) {
      this.persistControlReply(
        ctx.threadId,
        ctx.content,
        `Goal is too long. Keep goals under ${MAX_GOAL_OBJECTIVE_CHARS} characters.`,
      );
      return { kind: "handled" };
    }

    return this.prepareSet(ctx, arg);
  }

  private isControlArgument(arg: string, lower: string): boolean {
    return arg === "" || lower === "show" || lower === "clear" || lower === "reset";
  }

  private async handleControl(
    ctx: CommandContext,
    provider: IGoalCapable,
    arg: string,
    lower: string,
  ): Promise<CommandOutcome> {
    const nativeContent = this.nativeControlContent(ctx, lower);
    if (nativeContent) return { kind: "rewrite", content: nativeContent };
    const replyText = await this.controlReply(ctx, provider, arg, lower);
    this.persistControlReply(ctx.threadId, ctx.content, replyText);
    return { kind: "handled" };
  }

  private nativeControlContent(ctx: CommandContext, lower: string): string | undefined {
    const native = asClaudeNativeGoalCommandProvider(ctx.provider);
    if (!native?.hasNativeGoalCommand(this.sessionName(ctx.threadId))) return undefined;
    return lower === "clear" || lower === "reset" ? "/goal off" : "/goal";
  }

  private async controlReply(
    ctx: CommandContext,
    provider: IGoalCapable,
    arg: string,
    lower: string,
  ): Promise<string> {
    if (arg === "" || lower === "show") {
      const current = await provider.getGoal(this.sessionName(ctx.threadId));
      return isGoalOpen(current)
        ? `Active goal: "${current.objective}". Use \`/goal clear\` to remove it.`
        : `No active goal. Use \`/goal <condition>\` to set one.`;
    }
    const cleared = await provider.clearGoal(this.sessionName(ctx.threadId));
    this.broadcastGoalCleared(ctx.threadId, "cleared");
    return cleared ? `Goal cleared.` : `No active goal.`;
  }

  /** Broadcast that the active goal has been cleared. */
  private broadcastGoalCleared(
    threadId: string,
    reason: "cleared" | "rollback" | "completed",
  ): void {
    this.broadcast("agent.event", {
      type: AgentEventType.GoalCleared,
      threadId,
      reason,
    } satisfies AgentEvent);
  }

  /**
   * Persist the user message and a synthetic confirmation pill in one
   * transaction, then broadcast the pill as a Message event.
   *
   * No Ended event is emitted: a control command never starts a provider turn,
   * so it must not touch turn running-state. Emitting Ended here would clear the
   * client's running-state for a real turn already in flight (the composer keys
   * `isAgentRunning` on it), which breaks message-queue coordination (#583). The
   * client mirror skips the optimistic running-state for control commands, so
   * there is nothing for an Ended to clear in the idle case either.
   */
  private persistControlReply(threadId: string, userText: string, replyText: string): void {
    const baseSeq = this.deps.messageRepo.getLatestSequenceIncludingInternal(threadId);
    let assistantMsgId = "";
    this.deps.db.transaction(() => {
      this.deps.messageRepo.create(threadId, "user", userText, baseSeq + 1);
      const a = this.deps.messageRepo.create(threadId, "assistant", replyText, baseSeq + 2);
      assistantMsgId = a.id;
    })();

    this.broadcast("agent.event", {
      type: AgentEventType.Message,
      threadId,
      content: replyText,
      tokens: null,
      messageId: assistantMsgId,
    } satisfies AgentEvent);
  }
}
