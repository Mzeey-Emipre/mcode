#!/usr/bin/env bun
// Minimal NDJSON JSON-RPC 2.0 client for `codex app-server`.
// Usage: bun scripts/codex-trace.mjs <cwd> <traceOut> [prompt]
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const [, , cwd, traceFile, scenarioLabel, prompt] = process.argv;
if (!cwd || !traceFile || !scenarioLabel || !prompt) {
  console.error("usage: codex-trace.mjs <cwd> <traceFile> <scenarioLabel> <prompt>");
  process.exit(2);
}

const proc = spawn("codex", ["app-server"], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
  windowsHide: true,
});

let nextId = 1;
const pending = new Map();
let seq = 0;
function logLine(obj) {
  appendFileSync(traceFile, JSON.stringify(obj) + "\n");
}
logLine({ event: "start", scenario: scenarioLabel, t: new Date().toISOString() });

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    proc.stdin.write(JSON.stringify(msg) + "\n");
  });
}

const rl = readline.createInterface({ input: proc.stdout });
let resolveDone;
const done = new Promise((r) => { resolveDone = r; });

let activeTurnId = null;
let turnCompleted = false;

function parseLine(line) {
  if (!line.trim()) return null;
  let msg;
  try { msg = JSON.parse(line); } catch { return null; }
  return msg;
}

function settlePendingResponse(msg) {
  if (msg.id == null || !pending.has(msg.id)) return false;
  const { resolve, reject, method } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) {
    reject(new Error(`${method} failed: ${msg.error.message}`));
  } else {
    resolve(msg.result);
  }
  return true;
}

function addDeltaSummary(summary, params) {
  if (typeof params.delta === "string") summary.deltaLen = params.delta.length;
}

function addTurnCompletionSummary(summary, params) {
  summary.status = params.turn?.status;
  summary.itemsLen = Array.isArray(params.turn?.items) ? params.turn.items.length : null;
}

function addItemCompletionSummary(summary, params) {
  const item = params.item ?? {};
  if (typeof item.command === "string") summary.command = item.command.slice(0, 80);
  if (item.role) summary.role = item.role;
  if (typeof item.tool === "string") summary.tool = item.tool;
  if (Array.isArray(item.summary)) summary.summaryLen = item.summary.length;
  if (Array.isArray(item.reasoningContent)) summary.reasoningLen = item.reasoningContent.length;
}

function addErrorSummary(summary, params) {
  summary.errorMsg = params.error?.message;
  summary.willRetry = params.willRetry;
}

function addMethodSummary(summary, msg, params) {
  const methodSummaries = {
    "turn/completed": addTurnCompletionSummary,
    "item/completed": addItemCompletionSummary,
    error: addErrorSummary,
  };
  addDeltaSummary(summary, params);
  methodSummaries[msg.method]?.(summary, params);
}

function logNotification(msg) {
  seq++;
  const params = msg.params ?? {};
  const item = params.item ?? {};
  const summary = {
    seq,
    t: new Date().toISOString(),
    method: msg.method,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId ?? item.id,
    itemType: item.type,
  };
  addMethodSummary(summary, msg, params);
  logLine(summary);
  if (msg.method === "turn/completed" && params.turnId === activeTurnId) {
    turnCompleted = true;
    resolveDone();
  }
}

rl.on("line", (line) => {
  const msg = parseLine(line);
  if (!msg || settlePendingResponse(msg) || !msg.method) return;
  logNotification(msg);
});

proc.stderr.on("data", (d) => {
  logLine({ event: "stderr", text: d.toString().slice(0, 500) });
});
proc.on("exit", (code) => {
  logLine({ event: "exit", code });
  if (!turnCompleted) resolveDone();
});

const timeout = setTimeout(() => {
  logLine({ event: "timeout" });
  resolveDone();
}, 120_000);

try {
  const initRes = await send("initialize", {
    clientInfo: { name: "mcode-trace", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  });
  logLine({ event: "init/result", result: initRes });

  const ts = await send("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  logLine({ event: "thread/start/result", result: ts });
  const threadId = ts.thread?.id ?? ts.threadId;

  const turn = await send("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
  });
  activeTurnId = turn.turnId;
  logLine({ event: "turn/start/result", result: turn });

  await done;
} catch (err) {
  logLine({ event: "error", message: String(err?.message ?? err) });
} finally {
  clearTimeout(timeout);
  try { proc.stdin.end(); } catch {}
  setTimeout(() => proc.kill(), 1500);
}
