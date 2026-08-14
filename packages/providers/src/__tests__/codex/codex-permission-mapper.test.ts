import { describe, it, expect, vi } from "vitest";

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  mapDecisionToCodexResponse,
  synthesizeCodexPermissionRequest,
  CODEX_APPROVAL_METHODS,
} from "../../private/codex/codex-permission-mapper.js";

describe("mapDecisionToCodexResponse", () => {
  describe("commandExecution / fileChange (v2)", () => {
    it.each([
      ["item/commandExecution/requestApproval"],
      ["item/fileChange/requestApproval"],
    ])("maps allow to { decision: 'accept' } for %s", (method) => {
      expect(mapDecisionToCodexResponse(method, "allow", {})).toEqual({ decision: "accept" });
    });

    it.each([
      ["item/commandExecution/requestApproval"],
      ["item/fileChange/requestApproval"],
    ])("maps allow-session to { decision: 'acceptForSession' } for %s", (method) => {
      expect(mapDecisionToCodexResponse(method, "allow-session", {})).toEqual({
        decision: "acceptForSession",
      });
    });

    it.each([
      ["item/commandExecution/requestApproval"],
      ["item/fileChange/requestApproval"],
    ])("maps deny to { decision: 'decline' } for %s", (method) => {
      expect(mapDecisionToCodexResponse(method, "deny", {})).toEqual({ decision: "decline" });
    });

    it.each([
      ["item/commandExecution/requestApproval"],
      ["item/fileChange/requestApproval"],
    ])("maps cancelled to { decision: 'cancel' } for %s", (method) => {
      expect(mapDecisionToCodexResponse(method, "cancelled", {})).toEqual({ decision: "cancel" });
    });
  });

  describe("item/permissions/requestApproval (v2)", () => {
    const method = "item/permissions/requestApproval";
    const echoed = { fileSystem: { read: ["/foo"], write: [] }, network: { enabled: false } };

    it("maps allow to echoed permissions with turn scope", () => {
      expect(mapDecisionToCodexResponse(method, "allow", { permissions: echoed })).toEqual({
        permissions: echoed,
        scope: "turn",
      });
    });

    it("maps allow-session to echoed permissions with session scope", () => {
      expect(mapDecisionToCodexResponse(method, "allow-session", { permissions: echoed })).toEqual({
        permissions: echoed,
        scope: "session",
      });
    });

    it("maps deny to empty permissions with turn scope", () => {
      expect(mapDecisionToCodexResponse(method, "deny", { permissions: echoed })).toEqual({
        permissions: {},
        scope: "turn",
      });
    });

    it("maps cancelled to empty permissions with turn scope (kill() handles interrupt)", () => {
      expect(mapDecisionToCodexResponse(method, "cancelled", { permissions: echoed })).toEqual({
        permissions: {},
        scope: "turn",
      });
    });
  });

  describe("legacy applyPatchApproval / execCommandApproval", () => {
    it.each([
      ["applyPatchApproval", "allow", "approved"],
      ["execCommandApproval", "allow", "approved"],
      ["applyPatchApproval", "allow-session", "approved_for_session"],
      ["execCommandApproval", "allow-session", "approved_for_session"],
      ["applyPatchApproval", "deny", "denied"],
      ["execCommandApproval", "deny", "denied"],
      ["applyPatchApproval", "cancelled", "abort"],
      ["execCommandApproval", "cancelled", "abort"],
    ] as const)("maps %s + %s to decision: %s", (method, decision, expected) => {
      expect(mapDecisionToCodexResponse(method, decision, {})).toEqual({ decision: expected });
    });
  });

  describe("unknown methods", () => {
    it("falls back to decline for unknown non-permissions methods", () => {
      expect(mapDecisionToCodexResponse("item/unknown/requestApproval", "deny", {})).toEqual({
        decision: "decline",
      });
    });

    it("falls back to empty permissions + turn for unknown permissions-like methods", () => {
      expect(
        mapDecisionToCodexResponse("item/somePermissionsThing/requestApproval", "deny", {}),
      ).toEqual({ permissions: {}, scope: "turn" });
    });
  });
});

describe("synthesizeCodexPermissionRequest", () => {
  it("returns Shell toolName for commandExecution", () => {
    const req = synthesizeCodexPermissionRequest({
      threadId: "t1",
      requestId: "r1",
      method: "item/commandExecution/requestApproval",
      params: { command: "ls -la", cwd: "/tmp", reason: "list files" },
    });
    expect(req.toolName).toBe("Shell");
    expect(req.threadId).toBe("t1");
    expect(req.requestId).toBe("r1");
    expect(req.title).toBe("list files");
    expect(req.input).toEqual({ command: "ls -la", cwd: "/tmp" });
  });

  it("forwards commandActions and networkApprovalContext when present", () => {
    const req = synthesizeCodexPermissionRequest({
      threadId: "t1",
      requestId: "r1",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "curl example.com",
        cwd: "/tmp",
        commandActions: ["network"],
        networkApprovalContext: { host: "example.com" },
      },
    });
    expect(req.input).toEqual({
      command: "curl example.com",
      cwd: "/tmp",
      commandActions: ["network"],
      networkApprovalContext: { host: "example.com" },
    });
  });

  it("returns FileWrite toolName for fileChange", () => {
    const req = synthesizeCodexPermissionRequest({
      threadId: "t1",
      requestId: "r1",
      method: "item/fileChange/requestApproval",
      params: { itemId: "abc123", grantRoot: "/repo" },
    });
    expect(req.toolName).toBe("FileWrite");
    expect(req.input).toEqual({ itemId: "abc123", grantRoot: "/repo" });
  });

  it("returns WorkspacePermissions toolName for permissions request", () => {
    const req = synthesizeCodexPermissionRequest({
      threadId: "t1",
      requestId: "r1",
      method: "item/permissions/requestApproval",
      params: { permissions: { fileSystem: { read: ["/foo"], write: [] } } },
    });
    expect(req.toolName).toBe("WorkspacePermissions");
    expect(req.input).toEqual({ permissions: { fileSystem: { read: ["/foo"], write: [] } } });
  });

  it("returns ApplyPatch for legacy applyPatchApproval and passes params through", () => {
    const req = synthesizeCodexPermissionRequest({
      threadId: "t1",
      requestId: "r1",
      method: "applyPatchApproval",
      params: { patch: "diff --git..." },
    });
    expect(req.toolName).toBe("ApplyPatch");
    expect(req.input).toEqual({ patch: "diff --git..." });
  });

  it("returns Shell for legacy execCommandApproval", () => {
    const req = synthesizeCodexPermissionRequest({
      threadId: "t1",
      requestId: "r1",
      method: "execCommandApproval",
      params: { command: "rm -rf /tmp/x" },
    });
    expect(req.toolName).toBe("Shell");
    expect(req.input).toEqual({ command: "rm -rf /tmp/x" });
  });

  it("omits title when params.reason is missing", () => {
    const req = synthesizeCodexPermissionRequest({
      threadId: "t1",
      requestId: "r1",
      method: "item/commandExecution/requestApproval",
      params: { command: "ls", cwd: "/tmp" },
    });
    expect(req.title).toBeUndefined();
  });
});

describe("CODEX_APPROVAL_METHODS", () => {
  it("exposes the five recognised method names", () => {
    expect(CODEX_APPROVAL_METHODS).toEqual([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "applyPatchApproval",
      "execCommandApproval",
    ]);
  });
});
