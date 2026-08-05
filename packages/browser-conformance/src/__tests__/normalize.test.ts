import { describe, expect, it } from "vitest";
import { normalizeBrowserConformanceRun } from "../index.js";

describe("Browser conformance normalization", () => {
  it("keeps receipts, effects, recovery, truncation, ownership, and revisions while dropping dynamic fields", () => {
    const normalized = normalizeBrowserConformanceRun({
      receipts: [{
        requestId: "runtime-request-123",
        timestamp: 123456,
        operation: "browser_act",
        status: "interrupted",
        effect: "partial",
        recovery: "yield_to_user",
        truncated: true,
        revisions: { host: 2, document: 3, control: 4, capability: 5, observation: 6 },
        errorCode: "USER_TAKEOVER",
        errorStage: "effect",
        ownership: "user",
        exception: "do not retain this arbitrary string",
        order: { tick: 8, ordinal: 1 },
      }],
      outcome: {
        status: "interrupted",
        effect: "partial",
        recovery: "yield_to_user",
        truncated: true,
        revisions: { host: 2, document: 3, control: 4, capability: 5, observation: 6 },
        errorCode: "USER_TAKEOVER",
        errorStage: "effect",
        ownership: "user",
      },
      finalState: {
        readiness: "human-control",
        controlOwner: "user",
        tabCount: 1,
        currentUrl: "https://example.test/path?secret=redact#fragment",
        resources: { requests: 0, queues: 0, timers: 0, listeners: 0, heldInput: 0, controllerLeases: 0, targets: 0, replayEntries: 0, registries: 0, buffers: 0 },
      },
    });

    expect(normalized.receipts[0]).toMatchObject({
      operation: "act",
      status: "interrupted",
      effect: "partial",
      recovery: "yield_to_user",
      truncated: true,
      errorCode: "USER_TAKEOVER",
      errorStage: "effect",
      ownership: "user",
      revisions: { host: 2, document: 3, control: 4, capability: 5, observation: 6 },
    });
    expect(normalized.finalState.currentUrl).toBe("https://example.test/path");
    expect(JSON.stringify(normalized)).not.toContain("runtime-request-123");
    expect(JSON.stringify(normalized)).not.toContain("123456");
  });

  it("does not turn malformed outcomes into false success", () => {
    const normalized = normalizeBrowserConformanceRun({ outcome: { status: "completed-ish" } });
    expect(normalized.outcome.status).toBe("unknown");
    expect(normalized.outcome.effect).toBe("unknown");
    expect(normalized.outcome.recovery).toBe("unknown");
  });
});
