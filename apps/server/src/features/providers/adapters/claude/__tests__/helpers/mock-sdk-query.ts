/**
 * Shared helpers for stubbing the Claude Agent SDK's `Query` object in
 * tests. The SDK's Query surface is a large interface; most tests only
 * exercise the async iterator side, but still need the non-iterator
 * methods present for type-compat with the real runtime.
 */

import { vi } from "vitest";
import type { ProviderRuntimeEvent } from "@mcode/contracts";
import type {
  ProviderEventSubmissionReceipt,
  ProviderHostPorts,
} from "@mcode/providers";

/** Deterministic host facts for provider tests that exercise successful results. */
export const mockProviderHostRuntime = {
  platform: "linux",
  architecture: "x64",
  nodeAbi: "127",
} as const;

const acceptedProviderEventReceipt = {
  commit: {
    outcome: "committed",
    conversationRevision: 0,
    rosterRevision: 0,
    acceptedThrough: 0,
    durableThrough: 0,
    eventCount: 1,
  },
  delivery: { ingress: "queued" },
} as const satisfies ProviderEventSubmissionReceipt;

/** Creates the provider's canonical host boundary and captures its published runtime events. */
export function mockProviderHost(
  onEvent: (event: ProviderRuntimeEvent) => void = () => undefined,
): Pick<ProviderHostPorts, "runtime" | "events"> {
  return {
    runtime: mockProviderHostRuntime,
    events: {
      submit: async (batch) => {
        for (const draft of batch.events) {
          if (draft.payload.type !== "item.recorded") continue;
          const payload = draft.payload.item.payload;
          if (payload.projection !== "providerRuntimeEvent") continue;
          onEvent(payload.runtimeEvent);
        }
        return acceptedProviderEventReceipt;
      },
    },
  };
}

/**
 * Returns a fresh map of `vi.fn()` stubs for every non-iterator method on
 * the SDK Query object. Call sites spread this onto their async generator
 * via `Object.assign(gen, { ...queryMethodStubs(), close: vi.fn(...) })`
 * and can override specific methods (typically `close`) with per-test
 * behavior.
 */
export function queryMethodStubs() {
  return {
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    setMaxThinkingTokens: vi.fn(),
    applyFlagSettings: vi.fn(),
    initializationResult: vi.fn(),
    supportedCommands: vi.fn(),
    supportedModels: vi.fn(),
    supportedAgents: vi.fn(),
    mcpServerStatus: vi.fn(),
    accountInfo: vi.fn(),
    rewindFiles: vi.fn(),
    reconnectMcpServer: vi.fn(),
    toggleMcpServer: vi.fn(),
    setMcpServers: vi.fn(),
    streamInput: vi.fn(),
    stopTask: vi.fn(),
  };
}
