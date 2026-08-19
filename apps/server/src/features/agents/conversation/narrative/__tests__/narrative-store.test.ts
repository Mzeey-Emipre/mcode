import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../../events/persistence/hook-execution-repo.js";
import { NarrativeStore } from "../narrative-store.js";

/** Seed a workspace + thread so message/record foreign keys are satisfied. */
function seedThread(db: Database.Database): string {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws-1", "Test", "/tmp/test", now, now);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("thread-1", "ws-1", "Test thread", "main", now, now);
  return "thread-1";
}

function insertMessage(
  db: Database.Database,
  id: string,
  role: string,
  content: string,
  sequence: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, "thread-1", role, content, now, sequence);
}

describe("NarrativeStore Move/Rename persistence sanitization", () => {
  it.each(["Move", "rEnAmE"])(
    "passes only bounded source and destination paths to persistence for %s",
    (toolName) => {
      let persistedInputSummary: string | undefined;
      const store = new NarrativeStore(
        {} as MessageRepo,
        {
          bulkCreate: (records: Array<{ inputSummary?: string }>) => {
            persistedInputSummary = records[0]?.inputSummary;
          },
        } as unknown as ToolCallRecordRepo,
        { bulkCreate: () => undefined } as unknown as ThoughtSegmentRepo,
        { bulkCreate: () => undefined } as unknown as HookExecutionRepo,
      );
      store.beginTurn("thread-1");
      store.resetTurnCounters("thread-1");
      store.bufferToolCall("thread-1", {
        toolCallId: `file-${toolName}`,
        toolName,
        toolInput: {
          oldPath: "src/old.ts",
          path: "src/new.ts",
          beforeText: "SECRET_BEFORE",
          afterText: "SECRET_AFTER",
        },
      });

      store.persistNarrative("thread-1", "m1", "done", "completed");

      expect(persistedInputSummary).toBe("src/old.ts -> src/new.ts");
      expect(persistedInputSummary?.length).toBeLessThanOrEqual(200);
      expect(persistedInputSummary).not.toContain("SECRET_BEFORE");
      expect(persistedInputSummary).not.toContain("SECRET_AFTER");
    },
  );
});

describe("NarrativeStore sub-agent identity persistence", () => {
  it("captures bounded model and reasoning metadata only from Agent input", () => {
    const store = new NarrativeStore(
      {} as MessageRepo,
      { bulkCreate: () => undefined } as unknown as ToolCallRecordRepo,
      { bulkCreate: () => undefined } as unknown as ThoughtSegmentRepo,
      { bulkCreate: () => undefined } as unknown as HookExecutionRepo,
    );
    store.beginTurn("thread-1");
    store.resetTurnCounters("thread-1");

    store.bufferToolCall("thread-1", {
      toolCallId: "agent",
      toolName: "Agent",
      toolInput: { model: "gpt-5.3-codex", reasoningEffort: "high" },
    });
    store.bufferToolCall("thread-1", {
      toolCallId: "read",
      toolName: "Read",
      toolInput: { model: "must-not-inherit", reasoningEffort: "low" },
    });
    store.bufferToolCall("thread-1", {
      toolCallId: "oversized",
      toolName: "Agent",
      toolInput: { model: "x".repeat(129), reasoningEffort: "y".repeat(129) },
    });

    expect(store.getBufferedToolCalls("thread-1").map(({ model, reasoningEffort }) => ({
      model,
      reasoningEffort,
    }))).toEqual([
      { model: "gpt-5.3-codex", reasoningEffort: "high" },
      { model: undefined, reasoningEffort: undefined },
      { model: undefined, reasoningEffort: undefined },
    ]);
  });

  it("persists a bounded logical-agent key only for Codex spawnAgent input", () => {
    const store = new NarrativeStore(
      {} as MessageRepo,
      { bulkCreate: () => undefined } as unknown as ToolCallRecordRepo,
      { bulkCreate: () => undefined } as unknown as ThoughtSegmentRepo,
      { bulkCreate: () => undefined } as unknown as HookExecutionRepo,
    );
    store.beginTurn("thread-1");
    store.resetTurnCounters("thread-1");

    store.bufferToolCall("thread-1", {
      toolCallId: "codex",
      toolName: "Agent",
      toolInput: {
        codexCollabKind: "spawnAgent",
        agentPath: "/root/explorer",
      },
    });
    store.bufferToolCall("thread-1", {
      toolCallId: "other-provider",
      toolName: "Agent",
      toolInput: { agentPath: "/root/explorer" },
    });
    store.bufferToolCall("thread-1", {
      toolCallId: "oversized",
      toolName: "Agent",
      toolInput: {
        codexCollabKind: "spawnAgent",
        agentPath: `/${"x".repeat(300)}`,
      },
    });

    expect(store.getBufferedToolCalls("thread-1").map((item) => item.providerAgentKey)).toEqual([
      "/root/explorer",
      undefined,
      undefined,
    ]);
  });

  it("persists bounded explicit identity separately from delegated task text", () => {
    let persisted: Array<{ displayName?: string; inputSummary?: string }> = [];
    const store = new NarrativeStore(
      {} as MessageRepo,
      {
        bulkCreate: (records: Array<{ displayName?: string; inputSummary?: string }>) => {
          persisted = records;
        },
      } as unknown as ToolCallRecordRepo,
      { bulkCreate: () => undefined } as unknown as ThoughtSegmentRepo,
      { bulkCreate: () => undefined } as unknown as HookExecutionRepo,
    );
    store.beginTurn("thread-1");
    store.resetTurnCounters("thread-1");
    store.bufferToolCall("thread-1", {
      toolCallId: "agent-1",
      toolName: "Agent",
      toolInput: {
        agentPath: `/root/${"x".repeat(120)}`,
        description: "Inspect private task details",
      },
    });

    store.persistNarrative("thread-1", "m1", "done", "completed");

    expect(persisted[0]?.displayName).toHaveLength(96);
    expect(persisted[0]?.displayName?.endsWith("…")).toBe(true);
    expect(persisted[0]?.displayName).not.toContain("Inspect private task details");
    expect(persisted[0]?.inputSummary).toContain("Inspect private task details");
  });

  it("does not promote prompt or description to display identity", () => {
    const store = new NarrativeStore(
      {} as MessageRepo,
      { bulkCreate: () => undefined } as unknown as ToolCallRecordRepo,
      { bulkCreate: () => undefined } as unknown as ThoughtSegmentRepo,
      { bulkCreate: () => undefined } as unknown as HookExecutionRepo,
    );
    store.beginTurn("thread-1");
    store.resetTurnCounters("thread-1");
    store.bufferToolCall("thread-1", {
      toolCallId: "agent-1",
      toolName: "Agent",
      toolInput: { prompt: "Private prompt", description: "Private task" },
    });

    expect(store.getBufferedToolCalls("thread-1")[0]?.displayName).toBeUndefined();
  });

  it("projects late provider metadata onto an existing Agent row", () => {
    const store = new NarrativeStore(
      {} as MessageRepo,
      { bulkCreate: () => undefined } as unknown as ToolCallRecordRepo,
      { bulkCreate: () => undefined } as unknown as ThoughtSegmentRepo,
      { bulkCreate: () => undefined } as unknown as HookExecutionRepo,
    );
    store.beginTurn("thread-1");
    store.resetTurnCounters("thread-1");
    store.bufferToolCall("thread-1", {
      toolCallId: "agent-1",
      toolName: "Agent",
      toolInput: {
        codexCollabKind: "spawnAgent",
        agentPath: "/root/subagent",
        model: "gpt-initial",
      },
    });

    store.bufferToolCall("thread-1", {
      toolCallId: "agent-1",
      toolName: "Agent",
      toolInput: {
        agentName: "Hubble",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
      },
    });

    expect(store.getBufferedToolCalls("thread-1")).toEqual([
      expect.objectContaining({
        displayName: "Hubble",
        providerAgentKey: "/root/subagent",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
      }),
    ]);
  });

  it("projects late provider metadata after the Agent row completes", () => {
    const store = new NarrativeStore(
      {} as MessageRepo,
      { bulkCreate: () => undefined } as unknown as ToolCallRecordRepo,
      { bulkCreate: () => undefined } as unknown as ThoughtSegmentRepo,
      { bulkCreate: () => undefined } as unknown as HookExecutionRepo,
    );
    store.beginTurn("thread-1");
    store.resetTurnCounters("thread-1");
    store.bufferToolCall("thread-1", {
      toolCallId: "agent-1",
      toolName: "Agent",
      toolInput: { codexCollabKind: "spawnAgent", receiverThreadIds: ["child-1"] },
    });
    store.updateBufferedToolCallOutput("thread-1", "agent-1", "done", false);

    store.bufferToolCall("thread-1", {
      toolCallId: "agent-1",
      toolName: "Agent",
      toolInput: {
        agentName: "Hubble",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
      },
    });

    expect(store.getBufferedToolCalls("thread-1")).toEqual([
      expect.objectContaining({
        status: "completed",
        displayName: "Hubble",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
      }),
    ]);
  });
});

describe("NarrativeStore.load (read seam)", () => {
  let db: Database.Database;
  let store: NarrativeStore;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    store = new NarrativeStore(
      new MessageRepo(db),
      new ToolCallRecordRepo(db),
      new ThoughtSegmentRepo(db),
      new HookExecutionRepo(db),
    );
  });

  it("returns one list interleaved by (sequence, sortOrder), final response as the message body", () => {
    // One assistant message: preamble narration (0), tool call (1), hook (2),
    // final-response segment (3). The body must surface at sortOrder 3.
    insertMessage(db, "m1", "assistant", "Final answer text.", 1);
    new ThoughtSegmentRepo(db).bulkCreate([
      { messageId: "m1", text: "Let me look.", startedAt: "t", endedAt: "t", sortOrder: 0 },
      { messageId: "m1", text: "Final answer text.", startedAt: "t", endedAt: "t", sortOrder: 3, isFinalResponse: 1 },
    ]);
    new ToolCallRecordRepo(db).bulkCreate([
      { messageId: "m1", toolName: "Read", inputSummary: "f.ts", outputSummary: "ok", status: "completed", sortOrder: 1 },
    ]);
    new HookExecutionRepo(db).bulkCreate([
      { messageId: "m1", hookName: "PreToolUse", toolName: "Read", phase: "pre", payload: "{}", durationMs: 1, didBlock: false, startedAt: "t", endedAt: "t", sortOrder: 2 },
    ]);

    const entries = store.load("thread-1");

    expect(entries.map((e) => e.kind)).toEqual([
      "narrationSegment", // sortOrder 0
      "toolCall", // 1
      "hook", // 2
      "assistantMessage", // 3 (final response as body)
    ]);
    const body = entries.find((e) => e.kind === "assistantMessage");
    expect(body && body.kind === "assistantMessage" && body.body).toBe("Final answer text.");
    // The final-response segment is NOT also emitted as a narration row.
    const narrations = entries.filter((e) => e.kind === "narrationSegment");
    expect(narrations).toHaveLength(1);
    expect(narrations[0].kind === "narrationSegment" && narrations[0].record.text).toBe("Let me look.");
  });

  it("orders entries across messages by sequence, and skips user/system messages", () => {
    insertMessage(db, "u1", "user", "do the thing", 1);
    insertMessage(db, "m1", "assistant", "first answer", 2);
    insertMessage(db, "sys1", "system", "Context compacted", 3);
    insertMessage(db, "m2", "assistant", "second answer", 4);
    const tools = new ToolCallRecordRepo(db);
    tools.bulkCreate([
      { messageId: "m1", toolName: "Read", inputSummary: "a", outputSummary: "ok", status: "completed", sortOrder: 0 },
    ]);
    tools.bulkCreate([
      { messageId: "m2", toolName: "Bash", inputSummary: "ls", outputSummary: "ok", status: "completed", sortOrder: 0 },
    ]);

    const entries = store.load("thread-1");

    // Only assistant narrative; user + system rows excluded.
    expect(entries.every((e) => e.sequence === 2 || e.sequence === 4)).toBe(true);
    // All of message seq=2's entries precede all of seq=4's entries.
    const seqs = entries.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // m1 (seq 2): toolCall then assistantMessage (body sorts last, no final seg → MAX).
    const seq2 = entries.filter((e) => e.sequence === 2);
    expect(seq2.map((e) => e.kind)).toEqual(["toolCall", "assistantMessage"]);
  });

  it("places the assistant body last when there is no final-response segment", () => {
    insertMessage(db, "m1", "assistant", "answer with no tagged final segment", 1);
    new ToolCallRecordRepo(db).bulkCreate([
      { messageId: "m1", toolName: "Read", inputSummary: "a", outputSummary: "ok", status: "completed", sortOrder: 0 },
      { messageId: "m1", toolName: "Edit", inputSummary: "b", outputSummary: "ok", status: "completed", sortOrder: 1 },
    ]);

    const entries = store.load("thread-1");
    expect(entries.map((e) => e.kind)).toEqual(["toolCall", "toolCall", "assistantMessage"]);
  });
});

/**
 * Write-seam integration tests. These drive the NarrativeStore enrichment +
 * classification + persistence methods directly with synthetic events and
 * assert on the persisted rows (via `load` / repos), guarding the six
 * narrative-pipeline traps on the server side. The store is backed by a real
 * in-memory SQLite DB so `persistNarrative` exercises actual bulk inserts.
 */
describe("NarrativeStore write seam (server-side traps)", () => {
  const THREAD = "thread-1";
  const NOW = "2026-08-10T00:00:00.000Z";
  let db: Database.Database;
  let store: NarrativeStore;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    store = new NarrativeStore(
      new MessageRepo(db),
      new ToolCallRecordRepo(db),
      new ThoughtSegmentRepo(db),
      new HookExecutionRepo(db),
    );
  });

  /** Seed an assistant message row so persistNarrative's FK targets exist. */
  function seedAssistantMessage(id: string, content: string, sequence: number): void {
    insertMessage(db, id, "assistant", content, sequence);
  }

  function toolUse(toolCallId: string, toolName: string, parentToolCallId?: string) {
    return { toolCallId, toolName, toolInput: {}, parentToolCallId };
  }

  it("persists a long active turn in order across bounded transactions", async () => {
    seedAssistantMessage("m1", "done", 1);
    store.beginTurn(THREAD);
    store.resetTurnCounters(THREAD);
    for (let index = 0; index < 130; index++) {
      store.bufferToolCall(THREAD, toolUse(`tool-${index}`, "Read"));
    }

    const result = await store.persistNarrativeBatched(THREAD, "m1", "done", "completed");
    const persisted = new ToolCallRecordRepo(db).listByMessage("m1");

    expect(result).toEqual({ toolCallCount: 130 });
    expect(persisted).toHaveLength(130);
    expect(persisted.map((record) => record.id)).toEqual(
      Array.from({ length: 130 }, (_, index) => `tool-${index}`),
    );
  });

  it("drains a hook that arrives while a bounded narrative write yields", async () => {
    seedAssistantMessage("m1", "done", 1);
    const toolRepo = new ToolCallRecordRepo(db);
    const hookRepo = new HookExecutionRepo(db);
    store = new NarrativeStore(
      new MessageRepo(db),
      toolRepo,
      new ThoughtSegmentRepo(db),
      hookRepo,
    );
    store.beginTurn(THREAD);
    store.resetTurnCounters(THREAD);
    for (let index = 0; index < 65; index++) {
      store.bufferToolCall(THREAD, toolUse(`tool-${index}`, "Read"));
    }
    const originalBulkCreateBatched = toolRepo.bulkCreateBatched.bind(toolRepo);
    vi.spyOn(toolRepo, "bulkCreateBatched").mockImplementation(async (items, limits) => {
      const result = await originalBulkCreateBatched(items, limits);
      store.pushClosedHook(THREAD, {
        id: "late-hook",
        messageId: "",
        hookName: "Stop",
        toolName: null,
        phase: "stop",
        payload: "{}",
        durationMs: 1,
        didBlock: false,
        startedAt: NOW,
        endedAt: NOW,
        sortOrder: 66,
      });
      return result;
    });

    await store.persistNarrativeBatched(THREAD, "m1", "done", "completed");

    expect(hookRepo.listByMessage("m1").map((hook) => hook.id)).toEqual(["late-hook"]);
  });

  it("keeps non-strict bounded persistence best-effort after a repository failure", async () => {
    seedAssistantMessage("m1", "done", 1);
    const toolRepo = new ToolCallRecordRepo(db);
    vi.spyOn(toolRepo, "bulkCreateBatched").mockRejectedValue(new Error("disk unavailable"));
    store = new NarrativeStore(
      new MessageRepo(db),
      toolRepo,
      new ThoughtSegmentRepo(db),
      new HookExecutionRepo(db),
    );
    store.beginTurn(THREAD);
    store.resetTurnCounters(THREAD);
    store.bufferToolCall(THREAD, toolUse("tool-1", "Read"));

    await expect(
      store.persistNarrativeBatched(THREAD, "m1", "done", "completed"),
    ).resolves.toEqual({ toolCallCount: 1 });
  });

  describe("Trap 1: parent_tool_use_id is authoritative for parallel sub-agents", () => {
    it("attributes each child to its SDK-supplied parent across 4 parallel Agents", () => {
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);

      // Four Agents dispatched in parallel; the stack ends [a1,a2,a3,a4].
      for (const id of ["a1", "a2", "a3", "a4"]) {
        store.bufferToolCall(THREAD, toolUse(id, "Agent"));
      }
      // Each child carries its own SDK parent_tool_use_id. The naive LIFO peek
      // would clump them all under a4; the SDK value must win instead.
      store.bufferToolCall(THREAD, toolUse("c1", "Read", "a1"));
      store.bufferToolCall(THREAD, toolUse("c2", "Read", "a2"));
      store.bufferToolCall(THREAD, toolUse("c3", "Read", "a3"));
      store.bufferToolCall(THREAD, toolUse("c4", "Read", "a4"));

      const byId = new Map(
        store.getBufferedToolCalls(THREAD).map((b) => [b.toolCallId, b.parentToolCallId]),
      );
      expect(byId.get("c1")).toBe("a1");
      expect(byId.get("c2")).toBe("a2");
      expect(byId.get("c3")).toBe("a3");
      expect(byId.get("c4")).toBe("a4");
      // Agent rows without an explicit provider parent remain top-level.
      expect(byId.get("a1")).toBeUndefined();
    });

    it("persists explicit nested Agent parents without stack-parenting other Agents", () => {
      seedAssistantMessage("m1", "", 1);
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, {
        ...toolUse("agent-source", "Agent"),
        toolInput: { agentName: "Explorer" },
      });
      store.bufferToolCall(THREAD, {
        ...toolUse("agent-unparented", "Agent"),
        toolInput: { agentName: "Reviewer" },
      });
      store.bufferToolCall(THREAD, {
        ...toolUse("agent-target", "Agent", "agent-source"),
        toolInput: { agentName: "Implementer" },
      });
      store.bufferToolCall(THREAD, {
        ...toolUse("marker-target", "__McodeSubagentLifecycle", "agent-target"),
        toolInput: {
          lifecycle: "updated",
          sourceAgentName: "Explorer",
          sourceAgentToolCallId: "agent-source",
        },
      });

      store.persistNarrative(THREAD, "m1", "", "completed");

      const persistedTools = store.load(THREAD)
        .filter((entry) => entry.kind === "toolCall")
        .map((entry) => entry.record);
      const byId = new Map(persistedTools.map((record) => [record.id, record]));
      expect(byId.get("agent-source")?.parent_tool_call_id).toBeNull();
      expect(byId.get("agent-unparented")?.parent_tool_call_id).toBeNull();
      expect(byId.get("agent-target")?.parent_tool_call_id).toBe("agent-source");
      expect(byId.get("marker-target")?.parent_tool_call_id).toBe("agent-target");
    });

    it("falls back to the only running Agent when the SDK omits the parent", () => {
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, toolUse("solo", "Agent"));

      // SDK omitted parentToolCallId; exactly one Agent is running → attributed.
      expect(store.getCurrentParentToolCallId(THREAD)).toBe("solo");
      const childParent = store.bufferToolCall(THREAD, toolUse("child", "Read"));
      expect(childParent).toBe("solo");
    });

    it("replaces an inferred duplicate parent with explicit provider attribution and retains it", () => {
      seedAssistantMessage("m1", "", 1);
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, toolUse("agent-a", "Agent"));
      expect(store.bufferToolCall(THREAD, toolUse("child-x", "Read"))).toBe("agent-a");

      store.bufferToolCall(THREAD, toolUse("agent-b", "Agent"));
      expect(store.bufferToolCall(THREAD, toolUse("child-x", "Read", "agent-b"))).toBe("agent-b");

      store.updateBufferedToolCallOutput(THREAD, "agent-b", "done", false);
      expect(store.bufferToolCall(THREAD, toolUse("child-x", "Read"))).toBe("agent-b");
      store.updateBufferedToolCallOutput(THREAD, "child-x", "read", false);
      store.persistNarrative(THREAD, "m1", "", "completed");

      const persistedChild = store.load(THREAD)
        .find((entry) => entry.kind === "toolCall" && entry.record.id === "child-x");
      expect(persistedChild?.kind).toBe("toolCall");
      if (persistedChild?.kind === "toolCall") {
        expect(persistedChild.record.parent_tool_call_id).toBe("agent-b");
      }
    });

    it("returns undefined when two Agents are running (ambiguous fallback)", () => {
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, toolUse("a1", "Agent"));
      store.bufferToolCall(THREAD, toolUse("a2", "Agent"));

      expect(store.getCurrentParentToolCallId(THREAD)).toBeUndefined();
      const childParent = store.bufferToolCall(THREAD, toolUse("child", "Read"));
      expect(childParent).toBeUndefined();
    });
  });

  describe("Trap 2: agentCallStack lifecycle", () => {
    it("does NOT clear the stack on openOrExtendThought (textDelta analogue)", () => {
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, toolUse("solo", "Agent"));

      // A sub-agent streams text mid-flight; the fallback parent must survive.
      store.openOrExtendThought(THREAD, "thinking out loud");
      expect(store.getCurrentParentToolCallId(THREAD)).toBe("solo");
      expect(store.bufferToolCall(THREAD, toolUse("child", "Read"))).toBe("solo");
    });

    it("pops the Agent from the stack on its toolResult", () => {
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, toolUse("solo", "Agent"));
      expect(store.getCurrentParentToolCallId(THREAD)).toBe("solo");

      store.updateBufferedToolCallOutput(THREAD, "solo", "done", false);
      // Agent finished → no running Agent → coordinator tools do not inherit it.
      expect(store.getCurrentParentToolCallId(THREAD)).toBeUndefined();
    });

    it("persists tool output truncation metadata", () => {
      seedAssistantMessage("m1", "", 1);
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, toolUse("tc-1", "Bash"));

      store.updateBufferedToolCallOutput(THREAD, "tc-1", "preview", false, undefined, {
        outputTruncated: true,
        outputTotalBytes: 300_000,
        outputArtifactPath: "C:\\mcode\\artifacts\\tool-output\\thread\\tool.txt",
        exitCode: 1,
      });
      store.persistNarrative(THREAD, "m1", "", "completed");

      const tools = new ToolCallRecordRepo(db).listByMessage("m1");
      expect(tools[0].output_truncated).toBe(1);
      expect(tools[0].output_total_bytes).toBe(300_000);
      expect(tools[0].output_artifact_path).toBe("C:\\mcode\\artifacts\\tool-output\\thread\\tool.txt");
      expect(tools[0].exit_code).toBe(1);
    });

    it("clears the whole stack on the final Message event", () => {
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, toolUse("a1", "Agent"));
      store.bufferToolCall(THREAD, toolUse("a2", "Agent"));

      store.clearAgentStackOnMessage(THREAD);
      expect(store.getCurrentParentToolCallId(THREAD)).toBeUndefined();
    });
  });

  describe("Trap 3 (server analogue): buffers reset at beginTurn, survive through persist", () => {
    it("resets buffered tool calls on a fresh beginTurn", () => {
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, toolUse("tc-1", "Read"));
      expect(store.getBufferedToolCalls(THREAD)).toHaveLength(1);

      // New turn starts → previous trail cleared.
      store.beginTurn(THREAD);
      expect(store.getBufferedToolCalls(THREAD)).toHaveLength(0);
    });

    it("keeps buffers populated through persistNarrative until clearTurn", () => {
      seedAssistantMessage("m1", "final body", 1);
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, toolUse("tc-1", "Read"));

      const result = store.persistNarrative(THREAD, "m1", "final body", "completed");
      expect(result.toolCallCount).toBe(1);
      // Buffers are NOT cleared by persistNarrative.
      expect(store.getBufferedToolCalls(THREAD)).toHaveLength(1);

      store.clearTurn(THREAD);
      expect(store.getBufferedToolCalls(THREAD)).toHaveLength(0);
    });

    it("merges sparse duplicate ToolUse details without adding a second row", () => {
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, {
        toolCallId: "cmd-1",
        toolName: "command_execution",
        toolInput: {},
      });
      store.bufferToolCall(THREAD, {
        toolCallId: "cmd-1",
        toolName: "command_execution",
        toolInput: { command: "echo hi" },
      });

      const calls = store.getBufferedToolCalls(THREAD);
      expect(calls).toHaveLength(1);
      expect(calls[0]._rawToolInput).toEqual({ command: "echo hi" });
    });

    it("persists Codex commands beyond the old 200-character JSON summary", () => {
      const command = `pwsh -Command \"${"Write-Output long-command;".repeat(20)}\"`;
      seedAssistantMessage("m1", "done", 1);
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, {
        toolCallId: "cmd-1",
        toolName: "command_execution",
        toolInput: { command },
      });

      store.persistNarrative(THREAD, "m1", "done", "completed");

      const [record] = new ToolCallRecordRepo(db).listByMessage("m1");
      expect(command.length).toBeGreaterThan(200);
      expect(record.input_summary).toBe(command);
    });

  });

  describe("Classification precedence + is_final_response safety net", () => {
    it("drops the open thought when the boundary reports a final response (tool-free turn)", () => {
      seedAssistantMessage("m1", "Tool-free final answer", 1);
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.openOrExtendThought(THREAD, "Tool-free final answer");
      // end_turn-style boundary means final response, so drop it.
      store.dropOpenThought(THREAD);

      store.persistNarrative(THREAD, "m1", "Tool-free final answer", "completed");
      expect(new ThoughtSegmentRepo(db).listByMessage("m1")).toHaveLength(0);
    });

    it("moves an open thought out of the narrative buffer for final-response ownership transfer", () => {
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.openOrExtendThought(THREAD, "Tool-free final answer");

      const text = store.takeOpenThought(THREAD);

      expect(text).toBe("Tool-free final answer");
      expect(store.hasBufferedNarrative(THREAD)).toBe(false);
    });

    it("persists preamble as a thought when the boundary reports tool_use (non-final)", () => {
      seedAssistantMessage("m1", "", 1);
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.openOrExtendThought(THREAD, "Let me check that file.");
      // tool_use stop_reason means preamble.
      store.closeOpenThought(THREAD);
      store.bufferToolCall(THREAD, toolUse("tc-read", "Read"));

      store.persistNarrative(THREAD, "m1", "", "completed");
      const thoughts = new ThoughtSegmentRepo(db).listByMessage("m1");
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].text).toBe("Let me check that file.");
      expect(thoughts[0].is_final_response ?? 0).toBe(0);
    });

    it("tags the tail thought is_final_response via suffix-match when text equals the body", () => {
      const body = "FULL USER-FACING REPLY";
      seedAssistantMessage("m1", body, 1);
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.openOrExtendThought(THREAD, body);
      // No boundary fired (older/reconnect path) → suffix-match must catch it.
      store.persistNarrative(THREAD, "m1", body, "completed");

      const thoughts = new ThoughtSegmentRepo(db).listByMessage("m1");
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].is_final_response).toBe(1);
      // load() surfaces the body as assistantMessage, not a duplicate narration.
      const entries = store.load(THREAD);
      expect(entries.filter((e) => e.kind === "narrationSegment")).toHaveLength(0);
      const msg = entries.find((e) => e.kind === "assistantMessage");
      expect(msg && msg.kind === "assistantMessage" && msg.body).toBe(body);
    });

    it("orders a preamble thought before its following tool call via the shared sort counter", () => {
      seedAssistantMessage("m1", "", 1);
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.openOrExtendThought(THREAD, "I will read.");
      // The ToolUse handler closes the open thought before buffering the call,
      // so the thought sorts strictly before it (sort 0 < 1).
      store.closeOpenThought(THREAD);
      store.bufferToolCall(THREAD, toolUse("tc-1", "Read"));
      store.openOrExtendThought(THREAD, "Now respond.");

      store.persistNarrative(THREAD, "m1", "", "completed");
      const thoughts = new ThoughtSegmentRepo(db).listByMessage("m1");
      const tools = new ToolCallRecordRepo(db).listByMessage("m1");
      expect(thoughts.map((t) => [t.text, t.sort_order])).toEqual([
        ["I will read.", 0],
        ["Now respond.", 2],
      ]);
      expect(tools[0].sort_order).toBe(1);
    });
  });

  describe("Trap 6: counting data preserved (semantics unchanged)", () => {
    it("persists each Agent's captured lifecycle timestamps through the real repository", () => {
      seedAssistantMessage("m1", "", 1);
      vi.useFakeTimers();
      try {
        store.beginTurn(THREAD);
        store.resetTurnCounters(THREAD);
        vi.setSystemTime(new Date("2026-07-22T10:00:00.000Z"));
        store.bufferToolCall(THREAD, toolUse("agent-first", "Agent"));
        vi.setSystemTime(new Date("2026-07-22T10:00:05.000Z"));
        store.bufferToolCall(THREAD, toolUse("agent-second", "Agent"));
        vi.setSystemTime(new Date("2026-07-22T10:00:10.000Z"));
        store.bufferToolCall(THREAD, toolUse("agent-settled", "Agent"));
        vi.setSystemTime(new Date("2026-07-22T10:00:20.000Z"));
        store.updateBufferedToolCallOutput(THREAD, "agent-first", "First result", false);
        vi.setSystemTime(new Date("2026-07-22T10:00:50.000Z"));
        store.updateBufferedToolCallOutput(THREAD, "agent-second", "Second result", false);
        vi.setSystemTime(new Date("2026-07-22T10:01:00.000Z"));
        store.persistNarrative(THREAD, "m1", "", "completed");
      } finally {
        vi.useRealTimers();
      }

      const records = new ToolCallRecordRepo(db).listByMessage("m1");
      expect(records.map((record) => ({
        id: record.id,
        startedAt: record.started_at,
        completedAt: record.completed_at,
        durationMs: Date.parse(record.completed_at!) - Date.parse(record.started_at),
      }))).toEqual([
        {
          id: "agent-first",
          startedAt: "2026-07-22T10:00:00.000Z",
          completedAt: "2026-07-22T10:00:20.000Z",
          durationMs: 20_000,
        },
        {
          id: "agent-second",
          startedAt: "2026-07-22T10:00:05.000Z",
          completedAt: "2026-07-22T10:00:50.000Z",
          durationMs: 45_000,
        },
        {
          id: "agent-settled",
          startedAt: "2026-07-22T10:00:10.000Z",
          completedAt: "2026-07-22T10:01:00.000Z",
          durationMs: 50_000,
        },
      ]);
    });

    it("persists every top-level tool call including Agent rows, so step counts are derivable", () => {
      seedAssistantMessage("m1", "", 1);
      store.beginTurn(THREAD);
      store.resetTurnCounters(THREAD);
      store.bufferToolCall(THREAD, toolUse("r1", "Read"));
      store.bufferToolCall(THREAD, toolUse("r2", "Read"));
      store.bufferToolCall(THREAD, toolUse("r3", "Read"));
      store.bufferToolCall(THREAD, toolUse("ag", "Agent"));

      const { toolCallCount } = store.persistNarrative(THREAD, "m1", "", "completed");
      expect(toolCallCount).toBe(4);

      const tools = new ToolCallRecordRepo(db).listByMessage("m1");
      // All four top-level calls persisted; the Agent is one of the four, not a fifth.
      const topLevel = tools.filter((t) => t.parent_tool_call_id == null);
      expect(topLevel).toHaveLength(4);
      expect(topLevel.filter((t) => t.tool_name === "Agent")).toHaveLength(1);
    });
  });
});
