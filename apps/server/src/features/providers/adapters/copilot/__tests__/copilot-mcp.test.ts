import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { buildCopilotInternalMcpServers } from "../copilot-provider.js";

describe("Copilot internal MCP configuration", () => {
  it("serializes the remote HTTP server with all tools enabled", () => {
    expect(
      buildCopilotInternalMcpServers({
        name: "mcode_internal_thread_control",
        url: "http://127.0.0.1:43123/session",
        headers: { Authorization: "Bearer fixture" },
      }),
    ).toEqual({
      mcode_internal_thread_control: {
        type: "http",
        url: "http://127.0.0.1:43123/session",
        headers: { Authorization: "Bearer fixture" },
        tools: ["*"],
      },
    });
  });
});
