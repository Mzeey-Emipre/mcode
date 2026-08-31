#!/usr/bin/env bun
// Minimal NDJSON JSON-RPC 2.0 client for `codex app-server`.
// Usage: bun scripts/providers/codex/codex-trace.mjs <cwd> <traceOut> [prompt]
import * as NodeFS from "node:fs";
import { startCodexAppServer } from "./app-server-client.mjs";

const [, , cwd, traceFile, scenarioLabel, prompt] = process.argv;
if (!cwd || !traceFile || !scenarioLabel || !prompt) {
  console.error("usage: codex-trace.mjs <cwd> <traceFile> <scenarioLabel> <prompt>");
  process.exit(2);
}

let seq = 0;
function logLine(obj) {
  NodeFS.appendFileSync(traceFile, JSON.stringify(obj) + "\n");
}
let resolveDone;
const done = new Promise((r) => { resolveDone = r; });

let activeTurnId = null;
let turnCompleted = false;

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
  if (!msg.method) return;
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

logLine({ event: "start", scenario: scenarioLabel, t: new Date().toISOString() });
const client = startCodexAppServer({
  cwd,
  onNotification: logNotification,
  onStderr: (data) => {
    logLine({ event: "stderr", text: data.toString().slice(0, 500) });
  },
  onExit: (code) => {
    logLine({ event: "exit", code });
    if (!turnCompleted) resolveDone();
  },
  formatError: (method, error) => `${method} failed: ${error.message}`,
});

const timeout = setTimeout(() => {
  logLine({ event: "timeout" });
  resolveDone();
}, 120_000);

try {
  const initRes = await client.request("initialize", {
    clientInfo: { name: "mcode-trace", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  });
  logLine({ event: "init/result", result: initRes });

  const ts = await client.request("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  logLine({ event: "thread/start/result", result: ts });
  const threadId = ts.thread?.id ?? ts.threadId;

  const turn = await client.request("turn/start", {
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
  client.close(1500);
}
