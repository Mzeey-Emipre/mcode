import type Database from "better-sqlite3";
import {
  type IAgentProvider,
  type IGoalCapable,
  type AgentEvent,
  AgentEventType,
  isGoalCapable,
} from "@mcode/contracts";
import type { MessageRepo } from "../repositories/message-repo.js";

/** Broadcast function shape used to push agent events to connected clients. */
type BroadcastFn = (channel: "agent.event", data: AgentEvent) => void;

/** Repositories and database handle the command needs to persist its rows. */
interface GoalCommandDeps {
  readonly messageRepo: MessageRepo;
  readonly db: Database.Database;
}

/**
 * Result of routing a message through {@link GoalCommand.handle}:
 * - `passthrough` — not a goal command (or the provider lacks the capability);
 *   the caller forwards the original content to the model unchanged.
 * - `handled` — a control form (show/clear) was fully serviced and persisted;
 *   the caller should short-circuit the send.
 * - `rewrite` — a SET form; the caller persists `content` as the wire payload
 *   while keeping the original text for the transcript, then installs the goal.
 */
export type GoalCommandOutcome =
  | { readonly kind: "passthrough" }
  | { readonly kind: "handled" }
  | { readonly kind: "rewrite"; readonly content: string; readonly pendingGoal: string };

/** Matches `/goal`, optionally followed by an argument, across newlines. */
const GOAL_COMMAND = /^\s*\/goal\b\s*(.*)$/s;

/**
 * Owns the `/goal` app-native command. Constructed per send with the resolved
 * provider, the repositories, and the broadcast function; it holds no turn
 * state. Any provider that implements {@link IGoalCapable} gets `/goal` for
 * free; on a provider without it, every `/goal` is a passthrough so the model
 * still sees what the user typed.
 */
export class GoalCommand {
  /** The capable view of the provider, or null when it lacks goal support. */
  private readonly capable: IGoalCapable | null;

  constructor(
    provider: IAgentProvider,
    private readonly deps: GoalCommandDeps,
    private readonly broadcast: BroadcastFn,
  ) {
    this.capable = isGoalCapable(provider) ? provider : null;
  }

  /** The session id the goal hook keys on, derived from the thread id. */
  private sessionName(threadId: string): string {
    return `mcode-${threadId}`;
  }

  /**
   * Install the goal gate on the provider. Called by the send orchestrator as
   * late as possible before dispatch so a failed preflight leaves no stale
   * goal. A no-op when the provider lacks the capability.
   */
  installGoal(threadId: string, condition: string): void {
    this.capable?.setGoal(this.sessionName(threadId), condition);
  }

  /**
   * Tear the goal back out after a failed send so a hidden Stop-hook gate does
   * not linger into the next turn. A no-op when the provider lacks the
   * capability.
   */
  rollbackGoal(threadId: string): void {
    this.capable?.clearGoal(this.sessionName(threadId));
  }

  /**
   * Route a message. Returns {@link GoalCommandOutcome} describing how the
   * caller should proceed.
   */
  handle(threadId: string, content: string): GoalCommandOutcome {
    const match = GOAL_COMMAND.exec(content);
    if (!match || !this.capable) {
      return { kind: "passthrough" };
    }

    const arg = match[1].trim();
    const lower = arg.toLowerCase();
    const isControl =
      arg === "" || lower === "show" || lower === "clear" || lower === "reset";

    if (isControl) {
      let replyText: string;
      if (arg === "" || lower === "show") {
        const current = this.capable.getGoal(this.sessionName(threadId));
        replyText = current
          ? `Active goal: "${current}". The agent will not stop until this condition is met. Use \`/goal clear\` to remove it.`
          : `No active goal. Use \`/goal <condition>\` to set one.`;
      } else {
        this.capable.clearGoal(this.sessionName(threadId));
        replyText = `Goal cleared. The agent may now end its turn normally.`;
      }
      this.persistControlReply(threadId, content, replyText);
      return { kind: "handled" };
    }

    // SET form: rewrite the wire payload so the agent starts working on the
    // condition immediately, while the caller pins the original text for the
    // transcript. The actual setGoal() install is deferred to the caller (via
    // installGoal) so a send failure can't leave a stale goal in the provider.
    return {
      kind: "rewrite",
      pendingGoal: arg,
      content:
        `A goal has been set for this session: "${arg}". Treat this exactly ` +
        `as your directive — start working toward it now. The session will not ` +
        `stop until the goal is satisfied.`,
    };
  }

  /**
   * Persist the user message and a synthetic confirmation pill in one
   * transaction, then broadcast the pill and an Ended event. Ended clears the
   * composer's optimistic running state since no provider call ran.
   */
  private persistControlReply(threadId: string, userText: string, replyText: string): void {
    const { messages: existing } = this.deps.messageRepo.listByThread(threadId, 1);
    const baseSeq = existing.length > 0 ? existing[existing.length - 1].sequence : 0;
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
    this.broadcast("agent.event", {
      type: AgentEventType.Ended,
      threadId,
    } satisfies AgentEvent);
  }
}
