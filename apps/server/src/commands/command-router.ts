import type { IAgentProvider } from "@mcode/contracts";

/**
 * Per-send context handed to a matched {@link McodeCommand}. The provider is
 * the already-resolved instance for this turn; commands narrow it to a
 * capability via their own type guard.
 */
export interface CommandContext {
  readonly threadId: string;
  readonly content: string;
  readonly provider: IAgentProvider;
}

/**
 * Result of routing a message through the {@link CommandRouter}:
 * - `passthrough` — no command claimed the message (or the resolved provider
 *   lacks the matched command's required capability); forward the original
 *   content to the model unchanged.
 * - `handled` — a command fully serviced the message; short-circuit the send.
 * - `rewrite` — a command rewrote the wire payload; the caller sends `content`
 *   instead of the original text, runs `onDispatch` just before dispatch, and
 *   runs `onRollback` if the send fails. The lifecycle closures keep
 *   command-specific side effects (e.g. installing a goal gate) out of the
 *   router and the orchestrator.
 */
export type CommandOutcome =
  | { readonly kind: "passthrough" }
  | { readonly kind: "handled" }
  | {
      readonly kind: "rewrite";
      readonly content: string;
      readonly onDispatch?: () => void | Promise<void>;
      readonly onRollback?: () => void | Promise<void>;
    };

/**
 * A single mcode-native command. Implementations claim a content pattern via
 * {@link matches}, optionally gate on a provider capability via
 * {@link requiredCapability}, and service the message via {@link handle}.
 */
export interface McodeCommand {
  /** Whether this command claims the given message content. */
  matches(content: string): boolean;
  /**
   * Optional capability probe. When present and it returns false for the
   * resolved provider, the router passes the message through untouched so the
   * model still sees the raw text.
   */
  requiredCapability?(provider: IAgentProvider): boolean;
  /** Service a claimed message and describe how the caller should proceed. */
  handle(ctx: CommandContext): CommandOutcome | Promise<CommandOutcome>;
}

/**
 * Owns the mcode-native command namespace. Probes each registered command in
 * registration order; the first to {@link McodeCommand.matches} claims the
 * message. The capability probe lives here so provider differentiation is named
 * in one place rather than branched per command.
 */
export class CommandRouter {
  constructor(private readonly commands: readonly McodeCommand[]) {}

  /** Route a message to the first matching command, or passthrough. */
  async route(ctx: CommandContext): Promise<CommandOutcome> {
    for (const command of this.commands) {
      if (!command.matches(ctx.content)) {
        continue;
      }
      if (command.requiredCapability && !command.requiredCapability(ctx.provider)) {
        return { kind: "passthrough" };
      }
      return command.handle(ctx);
    }
    return { kind: "passthrough" };
  }
}
