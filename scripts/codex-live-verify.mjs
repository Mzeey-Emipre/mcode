#!/usr/bin/env bun
/**
 * Live verification of the Codex thought-vs-final fix.
 *
 * 1. Reads dev server auth token from /health.
 * 2. Connects WS, ensures a workspace exists pointing at /tmp/codex-trace.
 * 3. Calls `agent.createAndSend` with provider=codex and a tool-forcing prompt.
 * 4. Subscribes to the `agent.event` push channel and tags each TextDelta
 *    with whether the model has fired a tool yet this turn.
 * 5. Prints a clear pass/fail report and exits non-zero on regression.
 */
import { createRequire } from "node:module";
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(REPO_ROOT, "apps", "web", "package.json"));
const { WebSocket } = require("ws");

const TRACE_CWD = process.env.CODEX_TRACE_CWD ?? join(tmpdir(), "codex-trace");
const LOG = process.env.CODEX_VERIFY_LOG ?? join(tmpdir(), "codex-live-verify.log");
writeFileSync(LOG, "");
const w = (s) => { appendFileSync(LOG, s + "\n"); console.log(s); };

if (!existsSync(TRACE_CWD)) mkdirSync(TRACE_CWD, { recursive: true });

function getHealth() {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.MCODE_PORT || 19400);
    const req = request({ host: "127.0.0.1", port, path: "/health", method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const health = await getHealth();
w(`[health] activeAgents=${health.activeAgents} token=present`);

const PORT = Number(process.env.MCODE_PORT || 19400);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${health.authToken}`);
const pending = new Map();
let nextId = 1;
function rpc(method, params) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

let resolveOpen;
const opened = new Promise((r) => (resolveOpen = r));
ws.on("open", () => { w("[ws] open"); resolveOpen(); });

// Classification tracking: walk events in order, mark each TextDelta with the
// running tool state so we can prove pre-tool deltas have NO isFinalResponse
// and post-tool deltas DO carry isFinalResponse:true.
const events = [];
let pendingToolUses = 0;
let hasFiredToolThisTurn = false;
let toolStartedAt = null;
let toolEndedAt = null;
let resolveTurn;
const turnDone = new Promise((r) => (resolveTurn = r));

function parseMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return null; }
  return msg;
}

function settlePendingRpc(msg) {
  if (typeof msg.id !== "string" || !pending.has(msg.id)) return false;
  const { resolve, reject, method } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) {
    reject(new Error(`${method} failed: ${msg.error.message}`));
  } else {
    resolve(msg.result);
  }
  return true;
}

function recordToolUse(event) {
  pendingToolUses++;
  hasFiredToolThisTurn = true;
  if (toolStartedAt == null) toolStartedAt = events.length;
  events.push({ kind: "toolUse", toolName: event.toolName, idx: events.length });
}

function recordToolResult() {
  pendingToolUses = Math.max(0, pendingToolUses - 1);
  if (pendingToolUses === 0 && toolEndedAt == null) toolEndedAt = events.length;
  events.push({ kind: "toolResult", idx: events.length });
}

function recordTextDelta(event) {
  events.push({
    kind: "textDelta",
    delta: (event.delta ?? "").slice(0, 50),
    isFinalResponse: event.isFinalResponse === true,
    pendingTools: pendingToolUses,
    hasFiredTool: hasFiredToolThisTurn,
    idx: events.length,
  });
}

function recordAgentEvent(event) {
  const recorders = {
    toolUse: () => recordToolUse(event),
    toolResult: recordToolResult,
    textDelta: () => recordTextDelta(event),
    turnComplete: () => {
      events.push({ kind: "turnComplete", idx: events.length });
      resolveTurn();
    },
    error: () => w(`[event:error] ${JSON.stringify(event).slice(0, 200)}`),
  };
  recorders[event.type]?.();
}

ws.on("message", (raw) => {
  const msg = parseMessage(raw);
  if (!msg || settlePendingRpc(msg)) return;
  if (msg.type === "push" && msg.channel === "agent.event") {
    recordAgentEvent(msg.data);
  }
});

await opened;

// Workspace setup
const workspaces = await rpc("workspace.list", {});
w(`[ws-rpc] workspaces=${workspaces.length}`);
// Match by name to avoid path slash normalization issues across OS layers.
let ws_id = workspaces.find((x) => x.name === "codex-trace")?.id;
if (!ws_id) {
  const created = await rpc("workspace.create", { name: "codex-trace", path: TRACE_CWD });
  ws_id = created.id;
  w(`[ws-rpc] created workspace ${ws_id}`);
} else {
  w(`[ws-rpc] reusing workspace ${ws_id}`);
}

// Create thread and send a tool-forcing prompt
const sendRes = await rpc("agent.createAndSend", {
  workspaceId: ws_id,
  content: "First, write one short sentence stating your plan. Then run the shell command: echo hello. Then write one short sentence summarizing the output.",
  model: "gpt-5.5",
  // mode/branch are required by CreateThreadSchema embedded inside CreateAndSendSchema
  mode: "direct",
  branch: "main",
  provider: "codex",
  permissionMode: "full",
});
w(`[ws-rpc] createAndSend -> threadId=${sendRes?.thread?.id ?? "?"}`);

// Wait up to 120s for turnComplete
const t = setTimeout(() => { w("[timeout]"); resolveTurn(); }, 120_000);
await turnDone;
clearTimeout(t);

w(`\n========== EVENT TIMELINE (${events.length} events) ==========`);
for (const e of events) {
  if (e.kind === "textDelta") {
    const tag = e.isFinalResponse ? "FINAL ✓" : "thought";
    w(`  #${e.idx}  textDelta  [${tag}]  pendingTools=${e.pendingTools} hasFired=${e.hasFiredTool}  "${e.delta}"`);
  } else if (e.kind === "toolUse") {
    w(`  #${e.idx}  toolUse    [${e.toolName}]`);
  } else if (e.kind === "toolResult") {
    w(`  #${e.idx}  toolResult`);
  } else if (e.kind === "turnComplete") {
    w(`  #${e.idx}  turnComplete`);
  }
}

const deltas = events.filter((e) => e.kind === "textDelta");
const preToolDeltas = deltas.filter((e) => !e.hasFiredTool);
const midToolDeltas = deltas.filter((e) => e.hasFiredTool && e.pendingTools > 0);
const postToolDeltas = deltas.filter((e) => e.hasFiredTool && e.pendingTools === 0);

w(`\n========== CLASSIFICATION ==========`);
w(`  pre-tool deltas: ${preToolDeltas.length}  (should ALL be thoughts)`);
w(`    with isFinalResponse=true: ${preToolDeltas.filter((d) => d.isFinalResponse).length}  ${preToolDeltas.filter((d) => d.isFinalResponse).length === 0 ? "✓" : "✗ REGRESSION"}`);
w(`  mid-tool deltas: ${midToolDeltas.length}  (should ALL be thoughts)`);
w(`    with isFinalResponse=true: ${midToolDeltas.filter((d) => d.isFinalResponse).length}  ${midToolDeltas.filter((d) => d.isFinalResponse).length === 0 ? "✓" : "✗ REGRESSION"}`);
w(`  post-tool deltas: ${postToolDeltas.length}  (should ALL be final)`);
w(`    with isFinalResponse=true: ${postToolDeltas.filter((d) => d.isFinalResponse).length}  ${postToolDeltas.length > 0 && postToolDeltas.every((d) => d.isFinalResponse) ? "✓" : "✗ REGRESSION"}`);

const pass =
  preToolDeltas.every((d) => !d.isFinalResponse) &&
  midToolDeltas.every((d) => !d.isFinalResponse) &&
  postToolDeltas.length > 0 &&
  postToolDeltas.every((d) => d.isFinalResponse) &&
  hasFiredToolThisTurn;

w(`\n========== RESULT: ${pass ? "PASS ✓" : "FAIL ✗"} ==========`);
ws.close();
process.exit(pass ? 0 : 1);
