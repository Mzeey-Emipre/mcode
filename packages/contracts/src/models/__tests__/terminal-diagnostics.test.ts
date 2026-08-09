import { describe, expect, it } from "vitest";
import {
  TerminalDiagnosticEventSchema,
  TerminalDiagnosticsBundleSchema,
} from "../terminal-diagnostics.js";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("Terminal v1 diagnostics", () => {
  it("enforces metric units and metric-specific bounds", () => {
    const event = {
      eventId: UUID,
      at: "2026-08-09T12:00:00.000Z",
      metric: "attachment.hydration.ms",
      unit: "ms",
      value: 250,
      outcome: "ok",
      correlationId: "hydrate-1",
    } as const;
    expect(TerminalDiagnosticEventSchema().parse(event)).toEqual(event);
    expect(() => TerminalDiagnosticEventSchema().parse({ ...event, unit: "bytes" })).toThrow();
    expect(() => TerminalDiagnosticEventSchema().parse({ ...event, value: 600_001 })).toThrow();
  });

  it("rejects duplicate metrics and unordered histogram percentiles", () => {
    const health = {
      contractVersion: 1,
      state: "healthy",
      hostGeneration: "1",
      activeSessions: 1,
      lastHeartbeatMsAgo: 10,
      queueBytes: 0,
      eventLoopLagMs: 1,
      hostRssBytes: "1024",
    } as const;
    const base = {
      contractVersion: 1,
      generatedAt: "2026-08-09T12:00:00.000Z",
      backend: "modern",
      health,
      events: [],
      counters: [],
      histograms: [],
    } as const;
    expect(TerminalDiagnosticsBundleSchema().parse(base)).toEqual(base);
    expect(() =>
      TerminalDiagnosticsBundleSchema().parse({
        ...base,
        histograms: [
          {
            metric: "session.create.ms",
            unit: "ms",
            count: 1,
            p50: 10,
            p95: 9,
            p99: 12,
          },
        ],
      }),
    ).toThrow();
  });
});
