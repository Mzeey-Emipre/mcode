import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PtyPidRegistry } from "../pty-pid-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `pty-pid-registry-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function registryFilePath(dir: string): string {
  return join(dir, "pty-pids.json");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PtyPidRegistry", () => {
  let tmpDir: string;
  let registry: PtyPidRegistry;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    registry = new PtyPidRegistry(tmpDir);
  });

  afterEach(() => {
    try {
      unlinkSync(registryFilePath(tmpDir));
    } catch {
      /* ok - file may not exist */
    }
    try {
      unlinkSync(registryFilePath(tmpDir) + ".tmp");
    } catch {
      /* ok */
    }
  });

  it("register persists entry to disk", () => {
    registry.register("pty-1", 1234, "bash");

    const raw = require("node:fs").readFileSync(registryFilePath(tmpDir), "utf-8");
    const entries = JSON.parse(raw) as unknown[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ptyId: "pty-1", pid: 1234, imageName: "bash" });
  });

  it("deregister removes entry from disk", () => {
    registry.register("pty-1", 1234, "bash");
    registry.register("pty-2", 5678, "sh");
    registry.deregister("pty-1");

    const raw = require("node:fs").readFileSync(registryFilePath(tmpDir), "utf-8");
    const entries = JSON.parse(raw) as Array<{ ptyId: string }>;
    const ids = entries.map((e) => e.ptyId);
    expect(ids).not.toContain("pty-1");
    expect(ids).toContain("pty-2");
  });

  it("loadStale returns all entries and clears the file", () => {
    registry.register("pty-1", 1111, "bash");
    registry.register("pty-2", 2222, "sh");

    const stale = registry.loadStale();

    expect(stale).toHaveLength(2);
    const ids = stale.map((e) => e.ptyId).sort();
    expect(ids).toEqual(["pty-1", "pty-2"]);
    expect(existsSync(registryFilePath(tmpDir))).toBe(false);
  });

  it("clear empties all entries and removes file", () => {
    registry.register("pty-1", 1111, "bash");
    registry.clear();

    expect(existsSync(registryFilePath(tmpDir))).toBe(false);
  });

  it("register is idempotent for same ptyId", () => {
    registry.register("pty-1", 1111, "bash");
    registry.register("pty-1", 2222, "bash");

    const raw = require("node:fs").readFileSync(registryFilePath(tmpDir), "utf-8");
    const entries = JSON.parse(raw) as Array<{ ptyId: string; pid: number }>;
    const matching = entries.filter((e) => e.ptyId === "pty-1");
    expect(matching).toHaveLength(1);
    expect(matching[0].pid).toBe(2222);
  });

  it("loadStale on missing file returns empty array", () => {
    // Fresh registry - no file exists
    const result = registry.loadStale();
    expect(result).toEqual([]);
  });

  it("loadStale on corrupted file returns empty array", () => {
    writeFileSync(registryFilePath(tmpDir), "not valid json }{", "utf-8");
    const result = registry.loadStale();
    expect(result).toEqual([]);
  });

  it("multiple register calls produce valid JSON", () => {
    registry.register("pty-1", 1000, "bash");
    registry.register("pty-2", 1001, "sh");
    registry.register("pty-3", 1002, "zsh");

    const raw = require("node:fs").readFileSync(registryFilePath(tmpDir), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const entries = JSON.parse(raw) as unknown[];
    expect(entries).toHaveLength(3);
  });

  it("spawnedAt is an ISO timestamp string", () => {
    const before = Date.now();
    registry.register("pty-1", 9999, "bash");
    const after = Date.now();

    const raw = require("node:fs").readFileSync(registryFilePath(tmpDir), "utf-8");
    const entries = JSON.parse(raw) as Array<{ spawnedAt: string }>;
    const { spawnedAt } = entries[0];

    const parsed = new Date(spawnedAt).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("imageName is stored and returned correctly", () => {
    registry.register("pty-1", 4242, "powershell.exe");

    const stale = registry.loadStale();
    expect(stale).toHaveLength(1);
    expect(stale[0].imageName).toBe("powershell.exe");
  });
});
