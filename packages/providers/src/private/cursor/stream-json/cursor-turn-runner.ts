/** @internal Runs one Cursor CLI stream-JSON turn. */

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
import type { CursorTodoSnapshot } from "../events/cursor-todo-snapshot.js";
import type { CursorStreamEvent } from "./cursor-stream-json-types.js";

/** Represents the process-spawn operation used by the runner. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Supplies process dependencies for the runner. */
export interface CursorTurnRunnerDeps {
  spawn: SpawnLike;
}

/** Describes one Cursor CLI turn. */
export interface CursorTurnRunnerOptions {
  cliPath: string;
  prompt: string;
  cwd: string;
  threadId: string;
  model?: string;
  permissionMode: "default" | "full";
  chatId: string | null;
  env?: Record<string, string>;
}

/** Describes the result of one completed Cursor CLI turn. */
export interface CursorTurnResult {
  chatId: string | null;
  assistantText: string;
  assistantMessageContent: string;
  resultSubtype: string;
}

/** Builds CLI arguments for one stream-print turn. */
export function buildCursorTurnArgs(opts: {
  model?: string;
  permissionMode: "default" | "full";
  chatId: string | null;
  platform?: NodeJS.Platform;
}): string[] {
  const platform = opts.platform ?? process.platform;
  const args: string[] = [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
  ];
  // Stream-print mode cannot request approval. Default mode relies on the
  // Cursor sandbox, while Windows uses Cursor's allowlist because its OS
  // sandbox is unsupported. Explicit flags prevent user config from changing policy.
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

/** Runs one Cursor CLI turn and maps its stream events. */
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

    // Use stdin so prompt text does not cross shell parsing on Windows.
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
