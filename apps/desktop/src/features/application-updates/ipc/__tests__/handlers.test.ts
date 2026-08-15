import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerApplicationUpdateHandlers,
  type ApplicationUpdateIpc,
  type ApplicationUpdatesIpcApi,
} from "../handlers";

function createIpc(): {
  ipc: ApplicationUpdateIpc;
  handlers: Map<string, (event: unknown, payload?: unknown) => unknown>;
  removeHandler: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const removeHandler = vi.fn((channel: string) => handlers.delete(channel));
  return {
    handlers,
    removeHandler,
    ipc: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
      removeHandler,
    },
  };
}

function createApi(): ApplicationUpdatesIpcApi {
  return {
    getVersion: vi.fn(() => "0.13.0"),
    getUpdateStatus: vi.fn(() => ({ state: "idle" })),
    checkForUpdatesNow: vi.fn(),
    installUpdate: vi.fn(),
    downloadUpdate: vi.fn(),
    applyReleaseLineSwitch: vi.fn(),
  };
}

describe("application update IPC handlers", () => {
  let api: ApplicationUpdatesIpcApi;

  beforeEach(() => {
    api = createApi();
  });

  it("registers every existing update channel", () => {
    const { ipc, handlers } = createIpc();

    const cleanup = registerApplicationUpdateHandlers(ipc, api);

    expect([...handlers.keys()]).toEqual([
      "app:get-version",
      "app:get-update-status",
      "app:check-for-updates",
      "app:install-update",
      "app:download-update",
      "app:apply-release-line",
    ]);
    cleanup();
    expect(handlers.size).toBe(0);
  });

  it("returns stable version, status, and delegated lifecycle results", async () => {
    const checkResult = { state: "checking" as const };
    const installResult = true;
    vi.mocked(api.checkForUpdatesNow).mockReturnValue(
      Promise.resolve(checkResult),
    );
    vi.mocked(api.downloadUpdate).mockReturnValue(Promise.resolve());
    vi.mocked(api.installUpdate).mockReturnValue(Promise.resolve(installResult));
    const { ipc, handlers } = createIpc();
    registerApplicationUpdateHandlers(ipc, api);

    expect(handlers.get("app:get-version")?.({})).toBe("0.13.0");
    expect(handlers.get("app:get-update-status")?.({})).toEqual({
      state: "idle",
    });
    await expect(handlers.get("app:check-for-updates")?.({})).resolves.toBe(
      checkResult,
    );
    await expect(handlers.get("app:download-update")?.({})).resolves.toBeUndefined();
    await expect(handlers.get("app:install-update")?.({})).resolves.toBe(true);
  });

  it("validates release-line input before policy execution", async () => {
    const result = { state: "checking" as const };
    vi.mocked(api.applyReleaseLineSwitch).mockResolvedValue(result);
    const { ipc, handlers } = createIpc();
    registerApplicationUpdateHandlers(ipc, api);

    await expect(
      handlers.get("app:apply-release-line")?.({}, { releaseLine: "nightly", allowDowngrade: true }),
    ).resolves.toBe(result);
    expect(api.applyReleaseLineSwitch).toHaveBeenCalledWith("nightly", {
      allowDowngrade: true,
    });

    await expect(
      handlers.get("app:apply-release-line")?.({}, { releaseLine: "stable", allowDowngrade: "yes" }),
    ).resolves.toBe(result);
    expect(api.applyReleaseLineSwitch).toHaveBeenLastCalledWith("stable", {
      allowDowngrade: false,
    });

    await expect(
      handlers.get("app:apply-release-line")?.({}, { releaseLine: "preview" }),
    ).rejects.toThrow("Invalid releaseLine: preview");
    await expect(
      handlers.get("app:apply-release-line")?.({}, null),
    ).rejects.toThrow("Invalid releaseLine: undefined");
    expect(api.applyReleaseLineSwitch).toHaveBeenCalledTimes(2);
  });

  it("removes handlers once and permits clean re-registration", () => {
    const first = createIpc();
    const cleanup = registerApplicationUpdateHandlers(first.ipc, api);
    cleanup();
    cleanup();
    const second = createIpc();
    registerApplicationUpdateHandlers(second.ipc, api);

    expect(first.removeHandler).toHaveBeenCalledTimes(6);
    expect(second.handlers.size).toBe(6);
  });
});
