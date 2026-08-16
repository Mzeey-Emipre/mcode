import { describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_CONTRACT_VERSION, type BrowserAutomationResponse } from "@mcode/contracts";
import {
  BrowserAutomationTelemetry,
  browserAutomationTerminalFields,
} from "../telemetry.js";

describe("Browser automation telemetry", () => {
  it("classifies every terminal failure and reports unexpected rate", () => {
    const telemetry = new BrowserAutomationTelemetry();
    const record = (correlationId: string, response: BrowserAutomationResponse) => telemetry.record({
      timestampMs: 1,
      correlationId,
      stage: "settlement",
      provider: "codex",
      runtime: "electron",
      operation: "act",
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      durationMs: 10,
      ...browserAutomationTerminalFields(response),
    });
    record("ok", {
      contractVersion: 1,
      requestId: "ok",
      sequence: 1,
      ok: true,
      result: {
        operation: "act",
        outcome: "completed",
        stoppingPosition: 1,
        effect: "complete",
        recovery: "inspect",
        receipts: [{ index: 0, operation: "click", status: "applied" }],
        finalObservation: { observationRef: "obs", hostRevision: 1, documentRevision: 1, controlRevision: 1, capabilityRevision: 1, observationRevision: 1 },
      },
    });
    record("expected", {
      contractVersion: 1,
      requestId: "expected",
      sequence: 2,
      ok: false,
      error: { code: "HUMAN_INTERRUPTED", message: "Stopped", retryable: false, effect: "none", recovery: "yield_to_user" },
    });
    record("unexpected", {
      contractVersion: 1,
      requestId: "unexpected",
      sequence: 3,
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Failed", retryable: false, effect: "unknown", recovery: "do_not_retry" },
    });

    expect(telemetry.report()).toMatchObject({
      observedRequests: 3,
      successfulRequests: 1,
      expectedFailures: 1,
      unexpectedFailures: 1,
      unexpectedFailureRate: 1 / 3,
      classifiedFailures: { "user-takeover": 1, "unknown-outcome": 1 },
      zeroTolerance: { unknownOutcome: 1 },
    });
    expect(telemetry.report().recentFailures).toHaveLength(2);
  });

  it("retains only closed content-free fields and ignores sink failures", () => {
    const sink = vi.fn((_event: unknown) => { throw new Error("log unavailable"); });
    const telemetry = new BrowserAutomationTelemetry({ maxEvents: 1, sink });
    telemetry.record({
      timestampMs: 1,
      correlationId: "request-1",
      stage: "configuration",
      provider: "claude",
      operation: "inspect",
      contractVersion: 1,
      outcome: "accepted",
    });
    telemetry.record({
      timestampMs: 2,
      correlationId: "request-1",
      stage: "mcp-routing",
      provider: "claude",
      operation: "inspect",
      contractVersion: 1,
      outcome: "accepted",
      url: "https://example.test/private",
      headers: { authorization: "secret" },
    } as never);

    expect(telemetry.report().retainedEvents).toBe(1);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1]?.[0]).not.toHaveProperty("url");
    expect(sink.mock.calls[1]?.[0]).not.toHaveProperty("headers");
    expect(JSON.stringify(telemetry.report())).not.toMatch(/cookie|credential|header|typed|screenshot|dom|expression|url/i);
  });

  it("does not count document-boundary interruption as takeover", () => {
    const interrupted = browserAutomationTerminalFields({
      contractVersion: 1,
      requestId: "reload",
      sequence: 1,
      ok: true,
      result: {
        operation: "evaluate",
        outcome: "interrupted",
        stoppingPosition: 0,
        effect: "partial",
        recovery: "inspect",
        receipts: [{ index: 0, operation: "evaluate", status: "interrupted" }],
        finalObservation: {
          observationRef: "obs",
          hostRevision: 1,
          documentRevision: 2,
          controlRevision: 0,
          capabilityRevision: 1,
          observationRevision: 1,
        },
      },
    });
    expect(interrupted).toMatchObject({
      failureClass: "application-error",
      takeover: false,
      effect: "partial",
    });

    const telemetry = new BrowserAutomationTelemetry();
    telemetry.record({
      timestampMs: 1,
      correlationId: "reload",
      stage: "settlement",
      provider: "codex",
      operation: "evaluate",
      contractVersion: 1,
      ...interrupted,
    });
    expect(telemetry.report().zeroTolerance.postTakeoverEffect).toBe(0);
  });

  it("keeps explicit human interruption as takeover", () => {
    expect(browserAutomationTerminalFields({
      contractVersion: 1,
      requestId: "human",
      sequence: 1,
      ok: false,
      error: { code: "HUMAN_INTERRUPTED", message: "Stopped", retryable: true, effect: "preserved", recovery: "yield_to_user" },
    })).toMatchObject({
      failureClass: "user-takeover",
      takeover: true,
    });
  });
});
