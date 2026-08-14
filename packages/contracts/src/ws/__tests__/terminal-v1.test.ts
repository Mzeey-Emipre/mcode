import { describe, expect, it } from "vitest";
import {
  TERMINAL_RPC_MAX_BYTES,
  TERMINAL_V1_METHOD_NAMES,
  TERMINAL_V1_METHODS,
  parseTerminalRpcRequest,
  TerminalRpcRequestSchema,
  TerminalRpcResponseSchema,
} from "../terminal.js";
import { WS_METHODS } from "../methods.js";

const UUID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";

describe("Terminal v1 management RPC", () => {
  it("registers the complete frozen management surface", () => {
    expect(TERMINAL_V1_METHOD_NAMES).toEqual([
      "terminal.capabilities",
      "terminal.session.create",
      "terminal.session.list",
      "terminal.session.attach",
      "terminal.session.detach",
      "terminal.session.close",
      "terminal.session.hasChildren",
      "terminal.session.checkpoint.begin",
      "terminal.session.checkpoint.complete",
      "terminal.profile.list",
      "terminal.profile.create",
      "terminal.profile.update",
      "terminal.profile.delete",
      "terminal.profile.setDefault",
      "terminal.workspacePreferences.get",
      "terminal.workspacePreferences.update",
      "terminal.workspacePreferences.reset",
      "terminal.preferences.reset",
      "terminal.preferences.update",
      "terminal.diagnostics.report",
      "terminal.diagnostics.getBundle",
    ]);
  });

  it("rejects unknown request fields and invalid scopes before dispatch", () => {
    const request = {
      id: UUID,
      method: "terminal.session.create",
      params: { scope: { kind: "workspace", workspaceId: UUID } },
    } as const;
    expect(TerminalRpcRequestSchema().parse(request)).toEqual(request);
    expect(() =>
      TerminalRpcRequestSchema().parse({ ...request, params: { ...request.params, shell: "pwsh" } }),
    ).toThrow();
  });

  it("rejects oversized raw requests before JSON parsing", () => {
    const raw = `{${" ".repeat(TERMINAL_RPC_MAX_BYTES)}}`;
    expect(() => parseTerminalRpcRequest(raw)).toThrow(/exceeds 128 KiB/i);
    expect(parseTerminalRpcRequest(JSON.stringify({
      id: UUID,
      method: "terminal.capabilities",
      params: {},
    }))).toMatchObject({ method: "terminal.capabilities" });
  });

  it("makes checkpoint completion authoritative and bounds upload declarations", () => {
    const begin = TERMINAL_V1_METHODS["terminal.session.checkpoint.begin"].params;
    expect(
      begin.parse({
        sessionId: UUID,
        attachmentId: UUID,
        attachmentEpoch: "1",
        hostGeneration: "2",
        baseOutputSeq: "3",
        declaredBytes: 65_536,
        sha256: "a".repeat(64),
      }),
    ).toMatchObject({ declaredBytes: 65_536 });
    expect(() =>
      begin.parse({
        sessionId: UUID,
        attachmentId: UUID,
        attachmentEpoch: "1",
        hostGeneration: "2",
        baseOutputSeq: "3",
        declaredBytes: 8_388_609,
        sha256: "a".repeat(64),
      }),
    ).toThrow();
    expect(TERMINAL_V1_METHODS["terminal.session.checkpoint.complete"].authority).toBe(
      "checkpoint-upload",
    );
  });

  it("publishes a closed retry policy for every operation", () => {
    for (const method of TERMINAL_V1_METHOD_NAMES) {
      const contract = TERMINAL_V1_METHODS[method];
      expect(contract.unknownResult).toMatch(
        /^(SAFE_RETRY|UNKNOWN_DELIVERY|REATTACH)$/,
      );
      expect(Object.keys(contract.errors).length).toBeGreaterThan(0);
    }
    expect(TERMINAL_V1_METHODS["terminal.session.create"].errors).toMatchObject({
      HOST_STARTING: "SAFE_RETRY",
      SLOT_LIMIT_REACHED: "NEW_SESSION",
      PROTOCOL_MISMATCH: "RESTART",
    });
  });

  it("validates response results against the requested method", () => {
    expect(TerminalRpcResponseSchema("terminal.session.hasChildren")).toBe(
      TerminalRpcResponseSchema("terminal.session.hasChildren"),
    );
    const response = { id: UUID, result: { hasChildren: true } };
    expect(TerminalRpcResponseSchema("terminal.session.hasChildren").parse(response)).toEqual(
      response,
    );
    expect(() =>
      TerminalRpcResponseSchema("terminal.session.hasChildren").parse({
        id: UUID,
        result: { hasChildren: "yes" },
      }),
    ).toThrow();
    expect(() =>
      TerminalRpcResponseSchema("terminal.session.detach").parse(response),
    ).toThrow();
  });

  it("registers profile and preference methods in the general WebSocket router", () => {
    const methods = Object.keys(WS_METHODS());
    expect(methods).toContain("terminal.profile.list");
    expect(methods).toContain("terminal.preferences.update");
    expect(methods).not.toContain("terminal.diagnostics.report");
  });

  it("validates response errors against the method retry table", () => {
    const response = {
      id: UUID,
      error: {
        code: "SESSION_NOT_FOUND",
        message: "Session not found",
        retry: "SAFE_RETRY",
        correlationId: "rpc-1",
      },
    } as const;
    expect(TerminalRpcResponseSchema("terminal.session.hasChildren").parse(response)).toEqual(
      response,
    );
    expect(() =>
      TerminalRpcResponseSchema("terminal.session.hasChildren").parse({
        ...response,
        error: { ...response.error, code: "PROFILE_NOT_FOUND" },
      }),
    ).toThrow();
    expect(() =>
      TerminalRpcResponseSchema("terminal.session.hasChildren").parse({
        ...response,
        error: { ...response.error, retry: "NEW_SESSION" },
      }),
    ).toThrow();
  });

  it("permits diagnostics results between 128 KiB and 512 KiB", () => {
    const events = Array.from({ length: 800 }, (_, index) => ({
      eventId: `11111111-1111-4111-8111-${index.toString(16).padStart(12, "0")}`,
      at: "2026-08-09T12:00:00.000Z",
      metric: "session.create.ms",
      unit: "ms",
      value: 1,
      outcome: "ok",
      correlationId: `event-${index}`,
    }));
    const response = {
      id: UUID,
      result: {
        contractVersion: 1,
        generatedAt: "2026-08-09T12:00:00.000Z",
        backend: "modern",
        health: {
          contractVersion: 1,
          state: "healthy",
          hostGeneration: "1",
          activeSessions: 1,
          lastHeartbeatMsAgo: 10,
          queueBytes: 0,
          eventLoopLagMs: 1,
          hostRssBytes: "1024",
        },
        events,
        counters: [],
        histograms: [],
      },
    };
    expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeGreaterThan(
      TERMINAL_RPC_MAX_BYTES,
    );
    expect(
      TerminalRpcResponseSchema("terminal.diagnostics.getBundle").parse(response),
    ).toEqual(response);
  });
});
