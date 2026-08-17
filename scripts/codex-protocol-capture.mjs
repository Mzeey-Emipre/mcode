#!/usr/bin/env bun
/**
 * Multi-scenario Codex app-server protocol capture for Mcode mapper coverage.
 *
 * Writes NDJSON (one JSON object per line). Replay in
 * `packages/providers/src/__tests__/codex/codex-protocol-coverage.test.ts`.
 *
 * Usage:
 *   bun scripts/codex-protocol-capture.mjs <cwd> packages/providers/src/__tests__/codex/fixtures/codex-protocol-golden.ndjson
 *
 * Requires: `codex` on PATH, ChatGPT auth, network.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import readline from "node:readline";

const [, , cwd, outFile] = process.argv;
if (!cwd || !outFile) {
  console.error("usage: codex-protocol-capture.mjs <cwd> <out.ndjson>");
  process.exit(2);
}

mkdirSync(dirname(outFile), { recursive: true });

let codexVersion = "unknown";
try {
  codexVersion = execSync("codex --version", { encoding: "utf8", timeout: 5000 }).trim();
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
  appendFileSync(outFile, JSON.stringify(obj) + "\n");
}

writeFileSync(outFile, "");
log({ type: "meta", codexVersion, cwd, capturedAt: new Date().toISOString() });

const proc = spawn("codex", ["app-server"], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
  windowsHide: true,
});

let nextId = 1;
const pending = new Map();
let seq = 0;
let activeScenario = null;
let activeTurnId = null;
let resolveTurnDone = null;

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
}

const rl = readline.createInterface({ input: proc.stdout });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject, method } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
    else resolve(msg.result);
    return;
  }
  if (!msg.method) return;
  seq++;
  const p = msg.params ?? {};
  const item = p.item ?? {};
  log({
    type: "notification",
    scenario: activeScenario,
    seq,
    method: msg.method,
    threadId: p.threadId,
    turnId: p.turnId,
    itemId: p.itemId ?? item.id,
    itemType: item.type,
    deltaLen: typeof p.delta === "string" ? p.delta.length : undefined,
    turnStatus: p.turn?.status,
    turnItemsLen: Array.isArray(p.turn?.items) ? p.turn.items.length : undefined,
    command: typeof item.command === "string" ? item.command.slice(0, 120) : undefined,
    tool: typeof item.tool === "string" ? item.tool : undefined,
    summaryLen: Array.isArray(item.summary) ? item.summary.length : undefined,
    ...(INCLUDE_RAW ? { raw: msg } : {}),
  });
  if (msg.method === "turn/completed" && p.turnId === activeTurnId && resolveTurnDone) {
    const done = resolveTurnDone;
    resolveTurnDone = null;
    done(p.turn?.status ?? "completed");
  }
});

proc.stderr.on("data", (d) => {
  log({ type: "stderr", scenario: activeScenario, text: d.toString().slice(0, 400) });
});

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
      unlinkSync(join(cwd, SCRATCH_FILE));
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
  try {
    proc.stdin.end();
  } catch {
    /* ignore */
  }
  setTimeout(() => proc.kill(), 2000);
}
