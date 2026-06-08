import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import type { IAgentProvider, AgentEvent } from "@mcode/contracts";
import { AgentEventType } from "@mcode/contracts";
import { EventEmitter } from "events";
import { openMemoryDatabase } from "../../store/database.js";
import { MessageRepo } from "../../repositories/message-repo.js";
import { GoalCommand } from "../goal-command.js";

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
  return Object.assign(new EventEmitter(), {
    id: "claude" as const,
    setGoal: vi.fn<(sid: string, condition: string) => void>(),
    clearGoal: vi.fn<(sid: string) => void>(),
    getGoal: vi.fn<(sid: string) => string | undefined>(() => undefined),
  }) as unknown as IAgentProvider & {
    setGoal: ReturnType<typeof vi.fn>;
    clearGoal: ReturnType<typeof vi.fn>;
    getGoal: ReturnType<typeof vi.fn>;
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

  function build(provider: IAgentProvider) {
    return new GoalCommand(
      provider,
      { messageRepo, db },
      broadcast as unknown as (channel: "agent.event", data: AgentEvent) => void,
    );
  }

  describe("passthrough", () => {
    it("returns passthrough for content that is not a /goal command", () => {
      const cmd = build(fakeGoalCapableProvider());
      expect(cmd.handle(threadId, "just a normal message").kind).toBe("passthrough");
      expect(broadcast).not.toHaveBeenCalled();
    });

    it("returns passthrough when the provider lacks the goal capability", () => {
      const provider = fakeNonGoalProvider();
      const cmd = build(provider);

      const outcome = cmd.handle(threadId, "/goal ship the feature");

      expect(outcome.kind).toBe("passthrough");
      // Nothing persisted or broadcast — the model sees the raw text.
      expect(broadcast).not.toHaveBeenCalled();
      const { messages } = messageRepo.listByThread(threadId, 100);
      expect(messages).toHaveLength(0);
    });
  });

  describe("SET form", () => {
    it("rewrites the content into a directive and surfaces the pending goal", () => {
      const cmd = build(fakeGoalCapableProvider());

      const outcome = cmd.handle(threadId, "/goal analyse this branch");

      expect(outcome.kind).toBe("rewrite");
      if (outcome.kind !== "rewrite") throw new Error("expected rewrite");
      expect(outcome.pendingGoal).toBe("analyse this branch");
      // The wire payload becomes a directive that names the condition.
      expect(outcome.content).toContain("analyse this branch");
      expect(outcome.content.toLowerCase()).toContain("directive");
      // SET does not persist or broadcast on its own — the caller owns the send.
      expect(broadcast).not.toHaveBeenCalled();
    });
  });

  describe("install / rollback", () => {
    it("installGoal sets the goal on the provider keyed by the thread session", () => {
      const provider = fakeGoalCapableProvider();
      const cmd = build(provider);

      cmd.installGoal(threadId, "ship the feature");

      expect(provider.setGoal).toHaveBeenCalledWith(`mcode-${threadId}`, "ship the feature");
    });

    it("rollbackGoal clears the goal on the provider", () => {
      const provider = fakeGoalCapableProvider();
      const cmd = build(provider);

      cmd.rollbackGoal(threadId);

      expect(provider.clearGoal).toHaveBeenCalledWith(`mcode-${threadId}`);
    });

    it("install / rollback are no-ops on a non-capable provider", () => {
      const cmd = build(fakeNonGoalProvider());
      // Must not throw when the provider lacks the capability.
      expect(() => cmd.installGoal(threadId, "x")).not.toThrow();
      expect(() => cmd.rollbackGoal(threadId)).not.toThrow();
    });
  });

  /** Collect agent events broadcast on the "agent.event" channel. */
  function broadcastEvents(): AgentEvent[] {
    return broadcast.mock.calls
      .filter(([channel]) => channel === "agent.event")
      .map(([, payload]) => payload as AgentEvent);
  }

  describe("SHOW form", () => {
    it("reports the active goal and short-circuits the send", () => {
      const provider = fakeGoalCapableProvider();
      provider.getGoal.mockReturnValueOnce("ship the feature");
      const cmd = build(provider);

      const outcome = cmd.handle(threadId, "/goal");

      expect(outcome.kind).toBe("handled");
      expect(provider.setGoal).not.toHaveBeenCalled();

      // Original "/goal" text persisted as the user row; goal echoed in the pill.
      const { messages } = messageRepo.listByThread(threadId, 100);
      expect(messages.find((m) => m.role === "user")?.content).toBe("/goal");
      expect(messages.find((m) => m.role === "assistant")?.content).toContain(
        "ship the feature",
      );

      // The composer clears its optimistic running state on Ended.
      const events = broadcastEvents();
      expect(events.some((e) => e.type === AgentEventType.Message)).toBe(true);
      expect(events.some((e) => e.type === AgentEventType.Ended)).toBe(true);
    });

    it("reports no active goal when none is set", () => {
      const provider = fakeGoalCapableProvider();
      provider.getGoal.mockReturnValueOnce(undefined);
      const cmd = build(provider);

      const outcome = cmd.handle(threadId, "/goal show");

      expect(outcome.kind).toBe("handled");
      const { messages } = messageRepo.listByThread(threadId, 100);
      expect(messages.find((m) => m.role === "assistant")?.content).toMatch(
        /No active goal/,
      );
    });
  });

  describe("CLEAR form", () => {
    it("clears the goal, persists a confirmation pill, and emits Ended", () => {
      const provider = fakeGoalCapableProvider();
      const cmd = build(provider);

      const outcome = cmd.handle(threadId, "/goal clear");

      expect(outcome.kind).toBe("handled");
      expect(provider.clearGoal).toHaveBeenCalledWith(`mcode-${threadId}`);

      const { messages } = messageRepo.listByThread(threadId, 100);
      expect(messages.find((m) => m.role === "assistant")?.content).toMatch(
        /Goal cleared/,
      );

      const events = broadcastEvents();
      expect(events.some((e) => e.type === AgentEventType.Ended)).toBe(true);
    });
  });
});
