import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import type { Thread, IProviderRegistry } from "@mcode/contracts";
import { AgentEventType } from "@mcode/contracts";
import { openMemoryDatabase } from "../../store/database.js";
import { ThreadRepo } from "../../repositories/thread-repo.js";
import { WorkspaceRepo } from "../../repositories/workspace-repo.js";
import { MessageRepo } from "../../repositories/message-repo.js";
import { PlanQuestionAnswersRepo } from "../../repositories/plan-question-answers-repo.js";
import { TurnSnapshotRepo } from "../../repositories/turn-snapshot-repo.js";
import { TaskRepo } from "../../repositories/task-repo.js";
import { AgentService } from "../agent-service.js";
import { NarrativeStore } from "../narrative-store.js";
import { PlanQuestionService } from "../plan-question-service.js";
import { ProviderAvailabilityService } from "../provider-availability-service.js";
import type { GitService } from "../git-service.js";
import type { AttachmentService } from "../attachment-service.js";
import type { SnapshotService } from "../snapshot-service.js";
import type { MemoryPressureService } from "../memory-pressure-service.js";
import type { SettingsService } from "../settings-service.js";
import type { ThreadService } from "../thread-service.js";
import { EventEmitter } from "events";

vi.mock("../../transport/push.js", () => ({ broadcast: vi.fn() }));
import { broadcast } from "../../transport/push.js";

/**
 * Build an AgentService with a Claude-shaped provider stub that records
 * setGoal/clearGoal/sendTurn so we can assert which path the /goal
 * intercept took (control short-circuit vs SET fall-through).
 */
function buildService(db: Database.Database) {
  container.reset();
  container.registerInstance("Database", db);

  const threadRepo = container.resolve(ThreadRepo);
  const workspaceRepo = container.resolve(WorkspaceRepo);
  const messageRepo = container.resolve(MessageRepo);
  const planQuestionAnswersRepo = container.resolve(PlanQuestionAnswersRepo);
  const turnSnapshotRepo = container.resolve(TurnSnapshotRepo);
  const taskRepo = container.resolve(TaskRepo);

  const gitService = {
    resolveWorkingDir: vi.fn(() => process.cwd()),
    listWorktrees: vi.fn(() => []),
  } as unknown as GitService;

  const attachmentService = {
    persist: vi.fn(() => Promise.resolve({ stored: [], persisted: [] })),
  } as unknown as AttachmentService;

  const providerStub = Object.assign(new EventEmitter(), {
    id: "claude" as const,
    supportsCompletion: true,
    sessionForkOnResume: "unsupported" as const,
    maxInputCharactersPerTurn: 16_000,
    sendTurn: vi.fn<(params: { message: string; [k: string]: unknown }) => Promise<void>>(
      () => Promise.resolve(),
    ),
    setGoal: vi.fn<(sid: string, condition: string) => void>(),
    clearGoal: vi.fn<(sid: string) => void>(),
    getGoal: vi.fn<(sid: string) => string | undefined>(() => undefined),
  });
  // A provider lacking the goal capability (no setGoal/clearGoal/getGoal).
  // `/goal` must pass through to this provider as plain text.
  const nonGoalStub = Object.assign(new EventEmitter(), {
    id: "codex" as const,
    supportsCompletion: true,
    sessionForkOnResume: "unsupported" as const,
    maxInputCharactersPerTurn: 16_000,
    sendTurn: vi.fn<(params: { message: string; [k: string]: unknown }) => Promise<void>>(
      () => Promise.resolve(),
    ),
  });
  const providerRegistry = {
    resolve: vi.fn((id: string) => (id === "claude" ? providerStub : nonGoalStub)),
    resolveAll: vi.fn(() => []),
    shutdown: vi.fn(),
  } as unknown as IProviderRegistry;

  const threadService = { create: vi.fn() } as unknown as ThreadService;

  const snapshotService = {
    captureRef: vi.fn(() => Promise.resolve("abc123")),
    getFilesChanged: vi.fn(() => Promise.resolve([])),
  } as unknown as SnapshotService;

  const memoryPressureService = {
    markActive: vi.fn(),
    markIdle: vi.fn(),
  } as unknown as MemoryPressureService;

  const settingsService = {
    get: vi.fn(() =>
      Promise.resolve({
        model: { defaults: { fallbackId: undefined, contextWindow: "auto", thinking: false } },
        agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
        provider: { enabled: {}, cli: {} },
      }),
    ),
    on: vi.fn(),
  } as unknown as SettingsService;

  const availability = {
    assertUsable: vi.fn(),
  } as unknown as ProviderAvailabilityService;

  const svc = new AgentService(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    attachmentService,
    providerRegistry,
    threadService,
    { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/hook-execution-repo.js").HookExecutionRepo,
    turnSnapshotRepo,
    snapshotService,
    db,
    memoryPressureService,
    taskRepo,
    settingsService,
    availability,
    planQuestionAnswersRepo,
      { create: vi.fn(), updateStatus: vi.fn(), listByThread: vi.fn(() => []), getLatestForThread: vi.fn(() => null), getById: vi.fn(() => null) } as unknown as import("../../repositories/plan-repo.js").PlanRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      container.resolve(NarrativeStore),
      container.resolve(PlanQuestionService),
  );

  return { svc, threadRepo, workspaceRepo, messageRepo, providerStub, nonGoalStub };
}

describe("AgentService.sendMessage — /goal command", () => {
  let db: Database.Database;
  let thread: Thread;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openMemoryDatabase();
    const { workspaceRepo, threadRepo } = buildService(db);
    const ws = workspaceRepo.create("test-ws", process.cwd(), false);
    thread = threadRepo.create(ws.id, "thread", "direct", "main");
  });

  it("/goal <condition> installs the goal AND invokes the provider with a directive payload", async () => {
    const { svc, providerStub, messageRepo } = buildService(db);

    await svc.sendMessage(
      thread.id,
      "/goal analyse this branch",
      "default",
      "claude-sonnet-4-6",
      [],
      undefined,
      "claude",
    );

    // Goal installed on the matching session id used by ClaudeProvider.
    expect(providerStub.setGoal).toHaveBeenCalledWith(
      `mcode-${thread.id}`,
      "analyse this branch",
    );

    // Provider was actually called — this is the regression the user hit
    // where /goal <condition> set the hook but never started the agent.
    expect(providerStub.sendTurn).toHaveBeenCalledTimes(1);
    const sentMessage = providerStub.sendTurn.mock.calls[0][0].message;
    expect(sentMessage).toContain("analyse this branch");
    expect(sentMessage.toLowerCase()).toContain("directive");

    // Persisted user row should keep the original "/goal …" text so the
    // transcript reflects what the user typed, not the directive prompt.
    const { messages } = messageRepo.listByThread(thread.id, 100);
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("/goal analyse this branch");
  });

  it("rolls the installed goal back when the send fails so no Stop-hook gate lingers", async () => {
    const { svc, providerStub } = buildService(db);
    providerStub.sendTurn.mockRejectedValueOnce(new Error("provider boom"));

    // sendMessage swallows the send failure (emits an error event, marks the
    // thread errored) rather than rejecting, so this resolves normally.
    await svc.sendMessage(
      thread.id,
      "/goal analyse this branch",
      "default",
      "claude-sonnet-4-6",
      [],
      undefined,
      "claude",
    );

    // onDispatch installed the goal just before the failing send...
    expect(providerStub.setGoal).toHaveBeenCalledWith(
      `mcode-${thread.id}`,
      "analyse this branch",
    );
    // ...and the catch ran onRollback so the gate does not leak into the next turn.
    expect(providerStub.clearGoal).toHaveBeenCalledWith(`mcode-${thread.id}`);
  });

  it("/goal clear short-circuits — clears the goal, does NOT invoke the provider, broadcasts a Message pill without Ended", async () => {
    const { svc, providerStub, messageRepo } = buildService(db);

    await svc.sendMessage(
      thread.id,
      "/goal clear",
      "default",
      "claude-sonnet-4-6",
      [],
      undefined,
      "claude",
    );

    expect(providerStub.clearGoal).toHaveBeenCalledWith(`mcode-${thread.id}`);
    expect(providerStub.sendTurn).not.toHaveBeenCalled();

    // Confirmation pill persisted as an assistant message.
    const { messages } = messageRepo.listByThread(thread.id, 100);
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toMatch(/Goal cleared/);

    // The confirmation renders via a Message event. No Ended (#583): a control
    // command never starts a turn, so emitting Ended would clear the running
    // state of a real turn in flight and break queue coordination. The client
    // mirrors this by never marking the thread running for control commands.
    const calls = (broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const messageEvents = calls.filter(
      ([channel, payload]) =>
        channel === "agent.event" && (payload as { type?: string }).type === AgentEventType.Message,
    );
    const endedEvents = calls.filter(
      ([channel, payload]) =>
        channel === "agent.event" && (payload as { type?: string }).type === AgentEventType.Ended,
    );
    expect(messageEvents.length).toBeGreaterThanOrEqual(1);
    expect(endedEvents.length).toBe(0);
  });

  it("/goal (no args) reports active goal without invoking the provider", async () => {
    const { svc, providerStub, messageRepo } = buildService(db);
    providerStub.getGoal.mockReturnValueOnce("ship the feature");

    await svc.sendMessage(
      thread.id,
      "/goal",
      "default",
      "claude-sonnet-4-6",
      [],
      undefined,
      "claude",
    );

    expect(providerStub.sendTurn).not.toHaveBeenCalled();
    expect(providerStub.setGoal).not.toHaveBeenCalled();

    const { messages } = messageRepo.listByThread(thread.id, 100);
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContain("ship the feature");
  });

  it("providers without the goal capability pass /goal through as plain text", async () => {
    const { svc, providerStub, nonGoalStub } = buildService(db);

    await svc.sendMessage(
      thread.id,
      "/goal something",
      "default",
      "claude-sonnet-4-6",
      [],
      undefined,
      // A non-goal-capable provider so the capability probe returns passthrough.
      "codex",
    );

    // No goal install on the capable provider, and the non-capable provider
    // received the raw text (no rewrite).
    expect(providerStub.setGoal).not.toHaveBeenCalled();
    expect(nonGoalStub.sendTurn).toHaveBeenCalledTimes(1);
    expect(nonGoalStub.sendTurn.mock.calls[0][0].message).toBe("/goal something");
  });
});
