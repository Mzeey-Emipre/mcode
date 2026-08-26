import {
  AgentEventRoutingSchema,
  CanonicalAgentEventSchema,
  type CanonicalAgentEvent,
} from "@mcode/agent-model";
import type { ProviderFactoryInput } from "../factory-types.js";
import type { ProviderEventDraft, ProviderHostPorts } from "../host-ports.js";
import { SessionRuntime, type ProtocolAdapter } from "../private/session-runtime.js";
import { DeterministicCanonicalSink } from "./deterministic-sink.js";
import {
  loadProviderFixtureManifest,
  validateProviderFixtureManifest,
} from "./fixture-safety.js";
import type {
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

/** Drives one public factory through fake host ports and the shared session runtime. */
export async function runFactoryCoreProfile(
  registration: ProviderConformanceRegistration,
): Promise<FactoryCoreProfileResult> {
  const sink = new DeterministicCanonicalSink();
  const calls: string[] = [];
  const host = createFakeHost(sink, calls);
  const factoryInput: ProviderFactoryInput = {
    configuration: { cliPath: "conformance-provider", idleSessionTtlMs: 600_000 },
    host,
    ...(registration.providerId === "codex" ? { codex: createFakeCodexPorts() } : {}),
    ...(registration.providerId === "cursor" ? { cursor: createFakeCursorPorts() } : {}),
  };
  const boundary = registration.factory(factoryInput);
  if (boundary.id !== registration.providerId || boundary.descriptor.id !== registration.providerId) {
    throw new Error(`Provider factory returned the wrong identity for ${registration.providerId}`);
  }
  if (calls.length > 0) throw new Error(`Provider factory ${registration.providerId} performed host I/O`);

  interface State { id: string; busy: boolean }
  let spawnCount = 0;
  const adapter: ProtocolAdapter<State> = {
    spawn: async ({ sessionId }) => {
      spawnCount += 1;
      return { state: { id: sessionId, busy: false }, pids: [] };
    },
    isBusy: (state) => state.busy,
    interrupt: () => undefined,
    close: () => undefined,
    isStale: () => false,
  };
  const runtime = new SessionRuntime(adapter, {
    envService: { getEnv: () => host.environment.snapshot() as Record<string, string> },
    jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
    idleTtlMs: 600_000,
  });
  const sessionArgs = {
    sessionId: "SESSION_1",
    threadId: "THREAD_1",
    cwd: ".",
    permissionMode: "full",
  };
  const first = await runtime.acquire(sessionArgs);
  const followUp = await runtime.acquire(sessionArgs);
  if (first !== followUp || spawnCount !== 1) {
    throw new Error(`Provider runtime ${registration.providerId} did not reuse the live session`);
  }

  const drafts = createCoreDrafts(registration.providerId);
  const batch = {
    threadId: "THREAD_1",
    turnId: "TURN_1",
    executionId: "00000000-0000-4000-8000-000000000001",
    phase: "completed",
    events: drafts,
  };
  await host.events.submit(batch);
  await host.events.submit(batch);
  await runtime.stop(sessionArgs.sessionId);
  await runtime.stop(sessionArgs.sessionId);
  await runtime.shutdown();
  await runtime.shutdown();

  const snapshot = sink.snapshot();
  if (snapshot.events.length !== drafts.length) {
    throw new Error(`Provider sink ${registration.providerId} did not deduplicate replay`);
  }
  const terminalType = snapshot.events.at(-1)?.payload.type;
  if (terminalType !== "turn.completed") {
    throw new Error(`Provider factory ${registration.providerId} did not produce one terminal outcome`);
  }
  return { providerId: registration.providerId, spawnCount, terminalType };
}

/** Validates enabled factory registration, profiles, fixtures, and version evidence. */
export function validateProviderConformanceRegistry(
  registrations: readonly ProviderConformanceRegistration[],
): readonly ProviderFixtureManifest[] {
  if (registrations.length === 0) throw new TypeError("Provider conformance registry is empty");
  const providerIds = new Set<string>();
  const fixtures: ProviderFixtureManifest[] = [];
  for (const registration of registrations) {
    if (providerIds.has(registration.providerId)) {
      throw new TypeError(`Duplicate Provider conformance registration: ${registration.providerId}`);
    }
    providerIds.add(registration.providerId);
    if (!registration.requiredProfiles.includes("core")) {
      throw new TypeError(`Provider ${registration.providerId} lacks core profile coverage`);
    }
    if (new Set(registration.requiredProfiles).size !== registration.requiredProfiles.length) {
      throw new TypeError(`Provider ${registration.providerId} repeats profile coverage`);
    }
    if (registration.fixtureFiles.length === 0) {
      throw new TypeError(`Provider ${registration.providerId} lacks fixture manifests`);
    }
    const providerFixtures = registration.fixtureFiles.map(loadProviderFixtureManifest);
    if (providerFixtures.some((fixture) => fixture.providerId !== registration.providerId)) {
      throw new TypeError(`Provider ${registration.providerId} references another Provider's fixture`);
    }
    for (const fixture of providerFixtures) {
      for (const profile of fixture.requiredProfiles) {
        if (!registration.requiredProfiles.includes(profile)) {
          throw new TypeError(`Provider ${registration.providerId} fixture lacks registered profile coverage`);
        }
      }
    }
    for (const provenance of registration.requiredFixtureProvenance ?? []) {
      for (const profile of registration.requiredProfiles) {
        if (!providerFixtures.some((fixture) =>
          fixture.provenance === provenance && fixture.requiredProfiles.includes(profile)
        )) {
          throw new TypeError(
            `Provider ${registration.providerId} lacks ${provenance} fixture coverage for ${profile}`,
          );
        }
      }
    }
    fixtures.push(...providerFixtures);
    if (registration.supportedVersions.length === 0) {
      throw new TypeError(`Provider ${registration.providerId} lacks supported-version evidence`);
    }
    for (const evidence of registration.supportedVersions) {
      if (!evidence.component || !evidence.oldestSupported || !evidence.currentTested || !evidence.source) {
        throw new TypeError(`Provider ${registration.providerId} has incomplete supported-version evidence`);
      }
    }

    const boundary = registration.factory({
      configuration: { cliPath: "conformance-provider", idleSessionTtlMs: 600_000 },
      host: createFakeHost(new DeterministicCanonicalSink(), []),
      ...(registration.providerId === "codex" ? { codex: createFakeCodexPorts() } : {}),
      ...(registration.providerId === "cursor" ? { cursor: createFakeCursorPorts() } : {}),
    });
    const declaredProfiles = boundary.descriptor.capabilities
      .filter((capability) => capability.support === "supported")
      .map((capability) => capability.name);
    for (const capability of declaredProfiles) {
      if (!registration.requiredProfiles.includes(capability)) {
        throw new TypeError(`Provider ${registration.providerId} lacks ${capability} profile coverage`);
      }
    }
  }
  return fixtures;
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
