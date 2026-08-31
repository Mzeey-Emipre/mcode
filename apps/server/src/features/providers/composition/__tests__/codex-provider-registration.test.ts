import { describe, expect, it, vi } from "vitest";
import type { ProviderFactoryInput, ProviderHostPorts } from "@mcode/providers";
import { registerCodexProvider } from "../codex-provider-registration.js";

function createHostPorts(): ProviderHostPorts {
  return {
    runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
    environment: { snapshot: vi.fn(() => ({})) },
    processes: {
      attach: vi.fn(),
      terminateTree: vi.fn(async () => undefined),
    },
    browser: {
      stage: vi.fn(() => ({ leaseId: "lease-1", expiresAt: Date.now() + 1_000 })),
      releaseSession: vi.fn(() => 0),
      isConfigured: vi.fn(() => false),
      issue: vi.fn(() => null),
      release: vi.fn(() => ({ leaseId: "lease-1", released: false })),
      revokeCredential: vi.fn(() => false),
    },
    threadControl: {
      bootstrap: vi.fn(async () => null),
      close: vi.fn(async () => undefined),
    },
    grants: { consume: vi.fn(() => false) },
    events: { submit: vi.fn(async () => undefined) },
  };
}

describe("Codex Provider registration", () => {
  it("registers the usable factory instance without construction host calls", () => {
    const registered: unknown[] = [];
    const host = createHostPorts();
    const input: ProviderFactoryInput = {
      configuration: { cliPath: "codex", idleSessionTtlMs: 600_000 },
      host,
      codex: {
        settings: { get: vi.fn(async () => ({ cliPath: "codex", fastMode: false })) },
        attachments: { persistGeneratedImageFromPath: vi.fn() },
        catalog: {
          currentSkills: vi.fn(() => []),
          currentPrompts: vi.fn(() => []),
          refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
          shutdown: vi.fn(async () => undefined),
        },
      },
    } as unknown as ProviderFactoryInput;

    const provider = registerCodexProvider(
      { registerInstance: (_token, instance) => registered.push(instance) },
      input,
    );

    expect(registered).toEqual([provider]);
    expect(provider.id).toBe("codex");
    expect(provider.sendTurn).toBeTypeOf("function");
    const hostMethods = Object.values(host).flatMap((port) => Object.values(port));
    expect(hostMethods.filter(vi.isMockFunction).every((method) => method.mock.calls.length === 0)).toBe(true);
  });
});
