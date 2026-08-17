import { describe, expect, it } from "vitest";
import type { TerminalDiagnosticEvent, TerminalHealthSnapshot } from "@mcode/contracts";
import { TerminalDiagnosticsService } from "../terminal-diagnostics-service.js";

const HEALTH: TerminalHealthSnapshot = {
  contractVersion: 1,
  state: "healthy",
  hostGeneration: "7",
  activeSessions: 2,
  lastHeartbeatMsAgo: 10,
  queueBytes: 0,
  eventLoopLagMs: 1,
  hostRssBytes: "1024",
};

function event(overrides: Partial<TerminalDiagnosticEvent> = {}): TerminalDiagnosticEvent {
  return {
    eventId: "00000000-0000-4000-8000-000000000001",
    at: "2026-08-11T12:00:00.000Z",
    metric: "session.create.ms",
    unit: "ms",
    value: 25,
    outcome: "ok",
    correlationId: "user-supplied-text",
    ...overrides,
  };
}

describe("TerminalDiagnosticsService", () => {
  it("deduplicates events and replaces caller correlation text", () => {
    const service = new TerminalDiagnosticsService({
      backend: () => "modern",
      health: () => HEALTH,
      now: () => new Date("2026-08-11T12:01:00.000Z"),
      createCorrelationId: () => "corr-generated",
    });

    expect(service.report({ events: [event(), event()] })).toEqual({ accepted: 1 });

    const bundle = service.getBundle();
    expect(bundle.events).toHaveLength(1);
    expect(bundle.events[0].correlationId).toBe("corr-generated");
    expect(JSON.stringify(bundle)).not.toContain("user-supplied-text");
    expect(bundle.histograms).toEqual([
      {
        metric: "session.create.ms",
        unit: "ms",
        count: 1,
        p50: 25,
        p95: 25,
        p99: 25,
      },
    ]);
  });

  it("evicts expired events and bounds retained events to 2,048", () => {
    let now = new Date("2026-08-11T12:10:00.000Z");
    let id = 0;
    const service = new TerminalDiagnosticsService({
      backend: () => "modern",
      health: () => HEALTH,
      now: () => now,
      createCorrelationId: () => `corr-${id}`,
    });

    service.report({
      events: [event({ at: "2026-08-11T12:04:59.999Z" })],
    });
    for (let batch = 0; batch < 17; batch += 1) {
      service.report({
        events: Array.from({ length: 128 }, () => {
          id += 1;
          return event({
            eventId: `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
            at: now.toISOString(),
          });
        }),
      });
    }

    expect(service.getBundle().events).toHaveLength(2_048);

    now = new Date("2026-08-11T12:15:00.001Z");
    expect(service.getBundle().events).toHaveLength(0);
  });

  it("evicts expired events even when they arrive after recent events", () => {
    const service = new TerminalDiagnosticsService({
      backend: () => "modern",
      health: () => HEALTH,
      now: () => new Date("2026-08-11T12:10:00.000Z"),
    });

    service.report({ events: [
      event({ at: "2026-08-11T12:10:00.000Z" }),
      event({
        eventId: "00000000-0000-4000-8000-000000000002",
        at: "2026-08-11T12:04:59.999Z",
      }),
    ] });

    expect(service.getBundle().events.map(({ eventId }) => eventId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("rejects invalid or oversized reports at the service boundary", () => {
    const service = new TerminalDiagnosticsService({
      backend: () => "legacy",
      health: () => HEALTH,
    });

    expect(() => service.report({
      events: [{ ...event(), command: "secret" }],
    })).toThrow();
    expect(() => service.report({
      events: Array.from({ length: 129 }, (_, index) => event({
        eventId: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
      })),
    })).toThrow();
  });
});
