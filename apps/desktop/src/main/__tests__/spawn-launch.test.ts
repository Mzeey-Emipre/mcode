import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { spawnMock, execFileSyncMock, existsSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
}));
vi.mock("fs", () => ({
  existsSync: existsSyncMock,
}));

import { createExecutableResolver, spawnDetached } from "../open-in/spawn-launch";

/** Fake child process that records its event handlers so a test can drive them. */
function fakeChild() {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  return {
    on(event: string, cb: (arg?: unknown) => void) {
      handlers[event] = cb;
      return this;
    },
    unref: vi.fn(),
    emit(event: string, arg?: unknown) {
      handlers[event]?.(arg);
    },
  };
}

const originalPlatform = process.platform;

/** Pin process.platform so the OS-dependent spawn branches are deterministic. */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  spawnMock.mockReset();
  execFileSyncMock.mockReset();
  existsSyncMock.mockReset();
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("createExecutableResolver", () => {
  it("prefers the PATH command and caches the result across calls", () => {
    execFileSyncMock.mockReturnValue("");
    const resolve = createExecutableResolver("code");

    expect(resolve()).toBe("code");
    expect(resolve()).toBe("code");
    // Memoized: the PATH lookup runs once even though resolve() is called twice.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the first existing Windows path when not on PATH", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    existsSyncMock.mockImplementation((p: string) => p === "C:\\second.exe");

    const resolve = createExecutableResolver("vs", ["C:\\first.exe", "C:\\second.exe"]);

    expect(resolve()).toBe("C:\\second.exe");
  });

  it("returns null and caches it when nothing resolves", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    existsSyncMock.mockReturnValue(false);

    const resolve = createExecutableResolver("ghost", ["C:\\missing.exe"]);

    expect(resolve()).toBeNull();
    expect(resolve()).toBeNull();
    // Both the PATH lookup and the fs check run only once for the cached null.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(existsSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe("spawnDetached", () => {
  it("quotes the executable and arguments in the Windows shell branch", async () => {
    setPlatform("win32");
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnDetached("C:\\Program Files\\app\\code.cmd", ["C:\\my repo"]);
    child.emit("spawn");
    await promise;

    expect(spawnMock).toHaveBeenCalledWith(
      '"C:\\Program Files\\app\\code.cmd"',
      ['"C:\\my repo"'],
      expect.objectContaining({ shell: true, detached: true }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("spawns an .exe directly on Windows without a shell", async () => {
    setPlatform("win32");
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnDetached("C:\\Program Files\\vs\\devenv.exe", ["C:\\my repo"]);
    child.emit("spawn");
    await promise;

    const [, , options] = spawnMock.mock.calls[0];
    expect(spawnMock).toHaveBeenCalledWith(
      "C:\\Program Files\\vs\\devenv.exe",
      ["C:\\my repo"],
      expect.objectContaining({ detached: true }),
    );
    expect(options).not.toHaveProperty("shell");
  });

  it("rejects when the child process emits an error", async () => {
    setPlatform("win32");
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnDetached("missing.cmd", []);
    child.emit("error", new Error("spawn ENOENT"));

    await expect(promise).rejects.toThrow(/spawn ENOENT/);
  });
});
