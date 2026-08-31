import {
  BROWSER_CONFORMANCE_GENERATOR_VERSION,
  BROWSER_CONFORMANCE_SCENARIO_VERSION,
  BROWSER_CONFORMANCE_REVISION_KEYS,
  createBrowserConformanceRevisionVector,
  hashBrowserConformanceSeed,
  normalizeSeed,
  type BrowserConformanceEventKind,
  type BrowserConformanceRevisionKey,
  type BrowserConformanceSchedule,
} from "./model.js";
import { createBrowserConformanceRandom } from "./schedule.js";

/** A reviewed family of Browser races exercised by the conformance suite. */
export type BrowserConformanceRaceFamily = "bootstrap" | "action" | "observation" | "batch" | "cleanup";

/** One named race and the externally visible invariant it protects. */
export interface BrowserConformanceRaceCase {
  readonly id: string;
  readonly family: BrowserConformanceRaceFamily;
  readonly events: readonly BrowserConformanceEventKind[];
  readonly invariant: string;
}

/** Shared, readable race names. Keep this catalogue stable so failures replay by name. */
export const BROWSER_CONFORMANCE_RACE_CATALOGUE: readonly BrowserConformanceRaceCase[] = [
  { id: "bootstrap-disconnect-reconnect", family: "bootstrap", events: ["host-disconnect", "host-reconnect"], invariant: "bootstrap disconnect/reconnect settles exactly once" },
  { id: "bootstrap-concurrent-open", family: "bootstrap", events: ["target-register", "target-register"], invariant: "concurrent bootstrap opens have one owner and one target" },
  { id: "bootstrap-cancel", family: "bootstrap", events: ["cancel"], invariant: "cancelled bootstrap cannot report success" },
  { id: "bootstrap-timeout", family: "bootstrap", events: ["timeout"], invariant: "timed out bootstrap has a bounded terminal outcome" },
  { id: "bootstrap-close", family: "bootstrap", events: ["target-close"], invariant: "closed bootstrap target cannot be reused" },
  { id: "bootstrap-lost-response", family: "bootstrap", events: ["lost-response"], invariant: "lost bootstrap response replays its terminal result without a duplicate effect" },
  { id: "bootstrap-idempotent-replay", family: "bootstrap", events: ["late-response"], invariant: "idempotent bootstrap replay returns one committed effect" },
  { id: "bootstrap-late-creation", family: "bootstrap", events: ["late-response", "target-register"], invariant: "late bootstrap creation cannot resurrect released state" },
  { id: "action-takeover", family: "action", events: ["user-takeover"], invariant: "takeover stops agent effects and preserves committed steps" },
  { id: "action-navigation", family: "action", events: ["navigation"], invariant: "navigation invalidates document-bound actions" },
  { id: "action-reload", family: "action", events: ["reload"], invariant: "reload invalidates document-bound actions" },
  { id: "action-close", family: "action", events: ["target-close"], invariant: "closed targets reject later action effects" },
  { id: "action-resize", family: "action", events: ["resize"], invariant: "resize cannot mutate a replaced target" },
  { id: "action-cancel", family: "action", events: ["cancel"], invariant: "cancel releases action-owned resources" },
  { id: "action-timeout", family: "action", events: ["timeout"], invariant: "deadline timeout reports a known none/partial/complete effect" },
  { id: "action-competing-mutation", family: "action", events: ["competing-mutation"], invariant: "competing mutation has unambiguous ownership" },
  { id: "observation-host-revision", family: "observation", events: ["host-disconnect", "host-reconnect"], invariant: "host revision invalidates an old observation binding" },
  { id: "observation-document-revision", family: "observation", events: ["document-revision"], invariant: "document revision invalidates an old observation binding" },
  { id: "observation-control-revision", family: "observation", events: ["control-revision"], invariant: "control revision invalidates an old observation binding" },
  { id: "observation-capability-revision", family: "observation", events: ["capability-revision"], invariant: "capability revision cannot be overstated by a stale observation" },
  { id: "observation-observation-revision", family: "observation", events: ["observation-revision"], invariant: "observation revision rejects stale reads" },
  { id: "batch-invalidation", family: "batch", events: ["document-revision", "control-revision"], invariant: "batch stops after invalidation without stale mutations" },
  { id: "batch-navigation", family: "batch", events: ["navigation"], invariant: "batch navigation leaves partial effects explicit" },
  { id: "batch-partial-failure", family: "batch", events: ["competing-mutation", "late-response"], invariant: "partial batch failure preserves step order and ownership" },
  { id: "batch-deadline", family: "batch", events: ["timeout"], invariant: "batch deadline produces a known bounded outcome" },
  { id: "batch-cancel-between-steps", family: "batch", events: ["cancel"], invariant: "cancel between steps does not run a later step" },
  { id: "cleanup-late-response", family: "cleanup", events: ["late-response"], invariant: "late response cannot resurrect disposed resources" },
  { id: "cleanup-late-event", family: "cleanup", events: ["late-event"], invariant: "late event cannot mutate a disposed generation" },
  { id: "cleanup-late-timer", family: "cleanup", events: ["late-timer"], invariant: "late timer is inert after quiescence" },
  { id: "cleanup-disconnect", family: "cleanup", events: ["host-disconnect"], invariant: "disconnect cleanup leaves no orphaned ownership" },
  { id: "cleanup-replacement", family: "cleanup", events: ["target-close", "target-register"], invariant: "replacement gets a new generation without stale mutation" },
  { id: "cleanup-capacity", family: "cleanup", events: ["target-register", "target-register", "target-register", "target-register"], invariant: "capacity rejects excess targets without false success" },
] as const;

/** High-risk revision combinations that receive an explicit schedule. */
export const BROWSER_CONFORMANCE_HIGH_RISK_REVISION_COMBINATIONS: readonly (readonly BrowserConformanceRevisionKey[])[] = [
  ["host", "document", "control"],
  ["host", "capability", "observation"],
  ["document", "control", "observation"],
  ["control", "capability", "observation"],
] as const;

/** One generated schedule keyed by the revisions it exercises. */
export interface BrowserConformanceRevisionRaceSchedule {
  readonly id: string;
  readonly revisions: readonly BrowserConformanceRevisionKey[];
  readonly schedule: BrowserConformanceSchedule;
}

/** Complete bounded individual, pair, and high-risk revision schedules. */
export interface BrowserConformanceRevisionRaceSchedules {
  readonly individual: Readonly<Record<BrowserConformanceRevisionKey, BrowserConformanceRevisionRaceSchedule>>;
  readonly pairs: readonly BrowserConformanceRevisionRaceSchedule[];
  readonly highRisk: readonly BrowserConformanceRevisionRaceSchedule[];
}

/** Inputs controlling the bounded revision schedule generator. */
export interface BrowserConformanceRevisionRaceScheduleOptions {
  readonly seed: number | string;
  readonly maxCommands?: number;
  readonly maxEvents?: number;
  readonly maxCheckpoints?: number;
  readonly maxTick?: number;
}

/** Generates deterministic schedules for every revision, pair, and high-risk combination. */
export function createBrowserConformanceRevisionRaceSchedules(
  options: BrowserConformanceRevisionRaceScheduleOptions,
): BrowserConformanceRevisionRaceSchedules {
  const revisions = [...BROWSER_CONFORMANCE_REVISION_KEYS];
  const individual = Object.fromEntries(revisions.map((revision) => [
    revision,
    createRevisionRaceSchedule([revision], options),
  ])) as Record<BrowserConformanceRevisionKey, BrowserConformanceRevisionRaceSchedule>;
  const pairs: BrowserConformanceRevisionRaceSchedule[] = [];
  for (let left = 0; left < revisions.length; left += 1) {
    for (let right = left + 1; right < revisions.length; right += 1) {
      pairs.push(createRevisionRaceSchedule([revisions[left]!, revisions[right]!], options));
    }
  }
  return {
    individual,
    pairs,
    highRisk: BROWSER_CONFORMANCE_HIGH_RISK_REVISION_COMBINATIONS.map((combination) =>
      createRevisionRaceSchedule(combination, options)),
  };
}

/** Alias with a shorter name for callers that only need revision schedules. */
export const createBrowserConformanceRaceSchedules = createBrowserConformanceRevisionRaceSchedules;

function createRevisionRaceSchedule(
  revisions: readonly BrowserConformanceRevisionKey[],
  options: BrowserConformanceRevisionRaceScheduleOptions,
): BrowserConformanceRevisionRaceSchedule {
  const seed = normalizeRaceSeed(options.seed);
  const bounds = createRaceBounds(revisions, options);
  const random = createBrowserConformanceRandom(seed);
  const selectedRevisions = revisions.slice(0, bounds.maxEvents);
  const slots = createRaceSlots(selectedRevisions.length, bounds.maxCheckpoints, random);
  const events = createRaceEvents(selectedRevisions, slots, bounds.maxTick);
  const checkpoints = createRaceCheckpoints(selectedRevisions, slots, bounds.maxCheckpoints, bounds.maxTick);
  populateExpectedRevisions(events, checkpoints);
  return {
    id: revisions.join("+"),
    revisions: events.map((event) => event.revision),
    schedule: {
      version: BROWSER_CONFORMANCE_SCENARIO_VERSION,
      generatorVersion: BROWSER_CONFORMANCE_GENERATOR_VERSION,
      seed,
      bounds,
      events,
      checkpoints,
    },
  };
}

function normalizeRaceSeed(seed: number | string): number {
  return typeof seed === "string" ? hashBrowserConformanceSeed(seed) : normalizeSeed(seed);
}

function createRaceBounds(
  revisions: readonly BrowserConformanceRevisionKey[],
  options: BrowserConformanceRevisionRaceScheduleOptions,
): BrowserConformanceSchedule["bounds"] {
  return {
    maxEvents: bound(options.maxEvents ?? Math.max(8, revisions.length)),
    maxCommands: bound(options.maxCommands ?? 4),
    maxCheckpoints: bound(options.maxCheckpoints ?? revisions.length),
    maxTick: bound(options.maxTick ?? Math.max(8, revisions.length * 2)),
  };
}

function createRaceSlots(
  revisionCount: number,
  maxCheckpoints: number,
  random: ReturnType<typeof createBrowserConformanceRandom>,
): number[] {
  const itemCount = revisionCount + Math.min(revisionCount, maxCheckpoints);
  const slots = Array.from({ length: itemCount }, (_, index) => index);
  for (let index = slots.length - 1; index > 0; index -= 1) {
    const swap = random.integer(index + 1);
    [slots[index], slots[swap]] = [slots[swap]!, slots[index]!];
  }
  return slots;
}

function createRaceEvents(
  revisions: readonly BrowserConformanceRevisionKey[],
  slots: readonly number[],
  maxTick: number,
) {
  const events = revisions.map((revision, index) => ({
    order: { tick: raceTick(slots[index]!, maxTick), ordinal: index },
    kind: revisionEventKind(revision),
    revision,
  }));
  events.sort(compareRaceOrder);
  return events;
}

function createRaceCheckpoints(
  revisions: readonly BrowserConformanceRevisionKey[],
  slots: readonly number[],
  maxCheckpoints: number,
  maxTick: number,
) {
  const checkpoints = revisions.slice(0, maxCheckpoints).map((revision, index) => ({
    id: `revision-${revision}`,
    order: { tick: raceTick(slots[revisions.length + index]!, maxTick), ordinal: revisions.length + index },
    label: `${revision} revision checkpoint`,
    expectedRevisions: createBrowserConformanceRevisionVector(),
  }));
  checkpoints.sort(compareRaceOrder);
  return checkpoints;
}

function raceTick(slot: number, maxTick: number): number {
  return maxTick === 0 ? 0 : slot % (maxTick + 1);
}

function compareRaceOrder(
  left: { readonly order: { readonly tick: number; readonly ordinal: number } },
  right: { readonly order: { readonly tick: number; readonly ordinal: number } },
): number {
  return left.order.tick - right.order.tick || left.order.ordinal - right.order.ordinal;
}

function populateExpectedRevisions(
  events: readonly { readonly order: { readonly tick: number; readonly ordinal: number }; readonly revision: BrowserConformanceRevisionKey }[],
  checkpoints: readonly { readonly order: { readonly tick: number; readonly ordinal: number }; expectedRevisions: ReturnType<typeof createBrowserConformanceRevisionVector> }[],
): void {
  for (const checkpoint of checkpoints) {
    const counts: Partial<Record<BrowserConformanceRevisionKey, number>> = {};
    for (const event of events) {
      if (event.order.tick > checkpoint.order.tick || (event.order.tick === checkpoint.order.tick && event.order.ordinal >= checkpoint.order.ordinal)) break;
      if (event.revision) counts[event.revision] = (counts[event.revision] ?? 0) + 1;
    }
    checkpoint.expectedRevisions = createBrowserConformanceRevisionVector(counts);
  }
}

function revisionEventKind(revision: BrowserConformanceRevisionKey): BrowserConformanceEventKind {
  switch (revision) {
    case "host": return "host-disconnect";
    case "document": return "document-revision";
    case "control": return "control-revision";
    case "capability": return "capability-revision";
    case "observation": return "observation-revision";
  }
}

function bound(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Revision schedule bounds must be non-negative safe integers");
  return Math.min(256, value);
}
