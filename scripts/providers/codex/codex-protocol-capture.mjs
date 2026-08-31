#!/usr/bin/env bun
/**
 * Multi-scenario Codex app-server protocol capture for Mcode mapper coverage.
 *
 * Writes NDJSON (one JSON object per line). Replay in
 * `packages/providers/src/__tests__/codex/codex-protocol-coverage.test.ts`.
 *
 * Usage:
 *   bun scripts/providers/codex/codex-protocol-capture.mjs <cwd> packages/providers/src/__tests__/codex/fixtures/codex-protocol-golden.ndjson
 *
 * Requires: `codex` on PATH, ChatGPT auth, network.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { startCodexAppServer } from "./app-server-client.mjs";

const [, , cwd, outFile] = process.argv;
if (!cwd || !outFile) {
  console.error("usage: codex-protocol-capture.mjs <cwd> <out.ndjson>");
  process.exit(2);
}

NodeFS.mkdirSync(NodePath.dirname(outFile), { recursive: true });

let codexVersion = "unknown";
try {
  codexVersion = NodeChildProcess.execSync("codex --version", { encoding: "utf8", timeout: 5000 }).trim();
} catch {
  /* optional */
}

const INCLUDE_RAW = process.env.MCODE_CAPTURE_RAW === "1";
const SCRATCH_FILE = "codex-capture-scratch.txt";

const SCENARIOS = [
  { id: "A_text_only", prompt: "Reply with exactly: OK" },
  {
    id: "B_shell",
    prompt:
      "Run this shell command in the project directory and report the output: echo hello-from-codex",
  },
  {
    id: "C_file_touch",
    prompt:
      "Create a new file named codex-capture-scratch.txt in the project root with the single line capture-ok, then read it back with a shell command and confirm the content.",
  },
  {
    id: "D_subagents",
    prompt:
      "Run four parallel subagent reviews of this repository: security, performance, code quality, and correctness. Each subagent should run at least one short shell command (for example git status --short) and return a one-line finding. Do not edit files.",
  },
];

function log(obj) {
  NodeFS.appendFileSync(outFile, JSON.stringify(obj) + "\n");
}

NodeFS.writeFileSync(outFile, "");
log({ type: "meta", codexVersion, cwd, capturedAt: new Date().toISOString() });

let seq = 0;
let activeScenario = null;
let activeTurnId = null;
let resolveTurnDone = null;

function buildNotification(msg) {
  const params = msg.params ?? {};
  const item = params.item ?? {};
  return addRawNotification({
    type: "notification",
    scenario: activeScenario,
    seq: ++seq,
    method: msg.method,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId ?? item.id,
    itemType: item.type,
    ...buildNotificationDetails(params, item),
  }, msg);
}

function buildNotificationDetails(params, item) {
  return {
    deltaLen: readStringLength(params.delta),
    turnStatus: params.turn?.status,
    turnItemsLen: readArrayLength(params.turn?.items),
    command: readCommand(item.command),
    tool: readString(item.tool),
    summaryLen: readArrayLength(item.summary),
  };
}

function readStringLength(value) {
  return typeof value === "string" ? value.length : undefined;
}

function readArrayLength(value) {
  return Array.isArray(value) ? value.length : undefined;
}

function readCommand(value) {
  return typeof value === "string" ? value.slice(0, 120) : undefined;
}

function readString(value) {
  return typeof value === "string" ? value : undefined;
}

function addRawNotification(notification, msg) {
  return INCLUDE_RAW ? { ...notification, raw: msg } : notification;
}

function resolveCompletedTurn(msg) {
  const params = msg.params ?? {};
  if (msg.method !== "turn/completed" || params.turnId !== activeTurnId || !resolveTurnDone) {
    return;
  }
  const done = resolveTurnDone;
  resolveTurnDone = null;
  done(params.turn?.status ?? "completed");
}

function handleMessage(msg) {
  if (!msg.method) return;
  log(buildNotification(msg));
  resolveCompletedTurn(msg);
}

const client = startCodexAppServer({
  cwd,
  onNotification: handleMessage,
  onStderr: (data) => {
    log({ type: "stderr", scenario: activeScenario, text: data.toString().slice(0, 400) });
  },
  formatError: (method, error) => `${method}: ${error.message}`,
});
const send = client.request;

async function runScenario(scenario) {
  activeScenario = scenario.id;
  log({ type: "scenario_start", id: scenario.id, promptPreview: scenario.prompt.slice(0, 80) });
  const turn = await send("turn/start", {
    threadId,
    input: [{ type: "text", text: scenario.prompt }],
    effort: scenario.id === "D_subagents" ? "high" : "low",
  });
  activeTurnId = turn.turnId;
  log({ type: "turn_start", scenario: scenario.id, turnId: activeTurnId });

  const status = await Promise.race([
    new Promise((resolve) => {
      resolveTurnDone = resolve;
    }),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 180_000)),
  ]);
  activeTurnId = null;
  log({ type: "scenario_end", id: scenario.id, status });
  if (scenario.id === "C_file_touch") {
    try {
      NodeFS.unlinkSync(NodePath.join(cwd, SCRATCH_FILE));
    } catch {
      /* ignore */
    }
  }
  activeScenario = null;
}

let threadId = null;

try {
  const initRes = await send("initialize", {
    clientInfo: { name: "mcode-protocol-capture", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  });
  log({ type: "initialize", result: initRes });

  const ts = await send("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  threadId = ts.thread?.id ?? ts.threadId;
  log({ type: "thread_start", threadId });

  for (const scenario of SCENARIOS) {
    await runScenario(scenario);
  }
} catch (err) {
  log({ type: "fatal", message: String(err?.message ?? err) });
  process.exitCode = 1;
} finally {
  client.close(2000);
}
