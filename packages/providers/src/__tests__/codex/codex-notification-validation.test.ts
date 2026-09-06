import { describe, expect, it } from "vitest";
import { ProviderRuntimeEventSchema } from "@mcode/contracts";
import { CodexEventMapper } from "../../private/codex/codex-event-mapper.js";
import { parseCodexNotification } from "../../private/codex/codex-notification-validation.js";

const createMapper = () => new CodexEventMapper("thread-1", "native-main");
const reroute = { threadId: "native-main", turnId: "turn-1", fromModel: "requested", toModel: "safe", reason: "highRiskCyberActivity" };

describe("Codex notification boundary", () => {
  it("classifies unknown envelopes explicitly and rejects a conflicting JSON-RPC version", () => {
    expect(parseCodexNotification({ method: "future/notice", params: {} })).toEqual({ jsonrpc: "2.0", method: "future/notice", params: {}, unrecognized: true });
    expect(parseCodexNotification({ jsonrpc: "1.0", method: "warning", params: { message: "not a v2 notification" } })).toBeUndefined();
  });

  it("bounds the aggregate workspace-path sample while accepting extended Windows path lengths", () => {
    const mapper = createMapper();
    const params = { samplePaths: ["P".repeat(32_767)], extraCount: 0, failedScan: false };
    expect(mapper.mapNotificationWithDisposition({ method: "windows/worldWritableWarning", params }).events).toMatchObject([{ event: { type: "system", systemNotice: { kind: "security" } } }]);
    const oversized = mapper.mapNotificationWithDisposition({ method: "windows/worldWritableWarning", params: { ...params, samplePaths: Array.from({ length: 1_024 }, () => "P".repeat(1_025)) } });
    expect(oversized.disposition).toEqual({ kind: "diagnostic", reason: "malformed-notification" });
    expect(oversized.events).toMatchObject([{ event: { message: "Codex sent a malformed notification." } }]);
  });

  it("accepts upstream reasoning, command, MCP, goal, and terminal lifecycle payloads", () => {
    const mapper = createMapper();
    const route = { threadId: "native-main", turnId: "turn-1" };
    const command = { id: "cmd-1", type: "commandExecution", command: "echo verified", cwd: "C:/workspace", processId: null, status: "completed", commandActions: [], aggregatedOutput: "verified\n", exitCode: 0, durationMs: 2 };
    const goal = { threadId: "native-main", objective: "Verify notices", status: "active", tokenBudget: null, tokensUsed: 12, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2 };
    const inputs = [
      { method: "turn/started", params: { ...route, turn: { id: "turn-1", items: [], status: "inProgress", error: null } } },
      { method: "item/completed", params: { ...route, item: { id: "reason-1", type: "reasoning", summary: ["Check output"], content: ["Read the result"] } } },
      { method: "item/started", params: { ...route, item: { ...command, status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null } } },
      { method: "item/completed", params: { ...route, item: command } },
      { method: "item/completed", params: { ...route, item: { id: "mcp-1", type: "mcpToolCall", server: "fixture", tool: "read", status: "completed", arguments: { key: "fixture" }, result: { content: [{ type: "text", text: "read verified" }] }, error: null, durationMs: 1 } } },
      { method: "thread/goal/updated", params: { ...route, goal } },
      { method: "item/completed", params: { ...route, item: { id: "answer-1", type: "agentMessage", text: "Verified", phase: "final_answer", memoryCitation: null } } },
      { method: "turn/completed", params: { ...route, turn: { id: "turn-1", items: [], status: "completed", error: null } } },
    ];
    const results = inputs.map((input) => mapper.mapNotificationWithDisposition(input));
    expect(results.map((result) => result.disposition.kind)).toEqual(["state-only", "mapped", "mapped", "mapped", "mapped", "mapped", "mapped", "mapped"]);
    const events = results.flatMap((result) => result.events.map(({ event }) => event));
    expect(events.filter((event) => event.type === "textDelta")).toMatchObject([{ delta: "Check output\nRead the result", isFinalResponse: false }, { delta: "Verified", isFinalResponse: false }]);
    expect(events.filter((event) => event.type === "toolResult")).toMatchObject([{ toolCallId: "cmd-1", output: "verified\n", isError: false }, { toolCallId: "mcp-1", isError: false }]);
    expect(events.filter((event) => event.type === "goalUpdated")).toMatchObject([{ goal: { objective: "Verify notices", status: "active", tokensUsed: 12 } }]);
    expect(events.slice(-2)).toMatchObject([{ type: "message", content: "Verified" }, { type: "turnComplete", reason: "end_turn" }]);
  });

  it.each([
    null, [], 4,
    { method: 4, params: {} },
    { method: "configWarning", params: null },
    { method: "warning", params: { message: 5 } },
    { method: "guardianWarning", params: { message: "private-payload" } },
    { method: "model/rerouted", params: { threadId: "native-main", reason: "highRiskCyberActivity" } },
    { method: "model/rerouted", params: { ...reroute, reason: "unavailable" } },
    { method: "configWarning", params: { summary: "private-payload", details: 6 } },
    { method: "configWarning", params: { summary: "private-payload", range: { start: { line: 1, character: 2 }, end: { line: 2, character: 3 } } } },
    { method: "deprecationNotice", params: { summary: "private-payload", details: {} } },
    { method: "windows/worldWritableWarning", params: { samplePaths: ["private-payload"], extraCount: -1, failedScan: false } },
    { method: "windows/worldWritableWarning", params: { samplePaths: ["private-payload"], extraCount: 0 } },
    { method: "windows/worldWritableWarning", params: { samplePaths: [3], extraCount: 0, failedScan: false } },
    { method: "modelProvider/authRecoveryCompleted", params: { provider: "openai", message: "private-payload" } },
    { method: "item/completed", params: { item: { id: "item-1", type: "agentMessage", text: { private: true } } } },
    { method: "turn/completed", params: {} },
    { method: "turn/completed", params: { turn: { status: "completed", usage: { output_tokens: "private-payload" } } } },
  ])("contains malformed native input without a success or raw payload", (input) => {
    const mapper = createMapper();
    const result = mapper.mapNotificationWithDisposition(input);
    expect(result.disposition).toEqual({ kind: "diagnostic", reason: "malformed-notification" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].event).toMatchObject({ type: "system", message: "Codex sent a malformed notification.", systemNotice: { kind: "diagnostic" } });
    expect(JSON.stringify(result.events)).not.toContain("private-payload");
    expect(mapper.mapNotification({ method: "turn/completed", params: { turn: { status: "completed" } } }).map(({ event }) => event.type)).toEqual(["turnComplete"]);
  });

  it("retains the upstream one-based configuration location separately from bounded text", () => {
    const result = createMapper().mapNotification({ method: "configWarning", params: {
      summary: "S".repeat(2_000), details: "D".repeat(2_000), path: "C:/config.toml",
      range: { start: { line: 2, column: 4 }, end: { line: 2, column: 9 } },
      rawSecret: "private-payload",
    } });
    expect(result).toHaveLength(1);
    expect(ProviderRuntimeEventSchema().safeParse(result[0]).success).toBe(true);
    expect(result[0].event).toMatchObject({ type: "system", message: `${"S".repeat(700)} ${"D".repeat(299)}`, systemNotice: {
      kind: "configuration", scope: "session", configPath: "C:/config.toml", configRange: { startLine: 2, startColumn: 4, endLine: 2, endColumn: 9 },
    } });
    expect(JSON.stringify(result)).not.toContain("private-payload");
  });

  it("retains one reroute identity with bounded from, to, and canonical reason", () => {
    const mapper = createMapper();
    const [first] = mapper.mapNotification({ method: "model/rerouted", params: reroute });
    const [repeated] = mapper.mapNotification({ method: "model/rerouted", params: reroute });
    const [changed] = mapper.mapNotification({ method: "model/rerouted", params: { ...reroute, toModel: "S".repeat(300) } });
    expect(repeated).toEqual(first);
    expect(changed.event).toMatchObject({ type: "system", systemNotice: { kind: "model-rerouted", fromModel: "requested", toModel: "S".repeat(128), reason: "safety", presentation: "toast" } });
    expect(changed.event.type === "system" ? changed.event.systemNotice?.noticeKey : null).toBe(first.event.type === "system" ? first.event.systemNotice?.noticeKey : null);
  });

  it.each(["future/notice", "item/future/notice", "thread/future/notice", "windows/future/notice"])("keeps unknown %s diagnostic after turn completion", (method) => {
    const mapper = createMapper();
    mapper.mapNotification({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const result = mapper.mapNotificationWithDisposition({ method, params: { rawSecret: "private-payload" } });
    expect(result.disposition).toEqual({ kind: "diagnostic", reason: "unknown-notification" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].event).toMatchObject({ type: "system", systemNotice: { kind: "diagnostic" } });
    expect(JSON.stringify(result.events)).not.toContain("private-payload");
  });

  it("reports state-only buffering and emits the buffered command output on completion", () => {
    const mapper = createMapper();
    expect(mapper.mapNotificationWithDisposition({ method: "turn/started", params: {} })).toEqual({ events: [], disposition: { kind: "state-only", reason: "native-state" } });
    expect(mapper.mapNotificationWithDisposition({ method: "item/commandExecution/outputDelta", params: { itemId: "command-1", delta: "observed output" } })).toEqual({ events: [], disposition: { kind: "state-only", reason: "native-state" } });
    const completed = mapper.mapNotificationWithDisposition({ method: "item/completed", params: { item: { id: "command-1", type: "commandExecution", command: "echo output", exitCode: 0 } } });
    expect(completed.disposition).toEqual({ kind: "mapped" });
    expect(completed.events.find(({ event }) => event.type === "toolResult")?.event).toMatchObject({ type: "toolResult", output: "observed output", isError: false });
  });

  it("records stable ignore reasons from dispatch instead of inventing a mapped notice", () => {
    const mapper = createMapper();
    expect(mapper.mapNotificationWithDisposition({ method: "turn/diff/updated", params: { diff: "+private-payload" } })).toEqual({ events: [], disposition: { kind: "ignored-with-reason", reason: "native-diff-slice-deferred" } });
    mapper.mapNotification({ method: "turn/completed", params: { turn: { status: "completed" } } });
    expect(mapper.mapNotificationWithDisposition({ method: "item/agentMessage/delta", params: { delta: "late text" } })).toEqual({ events: [], disposition: { kind: "ignored-with-reason", reason: "turn-already-completed" } });
  });

  it("keeps an unlinked provider thread's security warning at session scope", () => {
    const result = createMapper().mapNotificationWithDisposition({ method: "guardianWarning", params: { threadId: "unknown-child", message: "Unsafe action blocked" } });
    expect(result.disposition).toEqual({ kind: "mapped" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ event: { type: "system", message: "Unsafe action blocked", systemNotice: { kind: "security", scope: "session", origin: "unattributed-thread" } } });
    expect(JSON.stringify(result.events)).not.toContain("unknown-child");
  });

  it("keeps an unlinked thread's unknown update out of the parent transcript", () => {
    const result = createMapper().mapNotificationWithDisposition({ method: "future/update", params: { threadId: "unknown-child", privateText: "private-payload" } });
    expect(result.disposition).toEqual({ kind: "diagnostic", reason: "unattributed-thread" });
    expect(result.events).toMatchObject([{ event: { type: "system", systemNotice: { kind: "diagnostic", scope: "session", origin: "unattributed-thread" } } }]);
    expect(JSON.stringify(result.events)).not.toContain("private-payload");
  });
});
