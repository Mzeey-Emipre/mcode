/** Timing phases that a Browser tracer may measure independently. */
export const BROWSER_CONFORMANCE_TIMING_PHASES = [
  "mcode",
  "application",
  "network",
  "wait",
  "model",
] as const;

/** One independently measured Browser timing phase. */
export type BrowserConformanceTimingPhase = (typeof BROWSER_CONFORMANCE_TIMING_PHASES)[number];

/** Maximum number of recent samples retained for one timing phase. */
export const BROWSER_CONFORMANCE_MAX_TIMING_SAMPLES = 256;

/** Maximum duration accepted for one timing sample. */
export const BROWSER_CONFORMANCE_MAX_TIMING_DURATION_MS = 24 * 60 * 60 * 1_000;

/** One bounded, content-free timing sample from a tracer. */
export interface BrowserConformanceTimingSample {
  readonly phase: BrowserConformanceTimingPhase;
  readonly durationMs: number;
}

/** Percentiles calculated from the retained samples for one phase. */
export interface BrowserConformanceTimingPercentiles {
  readonly samples: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
}

/** Percentile report for all independently measured Browser timing phases. */
export type BrowserConformanceTimingReport = Readonly<
  Record<BrowserConformanceTimingPhase, BrowserConformanceTimingPercentiles>
>;

/** Options controlling bounded tracer timing retention. */
export interface BrowserConformanceTimingMetricsOptions {
  readonly maxSamplesPerPhase?: number;
}

/**
 * Collects bounded, content-free timing samples without inferring one phase
 * from another.
 */
export class BrowserConformanceTimingMetrics {
  private readonly maxSamplesPerPhase: number;
  private readonly samples = new Map<BrowserConformanceTimingPhase, number[]>();

  constructor(options: BrowserConformanceTimingMetricsOptions = {}) {
    this.maxSamplesPerPhase = options.maxSamplesPerPhase ?? BROWSER_CONFORMANCE_MAX_TIMING_SAMPLES;
    if (
      !Number.isInteger(this.maxSamplesPerPhase) ||
      this.maxSamplesPerPhase < 1 ||
      this.maxSamplesPerPhase > BROWSER_CONFORMANCE_MAX_TIMING_SAMPLES
    ) {
      throw new RangeError("Browser conformance timing sample capacity is invalid");
    }
    for (const phase of BROWSER_CONFORMANCE_TIMING_PHASES) this.samples.set(phase, []);
  }

  /** Records one explicitly measured phase duration. */
  record(sample: BrowserConformanceTimingSample): void {
    if (!sample || typeof sample !== "object") throw new RangeError("Browser conformance timing sample is invalid");
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0 || sample.durationMs > BROWSER_CONFORMANCE_MAX_TIMING_DURATION_MS) {
      throw new RangeError("Browser conformance timing duration is invalid");
    }
    const values = this.samples.get(sample.phase);
    if (!values) throw new RangeError("Browser conformance timing phase is invalid");
    if (values.length >= this.maxSamplesPerPhase) values.shift();
    values.push(sample.durationMs);
  }

  /** Returns the current bounded percentile report for every timing phase. */
  report(): BrowserConformanceTimingReport {
    return Object.fromEntries(
      BROWSER_CONFORMANCE_TIMING_PHASES.map((phase) => [phase, summarize(this.samples.get(phase) ?? [])]),
    ) as BrowserConformanceTimingReport;
  }
}

function summarize(values: readonly number[]): BrowserConformanceTimingPercentiles {
  if (values.length === 0) return { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}
