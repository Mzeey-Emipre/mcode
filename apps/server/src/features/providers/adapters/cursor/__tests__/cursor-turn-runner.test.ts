/**
 * Tests for the cursor turn runner.
 *
 * The runner owns a single `cursor-agent --print --output-format stream-json`
 * subprocess for the duration of one prompt turn:
 *   - assembles the right CLI args (resume, model, full-access)
 *   - writes the prompt to stdin and closes it
 *   - parses NDJSON stdout via {@link CursorStreamJsonParser}
 *   - maps each event via {@link mapCursorStreamEvent} and forwards to onEvent
 *   - captures the persistent chat id from system/init
 *   - resolves on the terminal `result` event, rejects on non-zero exit /
 *     abort
 *
 * Spawn-arg coverage is pure (buildCursorTurnArgs), and the orchestration
 * coverage uses a fake child whose stdout/stderr/exit can be driven
 * synchronously from the test.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildCursorTurnArgs,
  runCursorTurn,
  type SpawnLike,
} from "../cursor-turn-runner.js";
import { createCursorTodoSnapshot } from "../cursor-todo-snapshot.js";
import type { AgentEvent } from "@mcode/contracts";
import type { ChildProcess } from "node:child_process";

// ── buildCursorTurnArgs ───────────────────────────────────────────────────

describe("buildCursorTurnArgs", () => {
  it("includes the stream-json baseline flags", () => {
    const args = buildCursorTurnArgs({ permissionMode: "default", chatId: null });
    expect(args).toContain("--print");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--stream-partial-output");
  });

  it("appends --resume <chatId> when chatId is set", () => {
    const args = buildCursorTurnArgs({
      permissionMode: "default",
      chatId: "chat-abc",
    });
    const i = args.indexOf("--resume");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("chat-abc");
  });

  it("omits --resume entirely when chatId is null", () => {
    const args = buildCursorTurnArgs({ permissionMode: "default", chatId: null });
    expect(args).not.toContain("--resume");
  });

  it("appends --model <model> when model is provided", () => {
    const args = buildCursorTurnArgs({
      permissionMode: "default",
      chatId: null,
      model: "sonnet-4",
    });
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("sonnet-4");
  });

  it("omits --model when model is undefined or empty", () => {
    expect(
      buildCursorTurnArgs({ permissionMode: "default", chatId: null }),
    ).not.toContain("--model");
    expect(
      buildCursorTurnArgs({ permissionMode: "default", chatId: null, model: "" }),
    ).not.toContain("--model");
  });

  it("appends --force in full-access mode (no permission prompts)", () => {
    const args = buildCursorTurnArgs({ permissionMode: "full", chatId: null });
    expect(args).toContain("--force");
  });

  it("omits --force in default mode", () => {
    const args = buildCursorTurnArgs({ permissionMode: "default", chatId: null });
    expect(args).not.toContain("--force");
  });

  // --trust grants pure workspace trust without bypassing tool prompts.
  // Without it, supervised-mode `cursor-agent --print` rejects every prompt
  // with "Workspace Trust Required" until trust is granted out-of-band. We
  // pass it in default mode so the supervised flow works on first run.
  it("appends --trust in default mode so workspace trust is granted", () => {
    const args = buildCursorTurnArgs({ permissionMode: "default", chatId: null });
    expect(args).toContain("--trust");
  });

  // In full-access mode, --force already grants both tool approval and
  // workspace trust, so --trust would be redundant.
  it("omits --trust in full-access mode (--force subsumes it)", () => {
    const args = buildCursorTurnArgs({ permissionMode: "full", chatId: null });
    expect(args).not.toContain("--trust");
  });

  // cursor-agent --print has no interactive permission flow, so supervised
  // mode delegates safety to whatever sandbox cursor-agent supports on the
  // host. On macOS/Linux this is OS-level sandboxing (file writes outside
  // workspace blocked). On Windows the OS sandbox is unavailable and
  // `--sandbox enabled` errors with "Sandbox requires macOS or Linux", so we
  // fall back to cursor-agent's built-in allowlist mode (`--sandbox
  // disabled`). The flag is always passed explicitly so user config can't
  // override the intended semantics.
  it("appends --sandbox enabled in default mode on linux", () => {
    const args = buildCursorTurnArgs({
      permissionMode: "default",
      chatId: null,
      platform: "linux",
    });
    const i = args.indexOf("--sandbox");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("enabled");
  });

  it("appends --sandbox enabled in default mode on darwin", () => {
    const args = buildCursorTurnArgs({
      permissionMode: "default",
      chatId: null,
      platform: "darwin",
    });
    const i = args.indexOf("--sandbox");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("enabled");
  });

  // On Windows the OS sandbox is unavailable; cursor-agent's allowlist mode
  // (`--sandbox disabled`) is the next-best gate.
  it("appends --sandbox disabled in default mode on win32 (allowlist mode)", () => {
    const args = buildCursorTurnArgs({
      permissionMode: "default",
      chatId: null,
      platform: "win32",
    });
    const i = args.indexOf("--sandbox");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("disabled");
  });

  // Full-access mode disables the sandbox on every platform so --force
  // genuinely means "run anything". Pass it explicitly so user config can't
  // accidentally turn it back on.
  it.each(["linux", "darwin", "win32"] as const)(
    "appends --sandbox disabled in full-access mode on %s",
    (platform) => {
      const args = buildCursorTurnArgs({
        permissionMode: "full",
        chatId: null,
        platform,
      });
      const i = args.indexOf("--sandbox");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(args[i + 1]).toBe("disabled");
    },
  );
});

// ── runCursorTurn (mocked child) ──────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 12345;
  killed = false;
  kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });
}

interface FakeSpawnHarness {
  spawn: SpawnLike;
  child: FakeChild;
  calls: Array<{ command: string; args: readonly string[] }>;
}

function fakeSpawn(): FakeSpawnHarness {
  const child = new FakeChild();
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args });
    // The "spawn" event is what node would emit asynchronously after fork.
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  };
  return { spawn, child, calls };
}

function ndjson(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("runCursorTurn", () => {
  it("invokes spawn with the configured cliPath and the built args", async () => {
    const harness = fakeSpawn();
    const onEvent = vi.fn();
    const promise = runCursorTurn(
      {
        cliPath: "/opt/cursor-agent",
        prompt: "hi",
        cwd: "/work",
        threadId: "t1",
        model: "sonnet",
        permissionMode: "default",
        chatId: null,
      },
      onEvent,
      createCursorTodoSnapshot(),
      undefined,
      { spawn: harness.spawn },
    );
    // Drive the child to completion so the awaited promise can resolve.
    setImmediate(() => {
      harness.child.stdout.write(
        ndjson({ type: "result", subtype: "success", duration_ms: 1 }),
      );
      harness.child.stdout.end();
      harness.child.emit("exit", 0, null);
    });
    await promise;
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.command).toBe("/opt/cursor-agent");
    expect(harness.calls[0]!.args).toContain("--print");
    expect(harness.calls[0]!.args).toContain("--model");
  });

  it("writes the prompt to stdin and ends it", async () => {
    const harness = fakeSpawn();
    const writes: string[] = [];
    harness.child.stdin.on("data", (b: Buffer) => writes.push(b.toString()));
    const stdinEnded = vi.fn();
    harness.child.stdin.on("end", stdinEnded);

    const promise = runCursorTurn(
      {
        cliPath: "agent",
        prompt: "explain this code",
        cwd: "/work",
        threadId: "t1",
        permissionMode: "default",
        chatId: null,
      },
      vi.fn(),
      createCursorTodoSnapshot(),
      undefined,
      { spawn: harness.spawn },
    );
    setImmediate(() => {
      harness.child.stdout.write(ndjson({ type: "result", subtype: "success" }));
      harness.child.stdout.end();
      harness.child.emit("exit", 0, null);
    });
    await promise;
    expect(writes.join("")).toBe("explain this code");
    expect(stdinEnded).toHaveBeenCalled();
  });

  it("captures chatId from system/init and returns it in the result", async () => {
    const harness = fakeSpawn();
    const events: AgentEvent[] = [];
    const promise = runCursorTurn(
      {
        cliPath: "agent",
        prompt: "x",
        cwd: "/work",
        threadId: "t1",
        permissionMode: "default",
        chatId: null,
      },
      (e) => events.push(e),
      createCursorTodoSnapshot(),
      undefined,
      { spawn: harness.spawn },
    );
    setImmediate(() => {
      harness.child.stdout.write(
        ndjson(
          { type: "system", subtype: "init", session_id: "chat-xyz" },
          { type: "result", subtype: "success" },
        ),
      );
      harness.child.stdout.end();
      harness.child.emit("exit", 0, null);
    });
    const result = await promise;
    expect(result.chatId).toBe("chat-xyz");
    expect(events.find((e) => e.type === "system")).toBeDefined();
  });

  it("forwards mapped events to onEvent (TextDelta from streaming assistant)", async () => {
    const harness = fakeSpawn();
    const events: AgentEvent[] = [];
    const promise = runCursorTurn(
      {
        cliPath: "agent",
        prompt: "x",
        cwd: "/work",
        threadId: "t1",
        permissionMode: "default",
        chatId: null,
      },
      (e) => events.push(e),
      createCursorTodoSnapshot(),
      undefined,
      { spawn: harness.spawn },
    );
    setImmediate(() => {
      harness.child.stdout.write(
        ndjson(
          { type: "system", subtype: "init", session_id: "c" },
          {
            type: "assistant",
            timestamp_ms: 1,
            message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
          },
          {
            type: "assistant",
            timestamp_ms: 2,
            message: { role: "assistant", content: [{ type: "text", text: "lo" }] },
          },
          { type: "result", subtype: "success" },
        ),
      );
      harness.child.stdout.end();
      harness.child.emit("exit", 0, null);
    });
    const result = await promise;
    expect(result.assistantText).toBe("Hello");
    expect(result.assistantMessageContent).toBe("Hello");
    const deltas = events
      .filter((e): e is AgentEvent & { delta: string } => e.type === "textDelta")
      .map((e) => e.delta);
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("resolves with resultSubtype from the terminal result event", async () => {
    const harness = fakeSpawn();
    const promise = runCursorTurn(
      {
        cliPath: "agent",
        prompt: "x",
        cwd: "/w",
        threadId: "t",
        permissionMode: "default",
        chatId: null,
      },
      vi.fn(),
      createCursorTodoSnapshot(),
      undefined,
      { spawn: harness.spawn },
    );
    setImmediate(() => {
      harness.child.stdout.write(
        ndjson({ type: "result", subtype: "success", duration_ms: 1234 }),
      );
      harness.child.stdout.end();
      harness.child.emit("exit", 0, null);
    });
    const result = await promise;
    expect(result.resultSubtype).toBe("success");
  });

  it("rejects on non-zero exit when no result event was seen", async () => {
    const harness = fakeSpawn();
    const promise = runCursorTurn(
      {
        cliPath: "agent",
        prompt: "x",
        cwd: "/w",
        threadId: "t",
        permissionMode: "default",
        chatId: null,
      },
      vi.fn(),
      createCursorTodoSnapshot(),
      undefined,
      { spawn: harness.spawn },
    );
    setImmediate(() => {
      harness.child.stderr.write("auth failed\n");
      harness.child.stdout.end();
      harness.child.stderr.end();
      harness.child.emit("exit", 1, null);
    });
    await expect(promise).rejects.toThrow(/auth failed|exit code 1/i);
  });

  it("kills the child and rejects when the abort signal fires", async () => {
    const harness = fakeSpawn();
    const ac = new AbortController();
    const promise = runCursorTurn(
      {
        cliPath: "agent",
        prompt: "x",
        cwd: "/w",
        threadId: "t",
        permissionMode: "default",
        chatId: null,
      },
      vi.fn(),
      createCursorTodoSnapshot(),
      ac.signal,
      { spawn: harness.spawn },
    );
    setImmediate(() => {
      ac.abort();
      // Simulate the kill landing — child exits with a signal.
      setImmediate(() => {
        harness.child.stdout.end();
        harness.child.emit("exit", null, "SIGTERM");
      });
    });
    await expect(promise).rejects.toThrow(/abort/i);
    expect(harness.child.kill).toHaveBeenCalled();
  });

  it("includes --resume <chatId> in args when chatId is provided", async () => {
    const harness = fakeSpawn();
    const promise = runCursorTurn(
      {
        cliPath: "agent",
        prompt: "x",
        cwd: "/w",
        threadId: "t",
        permissionMode: "full",
        chatId: "chat-prev",
      },
      vi.fn(),
      createCursorTodoSnapshot(),
      undefined,
      { spawn: harness.spawn },
    );
    setImmediate(() => {
      harness.child.stdout.write(ndjson({ type: "result", subtype: "success" }));
      harness.child.stdout.end();
      harness.child.emit("exit", 0, null);
    });
    await promise;
    const args = harness.calls[0]!.args;
    expect(args).toContain("--resume");
    expect(args).toContain("chat-prev");
    expect(args).toContain("--force");
  });
});
