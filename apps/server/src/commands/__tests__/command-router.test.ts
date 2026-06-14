import { describe, it, expect, vi } from "vitest";
import type { IAgentProvider } from "@mcode/contracts";
import { EventEmitter } from "events";
import { CommandRouter } from "../command-router.js";
import type { CommandContext, CommandOutcome, McodeCommand } from "../command-router.js";

/** A bare provider stub; capability is decided by each command's probe. */
function fakeProvider(id = "claude"): IAgentProvider {
  return Object.assign(new EventEmitter(), { id }) as unknown as IAgentProvider;
}

/** Build a routing context for the given content and provider. */
function ctx(content: string, provider: IAgentProvider = fakeProvider()): CommandContext {
  return { threadId: "thread-1", content, provider };
}

/**
 * A configurable fake command. `pattern` drives `matches`; `capability`
 * (when supplied) drives `requiredCapability`; `outcome` is what `handle`
 * returns. `handle` is a spy so tests can assert it did or did not run.
 */
function fakeCommand(opts: {
  pattern: RegExp;
  outcome: CommandOutcome;
  capability?: (provider: IAgentProvider) => boolean;
}): McodeCommand & { handle: ReturnType<typeof vi.fn> } {
  const handle = vi.fn<(c: CommandContext) => CommandOutcome>(() => opts.outcome);
  return {
    matches: (content: string) => opts.pattern.test(content),
    requiredCapability: opts.capability,
    handle,
  };
}

describe("CommandRouter", () => {
  it("returns passthrough when no registered command matches", async () => {
    const cmd = fakeCommand({ pattern: /^\/goal\b/, outcome: { kind: "handled" } });
    const router = new CommandRouter([cmd]);

    const outcome = await router.route(ctx("just a normal message"));

    expect(outcome.kind).toBe("passthrough");
    expect(cmd.handle).not.toHaveBeenCalled();
  });

  it("dispatches to a matching command and surfaces its handled outcome", async () => {
    const cmd = fakeCommand({ pattern: /^\/goal\b/, outcome: { kind: "handled" } });
    const router = new CommandRouter([cmd]);

    const routed = ctx("/goal clear");
    const outcome = await router.route(routed);

    expect(outcome.kind).toBe("handled");
    expect(cmd.handle).toHaveBeenCalledWith(routed);
  });

  it("surfaces a command's rewrite outcome with the rewritten content", async () => {
    const cmd = fakeCommand({
      pattern: /^\/goal\b/,
      outcome: { kind: "rewrite", content: "rewritten directive" },
    });
    const router = new CommandRouter([cmd]);

    const outcome = await router.route(ctx("/goal ship it"));

    expect(outcome.kind).toBe("rewrite");
    if (outcome.kind !== "rewrite") throw new Error("expected rewrite");
    expect(outcome.content).toBe("rewritten directive");
  });

  it("returns passthrough without handling when the provider lacks the required capability", async () => {
    const cmd = fakeCommand({
      pattern: /^\/goal\b/,
      outcome: { kind: "handled" },
      capability: () => false,
    });
    const router = new CommandRouter([cmd]);

    const outcome = await router.route(ctx("/goal ship it"));

    expect(outcome.kind).toBe("passthrough");
    expect(cmd.handle).not.toHaveBeenCalled();
  });

  it("handles the command when the provider satisfies the required capability", async () => {
    const capability = vi.fn(() => true);
    const cmd = fakeCommand({
      pattern: /^\/goal\b/,
      outcome: { kind: "handled" },
      capability,
    });
    const router = new CommandRouter([cmd]);

    const provider = fakeProvider();
    const outcome = await router.route(ctx("/goal ship it", provider));

    expect(outcome.kind).toBe("handled");
    expect(capability).toHaveBeenCalledWith(provider);
    expect(cmd.handle).toHaveBeenCalled();
  });

  it("dispatches to the first matching command in registration order", async () => {
    const first = fakeCommand({ pattern: /^\/goal\b/, outcome: { kind: "handled" } });
    const second = fakeCommand({ pattern: /^\/goal\b/, outcome: { kind: "rewrite", content: "x" } });
    const router = new CommandRouter([first, second]);

    const outcome = await router.route(ctx("/goal show"));

    expect(outcome.kind).toBe("handled");
    expect(first.handle).toHaveBeenCalled();
    expect(second.handle).not.toHaveBeenCalled();
  });
});
