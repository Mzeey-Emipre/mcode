import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  buildCursorBrowserMcpServers,
  cursorSupportsHttpMcp,
} from "../cursor-provider.js";

describe("Cursor browser MCP configuration", () => {
  it("uses ACP HTTP headers for a normal main-session grant", () => {
    expect(buildCursorBrowserMcpServers({
      mcpUrl: "http://127.0.0.1:19400/mcp",
      token: "opaque-token",
      credentialId: "credential-a",
      expiresAt: 10,
      allowedOperations: ["status"],
    })).toEqual([{
      type: "http",
      name: "mcode-browser",
      url: "http://127.0.0.1:19400/mcp",
      headers: [{ name: "Authorization", value: "Bearer opaque-token" }],
    }]);
  });

  it("omits MCP when HTTP capability or server configuration is unavailable", () => {
    expect(buildCursorBrowserMcpServers(null)).toEqual([]);
    expect(cursorSupportsHttpMcp({})).toBe(false);
    expect(cursorSupportsHttpMcp({ agentCapabilities: { mcpCapabilities: { http: false } } })).toBe(false);
    expect(cursorSupportsHttpMcp({ agentCapabilities: { mcpCapabilities: { http: true } } })).toBe(true);
  });
});
