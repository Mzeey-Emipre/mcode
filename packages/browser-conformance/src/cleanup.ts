import {
  BROWSER_CONFORMANCE_RESOURCE_KEYS,
  createBrowserConformanceRevisionVector,
  type BrowserConformanceCleanupInvariant,
  type BrowserConformanceResourceBounds,
  type BrowserConformanceResourceIdentity,
  type BrowserConformanceResourceKey,
  type BrowserConformanceResourceSnapshot,
  type BrowserConformanceRevisionVector,
} from "./model.js";

/** Partial resource input accepted when constructing a cleanup snapshot. */
export interface BrowserConformanceResourceSnapshotInput {
  readonly counts?: Partial<Readonly<Record<BrowserConformanceResourceKey, number>>>;
  readonly identities?: Partial<
    Readonly<Record<BrowserConformanceResourceKey, readonly BrowserConformanceResourceIdentity[]>>
  >;
  readonly revisions?: Partial<BrowserConformanceRevisionVector>;
}

/** One named cleanup violation produced by baseline comparison. */
export interface BrowserConformanceCleanupViolation {
  readonly resource: BrowserConformanceResourceKey;
  readonly reason: "growth" | "identity" | "invalid-count";
  readonly baseline: number;
  readonly final: number;
  readonly allowedGrowth: number;
}

/** Result of comparing terminal resources with their scoped baseline. */
export interface BrowserConformanceCleanupComparison {
  readonly ok: boolean;
  readonly violations: readonly BrowserConformanceCleanupViolation[];
  readonly delta: Readonly<Record<BrowserConformanceResourceKey, number>>;
}

/** Creates a complete zero-valued resource snapshot with optional identities. */
export function createBrowserConformanceResourceSnapshot(
  input: BrowserConformanceResourceSnapshotInput = {},
): BrowserConformanceResourceSnapshot {
  const identities = Object.fromEntries(
    BROWSER_CONFORMANCE_RESOURCE_KEYS.map((key) => [key, input.identities?.[key] ?? []]),
  ) as Record<BrowserConformanceResourceKey, readonly BrowserConformanceResourceIdentity[]>;
  return {
    requests: input.counts?.requests ?? identities.requests.length,
    queues: input.counts?.queues ?? identities.queues.length,
    timers: input.counts?.timers ?? identities.timers.length,
    listeners: input.counts?.listeners ?? identities.listeners.length,
    heldInput: input.counts?.heldInput ?? identities.heldInput.length,
    controllerLeases: input.counts?.controllerLeases ?? identities.controllerLeases.length,
    targets: input.counts?.targets ?? identities.targets.length,
    replayEntries: input.counts?.replayEntries ?? identities.replayEntries.length,
    registries: input.counts?.registries ?? identities.registries.length,
    buffers: input.counts?.buffers ?? identities.buffers.length,
    identities,
    revisions: createBrowserConformanceRevisionVector(input.revisions),
  };
}

/** Compares terminal resources with a baseline and declared growth bounds. */
export function compareBrowserConformanceCleanup(
  baseline: BrowserConformanceResourceSnapshot,
  final: BrowserConformanceResourceSnapshot,
  allowedGrowth: BrowserConformanceResourceBounds = {},
): BrowserConformanceCleanupComparison {
  const violations: BrowserConformanceCleanupViolation[] = [];
  const delta = {} as Record<BrowserConformanceResourceKey, number>;
  for (const resource of BROWSER_CONFORMANCE_RESOURCE_KEYS) {
    const before = baseline[resource];
    const after = final[resource];
    const growth = allowedGrowth[resource] ?? 0;
    delta[resource] = after - before;
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || before < 0 || after < 0) {
      violations.push({ resource, reason: "invalid-count", baseline: before, final: after, allowedGrowth: growth });
      continue;
    }
    if (!Number.isSafeInteger(growth) || growth < 0 || after > before + growth) {
      violations.push({ resource, reason: "growth", baseline: before, final: after, allowedGrowth: growth });
      continue;
    }
    if (!hasBaselineIdentities(baseline.identities[resource], final.identities[resource])) {
      violations.push({ resource, reason: "identity", baseline: before, final: after, allowedGrowth: growth });
    }
  }
  return { ok: violations.length === 0, violations, delta };
}

/** Compares a snapshot against the invariant's baseline and declared bounds. */
export function checkBrowserConformanceCleanup(
  invariant: BrowserConformanceCleanupInvariant,
  final: BrowserConformanceResourceSnapshot,
): BrowserConformanceCleanupComparison {
  return compareBrowserConformanceCleanup(invariant.baseline, final, invariant.allowedGrowth);
}

function hasBaselineIdentities(
  baseline: readonly BrowserConformanceResourceIdentity[],
  final: readonly BrowserConformanceResourceIdentity[],
): boolean {
  const finalKeys = new Set(final.map((identity) => `${identity.id}\u0000${identity.generation}`));
  return baseline.every((identity) => finalKeys.has(`${identity.id}\u0000${identity.generation}`));
}
