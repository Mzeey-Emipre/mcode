import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcRenderer = vi.hoisted(() => ({
  on: vi.fn(),
  send: vi.fn(),
  sendToHost: vi.fn(),
}));
const windowMock = vi.hoisted(() => ({ addEventListener: vi.fn() }));

vi.mock("electron", () => ({ ipcRenderer }));

const dispatch = (type: string, isTrusted: boolean): void => {
  const listener = windowMock.addEventListener.mock.calls.find(([eventType]) => eventType === type)?.[1] as
    | ((event: { readonly type: string; readonly isTrusted: boolean }) => void)
    | undefined;
  expect(listener).toBeDefined();
  listener?.({ type, isTrusted });
};

describe("preview guest preload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    ipcRenderer.send.mockClear();
    ipcRenderer.sendToHost.mockClear();
    vi.stubGlobal("window", windowMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("forwards trusted human input and suppresses authorized agent input through the real listeners", async () => {
    await import("../guest-input.js");
    const agentInputHandler = ipcRenderer.on.mock.calls[0]?.[1] as ((event: unknown, input: unknown) => void);
    const now = Date.now();

    agentInputHandler({}, { action: "allow", token: "revoked", generation: 1, kind: "pointer", count: 1, expiresAt: now + 5_000 });
    agentInputHandler({}, { action: "revoke", token: "revoked", generation: 1 });
    dispatch("pointerdown", true);
    expect(ipcRenderer.send).toHaveBeenCalledWith("mcode:browser-clipboard-trust");
    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith("mcode:browser-human-input", { kind: "pointer" });

    ipcRenderer.send.mockClear();
    ipcRenderer.sendToHost.mockClear();
    agentInputHandler({}, { action: "allow", token: "suppressed", generation: 2, kind: "pointer", count: 1, expiresAt: now + 5_000 });
    dispatch("pointerdown", true);
    expect(ipcRenderer.send).not.toHaveBeenCalled();
    expect(ipcRenderer.sendToHost).not.toHaveBeenCalled();

    vi.setSystemTime(now + 6_000);
    ipcRenderer.send.mockClear();
    ipcRenderer.sendToHost.mockClear();
    agentInputHandler({}, { action: "allow", token: "expired", generation: 3, kind: "pointer", count: 1, expiresAt: now + 100 });
    vi.setSystemTime(now + 101);
    dispatch("pointerdown", true);
    expect(ipcRenderer.send).toHaveBeenCalledWith("mcode:browser-clipboard-trust");
    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith("mcode:browser-human-input", { kind: "pointer" });

    dispatch("pointerdown", false);
    expect(ipcRenderer.send).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(1);
  });
});
