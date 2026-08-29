import {
  AgentEventRoutingSchema,
  CanonicalAgentEventSchema,
  type CanonicalAgentEvent,
} from "@mcode/agent-model";
import type { AgentEvent } from "@mcode/contracts";
import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";
import type { ProviderFactoryInput } from "../factory-types.js";
import type { ProviderEventDraft, ProviderHostPorts } from "../host-ports.js";
import { CursorAcpClientBridge } from "../private/cursor/acp/cursor-acp-client-bridge.js";
import { createCursorAcpTurnState } from "../private/cursor/acp/cursor-acp-event-mapper.js";
import type { CursorAcpSessionEntry } from "../private/cursor/cursor-session-state.js";
import { SessionRuntime, type ProtocolAdapter } from "../private/session-runtime.js";
import { DeterministicCanonicalSink } from "./deterministic-sink.js";
import {
  loadProviderFixtureManifest,
  validateProviderFixtureManifest,
} from "./fixture-safety.js";
import type {
  CursorAcpTraceEnvelope,
  CursorAcpTraceExtMethodEnvelope,
  CursorAcpTraceFixture,
  CursorAcpTracePermissionRequestEnvelope,
  CursorAcpTraceSessionUpdateEnvelope,
  FixtureExpectedSemantics,
  ProviderConformanceRegistration,
  ProviderFixtureManifest,
  ProviderFixtureMapper,
} from "./types.js";

/** Result produced when one enabled factory passes the common lifecycle profile. */
export interface FactoryCoreProfileResult {
  providerId: ProviderConformanceRegistration["providerId"];
  spawnCount: number;
  terminalType: CanonicalAgentEvent["type"];
}

/** Result from replaying one Cursor-specific ACP fixture through its production bridge. */
export interface CursorAcpTraceProfileResult {
  scenario: string;
  coveredProfiles: readonly string[];
  emittedEventTypes: readonly string[];
  toolNames: readonly string[];
  unsupportedMethods: readonly string[];
}

/** Replays a sanitized fixture through one native mapper and checks semantics. */
export function runMapperProfile<TInput>(input: {
  fixture: ProviderFixtureManifest;
  nativeInput: TInput;
  mapper: ProviderFixtureMapper<TInput>;
  summarize(drafts: readonly ProviderEventDraft[]): FixtureExpectedSemantics;
}): readonly ProviderEventDraft[] {
  const fixture = validateProviderFixtureManifest(input.fixture);
  const drafts = input.mapper.map(input.nativeInput);
  for (const draft of drafts) {
    CanonicalAgentEventSchema.parse(draft.payload);
    AgentEventRoutingSchema.parse(draft.routing);
    if (draft.sourceProviderId !== fixture.providerId) {
      throw new TypeError(`Provider mapper emitted the wrong source identity for ${fixture.providerId}`);
    }
  }
  const actual = input.summarize(drafts);
  if (JSON.stringify(actual) !== JSON.stringify(fixture.expected)) {
    throw new Error(`Provider mapper semantics differ for ${fixture.providerId}:${fixture.scenario}`);
  }
  return drafts;
}

/** Replays a sanitized Cursor ACP trace through the production client bridge. */
export async function runCursorAcpTraceProfile(
  fixture: ProviderFixtureManifest,
): Promise<CursorAcpTraceProfileResult> {
  const { validatedFixture, trace } = getCursorAcpTraceFixture(fixture);
  const replay = createCursorAcpTraceReplay(trace);
  for (const envelope of trace.envelopes) await replayCursorAcpEnvelope(envelope, replay);

  const actual = summarizeCursorAcpTraceReplay(replay);
  if (JSON.stringify(actual) !== JSON.stringify(trace.expected)) {
    throw new Error(`Cursor ACP trace semantics differ for ${validatedFixture.scenario}`);
  }
  return {
    scenario: validatedFixture.scenario,
    coveredProfiles: validatedFixture.requiredProfiles,
    emittedEventTypes: actual.emittedEventTypes,
    toolNames: actual.toolNames,
    unsupportedMethods: actual.unsupportedMethods,
  };
}

/** Drives one public factory through fake host ports and the shared session runtime. */
export async function runFactoryCoreProfile(
  registration: ProviderConformanceRegistration,
): Promise<FactoryCoreProfileResult> {
  const sink = new DeterministicCanonicalSink();
  const calls: string[] = [];
  const host = createFakeHost(sink, calls);
  const boundary = registration.factory(createConformanceFactoryInput(registration.providerId, host));
  assertFactoryIdentity(registration, boundary);
  assertFactoryDidNotUseHost(registration, calls);

  const runtimeProfile = createConformanceSessionRuntime(host);
  await assertRuntimeSessionReuse(registration, runtimeProfile);

  const drafts = createCoreDrafts(registration.providerId);
  const batch = createCoreDraftBatch(drafts);
  await host.events.submit(batch);
  await host.events.submit(batch);
  await stopConformanceSessionRuntime(runtimeProfile);
  const terminalType = assertSinkTerminalEvent(registration, sink, drafts);
  return { providerId: registration.providerId, spawnCount: runtimeProfile.spawnCount(), terminalType };
}

/** Validates enabled factory registration, profiles, fixtures, and version evidence. */
export function validateProviderConformanceRegistry(
  registrations: readonly ProviderConformanceRegistration[],
): readonly ProviderFixtureManifest[] {
  if (registrations.length === 0) throw new TypeError("Provider conformance registry is empty");
  const providerIds = new Set<string>();
  const fixtures: ProviderFixtureManifest[] = [];
  for (const registration of registrations) {
    validateRegistrationIdentity(registration, providerIds);
    validateRegistrationProfiles(registration);
    const providerFixtures = loadRegistrationFixtures(registration);
    validateFixtureProfileDeclarations(registration, providerFixtures);
    validateCursorFixtureProfiles(registration, providerFixtures);
    validateFixtureProvenance(registration, providerFixtures);
    fixtures.push(...providerFixtures);
    validateSupportedVersions(registration);
    validateBoundaryCapabilityProfiles(registration);
  }
  return fixtures;
}

interface CursorAcpTraceReplay {
  entry: CursorAcpSessionEntry;
  client: ReturnType<CursorAcpClientBridge["createClient"]>;
  requestExtMethod: NonNullable<ReturnType<CursorAcpClientBridge["createClient"]>["extMethod"]>;
  emittedEvents: AgentEvent[];
  planExits: Array<{ threadId: string; planMarkdown: string }>;
  permissionOutcomes: string[];
  unsupportedMethods: string[];
  ignoredForeignSessionUpdateCount: number;
}

interface ConformanceSessionState {
  id: string;
  busy: boolean;
}

interface ConformanceSessionRuntime {
  runtime: SessionRuntime<ConformanceSessionState>;
  sessionArgs: {
    sessionId: string;
    threadId: string;
    cwd: string;
    permissionMode: "full";
  };
  spawnCount(): number;
}

function getCursorAcpTraceFixture(fixture: ProviderFixtureManifest): {
  validatedFixture: ProviderFixtureManifest;
  trace: CursorAcpTraceFixture;
} {
  const validatedFixture = validateProviderFixtureManifest(fixture);
  const trace = validatedFixture.input.cursorAcpTrace;
  if (validatedFixture.providerId !== "cursor" || !trace) {
    throw new TypeError("Cursor ACP trace profile requires a Cursor fixture");
  }
  return { validatedFixture, trace };
}

function createCursorAcpTraceReplay(trace: CursorAcpTraceFixture): CursorAcpTraceReplay {
  const emittedEvents: AgentEvent[] = [];
  const planExits: Array<{ threadId: string; planMarkdown: string }> = [];
  const bridge = new CursorAcpClientBridge({
    settings: { get: () => ({ provider: { cursor: {} } }) as never },
    publishEvent: (_entry, event) => emittedEvents.push(event),
    emitPermissionRequest: () => undefined,
    emitPermissionResolved: () => undefined,
    emitExitPlanMode: (args) => planExits.push(args),
  });
  const entry = createCursorTraceSessionEntry(trace);
  const client = bridge.createClient(entry);
  const requestExtMethod = client.extMethod;
  if (!requestExtMethod) throw new Error("Cursor ACP bridge did not expose extMethod");
  return {
    entry,
    client,
    requestExtMethod,
    emittedEvents,
    planExits,
    permissionOutcomes: [],
    unsupportedMethods: [],
    ignoredForeignSessionUpdateCount: 0,
  };
}

async function replayCursorAcpEnvelope(
  envelope: CursorAcpTraceEnvelope,
  replay: CursorAcpTraceReplay,
): Promise<void> {
  switch (envelope.kind) {
    case "session/update":
      await replayCursorAcpSessionUpdate(envelope, replay);
      return;
    case "ext-method":
      await replayCursorAcpExtMethod(envelope, replay);
      return;
    case "request-permission":
      await replayCursorAcpPermissionRequest(envelope, replay);
      return;
  }
}

async function replayCursorAcpSessionUpdate(
  envelope: CursorAcpTraceSessionUpdateEnvelope,
  replay: CursorAcpTraceReplay,
): Promise<void> {
  const eventCount = replay.emittedEvents.length;
  await replay.client.sessionUpdate(envelope as unknown as SessionNotification);
  if (envelope.sessionId === replay.entry.acpSessionId) return;
  if (replay.emittedEvents.length !== eventCount) {
    throw new Error("Cursor ACP bridge emitted an event for a foreign session");
  }
  replay.ignoredForeignSessionUpdateCount += 1;
}

async function replayCursorAcpExtMethod(
  envelope: CursorAcpTraceExtMethodEnvelope,
  replay: CursorAcpTraceReplay,
): Promise<void> {
  const response = await replay.requestExtMethod(envelope.method, envelope.params as never);
  const unsupported = isUnsupportedCursorAcpResponse(response);
  if (cursorAcpMethodRequiresUnsupportedResponse(envelope) && !unsupported) {
    throw new Error(`Cursor ACP ${envelope.method} did not return an unsupported outcome`);
  }
  if (unsupported) replay.unsupportedMethods.push(envelope.method);
}

async function replayCursorAcpPermissionRequest(
  envelope: CursorAcpTracePermissionRequestEnvelope,
  replay: CursorAcpTraceReplay,
): Promise<void> {
  const response = await replay.client.requestPermission(envelope.request as unknown as RequestPermissionRequest);
  replay.permissionOutcomes.push(response.outcome.outcome);
}

function cursorAcpMethodRequiresUnsupportedResponse(envelope: CursorAcpTraceExtMethodEnvelope): boolean {
  return envelope.method === "cursor/continue"
    || (envelope.method === "cursor/task" && envelope.params === null);
}

function summarizeCursorAcpTraceReplay(replay: CursorAcpTraceReplay) {
  return {
    emittedEventTypes: replay.emittedEvents.map((event) => event.type),
    toolNames: replay.emittedEvents
      .filter((event): event is Extract<AgentEvent, { type: "toolUse" }> => event.type === "toolUse")
      .map((event) => event.toolName),
    planExitCount: replay.planExits.length,
    permissionOutcomes: replay.permissionOutcomes,
    unsupportedMethods: replay.unsupportedMethods,
    ignoredForeignSessionUpdateCount: replay.ignoredForeignSessionUpdateCount,
  };
}

function createConformanceFactoryInput(
  providerId: ProviderConformanceRegistration["providerId"],
  host: ProviderHostPorts,
): ProviderFactoryInput {
  const configuration = { cliPath: "conformance-provider", idleSessionTtlMs: 600_000 };
  if (providerId === "codex") return { configuration, host, codex: createFakeCodexPorts() };
  if (providerId === "cursor") return { configuration, host, cursor: createFakeCursorPorts() };
  return { configuration, host };
}

function assertFactoryIdentity(
  registration: ProviderConformanceRegistration,
  boundary: { id: string; descriptor: { id: string } },
): void {
  if (boundary.id !== registration.providerId || boundary.descriptor.id !== registration.providerId) {
    throw new Error(`Provider factory returned the wrong identity for ${registration.providerId}`);
  }
}

function assertFactoryDidNotUseHost(
  registration: ProviderConformanceRegistration,
  calls: readonly string[],
): void {
  if (calls.length > 0) throw new Error(`Provider factory ${registration.providerId} performed host I/O`);
}

function createConformanceSessionRuntime(host: ProviderHostPorts): ConformanceSessionRuntime {
  let spawnCount = 0;
  const adapter: ProtocolAdapter<ConformanceSessionState> = {
    spawn: async ({ sessionId }) => {
      spawnCount += 1;
      return { state: { id: sessionId, busy: false }, pids: [] };
    },
    isBusy: (state) => state.busy,
    interrupt: () => undefined,
    close: () => undefined,
    isStale: () => false,
  };
  return {
    runtime: new SessionRuntime(adapter, {
      envService: { getEnv: () => host.environment.snapshot() as Record<string, string> },
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      idleTtlMs: 600_000,
    }),
    sessionArgs: {
      sessionId: "SESSION_1",
      threadId: "THREAD_1",
      cwd: ".",
      permissionMode: "full",
    },
    spawnCount: () => spawnCount,
  };
}

async function assertRuntimeSessionReuse(
  registration: ProviderConformanceRegistration,
  profile: ConformanceSessionRuntime,
): Promise<void> {
  const first = await profile.runtime.acquire(profile.sessionArgs);
  const followUp = await profile.runtime.acquire(profile.sessionArgs);
  if (first !== followUp || profile.spawnCount() !== 1) {
    throw new Error(`Provider runtime ${registration.providerId} did not reuse the live session`);
  }
}

async function stopConformanceSessionRuntime(profile: ConformanceSessionRuntime): Promise<void> {
  await profile.runtime.stop(profile.sessionArgs.sessionId);
  await profile.runtime.stop(profile.sessionArgs.sessionId);
  await profile.runtime.shutdown();
  await profile.runtime.shutdown();
}

function createCoreDraftBatch(drafts: readonly ProviderEventDraft[]) {
  return {
    threadId: "THREAD_1",
    turnId: "TURN_1",
    executionId: "00000000-0000-4000-8000-000000000001",
    phase: "completed",
    events: drafts,
  };
}

function assertSinkTerminalEvent(
  registration: ProviderConformanceRegistration,
  sink: DeterministicCanonicalSink,
  drafts: readonly ProviderEventDraft[],
): CanonicalAgentEvent["type"] {
  const snapshot = sink.snapshot();
  if (snapshot.events.length !== drafts.length) {
    throw new Error(`Provider sink ${registration.providerId} did not deduplicate replay`);
  }
  const terminalType = snapshot.events.at(-1)?.payload.type;
  if (terminalType !== "turn.completed") {
    throw new Error(`Provider factory ${registration.providerId} did not produce one terminal outcome`);
  }
  return terminalType;
}

function validateRegistrationIdentity(
  registration: ProviderConformanceRegistration,
  providerIds: Set<string>,
): void {
  if (providerIds.has(registration.providerId)) {
    throw new TypeError(`Duplicate Provider conformance registration: ${registration.providerId}`);
  }
  providerIds.add(registration.providerId);
}

function validateRegistrationProfiles(registration: ProviderConformanceRegistration): void {
  if (!registration.requiredProfiles.includes("core")) {
    throw new TypeError(`Provider ${registration.providerId} lacks core profile coverage`);
  }
  if (new Set(registration.requiredProfiles).size !== registration.requiredProfiles.length) {
    throw new TypeError(`Provider ${registration.providerId} repeats profile coverage`);
  }
}

function loadRegistrationFixtures(
  registration: ProviderConformanceRegistration,
): ProviderFixtureManifest[] {
  if (registration.fixtureFiles.length === 0) {
    throw new TypeError(`Provider ${registration.providerId} lacks fixture manifests`);
  }
  const fixtures = registration.fixtureFiles.map(loadProviderFixtureManifest);
  if (fixtures.some((fixture) => fixture.providerId !== registration.providerId)) {
    throw new TypeError(`Provider ${registration.providerId} references another Provider's fixture`);
  }
  return fixtures;
}

function validateFixtureProfileDeclarations(
  registration: ProviderConformanceRegistration,
  fixtures: readonly ProviderFixtureManifest[],
): void {
  for (const fixture of fixtures) {
    for (const profile of fixture.requiredProfiles) {
      if (!registration.requiredProfiles.includes(profile)) {
        throw new TypeError(`Provider ${registration.providerId} fixture lacks registered profile coverage`);
      }
    }
  }
}

function validateCursorFixtureProfiles(
  registration: ProviderConformanceRegistration,
  fixtures: readonly ProviderFixtureManifest[],
): void {
  if (registration.providerId !== "cursor") return;
  for (const profile of registration.requiredProfiles) {
    if (!fixtures.some((fixture) => fixture.requiredProfiles.includes(profile))) {
      throw new TypeError(`Provider ${registration.providerId} lacks fixture coverage for ${profile}`);
    }
  }
}

function validateFixtureProvenance(
  registration: ProviderConformanceRegistration,
  fixtures: readonly ProviderFixtureManifest[],
): void {
  for (const provenance of registration.requiredFixtureProvenance ?? []) {
    if (!fixtures.some((fixture) => fixture.provenance === provenance)) {
      throw new TypeError(`Provider ${registration.providerId} lacks ${provenance} fixture coverage`);
    }
  }
}

function validateSupportedVersions(registration: ProviderConformanceRegistration): void {
  if (registration.supportedVersions.length === 0) {
    throw new TypeError(`Provider ${registration.providerId} lacks supported-version evidence`);
  }
  for (const evidence of registration.supportedVersions) validateVersionEvidence(registration, evidence);
}

function validateVersionEvidence(
  registration: ProviderConformanceRegistration,
  evidence: ProviderConformanceRegistration["supportedVersions"][number],
): void {
  if (!evidence.component || !evidence.oldestSupported || !evidence.currentTested || !evidence.source) {
    throw new TypeError(`Provider ${registration.providerId} has incomplete supported-version evidence`);
  }
}

function validateBoundaryCapabilityProfiles(registration: ProviderConformanceRegistration): void {
  const boundary = registration.factory(createConformanceFactoryInput(
    registration.providerId,
    createFakeHost(new DeterministicCanonicalSink(), []),
  ));
  const declaredProfiles = boundary.descriptor.capabilities
    .filter((capability) => capability.support === "supported")
    .map((capability) => capability.name);
  for (const capability of declaredProfiles) {
    if (!registration.requiredProfiles.includes(capability)) {
      throw new TypeError(`Provider ${registration.providerId} lacks ${capability} profile coverage`);
    }
  }
}

function createFakeCodexPorts(): NonNullable<ProviderFactoryInput["codex"]> {
  return {
    settings: { get: async () => ({ cliPath: "codex", fastMode: false }) },
    attachments: { persistGeneratedImageFromPath: () => { throw new Error("unused"); } },
    catalog: {
      currentSkills: () => [],
      currentPrompts: () => [],
      refreshCustomPrompts: async () => ({ prompts: [] }),
      shutdown: async () => undefined,
    },
  };
}

function createCursorTraceSessionEntry(trace: ProviderFixtureManifest["input"]["cursorAcpTrace"]): CursorAcpSessionEntry {
  const firstSessionUpdate = trace?.envelopes.find((envelope) => envelope.kind === "session/update");
  if (!firstSessionUpdate) throw new TypeError("Cursor ACP trace requires a session/update envelope");
  return {
    mcodeSessionId: "CURSOR_TRACE_SESSION",
    threadId: "CURSOR_TRACE_THREAD",
    acpSessionId: firstSessionUpdate.sessionId,
    permissionMode: "full",
    acpRuntime: {
      state: { sessionId: firstSessionUpdate.sessionId },
    } as CursorAcpSessionEntry["acpRuntime"],
    activeTurnState: createCursorAcpTurnState(),
    replayTurnState: null,
    todoSnapshot: { todos: new Map() },
  } as CursorAcpSessionEntry;
}

function isUnsupportedCursorAcpResponse(value: unknown): value is { outcome: { outcome: "unsupported" } } {
  if (value === null || typeof value !== "object") return false;
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome !== null
    && typeof outcome === "object"
    && (outcome as { outcome?: unknown }).outcome === "unsupported";
}

function createFakeCursorPorts(): NonNullable<ProviderFactoryInput["cursor"]> {
  return {
    settings: { get: () => undefined as never },
    skills: { list: () => [] },
  };
}

function createFakeHost(sink: DeterministicCanonicalSink, calls: string[]): ProviderHostPorts {
  return {
    environment: { snapshot: () => ({}) },
    processes: {
      attach: () => calls.push("processes.attach"),
      terminateTree: async () => { calls.push("processes.terminateTree"); },
    },
    browser: {
      stage: () => { calls.push("browser.stage"); return { leaseId: "LEASE_1", expiresAt: Date.now() + 1_000 }; },
      releaseSession: () => { calls.push("browser.releaseSession"); return 0; },
      isConfigured: () => false,
      issue: () => null,
      refresh: (leaseId) => ({ ok: false, leaseId, reason: "not-found" }),
      release: (leaseId) => ({ leaseId, released: false }),
      revokeCredential: () => false,
    },
    threadControl: {
      bootstrap: async () => { calls.push("threadControl.bootstrap"); return null; },
      close: async () => { calls.push("threadControl.close"); },
    },
    grants: { consume: () => { calls.push("grants.consume"); return false; } },
    events: { submit: (batch) => sink.submit(batch) },
  };
}

function createCoreDrafts(providerId: string): ProviderEventDraft[] {
  const routing = {
    threadId: "THREAD_1",
    turnId: "TURN_1",
    executionId: "00000000-0000-4000-8000-000000000001",
  };
  return [
    {
      eventId: `${providerId}:started`,
      routing,
      sourceProviderId: providerId,
      sourceIdentities: [{ providerId, scope: "turn", value: "NATIVE_TURN_1", provenance: "native" }],
      sourceSequence: 1,
      payload: { type: "turn.started", startedAt: "1970-01-01T00:00:01.000Z" },
    },
    {
      eventId: `${providerId}:completed`,
      routing,
      sourceProviderId: providerId,
      sourceIdentities: [{ providerId, scope: "turn", value: "NATIVE_TURN_1", provenance: "native" }],
      sourceSequence: 2,
      payload: { type: "turn.completed", endedAt: "1970-01-01T00:00:02.000Z" },
    },
  ];
}
