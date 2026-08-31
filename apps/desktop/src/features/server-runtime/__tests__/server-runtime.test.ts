import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

import { ServerRuntime } from "../index.js";

function createRuntime(port = 43123): ServerRuntime {
  return new ServerRuntime({
    platform: "linux",
    manager: {
      port,
      authToken: "test-token",
      ipcPath: "",
      onUnexpectedExit: null,
      start: vi.fn(async () => ({ port, authToken: "test-token" })),
      isHealthy: vi.fn(async () => true),
      restart: vi.fn(async () => undefined),
      forceReplace: vi.fn(async () => undefined),
    },
    ipcMain: { handle: vi.fn() },
    getMainWindow: () => null,
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    app: { quit: vi.fn() },
    notification: {
      isSupported: () => false,
      create: vi.fn(),
    },
    powerMonitor: { on: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
    getCookieStore: () => ({ set: vi.fn() }),
  });
}

describe("ServerRuntime Desktop Window seam", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([0, 1, 42])(
    "returns a valid active-agent count of %s from the health endpoint",
    async (activeAgents) => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ activeAgents }), { status: 200 }),
      ) as unknown as typeof fetch;

      await expect(createRuntime().getActiveAgentCount()).resolves.toBe(activeAgents);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:43123/health",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );

  it.each([
    ["fractional", 1.5],
    ["negative", -1],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["oversized", 1e100],
    ["malformed", "two"],
  ] as const)("returns zero for %s active-agent values", async (_label, activeAgents) => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ activeAgents }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(createRuntime().getActiveAgentCount()).resolves.toBe(0);
  });

  it("returns zero when the health endpoint is unavailable", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("server unavailable")) as unknown as typeof fetch;

    await expect(createRuntime().getActiveAgentCount()).resolves.toBe(0);
  });
});
