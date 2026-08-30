import {
  BROWSER_CONFORMANCE_EVENT_KINDS,
  BROWSER_CONFORMANCE_GENERATOR_VERSION,
  BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS,
  BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_TICK,
  BROWSER_CONFORMANCE_REVISION_KEYS,
  BROWSER_CONFORMANCE_SCENARIO_VERSION,
  type BrowserConformanceCheckpoint,
  type BrowserConformanceEventKind,
  type BrowserConformanceOrder,
  type BrowserConformanceRevisionKey,
  type BrowserConformanceSchedule,
  type BrowserConformanceScheduleBounds,
  type BrowserConformanceScheduledEvent,
  hashBrowserConformanceSeed,
  normalizeSeed,
} from "./model.js";

/** Default maximum command steps represented by a generated schedule. */
export const BROWSER_CONFORMANCE_DEFAULT_MAX_COMMANDS = 32;

/** Default maximum external events represented by a generated schedule. */
export const BROWSER_CONFORMANCE_DEFAULT_MAX_EVENTS = 64;

/** Default maximum named checkpoints represented by a generated schedule. */
export const BROWSER_CONFORMANCE_DEFAULT_MAX_CHECKPOINTS = 16;

/** Default virtual monotonic tick bound for generated schedules. */
export const BROWSER_CONFORMANCE_DEFAULT_MAX_TICK = 256;

/** Re-exported hard bounds used by custom scenario validation. */
export { BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS, BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_TICK } from "./model.js";

/** Seed accepted by the deterministic conformance random source. */
export type BrowserConformanceSeed = number | string;

/** Small deterministic random source used by generated Browser schedules. */
export interface BrowserConformanceRandom {
  /** Returns the next deterministic value in the half-open range [0, 1). */
  next(): number;
  /** Returns a deterministic integer in the half-open range [0, maxExclusive). */
  integer(maxExclusive: number): number;
  /** Selects one deterministic item from a non-empty list. */
  pick<T>(values: readonly T[]): T;
}

/** Inputs controlling deterministic schedule generation and its bounds. */
export interface BrowserConformanceScheduleOptions {
  readonly seed: BrowserConformanceSeed;
  readonly maxCommands?: number;
  readonly maxEvents?: number;
  readonly maxCheckpoints?: number;
  readonly maxTick?: number;
  readonly eventCount?: number;
  readonly checkpointCount?: number;
}

/** Creates a deterministic, bounded pseudo-random source from a seed. */
export function createBrowserConformanceRandom(seed: BrowserConformanceSeed): BrowserConformanceRandom {
  let state = typeof seed === "string" ? hashBrowserConformanceSeed(seed) : normalizeSeed(seed);
  return {
    next(): number {
      state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
      state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
      state ^= state >>> 16;
      return (state >>> 0) / 0x1_0000_0000;
    },
    integer(maxExclusive: number): number {
      if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError("Random integer bound must be a positive safe integer");
      }
      return Math.floor(this.next() * maxExclusive);
    },
    pick<T>(values: readonly T[]): T {
      if (values.length === 0) throw new RangeError("Cannot pick from an empty list");
      return values[this.integer(values.length)] as T;
    },
  };
}

/** Creates a deterministic bounded event/checkpoint schedule for a scenario. */
export function createBrowserConformanceSchedule(
  options: BrowserConformanceScheduleOptions,
): BrowserConformanceSchedule {
  const seed = normalizeScheduleSeed(options.seed);
  const bounds = createScheduleBounds(options);
  const random = createBrowserConformanceRandom(seed);
  const eventCount = resolveEventCount(options, bounds);
  const checkpointCount = resolveCheckpointCount(options, bounds);
  let ordinal = 0;
  const events: BrowserConformanceScheduledEvent[] = [];
  for (let index = 0; index < eventCount; index += 1) {
    const kind = random.pick(BROWSER_CONFORMANCE_EVENT_KINDS);
    const revision = revisionForEvent(kind, random);
    events.push({
      order: nextOrder(random, bounds.maxTick, ordinal++),
      kind,
      ...(revision ? { revision } : {}),
    });
  }
  events.sort((left, right) => compareOrder(left.order, right.order));

  const checkpoints: BrowserConformanceCheckpoint[] = [];
  for (let index = 0; index < checkpointCount; index += 1) {
    checkpoints.push({
      id: `checkpoint-${index + 1}`,
      order: nextOrder(random, bounds.maxTick, ordinal++),
      label: `checkpoint ${index + 1}`,
    });
  }
  checkpoints.sort((left, right) => compareOrder(left.order, right.order));

  return {
    version: BROWSER_CONFORMANCE_SCENARIO_VERSION,
    generatorVersion: BROWSER_CONFORMANCE_GENERATOR_VERSION,
    seed,
    bounds,
    events,
    checkpoints,
  };
}

function normalizeScheduleSeed(seed: BrowserConformanceSeed): number {
  return typeof seed === "string" ? hashBrowserConformanceSeed(seed) : normalizeSeed(seed);
}

function createScheduleBounds(options: BrowserConformanceScheduleOptions): BrowserConformanceScheduleBounds {
  return {
    maxCommands: boundedCount(options.maxCommands ?? BROWSER_CONFORMANCE_DEFAULT_MAX_COMMANDS),
    maxEvents: boundedCount(options.maxEvents ?? BROWSER_CONFORMANCE_DEFAULT_MAX_EVENTS),
    maxCheckpoints: boundedCount(options.maxCheckpoints ?? BROWSER_CONFORMANCE_DEFAULT_MAX_CHECKPOINTS),
    maxTick: boundedTick(options.maxTick ?? BROWSER_CONFORMANCE_DEFAULT_MAX_TICK),
  };
}

function resolveEventCount(options: BrowserConformanceScheduleOptions, bounds: BrowserConformanceScheduleBounds): number {
  const requested = options.eventCount ?? Math.min(bounds.maxEvents, bounds.maxCommands * 2);
  return Math.min(boundedCount(requested), bounds.maxEvents);
}

function resolveCheckpointCount(options: BrowserConformanceScheduleOptions, bounds: BrowserConformanceScheduleBounds): number {
  const requested = options.checkpointCount ?? Math.min(bounds.maxCheckpoints, bounds.maxCommands);
  return Math.min(boundedCount(requested), bounds.maxCheckpoints);
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_ITEMS, Math.max(0, Math.trunc(value)));
}

function boundedTick(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(BROWSER_CONFORMANCE_HARD_MAX_SCHEDULE_TICK, Math.max(0, Math.trunc(value)));
}

function nextOrder(random: BrowserConformanceRandom, maxTick: number, ordinal: number): BrowserConformanceOrder {
  return { tick: maxTick === 0 ? 0 : random.integer(maxTick + 1), ordinal };
}

function compareOrder(left: BrowserConformanceOrder, right: BrowserConformanceOrder): number {
  return left.tick - right.tick || left.ordinal - right.ordinal;
}

function revisionForEvent(
  kind: BrowserConformanceEventKind,
  random: BrowserConformanceRandom,
): BrowserConformanceRevisionKey | undefined {
  switch (kind) {
    case "host-disconnect":
    case "host-reconnect":
      return "host";
    case "navigation":
    case "reload":
      return "document";
    case "user-takeover":
    case "competing-mutation":
      return "control";
    case "capability-revision":
      return "capability";
    case "observation-revision":
      return "observation";
    default:
      return random.next() < 0.2 ? random.pick(BROWSER_CONFORMANCE_REVISION_KEYS) : undefined;
  }
}
