import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import type { Thread, IProviderRegistry, GoalState, AgentEvent, GoalLookupResult } from "@mcode/contracts";
import { AgentEventType } from "@mcode/contracts";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";
import {
  createAgentServiceForTest,
  goalLifecycleForAgentServiceTest,
  startProviderTurnForTest,
  wrapProviderEmitterForRuntimeEvents,
} from "./agent-service-test-harness.js";
import { createCanonicalAgentEventSinkStub } from "../../canonical/__tests__/canonical-agent-event-sink-stub.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { GoalLifecycleService } from "../../goals/goal-lifecycle-service.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { isTurnScopedEvent } from "../../turns/turn-runtime.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import * as NodeEvents from "node:events";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));
import { broadcast } from "../../../../application/transport/push.js";

function needsTurnExecutionId(event: unknown): event is Record<string, unknown> & { threadId: string } {
  return Boolean(
    event
    && typeof event === "object"
    && isTurnScopedEvent(event as Parameters<typeof isTurnScopedEvent>[0])
    && !(event as { turnExecutionId?: string }).turnExecutionId,
  );
}

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

  const gitService = {
    resolveWorkingDir: vi.fn(() => process.cwd()),
    listWorktrees: vi.fn(() => []),
  } as unknown as GitService;

  const attachmentService = {
    persist: vi.fn(() => Promise.resolve({ stored: [], persisted: [] })),
  } as unknown as AttachmentService;

  const makeGoal = (condition: string): GoalState => ({
    threadId: "test-thread",
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

  const providerStub = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
    id: "claude" as const,
    supportsCompletion: true,
    sessionForkOnResume: "unsupported" as const,
    maxInputCharactersPerTurn: 16_000,
    sendTurn: vi.fn<(params: { message: string; [k: string]: unknown }) => Promise<void>>(
      () => Promise.resolve(),
    ),
    setGoal: vi.fn<(sid: string, condition: string) => GoalState>((_, condition) => makeGoal(condition)),
    clearGoal: vi.fn<(sid: string) => boolean>(() => true),
    getGoal: vi.fn<(sid: string) => GoalState | undefined>(() => undefined),
    getGoalLookup: vi.fn<(_sid: string) => GoalLookupResult>(() => ({
      goal: null,
      authoritative: false,
      source: "claude-wrapper" as const,
      reason: "missing" as const,
    })),
    hasNativeGoalCommand: vi.fn<(sid: string) => boolean>(() => false),
    setNativeGoalMirror: vi.fn<(sid: string, condition: string) => GoalState>((_, condition) => makeGoal(condition)),
    clearNativeGoalMirror: vi.fn<(sid: string) => boolean>(() => true),
    runNativeGoalCommand: vi.fn<() => Promise<{ kind: "active"; objective: string } | { kind: "cleared"; objective: string } | { kind: "empty" } | { kind: "unavailable" } | null>>(
      () => Promise.resolve(null),
    ),
  }));
  // A provider lacking the goal capability (no setGoal/clearGoal/getGoal).
  // `/goal` must pass through to this provider as plain text.
  const nonGoalStub = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
    id: "gemini" as const,
    supportsCompletion: true,
    sessionForkOnResume: "unsupported" as const,
    maxInputCharactersPerTurn: 16_000,
    sendTurn: vi.fn<(params: { message: string; [k: string]: unknown }) => Promise<void>>(
      () => Promise.resolve(),
    ),
  }));
  const providerRegistry = {
    resolve: vi.fn((id: string) => (id === "claude" ? providerStub : nonGoalStub)),
    resolveAll: vi.fn(() => [providerStub]),
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
    assertCanStartTurn: vi.fn(),
    onPressureChange: vi.fn(),
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

  const eventPublication = new AgentEventPublicationRegistry();
  const svc = createAgentServiceForTest(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    attachmentService,
    providerRegistry,
    threadService,
    { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../events/persistence/hook-execution-repo.js").HookExecutionRepo,
    turnSnapshotRepo,
    snapshotService,
    db,
    memoryPressureService,
    settingsService,
    availability,
    planQuestionAnswersRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      container.resolve(NarrativeStore),
      new ParentAssistantTextCheckpointService(db),
      undefined,
      undefined,
      undefined,
      createCanonicalAgentEventSinkStub(db),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      eventPublication,
  );
  eventPublication.bind(() => undefined);
  eventPublication.start();
  const goals = new GoalLifecycleService(
    threadRepo,
    providerRegistry,
    messageRepo,
    db,
    svc.runtimeAccess() as never,
  );

  // Provider adapters always stamp turn-scoped events with the active execution
  // identity. Keep direct event fixtures on that same boundary, including the
  // post-turn receipt and auto-resume cases covered below.
  const emit = providerStub.emit.bind(providerStub);
  providerStub.emit = ((eventName: string, event?: unknown, ...args: unknown[]) => {
    if (eventName === "event" && needsTurnExecutionId(event)) {
      const source = event as Record<string, unknown> & { threadId: string };
      const current = svc.runtimeAccess().runtimeSnapshots()
        .find((snapshot) => snapshot.threadId === source.threadId);
      const active = current?.phase === "running" || current?.phase === "finalizing";
      const startsTurn = source.type === AgentEventType.TurnStarted || source.type === AgentEventType.Message;
      if (!current || (startsTurn && !active)) {
        const turnExecutionId = startProviderTurnForTest(svc, source.threadId);
        event = { ...source, turnExecutionId };
      } else {
        event = { ...source, turnExecutionId: current.turnExecutionId };
      }
    }
    return emit(eventName, event, ...args);
  }) as typeof providerStub.emit;

  return { svc, goals, threadRepo, workspaceRepo, messageRepo, providerStub, nonGoalStub };
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

    await svc.sendMessage({
      threadId: thread.id,
      content: "/goal analyse this branch",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

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

  it("tracks goal command effects through prepared, reserved, dispatched, and completed", async () => {
    const { goals, providerStub } = buildService(db);
    const outcome = await goals.routeCommand({
      threadId: thread.id,
      content: "/goal effect states",
      provider: providerStub,
    });
    if (outcome.kind !== "rewrite" || !("commandEffect" in outcome)) {
      throw new Error("Expected a typed goal command effect");
    }

    expect(goals.commandEffectState(outcome.commandEffect)).toBe("prepared");
    goals.reserveCommandEffect(outcome.commandEffect);
    expect(goals.commandEffectState(outcome.commandEffect)).toBe("reserved");
    await goals.dispatchCommandEffect(outcome.commandEffect);
    expect(goals.commandEffectState(outcome.commandEffect)).toBe("dispatched");
    goals.completeCommandEffect(outcome.commandEffect);
    expect(goals.commandEffectState(outcome.commandEffect)).toBeNull();
    expect(providerStub.setGoal).toHaveBeenCalledWith(`mcode-${thread.id}`, "effect states");
  });

  it("allocates a user sequence after a staged internal assistant", async () => {
    const { svc, messageRepo } = buildService(db);
    messageRepo.create(thread.id, "user", "prior question", 1);
    messageRepo.createAssistantIdempotent({
      id: "staged-assistant",
      threadId: thread.id,
      content: "staged answer",
      sequence: 2,
      isInternal: true,
    });

    await svc.sendMessage({
      threadId: thread.id,
      content: "follow-up question",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    const { messages } = messageRepo.listByThread(thread.id, 100);
    expect(messages.find((message) => message.content === "follow-up question")?.sequence).toBe(3);
  });

  it("installs a typed composer goal without persisting slash-command text", async () => {
    const { svc, providerStub, messageRepo } = buildService(db);

    await svc.sendMessage({
      threadId: thread.id,
      content: "Analyse this branch",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
      mentions: [],
      goalObjective: "Analyse this branch",
    });

    expect(providerStub.setGoal).toHaveBeenCalledWith(
      `mcode-${thread.id}`,
      "Analyse this branch",
    );
    expect(providerStub.sendTurn.mock.calls[0][0].message).toContain("directive");
    const { messages } = messageRepo.listByThread(thread.id, 100);
    expect(messages.find((message) => message.role === "user")?.content).toBe(
      "Analyse this branch",
    );
  });

  it("native Claude /goal sends exact slash-command wire text", async () => {
    const { svc, goals: _goals, providerStub } = buildService(db);
    providerStub.hasNativeGoalCommand.mockReturnValue(true);

    await svc.sendMessage({
      threadId: thread.id,
      content: "/goal analyse this branch",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(providerStub.setGoal).not.toHaveBeenCalled();
    expect(providerStub.setNativeGoalMirror).toHaveBeenCalledWith(
      `mcode-${thread.id}`,
      "analyse this branch",
    );
    expect(providerStub.sendTurn.mock.calls[0][0].message).toBe("/goal analyse this branch");
  });

  it("completes a direct say-goal when the assistant says the requested text", async () => {
    const { svc: _svc, goals: _goals, providerStub } = buildService(db);
    const activeGoal: GoalState = {
      threadId: thread.id,
      objective: "say hi",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 3,
      createdAt: Date.now() - 3_000,
      updatedAt: Date.now() - 3_000,
      providerId: "claude",
      source: "claude",
      controls: { canInspect: true, canClear: true },
    };
    providerStub.getGoal
      .mockReturnValueOnce(activeGoal)
      .mockReturnValue(undefined);

    providerStub.emit("event", {
      type: AgentEventType.Message,
      threadId: thread.id,
      content: "hi",
      tokens: null,
    } satisfies AgentEvent);

    for (let i = 0; i < 20 && providerStub.clearGoal.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(providerStub.clearGoal).toHaveBeenCalledWith(`mcode-${thread.id}`);
    expect(broadcast).toHaveBeenCalledWith("agent.event", expect.objectContaining({
      type: AgentEventType.GoalUpdated,
      threadId: thread.id,
      goal: expect.objectContaining({ objective: "say hi", status: "complete", providerId: "claude" }),
    }));
    expect(broadcast).toHaveBeenCalledWith("agent.event", expect.objectContaining({
      type: AgentEventType.GoalCleared,
      threadId: thread.id,
      providerId: "claude",
      reason: "completed",
    }));
  });

  it("does not complete broad goals from an arbitrary assistant answer", async () => {
    const { svc: _svc, goals: _goals, providerStub } = buildService(db);
    providerStub.getGoal.mockReturnValueOnce({
      threadId: thread.id,
      objective: "fix the bug",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      providerId: "claude",
      source: "claude",
      controls: { canInspect: true, canClear: true },
    } satisfies GoalState);

    providerStub.emit("event", {
      type: AgentEventType.Message,
      threadId: thread.id,
      content: "done",
      tokens: null,
    } satisfies AgentEvent);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(providerStub.clearGoal).not.toHaveBeenCalled();
  });

  it("does not emit direct-response completion events when provider clear returns false", async () => {
    const { svc: _svc, goals: _goals, providerStub } = buildService(db);
    const events: AgentEvent[] = [];
    providerStub.clearGoal.mockResolvedValueOnce(false);
    providerStub.getGoal
      .mockReturnValueOnce({
        threadId: thread.id,
        objective: "say hi",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 3,
        createdAt: Date.now() - 3_000,
        updatedAt: Date.now() - 3_000,
        providerId: "claude",
        source: "claude",
        controls: { canInspect: true, canClear: true },
      } satisfies GoalState)
      .mockReturnValue(undefined);
    providerStub.on("event", (event: AgentEvent) => events.push(event));

    providerStub.emit("event", {
      type: AgentEventType.Message,
      threadId: thread.id,
      content: "hi",
      tokens: null,
    } satisfies AgentEvent);

    for (let i = 0; i < 20 && providerStub.clearGoal.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(providerStub.clearGoal).toHaveBeenCalledWith(`mcode-${thread.id}`);
    expect(events.some((event) => event.type === AgentEventType.GoalUpdated)).toBe(false);
    expect(events.some((event) => event.type === AgentEventType.GoalCleared)).toBe(false);
  });

  it("rolls the installed goal back when the send fails so no Stop-hook gate lingers", async () => {
    const { svc, providerStub } = buildService(db);
    providerStub.sendTurn.mockRejectedValueOnce(new Error("provider boom"));

    // sendMessage swallows the send failure (emits an error event, marks the
    // thread errored) rather than rejecting, so this resolves normally.
    await svc.sendMessage({
      threadId: thread.id,
      content: "/goal analyse this branch",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    // onDispatch installed the goal just before the failing send...
    expect(providerStub.setGoal).toHaveBeenCalledWith(
      `mcode-${thread.id}`,
      "analyse this branch",
    );
    // ...and the catch ran onRollback so the gate does not leak into the next turn.
    expect(providerStub.clearGoal).toHaveBeenCalledWith(`mcode-${thread.id}`);
  });

  it("keeps the native goal mirror when a native control send fails", async () => {
    const { svc, providerStub } = buildService(db);
    providerStub.hasNativeGoalCommand.mockReturnValue(true);
    providerStub.sendTurn.mockRejectedValueOnce(new Error("provider boom"));

    await svc.sendMessage({
      threadId: thread.id,
      content: "/goal clear",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(providerStub.sendTurn.mock.calls[0][0].message).toBe("/goal off");
    expect(providerStub.clearNativeGoalMirror).not.toHaveBeenCalled();
  });

  it("/goal clear short-circuits — clears the goal, does NOT invoke the provider, broadcasts a Message pill without Ended", async () => {
    const { svc, providerStub, messageRepo } = buildService(db);

    await svc.sendMessage({
      threadId: thread.id,
      content: "/goal clear",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

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
    providerStub.getGoal.mockReturnValueOnce({
      threadId: thread.id,
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

    await svc.sendMessage({
      threadId: thread.id,
      content: "/goal",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(providerStub.sendTurn).not.toHaveBeenCalled();
    expect(providerStub.setGoal).not.toHaveBeenCalled();

    const { messages } = messageRepo.listByThread(thread.id, 100);
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContain("ship the feature");
  });

  it("providers without the goal capability pass /goal through as plain text", async () => {
    const { svc, providerStub, nonGoalStub } = buildService(db);

    await svc.sendMessage({
      threadId: thread.id,
      content: "/goal something",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "gemini",
    });

    // No goal install on the capable provider, and the non-capable provider
    // received the raw text (no rewrite).
    expect(providerStub.setGoal).not.toHaveBeenCalled();
    expect(nonGoalStub.sendTurn).toHaveBeenCalledTimes(1);
    expect(nonGoalStub.sendTurn.mock.calls[0][0].message).toBe("/goal something");
  });

  it("persists a Codex goal completion receipt that arrives after TurnComplete", async () => {
    const { svc: _svc, providerStub, messageRepo } = buildService(db);

    messageRepo.create(thread.id, "user", "/goal ship it", 1);

    providerStub.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: thread.id,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    });

    providerStub.emit("event", {
      type: AgentEventType.Message,
      threadId: thread.id,
      content: "Goal achieved in 19s.",
      tokens: null,
    });

    const { messages } = messageRepo.listByThread(thread.id, 100);
    expect(messages.map((m) => m.content)).toEqual([
      "/goal ship it",
      "Goal achieved in 19s.",
    ]);
  });

  it("rejects a normal send while the thread already has an active turn", async () => {
    const { svc, providerStub, messageRepo } = buildService(db);

    await svc.sendMessage({
      threadId: thread.id,
      content: "first turn",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const beforeMessages = messageRepo.listByThread(thread.id, 100).messages;
    providerStub.sendTurn.mockClear();

    await expect(
      svc.sendMessage({
        threadId: thread.id,
        content: "duplicate turn",
        permissionMode: "default",
        model: "claude-sonnet-4-6",
        attachments: [],
        provider: "claude",
      }),
    ).rejects.toThrow("already has an active agent session");

    expect(providerStub.sendTurn).not.toHaveBeenCalled();
    expect(messageRepo.listByThread(thread.id, 100).messages).toEqual(beforeMessages);
  });

  it("rolls back a prepared goal effect when runtime reservation fails", async () => {
    const { svc, providerStub, messageRepo } = buildService(db);
    await svc.sendMessage({
      threadId: thread.id,
      content: "first turn",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    providerStub.sendTurn.mockClear();

    await expect(svc.sendMessage({
      threadId: thread.id,
      content: "/goal reserve failure",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    })).rejects.toThrow("already has an active agent session");

    expect(goalLifecycleForAgentServiceTest(svc).pendingCommandEffectCount()).toBe(0);
    expect(providerStub.setGoal).not.toHaveBeenCalled();
    expect(providerStub.clearGoal).not.toHaveBeenCalled();
    expect(providerStub.sendTurn).not.toHaveBeenCalled();
    expect(messageRepo.listByThread(thread.id, 100).messages.map((message) => message.content)).toEqual(["first turn"]);
  });

  it("rejects concurrent normal sends before either can persist a duplicate row", async () => {
    const { svc, providerStub, messageRepo } = buildService(db);

    const first = svc.sendMessage({
      threadId: thread.id,
      content: "first turn",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const second = svc.sendMessage({
      threadId: thread.id,
      content: "duplicate turn",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    await expect(second).rejects.toThrow("already has an active agent session");
    await first;

    expect(providerStub.sendTurn).toHaveBeenCalledTimes(1);
    const contents = messageRepo.listByThread(thread.id, 100).messages.map((m) => m.content);
    expect(contents).toEqual(["first turn"]);
  });

  it("still handles /goal clear while the thread already has an active turn", async () => {
    const { svc, providerStub, messageRepo } = buildService(db);

    await svc.sendMessage({
      threadId: thread.id,
      content: "first turn",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    providerStub.sendTurn.mockClear();

    await svc.sendMessage({
      threadId: thread.id,
      content: "/goal clear",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(providerStub.clearGoal).toHaveBeenCalledWith(`mcode-${thread.id}`);
    expect(providerStub.sendTurn).not.toHaveBeenCalled();
    const contents = messageRepo.listByThread(thread.id, 100).messages.map((m) => m.content);
    expect(contents).toContain("/goal clear");
    expect(contents.some((content) => content.includes("Goal cleared"))).toBe(true);
  });

  it("thread.goal.clear during an active native Claude turn returns busy cache and keeps mirror", async () => {
    const { svc, goals, providerStub } = buildService(db);
    const activeGoal: GoalState = {
      threadId: thread.id,
      objective: "wait",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
      providerId: "claude",
      source: "claude",
      controls: { canInspect: true, canClear: true },
    };
    providerStub.hasNativeGoalCommand.mockReturnValue(true);
    providerStub.getGoalLookup.mockReturnValue({
      goal: activeGoal,
      authoritative: false,
      source: "claude-cache",
    });

    await svc.sendMessage({
      threadId: thread.id,
      content: "first turn",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    await expect(goals.clear(thread.id)).resolves.toEqual({
      goal: activeGoal,
      authoritative: false,
      source: "claude-cache",
      reason: "busy",
    });
    expect(providerStub.runNativeGoalCommand).not.toHaveBeenCalled();
    expect(providerStub.clearGoal).not.toHaveBeenCalled();
  });

  it("does not re-enter native Claude goal refresh while its own /goal read is in flight", async () => {
    const { svc: _svc, goals, providerStub } = buildService(db);
    const activeGoal: GoalState = {
      threadId: thread.id,
      objective: "wait",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
      providerId: "claude",
      source: "claude",
      controls: { canInspect: true, canClear: true },
    };
    let resolveNativeRead!: (value: { kind: "active"; objective: string }) => void;
    providerStub.hasNativeGoalCommand.mockReturnValue(true);
    providerStub.getGoal.mockReturnValue(activeGoal);
    providerStub.runNativeGoalCommand.mockReturnValue(new Promise((resolve) => {
      resolveNativeRead = resolve;
    }));
    goals.refreshAfterTurn(thread.id);

    for (let i = 0; i < 20 && providerStub.runNativeGoalCommand.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    goals.refreshAfterTurn(thread.id);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(providerStub.runNativeGoalCommand).toHaveBeenCalledTimes(1);
    resolveNativeRead({ kind: "active", objective: activeGoal.objective });
  });

  it("idle native thread.goal.clear dispatches /goal off and returns authoritative native clear", async () => {
    const { goals, providerStub } = buildService(db);
    providerStub.hasNativeGoalCommand.mockReturnValue(true);
    providerStub.runNativeGoalCommand.mockResolvedValue({ kind: "cleared", objective: "wait" });

    await expect(goals.clear(thread.id)).resolves.toEqual({
      goal: null,
      authoritative: true,
      source: "claude-native-command",
    });
    expect(providerStub.runNativeGoalCommand).toHaveBeenCalledWith(`mcode-${thread.id}`, "/goal off");
    expect(providerStub.clearGoal).not.toHaveBeenCalled();
  });

  it("post-turn native refresh emits complete then cleared once when status says no goal set", async () => {
    const { goals, providerStub } = buildService(db);
    const activeGoal: GoalState = {
      threadId: thread.id,
      objective: "say hi",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      providerId: "claude",
      source: "claude",
      controls: { canInspect: true, canClear: true },
    };
    providerStub.hasNativeGoalCommand.mockReturnValue(true);
    providerStub.getGoal.mockReturnValue(activeGoal);
    providerStub.runNativeGoalCommand.mockResolvedValue({ kind: "empty" });
    goals.refreshAfterTurn(thread.id);

    for (let i = 0; i < 20 && providerStub.runNativeGoalCommand.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(providerStub.runNativeGoalCommand).toHaveBeenCalledWith(`mcode-${thread.id}`, "/goal");
    expect(broadcast).toHaveBeenCalledWith("agent.event", expect.objectContaining({
      type: AgentEventType.GoalUpdated,
      goal: expect.objectContaining({ status: "complete", objective: "say hi" }),
    }));
    expect(broadcast).toHaveBeenCalledWith("agent.event", expect.objectContaining({
      type: AgentEventType.GoalCleared,
      reason: "completed",
    }));
  });

  it("post-turn native refresh does not enqueue /goal if a new turn starts after reading the cache", async () => {
    const { svc: _svc, goals, providerStub } = buildService(db);
    const activeGoal: GoalState = {
      threadId: thread.id,
      objective: "say hi",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      providerId: "claude",
      source: "claude",
      controls: { canInspect: true, canClear: true },
    };
    let resolveGoal!: (goal: GoalState) => void;
    providerStub.hasNativeGoalCommand.mockReturnValue(true);
    providerStub.getGoal.mockImplementation(() => new Promise<GoalState>((resolve) => {
      resolveGoal = resolve;
    }) as unknown as GoalState);
    goals.refreshAfterTurn(thread.id);

    await new Promise<void>((resolve) => setImmediate(resolve));
    providerStub.emit("event", {
      type: AgentEventType.TurnStarted,
      threadId: thread.id,
    } satisfies AgentEvent);
    resolveGoal(activeGoal);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(providerStub.runNativeGoalCommand).not.toHaveBeenCalled();
  });
});
