/**
 * Shared helpers for stubbing the Claude Agent SDK's `Query` object in
 * tests. The SDK's Query surface is a large interface; most tests only
 * exercise the async iterator side, but still need the non-iterator
 * methods present for type-compat with the real runtime.
 */

import { vi } from "vitest";

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
