import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { buildCursorInternalMcpServers } from "../cursor-provider.js";

describe("Cursor internal MCP configuration", () => {
  it("serializes the ACP HTTP server with header entries", () => {
    expect(
      buildCursorInternalMcpServers({
        name: "mcode_internal_thread_control",
        url: "http://127.0.0.1:43123/session",
        headers: { Authorization: "Bearer fixture" },
      }),
    ).toEqual([
      {
        type: "http",
        name: "mcode_internal_thread_control",
        url: "http://127.0.0.1:43123/session",
        headers: [{ name: "Authorization", value: "Bearer fixture" }],
      },
    ]);
  });
});
