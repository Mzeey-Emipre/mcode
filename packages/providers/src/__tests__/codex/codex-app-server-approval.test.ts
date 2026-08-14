import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

/**
 * We isolate the serverRequest routing by extracting the pure logic into a
 * helper exported from codex-app-server.ts. Spawning the real subprocess
 * is overkill for this unit; the integration is covered by manual UI testing.
 */
import { routeCodexServerRequest } from "../../private/codex/codex-app-server.js";

describe("routeCodexServerRequest", () => {
  let sendResponse: Mock<(id: number, result: unknown) => void>;

  beforeEach(() => {
    sendResponse = vi.fn<(id: number, result: unknown) => void>();
  });

  it("auto-approves v2 methods when approvalPolicy is 'never'", async () => {
    await routeCodexServerRequest({
      msg: { id: 1, method: "item/commandExecution/requestApproval", params: {} },
      approvalPolicy: "never",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(1, { decision: "acceptForSession" });
  });

  it("auto-approves permissions method with full access when policy is 'never'", async () => {
    await routeCodexServerRequest({
      msg: { id: 2, method: "item/permissions/requestApproval", params: {} },
      approvalPolicy: "never",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(2, {
      permissions: {
        fileSystem: { read: [], write: [] },
        network: { enabled: true },
      },
      scope: "session",
    });
  });

  it("auto-approves legacy methods with approved_for_session when policy is 'never'", async () => {
    await routeCodexServerRequest({
      msg: { id: 3, method: "applyPatchApproval", params: {} },
      approvalPolicy: "never",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(3, { decision: "approved_for_session" });
  });

  it("auto-denies in supervised mode when no handler is set", async () => {
    await routeCodexServerRequest({
      msg: { id: 4, method: "item/commandExecution/requestApproval", params: {} },
      approvalPolicy: "on-request",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(4, { decision: "decline" });
  });

  it("auto-denies legacy methods in supervised mode with 'denied'", async () => {
    await routeCodexServerRequest({
      msg: { id: 5, method: "applyPatchApproval", params: {} },
      approvalPolicy: "on-request",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(5, { decision: "denied" });
  });

  it("invokes the handler in supervised mode and relays its result", async () => {
    const handler = vi.fn().mockResolvedValue({ decision: "accept" });
    await routeCodexServerRequest({
      msg: { id: 6, method: "item/commandExecution/requestApproval", params: { command: "ls" } },
      approvalPolicy: "on-request",
      approvalHandler: handler,
      sendResponse,
    });
    expect(handler).toHaveBeenCalledWith({
      rpcId: 6,
      method: "item/commandExecution/requestApproval",
      params: { command: "ls" },
    });
    expect(sendResponse).toHaveBeenCalledWith(6, { decision: "accept" });
  });

  it("falls back to mapped safe-deny when the handler rejects", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    await routeCodexServerRequest({
      msg: { id: 7, method: "item/commandExecution/requestApproval", params: {} },
      approvalPolicy: "on-request",
      approvalHandler: handler,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(7, { decision: "decline" });
  });

  it("falls back to mapped safe-deny for permissions method when handler rejects", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    await routeCodexServerRequest({
      msg: { id: 8, method: "item/permissions/requestApproval", params: { permissions: {} } },
      approvalPolicy: "on-request",
      approvalHandler: handler,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(8, { permissions: {}, scope: "turn" });
  });

  it("ignores messages without a numeric id", async () => {
    await routeCodexServerRequest({
      msg: { method: "item/commandExecution/requestApproval", params: {} },
      approvalPolicy: "on-request",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
