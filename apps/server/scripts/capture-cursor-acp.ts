#!/usr/bin/env bun
/**
 * Live capture of Cursor `agent acp` `session/update` notifications.
 *
 * Writes JSONL under `<repo>/.mcode-local/cursor-acp-capture/` for comparing raw
 * ACP shapes to mapper output (subagents, read, edit, write, shell, ext methods).
 *
 * Usage (from repo root):
 *   bun apps/server/scripts/capture-cursor-acp.ts
 *   bun apps/server/scripts/capture-cursor-acp.ts --prompt "your message"
 *   bun apps/server/scripts/capture-cursor-acp.ts --suite
 *
 * Requires `agent` or `cursor-agent` on PATH and a logged-in Cursor CLI session.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { buildCursorAcpArgs } from "../../../packages/providers/src/private/cursor/acp/cursor-acp-spawn-args.js";
import { pickFullAccessAllowOption } from "../../../packages/providers/src/private/cursor/acp/cursor-acp-permission-mapper.js";
import {
  createCursorAcpTurnState,
  mapCursorAcpSessionNotification,
  type CursorAcpTurnState,
} from "../../../packages/providers/src/private/cursor/acp/cursor-acp-event-mapper.js";
import { summarizeEmittedAgentEventsForTrace } from "../../../packages/providers/src/private/cursor/acp/cursor-acp-session-trace.js";
import { cursorTaskExtToAgentEvents } from "../../../packages/providers/src/private/cursor/acp/cursor-acp-task.js";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const OUT_DIR = join(REPO_ROOT, ".mcode-local", "cursor-acp-capture");

/**
 * Resolves a request path under {@link REPO_ROOT}, rejecting traversal outside the repo.
 */
function resolveWithinRepo(requestPath: string): string {
  const root = resolve(REPO_ROOT);
  const candidate = resolve(root, requestPath);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || rel.split(/[/\\]/).includes("..")) {
    throw new Error(`Path escapes repo root: ${requestPath}`);
  }
  return candidate;
}
const FIXTURE_DIR = join(OUT_DIR, "fixture-workspace");
const FIXTURE_FILE = join(FIXTURE_DIR, "scratch.txt");

/** Scenarios designed to exercise distinct ACP tool_call shapes. */
const CAPTURE_SUITE: Array<{ id: string; prompt: string }> = [
  {
    id: "subagents_parallel",
    prompt:
      "Scenario subagents_parallel: Run exactly two read-only Task subagents in parallel. " +
      "Subagent A: Glob every file under packages/providers/src/private/cursor/. " +
      "Subagent B: Read packages/providers/src/private/cursor/events/cursor-subagent-detection.ts. " +
      "Do not edit repo files. End with a line listing tool names each subagent used.",
  },
  {
    id: "read_and_search",
    prompt:
      "Scenario read_and_search: Without subagents, read packages/providers/src/private/cursor/acp/cursor-acp-task.ts " +
      "and run one repo search (Grep) for 'cursor/task' under packages/providers/. Do not edit files.",
  },
  {
    id: "write_and_edit",
    prompt:
      `Scenario write_and_edit: Only touch ${FIXTURE_FILE.replace(/\\/g, "/")}. ` +
      "If missing, create it with the single line 'before'. Then edit it to replace 'before' with 'after'. " +
      "Do not touch any other path.",
  },
  {
    id: "shell_echo",
    prompt:
      "Scenario shell_echo: Run one terminal command only: echo mcode-acp-capture-ok (or Windows equivalent). " +
      "Do not edit files and do not use subagents.",
  },
  {
    id: "write_create",
    prompt:
      `Scenario write_create: Create a new file only at ${FIXTURE_DIR.replace(/\\/g, "/")}/capture-new.txt ` +
      "with exactly the line 'created-by-acp-capture'. Do not modify any other file.",
  },
  {
    id: "todos_plan",
    prompt:
      "Scenario todos_plan: Without editing repo files, create a short 3-step plan in your reply " +
      "and use your todo/plan tool if available. Steps: inspect, verify, summarize.",
  },
];

const args = process.argv.slice(2);
const useSuite = args.includes("--suite");
const promptFlag = args.indexOf("--prompt");
const singlePrompt =
  promptFlag >= 0 && args[promptFlag + 1]
    ? args.slice(promptFlag + 1).join(" ").trim()
    : CAPTURE_SUITE[0].prompt;
const cliPath = process.env.MCODE_CURSOR_CLI?.trim() || "agent";

function stamp(): string {
  return new Date().toISOString();
}

function writeLine(file: string, record: Record<string, unknown>): void {
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

function summarizeRawLog(rawPath: string): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    const text = readFileSync(rawPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.kind === "session_update" && typeof row.updateKind === "string") {
        counts[row.updateKind] = (counts[row.updateKind] ?? 0) + 1;
      }
      if (row.kind === "ext_method" && typeof row.method === "string") {
        const key = `ext:${row.method}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  } catch {
    /* empty log */
  }
  return counts;
}

function buildClient(opts: {
  rawPath: string;
  mappedPath: string;
  getTurnState: () => CursorAcpTurnState;
  getSessionId: () => string;
  getScenarioId: () => string;
}): Client {
  const { rawPath, mappedPath, getTurnState, getSessionId, getScenarioId } = opts;

  return {
    sessionUpdate: async (params: SessionNotification) => {
      const updateKind =
        params.update && typeof params.update === "object" && "sessionUpdate" in params.update
          ? String((params.update as { sessionUpdate?: string }).sessionUpdate)
          : "unknown";

      const toolCallSlice =
        updateKind === "tool_call" || updateKind === "tool_call_update"
          ? (params.update as Record<string, unknown>)
          : undefined;

      writeLine(rawPath, {
        t: stamp(),
        scenarioId: getScenarioId(),
        kind: "session_update",
        sessionId: params.sessionId,
        updateKind,
        toolTitle: toolCallSlice?.title,
        toolKind: toolCallSlice?.kind,
        acpToolName:
          toolCallSlice?.rawInput &&
          typeof toolCallSlice.rawInput === "object" &&
          !Array.isArray(toolCallSlice.rawInput)
            ? (toolCallSlice.rawInput as Record<string, unknown>)._toolName
            : undefined,
        payload: params,
      });

      const sessionId = getSessionId();
      if (!sessionId || params.sessionId !== sessionId) return;

      const mapped = mapCursorAcpSessionNotification(
        params,
        "capture-thread",
        getTurnState(),
      );
      if (mapped.length > 0) {
        writeLine(mappedPath, {
          t: stamp(),
          scenarioId: getScenarioId(),
          updateKind,
          mapped: summarizeEmittedAgentEventsForTrace(mapped),
          full: mapped,
        });
      }
    },
    requestPermission: async (req) => {
      const optionId = pickFullAccessAllowOption(req.options);
      writeLine(rawPath, {
        t: stamp(),
        scenarioId: getScenarioId(),
        kind: "request_permission",
        title: req.toolCall.title,
        rawInput: req.toolCall.rawInput,
      });
      if (!optionId) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    },
    readTextFile: async (r) => {
      const path = resolveWithinRepo(r.path);
      return { content: readFileSync(path, "utf8") };
    },
    writeTextFile: async (r) => {
      const path = resolveWithinRepo(r.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, r.content, "utf8");
      return {};
    },
    extMethod: async (method, params) => {
      writeLine(rawPath, {
        t: stamp(),
        scenarioId: getScenarioId(),
        kind: "ext_method",
        method,
        params,
      });
      if (method === "cursor/task" && params && typeof params === "object" && !Array.isArray(params)) {
        const mapped = cursorTaskExtToAgentEvents(
          "capture-thread",
          params as Record<string, unknown>,
          getTurnState(),
        );
        if (mapped.length > 0) {
          writeLine(mappedPath, {
            t: stamp(),
            scenarioId: getScenarioId(),
            updateKind: "cursor/task",
            mapped: summarizeEmittedAgentEventsForTrace(mapped),
            full: mapped,
          });
        }
      }
      return {};
    },
    extNotification: async (method, params) => {
      writeLine(rawPath, {
        t: stamp(),
        scenarioId: getScenarioId(),
        kind: "ext_notification",
        method,
        params,
      });
    },
  };
}

async function runCapture(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  try {
    writeFileSync(FIXTURE_FILE, "before\n", "utf8");
  } catch {
    /* ok */
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = join(OUT_DIR, `${runId}-raw.jsonl`);
  const mappedPath = join(OUT_DIR, `${runId}-mapped.jsonl`);
  const summaryPath = join(OUT_DIR, `${runId}-summary.txt`);
  const scenarios = useSuite ? CAPTURE_SUITE : [{ id: "single", prompt: singlePrompt }];

  writeFileSync(
    summaryPath,
    [
      `capture started ${stamp()}`,
      `cwd: ${REPO_ROOT}`,
      `cli: ${cliPath}`,
      `mode: ${useSuite ? "suite" : "single"}`,
      `scenarios: ${scenarios.map((s) => s.id).join(", ")}`,
      "",
    ].join("\n"),
    "utf8",
  );

  const acpArgs = buildCursorAcpArgs({ permissionMode: "full" });
  const child = spawn(cliPath, acpArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: REPO_ROOT,
    shell: process.platform === "win32",
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("cursor-agent acp: stdio pipes unavailable");
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) writeLine(rawPath, { t: stamp(), kind: "stderr", text });
  });

  const out = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const inp = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(out, inp);

  let turnState = createCursorAcpTurnState();
  let acpSessionId = "";
  let currentScenarioId = "session";

  const connection = new ClientSideConnection(
    () =>
      buildClient({
        rawPath,
        mappedPath,
        getScenarioId: () => currentScenarioId,
        getTurnState: () => turnState,
        getSessionId: () => acpSessionId,
      }),
    stream,
  );

  console.log("[capture-cursor-acp] initializing...");
  await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "mcode-capture", title: "Mcode ACP Capture", version: "0.0.1" },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
  });

  await connection.authenticate({ methodId: "cursor_login" }).catch(() => null);

  console.log("[capture-cursor-acp] newSession...");
  const created = await connection.newSession({ cwd: REPO_ROOT, mcpServers: [] });
  acpSessionId = created.sessionId;
  writeLine(rawPath, { t: stamp(), kind: "session_created", sessionId: acpSessionId });

  for (const scenario of scenarios) {
    currentScenarioId = scenario.id;
    turnState = createCursorAcpTurnState();
    console.log(`[capture-cursor-acp] scenario: ${scenario.id}`);
    writeLine(rawPath, { t: stamp(), kind: "scenario_start", scenarioId: scenario.id, prompt: scenario.prompt });

    const response = await connection.prompt({
      sessionId: acpSessionId,
      prompt: [{ type: "text", text: scenario.prompt }],
    });

    writeLine(rawPath, {
      t: stamp(),
      kind: "scenario_complete",
      scenarioId: scenario.id,
      stopReason: response.stopReason,
      usage: response.usage,
    });
    console.log(`[capture-cursor-acp]   stopReason=${response.stopReason}`);
  }

  const counts = summarizeRawLog(rawPath);
  appendFileSync(
    summaryPath,
    [
      "",
      `finished ${stamp()}`,
      `raw log: ${rawPath}`,
      `mapped log: ${mappedPath}`,
      "",
      "Event counts (session_update kinds + ext methods):",
      JSON.stringify(counts, null, 2),
      "",
      "Inspect raw.jsonl for full envelopes (tool_call rawInput, content diffs, cursor/task).",
    ].join("\n"),
    "utf8",
  );

  console.log("[capture-cursor-acp] done");
  console.log("  raw:", rawPath);
  console.log("  mapped:", mappedPath);
  console.log("  summary:", summaryPath);
  console.log("  counts:", JSON.stringify(counts));

  child.kill();
}

runCapture().catch((err: unknown) => {
  console.error("[capture-cursor-acp] failed:", err);
  process.exit(1);
});
