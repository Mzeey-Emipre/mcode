import { beforeEach, describe, expect, it, vi } from "vitest";

const refs = vi.hoisted(() => {
  const lockPath = "/tmp/mcode/server.lock";
  const replacementBytes = "replacement-lock-bytes";
  const files = new Map<string, string>();
  const renameSync = vi.fn((source: string, destination: string) => {
    const bytes = files.get(source);
    if (bytes === undefined) throw createFileError("ENOENT");
    files.delete(source);
    files.set(destination, bytes);
    if (source === lockPath) files.set(lockPath, replacementBytes);
  });
  const linkSync = vi.fn((source: string, destination: string) => {
    if (files.has(destination)) throw createFileError("EEXIST");
    const bytes = files.get(source);
    if (bytes === undefined) throw createFileError("ENOENT");
    files.set(destination, bytes);
  });
  const unlinkSync = vi.fn((path: string) => {
    if (!files.delete(path)) throw createFileError("ENOENT");
  });
  return { files, linkSync, lockPath, renameSync, replacementBytes, unlinkSync };
});

vi.mock("fs", () => ({
  existsSync: vi.fn((path: string) => refs.files.has(path)),
  linkSync: refs.linkSync,
  readFileSync: vi.fn((path: string) => {
    const bytes = refs.files.get(path);
    if (bytes === undefined) throw createFileError("ENOENT");
    return bytes;
  }),
  renameSync: refs.renameSync,
  unlinkSync: refs.unlinkSync,
}));

vi.mock("fs/promises", () => ({ readFile: vi.fn() }));

import { removeServerLockIfUnchanged, type ServerLock } from "../lock.js";

/** Create an error shaped like a filesystem failure. */
function createFileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

const expectedLock: ServerLock = {
  authToken: "test-auth-token",
  ipcPath: "",
  pid: 12345,
  port: 19600,
  startedAt: "2026-01-01T00:00:00.000Z",
  version: "0.1.0-test",
};

describe("removeServerLockIfUnchanged", () => {
  beforeEach(() => {
    refs.files.clear();
    refs.files.set(
      refs.lockPath,
      JSON.stringify({ ...expectedLock, authToken: "quarantined-token" }),
    );
    refs.linkSync.mockClear();
    refs.renameSync.mockClear();
    refs.unlinkSync.mockClear();
  });

  it("never overwrites a replacement created while a lock is quarantined", () => {
    expect(removeServerLockIfUnchanged(refs.lockPath, expectedLock)).toBe(false);

    expect(refs.files.get(refs.lockPath)).toBe(refs.replacementBytes);
    expect(refs.linkSync).toHaveBeenCalledWith(
      expect.any(String),
      refs.lockPath,
    );
  });
});
