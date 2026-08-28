import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import type { IAgentProvider, AgentEvent, GoalState } from "@mcode/contracts";
import { AgentEventType } from "@mcode/contracts";
import { EventEmitter } from "events";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { GoalCommand } from "../goal-command.js";
import type { CommandContext } from "../command-router.js";

/** Seed a workspace + thread so message foreign keys are satisfied. */
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

/** A Claude-shaped fake that implements the goal capability. */
function fakeGoalCapableProvider() {
  const makeGoal = (condition: string): GoalState => ({
    threadId: "thread-1",
    objective: condition,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    providerId: "claude",
    source: "claude",
    controls: { canInspect: true, canClear: true },
  });
  return Object.assign(new EventEmitter(), {
    id: "claude" as const,
    setGoal: vi.fn<(sid: string, condition: string) => GoalState>((_, condition) => makeGoal(condition)),
    clearGoal: vi.fn<(sid: string) => boolean>(() => true),
    getGoal: vi.fn<(sid: string) => GoalState | undefined>(() => undefined),
    hasNativeGoalCommand: vi.fn<(sid: string) => boolean>(() => false),
    setNativeGoalMirror: vi.fn<(sid: string, condition: string) => GoalState>((_, condition) => makeGoal(condition)),
    clearNativeGoalMirror: vi.fn<(sid: string) => boolean>(() => true),
  }) as unknown as IAgentProvider & {
    setGoal: ReturnType<typeof vi.fn>;
    clearGoal: ReturnType<typeof vi.fn>;
    getGoal: ReturnType<typeof vi.fn>;
    hasNativeGoalCommand: ReturnType<typeof vi.fn>;
    setNativeGoalMirror: ReturnType<typeof vi.fn>;
    clearNativeGoalMirror: ReturnType<typeof vi.fn>;
  };
}

/** A provider lacking the goal capability (e.g. codex/copilot). */
function fakeNonGoalProvider() {
  return Object.assign(new EventEmitter(), {
    id: "codex" as const,
  }) as unknown as IAgentProvider;
}

describe("GoalCommand", () => {
  let db: Database.Database;
  let messageRepo: MessageRepo;
  let broadcast: ReturnType<typeof vi.fn>;
  const threadId = "thread-1";

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    messageRepo = new MessageRepo(db);
    broadcast = vi.fn();
  });

  function build() {
    return new GoalCommand(
      { messageRepo, db },
      broadcast as unknown as (channel: "agent.event", data: AgentEvent) => void,
    );
  }

  /** Build a routing context for the given content and provider. */
  function ctx(content: string, provider: IAgentProvider): CommandContext {
    return { threadId, content, provider };
  }

  describe("matching and capability", () => {
    it("matches /goal content and ignores other content", () => {
      const cmd = build();
      expect(cmd.matches("/goal ship it")).toBe(true);
      expect(cmd.matches("/goal")).toBe(true);
      expect(cmd.matches("just a normal message")).toBe(false);
      expect(cmd.matches("please /goal ship it")).toBe(false);
    });

    it("requires the goal capability on the resolved provider", () => {
      const cmd = build();
      expect(cmd.requiredCapability(fakeGoalCapableProvider())).toBe(true);
      expect(cmd.requiredCapability(fakeNonGoalProvider())).toBe(false);
    });
  });

  describe("passthrough", () => {
    it("returns passthrough for content that is not a /goal command", async () => {
      const cmd = build();
      expect((await cmd.handle(ctx("just a normal message", fakeGoalCapableProvider()))).kind).toBe(
        "passthrough",
      );
      expect(broadcast).not.toHaveBeenCalled();
    });

    it("returns passthrough when the provider lacks the goal capability", async () => {
      const cmd = build();

      const outcome = await cmd.handle(ctx("/goal ship the feature", fakeNonGoalProvider()));

      expect(outcome.kind).toBe("passthrough");
      // Nothing persisted or broadcast — the model sees the raw text.
      expect(broadcast).not.toHaveBeenCalled();
      const { messages } = messageRepo.listByThread(threadId, 100);
      expect(messages).toHaveLength(0);
    });
  });

  describe("SET form", () => {
    it("rewrites the content into a directive and defers the goal install", async () => {
      const provider = fakeGoalCapableProvider();
      const cmd = build();

      const outcome = await cmd.handle(ctx("/goal analyse this branch", provider));

      expect(outcome.kind).toBe("rewrite");
      if (outcome.kind !== "rewrite") throw new Error("expected rewrite");
      // The wire payload becomes a directive that names the condition.
      expect(outcome.content).toContain("analyse this branch");
      expect(outcome.content.toLowerCase()).toContain("directive");
      // SET does not persist, broadcast, or install on its own. The goal owner
      // receives a typed effect request after admission reserves a runtime lease.
      expect(broadcast).not.toHaveBeenCalled();
      expect(provider.setGoal).not.toHaveBeenCalled();
      expect(outcome.effect).toEqual({
        kind: "goal",
        objective: "analyse this branch",
        delivery: "provider",
      });
    });
  });

  /** Collect agent events broadcast on the "agent.event" channel. */
  function broadcastEvents(): AgentEvent[] {
    return broadcast.mock.calls
      .filter(([channel]) => channel === "agent.event")
      .map(([, payload]) => payload as AgentEvent);
  }

  describe("SHOW form", () => {
    it("reports the active goal and short-circuits the send", async () => {
      const provider = fakeGoalCapableProvider();
      provider.getGoal.mockReturnValueOnce({
        threadId,
        objective: "ship the feature",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
        providerId: "claude",
        source: "claude",
        controls: { canInspect: true, canClear: true },
      } satisfies GoalState);
      const cmd = build();

      const outcome = await cmd.handle(ctx("/goal", provider));

      expect(outcome.kind).toBe("handled");
      expect(provider.setGoal).not.toHaveBeenCalled();

      // Original "/goal" text persisted as the user row; goal echoed in the pill.
      const { messages } = messageRepo.listByThread(threadId, 100);
      expect(messages.find((m) => m.role === "user")?.content).toBe("/goal");
      expect(messages.find((m) => m.role === "assistant")?.content).toContain(
        "ship the feature",
      );

      // The reply renders via the Message event. No synthetic Ended: control
      // commands never start a turn, so emitting Ended would clear the running
      // state of a real turn in flight (issue #583).
      const events = broadcastEvents();
      expect(events.some((e) => e.type === AgentEventType.Message)).toBe(true);
      expect(events.some((e) => e.type === AgentEventType.Ended)).toBe(false);
    });

    it("reports no active goal when none is set", async () => {
      const provider = fakeGoalCapableProvider();
      provider.getGoal.mockReturnValueOnce(undefined);
      const cmd = build();

      const outcome = await cmd.handle(ctx("/goal show", provider));

      expect(outcome.kind).toBe("handled");
      const { messages } = messageRepo.listByThread(threadId, 100);
      expect(messages.find((m) => m.role === "assistant")?.content).toMatch(
        /No active goal/,
      );
    });

    it("reports no active goal when the provider returns a completed goal", async () => {
      const provider = fakeGoalCapableProvider();
      provider.getGoal.mockReturnValueOnce({
        threadId,
        objective: "ship the feature",
        status: "complete",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 19,
        createdAt: 1,
        updatedAt: 20,
        providerId: "codex",
        source: "codex",
        controls: { canInspect: true, canClear: false },
      } satisfies GoalState);
      const cmd = build();

      const outcome = await cmd.handle(ctx("/goal show", provider));

      expect(outcome.kind).toBe("handled");
      const { messages } = messageRepo.listByThread(threadId, 100);
      expect(messages.find((m) => m.role === "assistant")?.content).toMatch(
        /No active goal/,
      );
    });

    it("uses exact native /goal wire text when Claude support is proven", async () => {
      const provider = fakeGoalCapableProvider();
      provider.hasNativeGoalCommand.mockReturnValueOnce(true);
      const cmd = build();

      const outcome = await cmd.handle(ctx("/goal analyse this branch", provider));

      expect(outcome.kind).toBe("rewrite");
      if (outcome.kind !== "rewrite") throw new Error("expected rewrite");
      expect(outcome.content).toBe("/goal analyse this branch");

      expect(provider.setGoal).not.toHaveBeenCalled();
      expect(outcome.effect).toEqual({
        kind: "goal",
        objective: "analyse this branch",
        delivery: "native",
      });
    });

    it("does not clear the native mirror from control command rollback", async () => {
      const provider = fakeGoalCapableProvider();
      provider.hasNativeGoalCommand.mockReturnValueOnce(true);
      const cmd = build();

      const outcome = await cmd.handle(ctx("/goal clear", provider));

      expect(outcome.kind).toBe("rewrite");
      if (outcome.kind !== "rewrite") throw new Error("expected rewrite");
      expect(outcome.content).toBe("/goal off");

      expect(provider.clearNativeGoalMirror).not.toHaveBeenCalled();
    });
  });

  describe("CLEAR form", () => {
    it("clears the goal and persists a confirmation pill without emitting Ended", async () => {
      const provider = fakeGoalCapableProvider();
      const cmd = build();

      const outcome = await cmd.handle(ctx("/goal clear", provider));

      expect(outcome.kind).toBe("handled");
      expect(provider.clearGoal).toHaveBeenCalledWith(`mcode-${threadId}`);

      const { messages } = messageRepo.listByThread(threadId, 100);
      expect(messages.find((m) => m.role === "assistant")?.content).toMatch(
        /Goal cleared/,
      );

      // The reply renders via Message; no Ended (issue #583) so a real turn in
      // flight keeps its running-state.
      const events = broadcastEvents();
      expect(events.some((e) => e.type === AgentEventType.Message)).toBe(true);
      expect(events.some((e) => e.type === AgentEventType.GoalCleared)).toBe(true);
      expect(events.some((e) => e.type === AgentEventType.Ended)).toBe(false);
    });
  });
});
