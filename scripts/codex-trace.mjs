#!/usr/bin/env bun
// Minimal NDJSON JSON-RPC 2.0 client for `codex app-server`.
// Usage: bun scripts/codex-trace.mjs <cwd> <traceOut> [prompt]
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
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

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject, method } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${method} failed: ${msg.error.message}`));
    else resolve(msg.result);
    return;
  }
  if (msg.method) {
    seq++;
    const p = msg.params ?? {};
    const item = p.item ?? {};
    const summary = {
      seq,
      t: new Date().toISOString(),
      method: msg.method,
      threadId: p.threadId,
      turnId: p.turnId,
      itemId: p.itemId ?? item.id,
      itemType: item.type,
    };
    // include small fields when present
    if (typeof p.delta === "string") summary.deltaLen = p.delta.length;
    if (msg.method === "turn/completed") {
      summary.status = p.turn?.status;
      summary.itemsLen = Array.isArray(p.turn?.items) ? p.turn.items.length : null;
    }
    if (msg.method === "item/completed") {
      const it = p.item ?? {};
      if (typeof it.command === "string") summary.command = it.command.slice(0, 80);
      if (it.role) summary.role = it.role;
      if (typeof it.tool === "string") summary.tool = it.tool;
      if (Array.isArray(it.summary)) summary.summaryLen = it.summary.length;
      if (Array.isArray(it.reasoningContent)) summary.reasoningLen = it.reasoningContent.length;
    }
    if (msg.method === "error") {
      summary.errorMsg = p.error?.message;
      summary.willRetry = p.willRetry;
    }
    logLine(summary);
    if (msg.method === "turn/completed" && p.turnId === activeTurnId) {
      turnCompleted = true;
      resolveDone();
    }
  }
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
