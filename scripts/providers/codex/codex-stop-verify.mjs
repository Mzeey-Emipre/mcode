#!/usr/bin/env bun
/**
 * Live verification: start a long codex turn, stop mid-flight,
 * confirm thread.status push -> in-flight tool rows get cancelled.
 * Mirrors the client-side ws-events.ts thread.status handler.
 */
import { connectMcodeWebSocket } from "./mcode-websocket-client.mjs";

// Simulated client store: { id -> {isComplete, isError, output, toolName} }
const toolCalls = new Map();
let statusEvents = [];

function recordToolUse(event) {
  toolCalls.set(event.toolCallId, {
    id: event.toolCallId, toolName: event.toolName, isComplete: false, isError: false,
    parentToolCallId: event.parentToolCallId ?? null, output: null,
  });
}

function recordToolResult(event) {
  const toolCall = toolCalls.get(event.toolCallId);
  if (!toolCall) return;
  toolCall.isComplete = true;
  toolCall.isError = Boolean(event.isError);
  toolCall.output = event.output ?? null;
}

function recordAgentEvent(event) {
  const recorders = { toolUse: recordToolUse, toolResult: recordToolResult };
  recorders[event.type]?.(event);
}

function cancelIncompleteToolCalls() {
  for (const toolCall of toolCalls.values()) {
    if (toolCall.isComplete) continue;
    toolCall.isComplete = true;
    toolCall.isError = true;
    toolCall.output = toolCall.output ?? "Cancelled";
  }
}

function recordThreadStatus(status) {
  statusEvents.push(status);
  if (["paused", "interrupted", "errored"].includes(status)) {
    cancelIncompleteToolCalls();
  }
}

function recordPushMessage(msg) {
  if (msg.channel === "agent.event") {
    recordAgentEvent(msg.data);
  } else if (msg.channel === "thread.status") {
    recordThreadStatus(msg.data.status);
  }
}

const { rpc, close } = await connectMcodeWebSocket({ onPush: recordPushMessage });

// Use existing codex-trace workspace.
const ws_list = await rpc("workspace.list", {});
const ws_id = ws_list.find((x) => x.name === "codex-trace")?.id;
if (!ws_id) { console.error("no codex-trace workspace"); process.exit(2); }

// Long prompt: lots of preamble + multiple shell commands so we can stop mid-stream.
const send = await rpc("agent.createAndSend", {
  workspaceId: ws_id,
  content:
    "Write a long, multi-sentence explanation of what you are about to do. Then run shell commands: dir, dir, dir, dir, dir. Then describe each output.",
  model: "gpt-5.5",
  mode: "direct",
  branch: "main",
  provider: "codex",
  permissionMode: "full",
});
const threadId = send?.id ?? send?.thread?.id;
console.log(`[ok] turn started thread=${threadId}`);

// Wait until at least one tool has fired AND there's at least one in-flight
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  const inFlight = [...toolCalls.values()].filter((tc) => !tc.isComplete);
  if (inFlight.length > 0) break;
  await new Promise((r) => setTimeout(r, 200));
}
const inFlightBefore = [...toolCalls.values()].filter((tc) => !tc.isComplete);
console.log(`[step] in-flight at stop: ${inFlightBefore.length}`);
console.log(`        names: ${inFlightBefore.map((t) => t.toolName).join(", ") || "(none yet)"}`);

// STOP
await rpc("agent.stop", { threadId });
console.log(`[step] sent agent.stop`);

// Wait briefly for thread.status push
await new Promise((r) => setTimeout(r, 2000));

const inFlightAfter = [...toolCalls.values()].filter((tc) => !tc.isComplete);
const total = toolCalls.size;
const cancelled = [...toolCalls.values()].filter((tc) => tc.isComplete && tc.output === "Cancelled");
console.log(`\n========== STATUS ==========`);
console.log(`thread.status events received: ${statusEvents.join(" -> ")}`);
console.log(`total tool calls observed: ${total}`);
console.log(`in-flight BEFORE stop: ${inFlightBefore.length}`);
console.log(`in-flight AFTER stop : ${inFlightAfter.length}`);
console.log(`marked Cancelled by handler: ${cancelled.length}`);

const terminalStatuses = new Set(["paused", "interrupted", "errored"]);
const pass =
  statusEvents.some((s) => terminalStatuses.has(s)) &&
  toolCalls.size > 0 &&
  inFlightAfter.length === 0 &&
  inFlightBefore.length > 0 &&
  cancelled.length > 0;

console.log(`\n========== RESULT: ${pass ? "PASS ✓" : "FAIL ✗"} ==========`);
close();
process.exit(pass ? 0 : 1);
