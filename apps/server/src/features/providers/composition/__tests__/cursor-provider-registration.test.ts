import { describe, expect, it, vi } from "vitest";
import type { Settings } from "@mcode/contracts";
import type { ProviderFactoryInput, ProviderHostPorts } from "@mcode/providers";
import { registerCursorProvider } from "../cursor-provider-registration.js";

function createHostPorts() {
  const environmentSnapshot = vi.fn(() => ({}));
  const processAttach = vi.fn();
  const terminateTree = vi.fn(async () => undefined);
  const browserStage = vi.fn(() => ({ leaseId: "lease", expiresAt: Date.now() + 1_000 }));
  const browserIssue = vi.fn(() => null);
  const threadControlBootstrap = vi.fn(async () => null);
  const submitEvents = vi.fn(async () => undefined);
  const host: ProviderHostPorts = {
    environment: { snapshot: environmentSnapshot },
    processes: { attach: processAttach, terminateTree },
    browser: {
      stage: browserStage,
      releaseSession: () => 0,
      isConfigured: () => false,
      issue: browserIssue,
      refresh: (leaseId) => ({ ok: false, leaseId, reason: "not-found" }),
      release: (leaseId) => ({ leaseId, released: false }),
      revokeCredential: () => false,
    },
    threadControl: { bootstrap: threadControlBootstrap, close: async () => undefined },
    grants: { consume: () => false },
    events: { submit: submitEvents },
  };
  return { host, environmentSnapshot, processAttach, terminateTree, browserStage, browserIssue, threadControlBootstrap, submitEvents };
}

describe("registerCursorProvider", () => {
  it("registers one usable Cursor lifecycle owner without factory I/O", () => {
    const ports = createHostPorts();
    const registerInstance = vi.fn();
    const input: ProviderFactoryInput = {
      configuration: { cliPath: "cursor-agent", idleSessionTtlMs: 600_000 },
      host: ports.host,
      cursor: {
        settings: { get: () => ({} as Settings) },
        skills: { list: () => [] },
      },
    };

    const provider = registerCursorProvider({ registerInstance }, input);

    expect(registerInstance).toHaveBeenCalledExactlyOnceWith("IAgentProvider", provider);
    expect(provider.id).toBe("cursor");
    expect(provider.sendTurn).toBeTypeOf("function");
    expect(ports.environmentSnapshot).not.toHaveBeenCalled();
    expect(ports.processAttach).not.toHaveBeenCalled();
    expect(ports.terminateTree).not.toHaveBeenCalled();
    expect(ports.browserStage).not.toHaveBeenCalled();
    expect(ports.browserIssue).not.toHaveBeenCalled();
    expect(ports.threadControlBootstrap).not.toHaveBeenCalled();
    expect(ports.submitEvents).not.toHaveBeenCalled();
  });
});
