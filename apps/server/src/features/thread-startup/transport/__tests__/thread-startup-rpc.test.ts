import { describe, expect, it, vi } from "vitest";
import type { ThreadStartup } from "@mcode/contracts";
import { routeMessage, type RouterDeps } from "../../../../application/transport/ws-router.js";

const startup: ThreadStartup = {
  startupId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "workspace-1",
  kind: "direct",
  state: "pending",
  phase: "thread",
  steps: [
    { phase: "thread", state: "pending" },
    { phase: "agent", state: "pending" },
  ],
  transcript: [],
  cancellation: "none",
  revision: 1,
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
};

describe("thread startup RPC", () => {
  it("routes get, list, and cancellation intent through the typed WebSocket router", async () => {
    const get = vi.fn(() => startup);
    const list = vi.fn(() => [startup]);
    const cancel = vi.fn(() => ({ ...startup, cancellation: "requested" as const, revision: 2 }));
    const deps = { threadStartupService: { get, list, cancel } } as unknown as RouterDeps;

    const getResponse = await routeMessage(JSON.stringify({
      id: "get",
      method: "thread.startup.get",
      params: { startupId: startup.startupId },
    }), deps);
    const listResponse = await routeMessage(JSON.stringify({
      id: "list",
      method: "thread.startup.list",
      params: { workspaceId: startup.workspaceId },
    }), deps);
    const cancelResponse = await routeMessage(JSON.stringify({
      id: "cancel",
      method: "thread.startup.cancel",
      params: { startupId: startup.startupId },
    }), deps);

    expect(getResponse).toEqual({ id: "get", result: startup });
    expect(listResponse).toEqual({ id: "list", result: { records: [startup] } });
    expect(cancelResponse).toMatchObject({
      id: "cancel",
      result: { cancellation: "requested", revision: 2 },
    });
    expect(get).toHaveBeenCalledWith(startup.startupId);
    expect(list).toHaveBeenCalledWith(startup.workspaceId);
    expect(cancel).toHaveBeenCalledWith(startup.startupId);
  });
});
