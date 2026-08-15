import { describe, expect, it, vi } from "vitest";

import {
  UPDATE_STATUS_CHANNEL,
  createUpdateStatusState,
} from "../update-status";

function createWindows() {
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
  return {
    window,
    provider: {
      getAllWindows: vi.fn(() => [window]),
      getFocusedWindow: vi.fn(() => null),
    },
  };
}

describe("update status", () => {
  it("publishes the exact status payload to live windows", () => {
    const { provider, window } = createWindows();
    const state = createUpdateStatusState(provider);
    const status = {
      state: "available" as const,
      version: "0.14.0",
      releaseNotes: "Bug fixes",
    };

    state.publish(status);

    expect(state.get()).toEqual(status);
    expect(window.webContents.send).toHaveBeenCalledWith(
      UPDATE_STATUS_CHANNEL,
      status,
    );
  });

  it("does not publish to destroyed windows", () => {
    const { provider, window } = createWindows();
    window.isDestroyed.mockReturnValue(true);
    const state = createUpdateStatusState(provider);

    state.publish({ state: "checking" });

    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("stops publishing after cleanup", () => {
    const { provider, window } = createWindows();
    const state = createUpdateStatusState(provider);
    state.cleanup();

    state.publish({ state: "checking" });

    expect(state.get()).toEqual({ state: "idle" });
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("reactivates with an idle status after reinitialization", () => {
    const { provider, window } = createWindows();
    const state = createUpdateStatusState(provider);
    state.publish({ state: "available", version: "0.14.0" });
    state.cleanup();

    state.initialize();
    expect(state.get()).toEqual({ state: "idle" });
    state.publish({ state: "checking" });

    expect(state.get()).toEqual({ state: "checking" });
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      UPDATE_STATUS_CHANNEL,
      { state: "checking" },
    );
  });
});
