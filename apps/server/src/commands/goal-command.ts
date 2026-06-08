import type Database from "better-sqlite3";
import {
  type IAgentProvider,
  type AgentEvent,
  AgentEventType,
  isGoalCapable,
} from "@mcode/contracts";
import type { MessageRepo } from "../repositories/message-repo.js";
import type { CommandContext, CommandOutcome, McodeCommand } from "./command-router.js";

/** Broadcast function shape used to push agent events to connected clients. */
type BroadcastFn = (channel: "agent.event", data: AgentEvent) => void;

/** Repositories and database handle the command needs to persist its rows. */
interface GoalCommandDeps {
  readonly messageRepo: MessageRepo;
  readonly db: Database.Database;
}

/** Matches `/goal`, optionally followed by an argument, across newlines. */
const GOAL_COMMAND = /^\s*\/goal\b\s*(.*)$/s;

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

  /**
   * Route a `/goal` message. Returns {@link CommandOutcome} describing how the
   * caller should proceed. The SET form rewrites the wire payload and defers the
   * actual goal install to the returned {@link CommandOutcome.onDispatch} so a
   * send failure can't leave a stale goal in the provider; `onRollback` tears it
   * back out.
   */
  handle(ctx: CommandContext): CommandOutcome {
    const { threadId, content } = ctx;
    const match = GOAL_COMMAND.exec(content);
    const capable = isGoalCapable(ctx.provider) ? ctx.provider : null;
    if (!match || !capable) {
      return { kind: "passthrough" };
    }

    const arg = match[1].trim();
    const lower = arg.toLowerCase();
    const isControl =
      arg === "" || lower === "show" || lower === "clear" || lower === "reset";

    if (isControl) {
      let replyText: string;
      if (arg === "" || lower === "show") {
        const current = capable.getGoal(this.sessionName(threadId));
        replyText = current
          ? `Active goal: "${current}". The agent will not stop until this condition is met. Use \`/goal clear\` to remove it.`
          : `No active goal. Use \`/goal <condition>\` to set one.`;
      } else {
        capable.clearGoal(this.sessionName(threadId));
        replyText = `Goal cleared. The agent may now end its turn normally.`;
      }
      this.persistControlReply(threadId, content, replyText);
      return { kind: "handled" };
    }

    // SET form: rewrite the wire payload so the agent starts working on the
    // condition immediately, while the caller pins the original text for the
    // transcript. The setGoal() install is deferred to onDispatch (run by the
    // caller just before sendTurn) so a send failure can't leave a stale goal;
    // onRollback clears it if the send fails.
    const session = this.sessionName(threadId);
    return {
      kind: "rewrite",
      content:
        `A goal has been set for this session: "${arg}". Treat this exactly ` +
        `as your directive — start working toward it now. The session will not ` +
        `stop until the goal is satisfied.`,
      onDispatch: () => capable.setGoal(session, arg),
      onRollback: () => capable.clearGoal(session),
    };
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
  }
}
