import { describe, expect, it, vi } from "vitest";
import { createProviderHostPorts } from "../provider-host-ports.js";

describe("createProviderHostPorts", () => {
  it("adapts the server browser grant to the Provider contract", () => {
    const ports = createProviderHostPorts({
      envService: { getEnv: () => ({}) },
      jobObject: { isWindowsJob: false },
      browser: {
        issue: vi.fn(() => ({
          leaseId: "lease-1",
          mcpUrl: "http://127.0.0.1:1234/mcp",
          token: "opaque-token",
          credentialId: "credential-1",
          expiresAt: 123,
          allowedOperations: ["inspect"],
        })),
      },
      threadControl: {},
      grants: {},
      events: {},
    } as never);

    expect(ports.browser.issue({ leaseId: "lease-1", expiresAt: 123 })).toEqual({
      leaseId: "lease-1",
      mcpUrl: "http://127.0.0.1:1234/mcp",
      token: "opaque-token",
      credentialId: "credential-1",
      expiresAt: 123,
      allowedOperations: ["inspect"],
    });
  });

  it("routes canonical drafts through the server-owned sink", async () => {
    const commit = vi.fn();
    const ports = createProviderHostPorts({
      envService: { getEnv: () => ({ PATH: "test" }) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: { commit },
    } as never);
    const batch = {
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: "00000000-0000-4000-8000-000000000001",
      phase: "streaming",
      events: [],
    };

    await ports.events.submit(batch);

    expect(commit).toHaveBeenCalledWith({ ...batch, nativeCursor: undefined });
  });
});
