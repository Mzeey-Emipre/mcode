import { describe, expect, it } from "vitest";
import {
  CANONICAL_DIAGNOSTIC_RING_CAPACITY,
  CanonicalAgentDiagnostics,
} from "../canonical-agent-diagnostics.js";

describe("CanonicalAgentDiagnostics", () => {
  it.each([
    [CANONICAL_DIAGNOSTIC_RING_CAPACITY - 1, 0],
    [CANONICAL_DIAGNOSTIC_RING_CAPACITY, 0],
    [CANONICAL_DIAGNOSTIC_RING_CAPACITY + 1, 1],
  ])("retains %i content-free diagnostics with %i dropped", (count, droppedEntries) => {
    const diagnostics = new CanonicalAgentDiagnostics();

    for (let index = 0; index < count; index += 1) {
      diagnostics.record({
        turnId: "turn-1",
        executionId: "execution-1",
        source: "provider",
        event: {
          type: "textDelta",
          threadId: "thread-1",
          delta: `secret-${index}`,
        },
      });
    }

    const exported = diagnostics.exportTurn("turn-1");
    expect(exported.entries).toHaveLength(Math.min(count, CANONICAL_DIAGNOSTIC_RING_CAPACITY));
    expect(exported.truncation).toEqual({ droppedEntries });
    expect(JSON.stringify(exported.entries)).not.toContain("secret-");
    expect(exported.entries.at(-1)).toMatchObject({
      source: "provider",
      eventType: "textDelta",
      contentBytes: 10,
      redacted: true,
    });
    expect(exported).not.toHaveProperty("rawEvents");
  });

  it("requires consent, expiry, and separate confirmation for one-turn raw export", () => {
    let now = 1_000;
    const diagnostics = new CanonicalAgentDiagnostics(() => now);

    expect(() => diagnostics.startRawCapture({
      turnId: "turn-1",
      consent: false,
      expiresInMs: 1_000,
    })).toThrow("Raw capture requires explicit consent");

    diagnostics.startRawCapture({
      turnId: "turn-1",
      consent: true,
      expiresInMs: 1_000,
    });
    diagnostics.record({
      turnId: "turn-1",
      executionId: "execution-1",
      source: "provider",
      event: { type: "message", content: "private answer" },
      terminal: true,
    });

    expect(() => diagnostics.exportTurn("turn-1", { includeRaw: true })).toThrow(
      "Raw export requires separate confirmation",
    );
    expect(diagnostics.exportTurn("turn-1", {
      includeRaw: true,
      confirmRaw: true,
    }).rawEvents).toEqual([{ type: "message", content: "private answer" }]);
    expect(diagnostics.exportTurn("turn-1", {
      includeRaw: true,
      confirmRaw: true,
    }).rawEvents).toEqual([]);

    diagnostics.startRawCapture({
      turnId: "turn-2",
      consent: true,
      expiresInMs: 1_000,
    });
    now = 2_001;
    diagnostics.record({
      turnId: "turn-2",
      executionId: "execution-2",
      source: "provider",
      event: { type: "message", content: "expired answer" },
    });
    expect(diagnostics.exportTurn("turn-2", {
      includeRaw: true,
      confirmRaw: true,
    }).rawEvents).toEqual([]);
  });
});
