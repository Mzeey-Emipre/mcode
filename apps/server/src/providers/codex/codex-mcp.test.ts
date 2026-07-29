import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { hasCodexInternalThreadControlMcp } from "./codex-provider.js";

describe("Codex internal MCP configuration validation", () => {
  it("accepts effective config containing the internal server", () => {
    expect(
      hasCodexInternalThreadControlMcp({
        config: { mcp_servers: { mcode_internal_thread_control: { url: "http://fixture" } } },
      }),
    ).toBe(true);
  });

  it("rejects effective config without the internal server", () => {
    expect(hasCodexInternalThreadControlMcp({ config: { mcp_servers: {} } })).toBe(false);
    expect(hasCodexInternalThreadControlMcp({ config: { mcp_servers: null } })).toBe(false);
  });
});
