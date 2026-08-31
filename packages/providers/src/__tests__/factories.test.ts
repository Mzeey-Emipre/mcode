import { describe, expect, it, vi } from "vitest";
import type { Settings } from "@mcode/contracts";
import {
  createClaudeProvider,
  createCodexProvider,
  createCopilotProvider,
  createCursorProvider,
  type ProviderFactoryInput,
  type ProviderHostPorts,
} from "../index.js";
import { providerProtocolBinding } from "../private/factory.js";

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
      refresh: vi.fn((leaseId: string) => ({ ok: false as const, leaseId, reason: "not-found" as const })),
      release: vi.fn((leaseId: string) => ({ leaseId, released: false })),
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

function createInput(): ProviderFactoryInput {
  return {
    configuration: {
      cliPath: "provider-cli",
      idleSessionTtlMs: 600_000,
    },
    host: createHostPorts(),
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
    cursor: {
      settings: { get: vi.fn(() => ({} as Settings)) },
      skills: { list: vi.fn(() => []) },
    },
  };
}

describe("Provider factories", () => {
  it.each([
    ["claude", createClaudeProvider],
    ["codex", createCodexProvider],
    ["copilot", createCopilotProvider],
    ["cursor", createCursorProvider],
  ] as const)("creates an inert %s Provider boundary", (id, createProvider) => {
    const input = createInput();

    const provider = createProvider(input);

    expect(provider.id).toBe(id);
    expect(provider.descriptor.id).toBe(id);
    if (id === "codex") {
      expect(provider.sendTurn).toBeTypeOf("function");
      expect(provider.descriptor.capabilities).toEqual([
        { name: "build", support: "supported" },
        { name: "plan", support: "supported" },
        { name: "goals", support: "supported" },
        { name: "permissions", support: "supported" },
        { name: "usage", support: "supported" },
        { name: "session-eviction", support: "supported" },
        { name: "clean-fork", support: "supported" },
        { name: "orchestration", support: "supported" },
        { name: "browser-access", support: "supported" },
        { name: "thread-control", support: "supported" },
        { name: "child-cancellation", support: "supported" },
      ]);
      expect(provider.descriptor.capabilities).not.toContainEqual(
        { name: "provider-continuation", support: "supported" },
      );
    }
    if (id === "cursor") {
      expect(provider.sendTurn).toBeTypeOf("function");
      expect(provider.descriptor.capabilities).toContainEqual(
        { name: "provider-continuation", support: "unsupported" },
      );
      expect(provider.descriptor.capabilities).toContainEqual(
        { name: "child-cancellation", support: "unsupported" },
      );
    }
    expect(Object.values(input.host).flatMap((port) => Object.values(port))).toSatisfy(
      (methods: unknown[]) => methods.every((method) => !vi.mocked(method as never).mock.calls.length),
    );
  });

  it("rejects invalid configuration before it creates a Provider", () => {
    const input = createInput();
    input.configuration.idleSessionTtlMs = 0;

    expect(() => createCodexProvider(input)).toThrow("idleSessionTtlMs");
  });

  it("rejects an incomplete host-port bundle", () => {
    const input = createInput();
    const incompleteHost = { ...input.host, events: undefined };

    expect(() => createCodexProvider({ ...input, host: incompleteHost as never })).toThrow(
      "events.submit",
    );
  });

  it("does not expose private runtime or protocol machinery", async () => {
    const publicApi = await import("../index.js");

    expect(publicApi).not.toHaveProperty("SessionRuntime");
    expect(publicApi).not.toHaveProperty("ProtocolAdapter");
    expect(publicApi).not.toHaveProperty("AcpSessionRuntime");
  });

  it("composes Cursor with bounded private ACP protocol machinery", () => {
    const cursor = createCursorProvider(createInput());
    const protocol = providerProtocolBinding(cursor);

    expect(protocol?.kind).toBe("acp");
    expect(protocol?.encodeRequest("session/new", { cwd: "/repo" })).toBe(
      '{"jsonrpc":"2.0","method":"session/new","params":{"cwd":"/repo"}}',
    );
    expect(() => protocol?.encodeRequest("session/prompt", "x".repeat(1_048_576))).toThrow(
      "maximum encoded size",
    );
  });

  it("rejects incomplete Cursor-specific ports", () => {
    const input = createInput();
    input.cursor = { settings: { get: vi.fn(() => ({} as Settings)) } } as never;

    expect(() => createCursorProvider(input)).toThrow("skills.list");
  });
});
