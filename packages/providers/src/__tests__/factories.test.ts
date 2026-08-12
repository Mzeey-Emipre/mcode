import { describe, expect, it, vi } from "vitest";
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
    environment: { snapshot: vi.fn(() => ({})) },
    processes: {
      attach: vi.fn(),
      terminateTree: vi.fn(async () => undefined),
    },
    browser: {
      stage: vi.fn(() => ({ leaseId: "lease-1" })),
      releaseSession: vi.fn(() => 0),
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
});
