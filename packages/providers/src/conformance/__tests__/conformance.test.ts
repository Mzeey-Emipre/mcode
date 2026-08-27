import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEventDraft } from "../../host-ports.js";
import {
  DeterministicCanonicalSink,
  ENABLED_PROVIDER_CONFORMANCE,
  createProviderFixtureManifest,
  loadProviderFixtureManifest,
  runFactoryCoreProfile,
  runCursorAcpTraceProfile,
  runMapperProfile,
  sanitizeProviderFixtureFile,
  validateProviderConformanceRegistry,
  validateProviderFixtureManifest,
  type ProviderFixtureManifest,
  type SanitizedTraceEvent,
} from "../index.js";

describe("Provider conformance registry", () => {
  it("covers every enabled factory with core fixtures and supported versions", async () => {
    const fixtures = validateProviderConformanceRegistry(ENABLED_PROVIDER_CONFORMANCE);
    const codex = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "codex")!;
    expect(codex.requiredProfiles).toEqual([
      "core",
      "build",
      "plan",
      "goals",
      "permissions",
      "usage",
      "session-eviction",
      "clean-fork",
      "orchestration",
      "browser-access",
      "thread-control",
      "child-cancellation",
    ]);

    expect([...new Set(fixtures.map((fixture) => fixture.providerId))].sort()).toEqual([
      "claude",
      "codex",
      "copilot",
      "cursor",
    ]);
    await expect(Promise.all(ENABLED_PROVIDER_CONFORMANCE.map(runFactoryCoreProfile))).resolves.toEqual([
      { providerId: "claude", spawnCount: 1, terminalType: "turn.completed" },
      { providerId: "codex", spawnCount: 1, terminalType: "turn.completed" },
      { providerId: "copilot", spawnCount: 1, terminalType: "turn.completed" },
      { providerId: "cursor", spawnCount: 1, terminalType: "turn.completed" },
    ]);
  });

  it("fails when a Provider loses manifests, profile coverage, or version evidence", () => {
    const registration = ENABLED_PROVIDER_CONFORMANCE[0]!;

    expect(() => validateProviderConformanceRegistry([
      { ...registration, fixtureFiles: [] },
    ])).toThrow("lacks fixture manifests");
    expect(() => validateProviderConformanceRegistry([
      { ...registration, requiredProfiles: [] },
    ])).toThrow("lacks core profile coverage");
    expect(() => validateProviderConformanceRegistry([
      { ...registration, supportedVersions: [] },
    ])).toThrow("lacks supported-version evidence");

    const cursor = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "cursor")!;
    expect(() => validateProviderConformanceRegistry([
      { ...cursor, fixtureFiles: cursor.fixtureFiles.filter((file) => !file.endsWith("captured.json")) },
    ])).toThrow("lacks captured fixture coverage");
  });

  it("covers each declared Cursor capability with captured and synthetic ACP trace envelopes", async () => {
    const cursor = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "cursor")!;
    const cursorFixtures = cursor.fixtureFiles.map(loadProviderFixtureManifest);
    const captured = cursorFixtures.find((fixture) => fixture.provenance === "captured")!;
    const synthetic = cursorFixtures.find((fixture) => fixture.provenance === "synthetic")!;

    expect([...new Set(cursorFixtures.flatMap((fixture) => fixture.requiredProfiles))].sort()).toEqual(
      [...cursor.requiredProfiles].sort(),
    );
    expect(captured.requiredProfiles).toEqual(["core", "build"]);
    expect(synthetic.requiredProfiles).toEqual(cursor.requiredProfiles);
    await expect(Promise.all(cursorFixtures.map(runCursorAcpTraceProfile))).resolves.toEqual([
      {
        scenario: "synthetic Cursor ACP lifecycle and unsupported extension replay",
        coveredProfiles: cursor.requiredProfiles,
        emittedEventTypes: ["toolUse", "toolResult", "toolUse", "toolUse", "toolResult"],
        toolNames: ["Read", "Agent", "Agent"],
        unsupportedMethods: ["cursor/task", "cursor/continue"],
      },
      {
        scenario: "captured Cursor ACP tool and child lifecycle envelope replay",
        coveredProfiles: ["core", "build"],
        emittedEventTypes: ["toolUse", "toolUse", "toolResult", "toolUse", "toolResult"],
        toolNames: ["Agent", "Agent", "Read"],
        unsupportedMethods: [],
      },
    ]);
  });

  it("registers a sanitized Codex adversarial fixture without private content", () => {
    const registration = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "codex")!;
    const fixture = registration.fixtureFiles
      .map(loadProviderFixtureManifest)
      .find(({ scenario }) => scenario.includes("adversarial"));

    expect(fixture?.provenance).toBe("synthetic");
    expect(JSON.stringify(fixture?.input)).not.toMatch(
      /prompt|response|secret|token|password|environment|absolute path|raw|output|[A-Z]:[\\/]|\\\\/i,
    );
    expect(fixture?.expected.terminal).toBe("errored");
  });
});

describe("Provider fixture pipeline", () => {
  const fixtureFile = ENABLED_PROVIDER_CONFORMANCE.find(({ providerId }) => providerId === "codex")!.fixtureFiles[0]!;

  it("replays structural protocol input into validated canonical drafts", () => {
    const fixture = loadProviderFixtureManifest(fixtureFile);
    const routing = {
      threadId: "THREAD_1",
      turnId: "TURN_1",
      executionId: "00000000-0000-4000-8000-000000000001",
    };
    const mapper = {
      map(events: readonly SanitizedTraceEvent[]): readonly ProviderEventDraft[] {
        return events.map((event) => ({
          eventId: `${event.kind}:${event.sequence}`,
          routing,
          sourceProviderId: "codex",
          sourceIdentities: event.nativeId
            ? [{ providerId: "codex", scope: "item", value: event.nativeId, provenance: "native" }]
            : [],
          sourceSequence: event.sequence,
          payload: event.kind === "terminal"
            ? { type: "turn.completed", endedAt: "1970-01-01T00:00:05.000Z" }
            : { type: "ingest.volatile-truncated", droppedEventCount: event.size ?? 1 },
        }));
      },
    };

    const drafts = runMapperProfile({
      fixture,
      nativeInput: fixture.input.events,
      mapper,
      summarize: (mapped) => ({
        orderedKinds: mapped.map((draft) => draft.eventId.split(":")[0] as SanitizedTraceEvent["kind"]),
        terminal: "completed",
        toolPairs: [["PAIR_1", "PAIR_1"]],
      }),
    });

    expect(drafts).toHaveLength(5);
    expect(drafts[0]?.sourceIdentities[0]).toMatchObject({ provenance: "native", value: "SESSION_1" });
  });

  it("computes the source hash and rejects sensitive or unreviewed content", () => {
    const fixture = loadProviderFixtureManifest(fixtureFile);
    const rebuilt = createProviderFixtureManifest(omitGeneratedFields(fixture));

    expect(rebuilt.sourceHash).toBe(fixture.sourceHash);
    expect(() => validateProviderFixtureManifest({ ...fixture, prompt: "private request" })).toThrow(
      "forbidden field: prompt",
    );
    expect(() => validateProviderFixtureManifest({
      ...fixture,
      scenario: "Bearer private-credential-value",
    })).toThrow("secret-shaped data");
    expect(() => validateProviderFixtureManifest({
      ...fixture,
      scenario: "C:\\Users\\person\\repo",
    })).toThrow("absolute path");
    expect(() => validateProviderFixtureManifest({
      ...fixture,
      redaction: { ...fixture.redaction, reviewed: false },
    })).toThrow("requires redaction review");
  });

  it("sanitizes raw rows without retaining private fields or native identifiers", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-conformance-"));
    const priorCwd = process.cwd();
    try {
      process.chdir(root);
      mkdirSync(".conformance-raw", { recursive: true });
      mkdirSync("src/conformance/fixtures", { recursive: true });
      writeFileSync(".conformance-raw/capture.jsonl", [
        JSON.stringify({ kind: "turn", nativeId: "private-native-id", status: "started", prompt: "private prompt" }),
        JSON.stringify({ kind: "terminal", nativeId: "private-native-id", status: "completed", rawOutput: "private output" }),
      ].join("\n"));

      const manifest = sanitizeProviderFixtureFile({
        rawFile: ".conformance-raw/capture.jsonl",
        outputFile: "src/conformance/fixtures/captured.json",
        metadata: {
          providerId: "codex",
          cliVersion: "1.2.3",
          protocolVersion: "2",
          provenance: "captured",
          requiredProfiles: ["core"],
          scenario: "captured lifecycle",
          expected: { orderedKinds: ["turn", "terminal"], terminal: "completed", toolPairs: [] },
        },
      });
      const output = readFileSync("src/conformance/fixtures/captured.json", "utf8");

      expect(manifest.input.events[0]?.nativeId).toMatch(/^NATIVE_/);
      expect(output).not.toContain("private-native-id");
      expect(output).not.toContain("private prompt");
      expect(output).not.toContain("private output");
    } finally {
      process.chdir(priorCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Deterministic canonical sink", () => {
  it.each([
    {
      type: "turn.completed" as const,
      payload: { type: "turn.completed" as const, endedAt: "1970-01-01T00:00:01.000Z" },
    },
    {
      type: "turn.cancelled" as const,
      payload: {
        type: "turn.cancelled" as const,
        endedAt: "1970-01-01T00:00:01.000Z",
        reason: "user stop",
      },
    },
    {
      type: "turn.interrupted" as const,
      payload: {
        type: "turn.interrupted" as const,
        endedAt: "1970-01-01T00:00:01.000Z",
        reason: "provider restart",
      },
    },
    {
      type: "turn.errored" as const,
      payload: {
        type: "turn.errored" as const,
        endedAt: "1970-01-01T00:00:01.000Z",
        error: "provider failed",
      },
    },
  ])("ignores and diagnoses events after $type", async ({ type, payload }) => {
    const sink = new DeterministicCanonicalSink();
    const routing = {
      threadId: "THREAD_1",
      turnId: "TURN_1",
      executionId: "00000000-0000-4000-8000-000000000001",
    };
    const terminal: ProviderEventDraft = {
      eventId: `terminal:${type}`,
      routing,
      sourceProviderId: "codex",
      sourceIdentities: [],
      payload,
    };
    const lateEvent: ProviderEventDraft = {
      eventId: `late:${type}`,
      routing,
      sourceProviderId: "codex",
      sourceIdentities: [],
      payload: { type: "ingest.volatile-truncated", droppedEventCount: 1 },
    };

    await sink.submit({ ...routing, phase: "streaming", events: [terminal] });
    await sink.submit({ ...routing, phase: "late", events: [lateEvent] });

    expect(sink.snapshot().events.map(({ payload: eventPayload }) => eventPayload.type)).toEqual([type]);
    expect(sink.snapshot().diagnostics).toEqual([`Ignored event ingest.volatile-truncated after ${type}`]);
  });

  it("reserves terminal capacity and emits explicit overflow evidence", async () => {
    const sink = new DeterministicCanonicalSink({ maxEvents: 3, maxDiagnostics: 2 });
    const routing = {
      threadId: "THREAD_1",
      turnId: "TURN_1",
      executionId: "00000000-0000-4000-8000-000000000001",
    };
    const events: ProviderEventDraft[] = Array.from({ length: 4 }, (_, index) => ({
      eventId: `event:${index}`,
      routing,
      sourceProviderId: "codex",
      sourceIdentities: [],
      sourceSequence: index + 1,
      payload: { type: "ingest.volatile-truncated", droppedEventCount: 1 },
    }));

    await sink.submit({ ...routing, phase: "streaming", events });
    await sink.submit({
      ...routing,
      phase: "late",
      events: [{ ...events[0]!, eventId: "late-event" }],
    });

    expect(sink.snapshot().events.map(({ payload }) => payload.type)).toEqual([
      "ingest.volatile-truncated",
      "ingest.volatile-truncated",
      "ingest.overflow",
    ]);
    expect(sink.snapshot().diagnostics[0]).toContain("after ingest.overflow");
  });
});

function omitGeneratedFields(
  fixture: ProviderFixtureManifest,
): Omit<ProviderFixtureManifest, "contractVersion" | "sourceHash"> {
  const {
    contractVersion: _contractVersion,
    sourceHash: _sourceHash,
    ...input
  } = fixture;
  return input;
}
