import { createHash, randomUUID } from "node:crypto";
import {
  TERMINAL_V1_METHODS,
  TerminalDiagnosticsBundleSchema,
  type TerminalDiagnosticEvent,
  type TerminalDiagnosticsBundle,
  type TerminalHealthSnapshot,
  type TerminalMetricId,
} from "@mcode/contracts";

const RETENTION_MS = 5 * 60 * 1_000;
const MAX_RETAINED_EVENTS = 2_048;

/** Runtime sources used to build redacted Terminal diagnostic bundles. */
export interface TerminalDiagnosticsServiceOptions {
  readonly backend: () => "modern" | "legacy";
  readonly health: () => TerminalHealthSnapshot;
  readonly now?: () => Date;
  readonly createCorrelationId?: () => string;
}

interface RetainedDiagnosticEvent {
  readonly event: TerminalDiagnosticEvent;
  readonly atMs: number;
  readonly sourceCorrelationKey: string;
}

/** Collects bounded Terminal diagnostics without retaining caller-provided text. */
export class TerminalDiagnosticsService {
  private readonly events: RetainedDiagnosticEvent[] = [];
  private readonly eventIds = new Set<string>();
  private readonly correlations = new Map<string, string>();
  private readonly correlationReferences = new Map<string, number>();
  private readonly now: () => Date;
  private readonly createCorrelationId: () => string;

  constructor(private readonly options: TerminalDiagnosticsServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createCorrelationId = options.createCorrelationId ?? (() => `corr-${randomUUID()}`);
  }

  /** Validates, redacts, deduplicates, and retains one renderer event batch. */
  report(input: unknown): { accepted: number } {
    const parsed = TERMINAL_V1_METHODS["terminal.diagnostics.report"].params.parse(input) as {
      readonly events: readonly TerminalDiagnosticEvent[];
    };
    this.evictExpired(this.now().getTime());
    let accepted = 0;
    for (const event of parsed.events) {
      if (this.eventIds.has(event.eventId)) continue;
      const atMs = Date.parse(event.at);
      const sourceCorrelationKey = correlationKey(event.correlationId);
      const redacted = Object.freeze({
        ...event,
        correlationId: this.redactedCorrelation(sourceCorrelationKey),
      });
      this.events.push({ event: redacted, atMs, sourceCorrelationKey });
      this.eventIds.add(event.eventId);
      this.correlationReferences.set(
        sourceCorrelationKey,
        (this.correlationReferences.get(sourceCorrelationKey) ?? 0) + 1,
      );
      accepted += 1;
    }
    this.events.sort((left, right) => left.atMs - right.atMs);
    this.evictExpired(this.now().getTime());
    this.evictOverflow();
    return { accepted };
  }

  /** Returns one schema-validated bundle capped at the public 512 KiB boundary. */
  getBundle(): TerminalDiagnosticsBundle {
    this.evictExpired(this.now().getTime());
    const events = this.events.map(({ event }) => event);
    const bundle = this.createBundle(events);
    while (!TERMINAL_V1_METHODS["terminal.diagnostics.getBundle"].result.safeParse(bundle).success) {
      if (events.length === 0) {
        return TerminalDiagnosticsBundleSchema().parse(bundle);
      }
      events.shift();
      Object.assign(bundle, this.createBundle(events));
    }
    return bundle;
  }

  private createBundle(events: readonly TerminalDiagnosticEvent[]): TerminalDiagnosticsBundle {
    const measurements = new Map<TerminalMetricId, number[]>();
    for (const event of events) {
      const values = measurements.get(event.metric) ?? [];
      values.push(event.value);
      measurements.set(event.metric, values);
    }
    const counters = [...measurements.entries()]
      .filter(([metric]) => metric.endsWith(".count"))
      .map(([metric, values]) => ({ metric, value: values.reduce((sum, value) => sum + value, 0) }));
    const histograms = [...measurements.entries()]
      .filter(([metric]) => !metric.endsWith(".count"))
      .map(([metric, values]) => {
        const ordered = [...values].sort((left, right) => left - right);
        const unit = metric.endsWith(".ms") ? "ms" as const : "bytes" as const;
        return {
          metric,
          unit,
          count: ordered.length,
          p50: percentile(ordered, 0.5),
          p95: percentile(ordered, 0.95),
          p99: percentile(ordered, 0.99),
        };
      });
    return TerminalDiagnosticsBundleSchema().parse({
      contractVersion: 1,
      generatedAt: this.now().toISOString(),
      backend: this.options.backend(),
      health: this.options.health(),
      events,
      counters,
      histograms,
    });
  }

  private redactedCorrelation(sourceKey: string): string {
    const existing = this.correlations.get(sourceKey);
    if (existing) return existing;
    const generated = this.createCorrelationId();
    this.correlations.set(sourceKey, generated);
    return generated;
  }

  private evictExpired(nowMs: number): void {
    const cutoff = nowMs - RETENTION_MS;
    while (this.events[0]?.atMs < cutoff) this.removeOldest();
  }

  private evictOverflow(): void {
    while (this.events.length > MAX_RETAINED_EVENTS) this.removeOldest();
  }

  private removeOldest(): void {
    const removed = this.events.shift();
    if (!removed) return;
    this.eventIds.delete(removed.event.eventId);
    const remaining = (this.correlationReferences.get(removed.sourceCorrelationKey) ?? 1) - 1;
    if (remaining === 0) {
      this.correlationReferences.delete(removed.sourceCorrelationKey);
      this.correlations.delete(removed.sourceCorrelationKey);
      return;
    }
    this.correlationReferences.set(removed.sourceCorrelationKey, remaining);
  }
}

function correlationKey(source: string): string {
  return createHash("sha256").update(source).digest("base64url");
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  return values[Math.ceil(values.length * quantile) - 1];
}
