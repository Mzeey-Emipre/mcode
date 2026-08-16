import { describe, expect, it, vi } from "vitest";
import { LegacyTerminalClient } from "../legacy/legacy-terminal-client";

const bundle = {
  contractVersion: 1,
  generatedAt: "2026-08-12T10:00:00.000Z",
  backend: "legacy",
  health: {
    contractVersion: 1,
    state: "healthy",
    hostGeneration: "7",
    activeSessions: 0,
    lastHeartbeatMsAgo: 2,
    queueBytes: 0,
    eventLoopLagMs: 1,
    hostRssBytes: "1234",
  },
  events: [],
  counters: [],
  histograms: [],
};

describe("LegacyTerminalClient", () => {
  it("returns the exact parsed content-free diagnostics bundle", async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === "terminal.diagnostics.getBundle") return bundle;
      throw new Error(`Unexpected RPC: ${method}`);
    });
    const client = new LegacyTerminalClient(rpc as never);

    await expect(client.diagnostics()).resolves.toEqual(bundle);
    expect(rpc).toHaveBeenCalledWith("terminal.diagnostics.getBundle", {});
  });

  it.each([
    ["malformed", { ...bundle, health: { ...bundle.health, state: "unknown" } }],
    [
      "overlarge",
      {
        ...bundle,
        events: Array.from({ length: 2_049 }, () => ({
          eventId: "00000000-0000-4000-8000-000000000001",
          at: bundle.generatedAt,
          metric: "host.rss.bytes",
          unit: "bytes",
          value: 1,
          outcome: "ok",
          correlationId: "test",
        })),
      },
    ],
  ])("rejects %s hostile diagnostics responses", async (_kind, response) => {
    const rpc = vi.fn(async () => response);
    const client = new LegacyTerminalClient(rpc as never);

    await expect(client.diagnostics()).rejects.toThrow();
  });
});
