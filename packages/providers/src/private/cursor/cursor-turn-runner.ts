/**
 * Owns one `cursor-agent --print --output-format stream-json` subprocess for
 * the duration of a single prompt turn.
 *
 * The previous transport (`cursor-agent acp`) kept a long-lived subprocess
 * per mcode session and was bitten by Cursor's broken `session/load` resume
 * path: chats persisted on disk could not be reattached after a server
 * restart, so context silently dropped. The `--print --resume <chatId>` mode
 * resolves the chat from disk on every invocation, which means we can spawn
 * fresh per turn and rely on the stable persistent chat id for continuity.
 *
 * The runner is intentionally narrow: assemble args, feed prompt to stdin,
 * pipe stdout through {@link CursorStreamJsonParser} and
 * {@link mapCursorStreamEvent}, resolve on the terminal `result` event,
 * reject on non-zero exit or external abort. Caller persists the captured
 * chat id and reuses it on the next invocation.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { logger } from "@mcode/shared";
import type { AgentEvent } from "@mcode/contracts";
import { CursorStreamJsonParser } from "./cursor-stream-json-parser.js";
import {
  createCursorStreamAccumulator,
  mapCursorStreamEvent,
  resolveCursorAssistantMessageContent,
} from "./cursor-stream-event-mapper.js";
import type { CursorTodoSnapshot } from "./cursor-todo-snapshot.js";
import type { CursorStreamEvent } from "./cursor-stream-json-types.js";

/** Subset of `child_process.spawn` we depend on (overridable for tests). */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Injectable dependencies. Default uses the real {@link nodeSpawn}. */
export interface CursorTurnRunnerDeps {
  spawn: SpawnLike;
}

/** Per-turn invocation parameters. */
export interface CursorTurnRunnerOptions {
  /** Resolved cursor-agent binary path (or just `"agent"` when on PATH). */
  cliPath: string;
  /** Full user prompt (attachments already inlined by caller). */
  prompt: string;
  /** Working directory for tool execution. */
  cwd: string;
  /** Mcode thread id (without `mcode-` prefix) used when emitting events. */
  threadId: string;
  /** Optional model override (passed via `--model`). */
  model?: string;
  /**
   * "full" → `--force --sandbox disabled` (tool approval + workspace trust,
   * sandbox off; runs anywhere on the host). "default" → `--trust` plus
   * `--sandbox enabled` on macOS/Linux (OS-level sandbox blocks writes
   * outside workspace and dangerous shell) or `--sandbox disabled` on
   * Windows (cursor-agent's built-in allowlist mode — the OS sandbox is
   * unsupported on Windows). `--print` has no interactive permission flow,
   * so sandboxing is the only gate in supervised mode.
   */
  permissionMode: "default" | "full";
  /** Persistent chat id to resume; pass null on the first turn of a thread. */
  chatId: string | null;
  /** When set, passed to `spawn` as `env` (defaults to a string snapshot of `process.env`). */
  env?: Record<string, string>;
}

/** Successful turn outcome. The caller persists `chatId` for the next turn. */
export interface CursorTurnResult {
  /** Captured persistent chat id from system/init (may differ from input). */
  chatId: string | null;
  /** Concatenated assistant text accumulated this turn. */
  assistantText: string;
  /** Text used for persisted assistant messages (post-tool deltas when tagged final, otherwise full transcript). */
  assistantMessageContent: string;
  /** Subtype of the terminal `result` event (`success`, `error`, …). */
  resultSubtype: string;
}

/**
 * Builds the cursor-agent CLI arg list for a single `--print` invocation.
 *
 * Order is deterministic so unit tests can assert positional flag/value
 * pairs without re-implementing the argv parser.
 */
export function buildCursorTurnArgs(opts: {
  model?: string;
  permissionMode: "default" | "full";
  chatId: string | null;
  /**
   * Host platform — controls the sandbox flag in supervised mode.
   * Defaults to `process.platform`; tests pass it explicitly so the matrix
   * (linux/darwin/win32) is exhaustively covered without monkey-patching
   * the global.
   */
  platform?: NodeJS.Platform;
}): string[] {
  const platform = opts.platform ?? process.platform;
  const args: string[] = [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
  ];
  // --force grants tool approval AND workspace trust; --trust grants only
  // workspace trust. Without --trust, default-mode `cursor-agent --print`
  // rejects every prompt with "Workspace Trust Required" until trust is
  // granted out of band. We pick exactly one so the flags don't shadow each
  // other.
  //
  // --print has no interactive permission flow ("Has access to all tools"),
  // so supervised mode delegates safety to cursor-agent's sandbox. On
  // macOS/Linux that's an OS-level sandbox; on Windows the OS sandbox is
  // unavailable and cursor-agent errors with "Sandbox requires macOS or
  // Linux", so we fall back to `--sandbox disabled` which switches
  // cursor-agent into its built-in allowlist mode (off-allowlist commands
  // are auto-rejected at the agent layer). Full-access mode always disables
  // the sandbox so --force genuinely means "run anything". All flags are
  // passed explicitly so user config can't override the intended semantics.
  if (opts.permissionMode === "full") {
    args.push("--force");
    args.push("--sandbox", "disabled");
  } else {
    args.push("--trust");
    const supervisedSandboxAvailable = platform === "darwin" || platform === "linux";
    args.push("--sandbox", supervisedSandboxAvailable ? "enabled" : "disabled");
  }
  if (opts.model && opts.model.length > 0) {
    args.push("--model", opts.model);
  }
  if (opts.chatId) {
    args.push("--resume", opts.chatId);
  }
  return args;
}

/**
 * Runs one cursor-agent turn end to end.
 *
 * Resolves with the captured chat id and assistant text once the terminal
 * `result` event is observed (regardless of the result's `subtype`, which is
 * surfaced on {@link CursorTurnResult.resultSubtype} so the caller can
 * differentiate success/error). Rejects when:
 *   - the spawn itself fails ({@link ChildProcess} `error` event)
 *   - the child exits non-zero before any `result` event
 *   - the abort signal fires (we send SIGTERM and reject with an abort error)
 *
 * The prompt is delivered via stdin (closed immediately after) to avoid
 * shell-escaping arbitrary user content into argv.
 */
export async function runCursorTurn(
  options: CursorTurnRunnerOptions,
  onEvent: (event: AgentEvent) => void,
  todoSnapshot: CursorTodoSnapshot,
  abortSignal?: AbortSignal,
  deps: CursorTurnRunnerDeps = { spawn: nodeSpawn },
): Promise<CursorTurnResult> {
  const args = buildCursorTurnArgs({
    model: options.model,
    permissionMode: options.permissionMode,
    chatId: options.chatId,
  });

  const child = deps.spawn(options.cliPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    cwd: options.cwd,
    env: options.env ?? processEnvironmentSnapshot(),
  });

  return new Promise<CursorTurnResult>((resolve, reject) => {
    const acc = createCursorStreamAccumulator();
    const parser = new CursorStreamJsonParser();
    let resultSubtype: string | null = null;
    let stderrBuffer = "";
    let aborted = false;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const processEvents = (events: CursorStreamEvent[]): void => {
      for (const event of events) {
        if (
          event.type === "result" &&
          typeof (event as { subtype?: unknown }).subtype === "string"
        ) {
          resultSubtype = (event as { subtype: string }).subtype;
        }
        const mapped = mapCursorStreamEvent(event, options.threadId, acc, todoSnapshot);
        for (const m of mapped) onEvent(m);
      }
    };

    child.once("error", (err) => {
      settle(() =>
        reject(new Error(`Failed to spawn cursor-agent: ${(err as Error).message}`)),
      );
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      processEvents(parser.feed(text));
    });

    child.stdout?.on("end", () => {
      processEvents(parser.flush());
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrBuffer += text;
      // Bound the buffer so a chatty stderr can't OOM us.
      if (stderrBuffer.length > 8192) stderrBuffer = stderrBuffer.slice(-8192);
    });

    child.once("exit", (code, signal) => {
      if (aborted) {
        settle(() => reject(new Error("Cursor turn aborted")));
        return;
      }
      if (resultSubtype != null) {
        settle(() =>
          resolve({
            chatId: acc.chatId,
            assistantText: acc.assistantText,
            assistantMessageContent: resolveCursorAssistantMessageContent(acc),
            resultSubtype: resultSubtype as string,
          }),
        );
        return;
      }
      const codeStr = code != null ? `exit code ${code}` : `signal ${signal}`;
      const stderrTrim = stderrBuffer.trim();
      const message = stderrTrim
        ? `cursor-agent ${codeStr}: ${stderrTrim}`
        : `cursor-agent ${codeStr}`;
      settle(() => reject(new Error(message)));
    });

    if (abortSignal) {
      const onAbort = (): void => {
        aborted = true;
        try {
          child.kill("SIGTERM");
        } catch (e) {
          logger.warn("Cursor runner kill failed", { error: String(e) });
        }
      };
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    // Deliver the prompt via stdin then close the stream so cursor-agent
    // proceeds. Avoid the argv positional form so arbitrary user content
    // does not collide with shell escaping on win32 (`shell: true`).
    const stdin = child.stdin;
    if (stdin) {
      stdin.write(options.prompt);
      stdin.end();
    }
  });
}

function processEnvironmentSnapshot(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
