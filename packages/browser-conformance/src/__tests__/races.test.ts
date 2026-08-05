import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_CONFORMANCE_EVENT_KINDS,
  BROWSER_CONFORMANCE_HIGH_RISK_REVISION_COMBINATIONS,
  BROWSER_CONFORMANCE_RACE_CATALOGUE,
  createBrowserConformanceRaceSchedules,
  createBrowserConformanceResourceSnapshot,
  createBrowserConformanceScenario,
  createBrowserConformanceSchedule,
  createBrowserConformanceRevisionRaceSchedules,
  createBrowserExecutorParityScenario,
  normalizeBrowserConformanceRun,
  runBrowserConformanceScenarioWithReplay,
  runBrowserConformanceExecutorScenario,
  type BrowserConformanceNormalizedRun,
  type BrowserConformanceReceipt,
  type BrowserConformanceResourceSnapshot,
  type BrowserConformanceScheduledEvent,
  type BrowserConformanceSubject,
} from "../index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Browser conformance named races", () => {
  it("keeps every reviewed race named, categorized, and non-unknown", () => {
    expect(BROWSER_CONFORMANCE_RACE_CATALOGUE).toHaveLength(32);
    expect(new Set(BROWSER_CONFORMANCE_RACE_CATALOGUE.map((race) => race.id)).size)
      .toBe(BROWSER_CONFORMANCE_RACE_CATALOGUE.length);
    expect(new Set(BROWSER_CONFORMANCE_RACE_CATALOGUE.map((race) => race.family)))
      .toEqual(new Set(["bootstrap", "action", "observation", "batch", "cleanup"]));
    for (const race of BROWSER_CONFORMANCE_RACE_CATALOGUE) {
      expect(race.id).toMatch(/^[a-z0-9-]+$/);
      expect(race.events.length).toBeGreaterThan(0);
      expect(race.invariant).not.toMatch(/unknown/i);
      expect(race.invariant).toMatch(/(?:one|exactly|known|without|cannot|does not|invalidat|reject|preserv|stop|release|inert|generation|owner|effect|outcome)/i);
      for (const event of race.events) expect(BROWSER_CONFORMANCE_EVENT_KINDS).toContain(event);
    }
  });

  it("covers each race meaning explicitly", () => {
    const ids = new Set(BROWSER_CONFORMANCE_RACE_CATALOGUE.map((race) => race.id));
    for (const id of [
      "bootstrap-disconnect-reconnect", "bootstrap-concurrent-open", "bootstrap-cancel", "bootstrap-timeout",
      "bootstrap-close", "bootstrap-lost-response", "bootstrap-idempotent-replay", "bootstrap-late-creation",
      "action-takeover", "action-navigation", "action-reload", "action-close", "action-resize", "action-cancel",
      "action-timeout", "action-competing-mutation", "observation-host-revision", "observation-document-revision",
      "observation-control-revision", "observation-capability-revision", "observation-observation-revision",
      "batch-invalidation", "batch-navigation", "batch-partial-failure", "batch-deadline", "batch-cancel-between-steps",
      "cleanup-late-response", "cleanup-late-event", "cleanup-late-timer", "cleanup-disconnect", "cleanup-replacement",
      "cleanup-capacity",
    ]) expect(ids).toContain(id);
    expect(BROWSER_CONFORMANCE_RACE_CATALOGUE.find((race) => race.id === "cleanup-late-event")?.events)
      .toEqual(["late-event"]);
    expect(BROWSER_CONFORMANCE_RACE_CATALOGUE.find((race) => race.id === "cleanup-late-timer")?.events)
      .toEqual(["late-timer"]);
  });

  it("generates bounded byte-for-byte schedules for every revision, pair, and high-risk set", async () => {
    const options = { seed: "revision-race-seed", maxCommands: 3, maxEvents: 8, maxCheckpoints: 4, maxTick: 12 } as const;
    const first = createBrowserConformanceRevisionRaceSchedules(options);
    const second = createBrowserConformanceRaceSchedules(options);
    const differentSeed = createBrowserConformanceRevisionRaceSchedules({ ...options, seed: "revision-race-seed-2" });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(differentSeed));
    expect(Object.keys(first.individual)).toHaveLength(5);
    expect(first.pairs).toHaveLength(10);
    expect(first.highRisk).toHaveLength(BROWSER_CONFORMANCE_HIGH_RISK_REVISION_COMBINATIONS.length);
    const schedules = [
      ...Object.values(first.individual),
      ...first.pairs,
      ...first.highRisk,
    ];
    for (const generated of schedules) {
      const { schedule } = generated;
      expect(schedule.events.length).toBeLessThanOrEqual(schedule.bounds.maxEvents);
      expect(schedule.checkpoints.length).toBeLessThanOrEqual(schedule.bounds.maxCheckpoints);
      expect(schedule.events.every((event) => event.order.tick <= schedule.bounds.maxTick)).toBe(true);
      expect(schedule.events.map((event) => event.revision)).toEqual(generated.revisions);
      expect(new Set(schedule.events.map((event) => event.revision))).toEqual(new Set(generated.revisions));
      expect(new Set([
        ...schedule.events.map((event) => `${event.order.tick}:${event.order.ordinal}`),
        ...schedule.checkpoints.map((checkpoint) => `${checkpoint.order.tick}:${checkpoint.order.ordinal}`),
      ]).size).toBe(schedule.events.length + schedule.checkpoints.length);

      const subject = new RecordingSubject();
      await executeScheduledSubject(subject, schedule);
      expect(subject.injectedEvents.map((event) => `${event.kind}:${event.revision ?? ""}`))
        .toEqual(schedule.events.map((event) => `${event.kind}:${event.revision ?? ""}`));
    }
  });

  it.each([
    ["completed", undefined],
    ["failed", "timeout"],
    ["interrupted", "cancel"],
    ["failed", "host-disconnect"],
  ] as const)("does not resurrect resources after terminal %s activity", async (status, terminalEvent) => {
    const subject = new TerminalSubject(status);
    const baseline = subject.snapshotResources();
    if (terminalEvent) await subject.injectExternalEvent({ order: { tick: 0, ordinal: 0 }, kind: terminalEvent });
    await subject.dispatch({ id: "terminal", operation: "open" });
    await subject.drainToQuiescence();
    await subject.dispose();
    const postDispose = subject.snapshotResources();
    await subject.injectExternalEvent({ order: { tick: 1, ordinal: 1 }, kind: "late-response" });
    await subject.injectExternalEvent({ order: { tick: 2, ordinal: 2 }, kind: "target-register" });
    await subject.drainToQuiescence();
    expect(subject.snapshotResources()).toEqual(postDispose);
    expect(postDispose).toEqual(createBrowserConformanceResourceSnapshot());
    expect(subject.snapshotOutcome().outcome.status).not.toBe("unknown");
    expect(subject.snapshotOutcome().outcome.effect).not.toBe("unknown");
    expect(baseline.revisions).toEqual(createBrowserConformanceResourceSnapshot().revisions);
  });

  it("writes a bounded sanitized replay for each thrown scenario invariant", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-browser-race-replay-"));
    temporaryRoots.push(root);
    const race = BROWSER_CONFORMANCE_RACE_CATALOGUE.find((entry) => entry.id === "cleanup-late-response")!;
    const subject = new RecordingSubject(true);
    const scenario = createBrowserConformanceScenario({
      id: race.id,
      seed: "replay-race-seed",
      commands: [{ id: "race", operation: "inspect", args: { typedText: "do-not-retain" } }],
      cleanup: { baseline: subject.snapshotResources() },
    });
    const failingInvariant = race.invariant;
    let thrown: unknown;
    try {
      await runBrowserConformanceScenarioWithReplay(scenario, subject, {
        workspaceRoot: root,
        failingInvariant,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("race invariant failed");
    expect(subject.disposeCount).toBe(1);
    const replayPath = join(root, ".dev", "verification", "browser-conformance", `replay-${scenario.seed}.json`);
    const replay = JSON.parse(await readFile(replayPath, "utf8")) as { seed: number; failingInvariant: string };
    expect(replay.seed).toBe(scenario.seed);
    expect(replay.failingInvariant).toBe(failingInvariant);
  });

  it("writes a failed replay even when the subject cannot snapshot its run", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-browser-snapshot-replay-"));
    temporaryRoots.push(root);
    const scenario = createBrowserConformanceScenario({
      id: "snapshot-failure",
      seed: "snapshot-failure-seed",
      commands: [{ id: "inspect", operation: "inspect" }],
      cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
    });
    const subject = new RecordingSubject(false, true);
    await expect(runBrowserConformanceScenarioWithReplay(scenario, subject, {
      workspaceRoot: root,
      failingInvariant: "snapshot remains available for replay",
    })).rejects.toThrow("snapshot unavailable");
    const replayPath = join(root, ".dev", "verification", "browser-conformance", `replay-${scenario.seed}.json`);
    const replay = JSON.parse(await readFile(replayPath, "utf8")) as { failingInvariant: string; run: { outcome: { status: string } } };
    expect(replay.failingInvariant).toBe("snapshot remains available for replay");
    expect(replay.run.outcome.status).toBe("failed");
  });

  it("uses the replay runner around the shared executor scenario failure path", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-browser-executor-replay-"));
    temporaryRoots.push(root);
    const parity = createBrowserExecutorParityScenario();
    const subject = new RecordingSubject(true);
    await expect(runBrowserConformanceScenarioWithReplay(parity.scenario, subject, {
      workspaceRoot: root,
      failingInvariant: "shared executor invariant",
    })).rejects.toThrow("race invariant failed");
    const replayPath = join(root, ".dev", "verification", "browser-conformance", `replay-${parity.scenario.seed}.json`);
    const replay = JSON.parse(await readFile(replayPath, "utf8")) as { scenarioId: string; failingInvariant: string };
    expect(replay.scenarioId).toBe(parity.scenario.id);
    expect(replay.failingInvariant).toBe("shared executor invariant");
  });

  it("injects each scheduled event once and validates checkpoints in the shared runner", async () => {
    const schedule = createBrowserConformanceSchedule({ seed: 91, maxCommands: 1, maxEvents: 1, maxCheckpoints: 1, maxTick: 3, eventCount: 1, checkpointCount: 1 });
    const scenario = createBrowserConformanceScenario({ id: "runner-order", seed: 91, commands: [{ id: "inspect", operation: "inspect" }], schedule, cleanup: { baseline: createBrowserConformanceResourceSnapshot() } });
    const subject = new RecordingSubject();
    await runBrowserConformanceExecutorScenario(scenario, subject);
    expect(subject.injectedEvents).toHaveLength(1);
    expect(subject.disposeCount).toBe(1);

    const failingSchedule = { ...schedule, checkpoints: schedule.checkpoints.map((checkpoint) => ({ ...checkpoint, expectedRevisions: { ...checkpoint.expectedRevisions, host: 1 } })) };
    const failingScenario = createBrowserConformanceScenario({ id: "runner-checkpoint-failure", seed: 91, commands: [{ id: "inspect", operation: "inspect" }], schedule: failingSchedule, cleanup: { baseline: createBrowserConformanceResourceSnapshot() } });
    const failingSubject = new RecordingSubject();
    await expect(runBrowserConformanceExecutorScenario(failingScenario, failingSubject)).rejects.toThrow(/checkpoint/);
    expect(failingSubject.injectedEvents).toHaveLength(1);
    expect(failingSubject.disposeCount).toBe(1);
  });

  it("orders a same-tick checkpoint before a later-ordinal event", async () => {
    const schedule = {
      ...createBrowserConformanceSchedule({ seed: 92, maxCommands: 1, maxEvents: 1, maxCheckpoints: 1, maxTick: 2, eventCount: 0, checkpointCount: 0 }),
      events: [{ order: { tick: 0, ordinal: 1 }, kind: "host-disconnect" as const, revision: "host" as const }],
      checkpoints: [{ order: { tick: 0, ordinal: 0 }, id: "before-host", label: "before host", expectedRevisions: { host: 0 } }],
    };
    const scenario = createBrowserConformanceScenario({
      id: "same-tick-ordinal-order",
      seed: 92,
      commands: [{ id: "inspect", operation: "inspect" }],
      schedule,
      cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
    });
    const subject = new RecordingSubject();
    await runBrowserConformanceExecutorScenario(scenario, subject);
    expect(subject.injectedEvents.map((event) => event.revision)).toEqual(["host"]);
    expect(subject.observedOrder.filter((entry) => entry.startsWith("command:") || entry.startsWith("event:")))
      .toEqual(["command:inspect", "event:host-disconnect"]);
  });

  it("advances the virtual clock again when a later tick remains after commands", async () => {
    const schedule = {
      ...createBrowserConformanceSchedule({ seed: 93, maxCommands: 1, maxEvents: 1, maxCheckpoints: 0, maxTick: 4, eventCount: 0, checkpointCount: 0 }),
      events: [{ order: { tick: 4, ordinal: 0 }, kind: "timeout" as const }],
    };
    const scenario = createBrowserConformanceScenario({
      id: "later-tick-advancement",
      seed: 93,
      commands: [{ id: "inspect", operation: "inspect" }],
      schedule,
      cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
    });
    const subject = new RecordingSubject();
    await runBrowserConformanceExecutorScenario(scenario, subject);
    expect(subject.advancedTicks).toEqual([0, 4]);
  });

  it("enforces cleanup after disposal while preserving an explicitly bounded target", async () => {
    const final = createBrowserConformanceResourceSnapshot({
      identities: { targets: [{ id: "target-a", generation: 1 }] },
    });
    const scenario = createBrowserConformanceScenario({
      id: "cleanup-bound",
      seed: 94,
      commands: [],
      cleanup: { baseline: createBrowserConformanceResourceSnapshot(), allowedGrowth: { targets: 1 } },
    });
    const subject = new CleanupSubject(final);
    await runBrowserConformanceExecutorScenario(scenario, subject);
    expect(subject.disposeCount).toBe(1);
  });

  it.each([
    ["growth", createBrowserConformanceResourceSnapshot({ identities: { targets: [{ id: "target-a", generation: 1 }, { id: "target-b", generation: 1 }] } }), "targets"],
    ["identity", createBrowserConformanceResourceSnapshot({ identities: { targets: [{ id: "target-a", generation: 2 }] } }), "targets"],
  ] as const)("turns cleanup %s into a replayable scenario failure", async (_kind, final, resource) => {
    const root = await mkdtemp(join(tmpdir(), "mcode-browser-cleanup-replay-"));
    temporaryRoots.push(root);
    const baseline = createBrowserConformanceResourceSnapshot({ identities: { targets: [{ id: "target-a", generation: 1 }] } });
    const scenario = createBrowserConformanceScenario({
      id: `cleanup-${_kind}`,
      seed: 95,
      commands: [],
      cleanup: { baseline, allowedGrowth: { targets: 0 } },
    });
    const subject = new CleanupSubject(final);
    await expect(runBrowserConformanceScenarioWithReplay(scenario, subject, {
      workspaceRoot: root,
      failingInvariant: "cleanup resources must be released",
    })).rejects.toThrow(new RegExp(`cleanup failed: ${resource}`));
    expect(subject.disposeCount).toBe(1);
    const replayPath = join(root, ".dev", "verification", "browser-conformance", `replay-${scenario.seed}.json`);
    const replay = JSON.parse(await readFile(replayPath, "utf8")) as { cleanup: { comparison?: { violations?: Array<{ resource: string }> } } };
    expect(replay.cleanup.comparison?.violations?.map((violation) => violation.resource)).toContain(resource);
  });
});

async function executeScheduledSubject(
  subject: BrowserConformanceSubject & { readonly events?: readonly BrowserConformanceScheduledEvent[] },
  schedule: { readonly events: readonly BrowserConformanceScheduledEvent[] },
): Promise<void> {
  for (const event of schedule.events) subject.schedule(event);
  for (const event of schedule.events) {
    await subject.advanceClock(event.order.tick);
    await subject.injectExternalEvent(event);
  }
}

class RecordingSubject implements BrowserConformanceSubject {
  readonly injectedEvents: BrowserConformanceScheduledEvent[] = [];
  readonly advancedTicks: number[] = [];
  readonly observedOrder: string[] = [];
  private disposed = false;
  private outcome = normalizeBrowserConformanceRun({ finalState: { resources: {} } });
  disposeCount = 0;

  constructor(private readonly failDispatch = false, private readonly failSnapshot = false) {}

  schedule(_event: BrowserConformanceScheduledEvent): void {}
  async advanceClock(tick: number): Promise<void> { this.advancedTicks.push(tick); }
  async injectExternalEvent(event: BrowserConformanceScheduledEvent): Promise<void> {
    if (!this.disposed) {
      this.injectedEvents.push(event);
      this.observedOrder.push(`event:${event.kind}`);
      if (event.revision) {
        const revisions = { ...this.outcome.finalState.revisions, [event.revision]: this.outcome.finalState.revisions[event.revision] + 1 };
        this.outcome = normalizeBrowserConformanceRun({ ...this.outcome, finalState: { ...this.outcome.finalState, revisions } });
      }
    }
  }
  async dispatch(command: { id: string; operation: "inspect" }): Promise<BrowserConformanceReceipt> {
    if (this.failDispatch) throw new Error("race invariant failed");
    this.observedOrder.push(`command:${command.id}`);
    const receipt = normalizeBrowserConformanceRun({ receipts: [{ commandId: command.id, operation: command.operation, status: "satisfied", effect: "none", recovery: "none" }] }).receipts[0]!;
    this.outcome = normalizeBrowserConformanceRun({ receipts: [receipt], outcome: { status: "completed", effect: "none", recovery: "none" }, finalState: { resources: {} } });
    return receipt;
  }
  snapshotOutcome(): BrowserConformanceNormalizedRun {
    if (this.failSnapshot) throw new Error("snapshot unavailable");
    return this.outcome;
  }
  snapshotResources(): BrowserConformanceResourceSnapshot { return createBrowserConformanceResourceSnapshot(); }
  async drainToQuiescence(): Promise<void> {}
  async dispose(): Promise<void> { this.disposeCount += 1; this.disposed = true; }
}

class CleanupSubject implements BrowserConformanceSubject {
  disposeCount = 0;
  private disposed = false;
  private readonly outcome = normalizeBrowserConformanceRun({ finalState: { resources: {} } });

  constructor(private readonly finalResources: BrowserConformanceResourceSnapshot) {}

  schedule(_event: BrowserConformanceScheduledEvent): void {}
  async advanceClock(_tick: number): Promise<void> {}
  async injectExternalEvent(_event: BrowserConformanceScheduledEvent): Promise<void> {}
  async dispatch(_command: { id: string; operation: "inspect" }): Promise<BrowserConformanceReceipt> {
    throw new Error("cleanup subject has no commands");
  }
  snapshotOutcome(): BrowserConformanceNormalizedRun { return this.outcome; }
  snapshotResources(): BrowserConformanceResourceSnapshot {
    return this.disposed ? this.finalResources : this.finalResources;
  }
  async drainToQuiescence(): Promise<void> {}
  async dispose(): Promise<void> { this.disposeCount += 1; this.disposed = true; }
}

class TerminalSubject implements BrowserConformanceSubject {
  private disposed = false;
  private readonly resources = createBrowserConformanceResourceSnapshot();
  private outcome: BrowserConformanceNormalizedRun;

  constructor(status: "completed" | "failed" | "interrupted") {
    this.outcome = normalizeBrowserConformanceRun({ outcome: { status, effect: status === "completed" ? "complete" : "none", recovery: status === "completed" ? "none" : "inspect" }, finalState: { resources: this.resources } });
  }
  schedule(_event: BrowserConformanceScheduledEvent): void {}
  async advanceClock(_tick: number): Promise<void> {}
  async injectExternalEvent(_event: BrowserConformanceScheduledEvent): Promise<void> {}
  async dispatch(command: { id: string; operation: "open" }): Promise<BrowserConformanceReceipt> {
    const receipt = normalizeBrowserConformanceRun({ receipts: [{ commandId: command.id, operation: command.operation, status: "applied", effect: "created", recovery: "none" }], outcome: this.outcome.outcome, finalState: { resources: this.resources } }).receipts[0]!;
    this.outcome = normalizeBrowserConformanceRun({ receipts: [receipt], outcome: this.outcome.outcome, finalState: { resources: this.resources } });
    return receipt;
  }
  snapshotOutcome(): BrowserConformanceNormalizedRun { return this.outcome; }
  snapshotResources(): BrowserConformanceResourceSnapshot { return this.resources; }
  async drainToQuiescence(): Promise<void> {}
  async dispose(): Promise<void> { this.disposed = true; }
}
