import { EventEmitter } from "events";
import { describe, it, expect, vi } from "vitest";
import {
  buildTerminalArgs,
  createTerminalAdapter,
  type TerminalAdapterConfig,
  type TerminalAdapterDeps,
  type TerminalId,
} from "../open-in/terminal-adapter";

const WT_CONFIG: TerminalAdapterConfig = {
  id: "windows-terminal",
  label: "Windows Terminal",
  iconKey: "windows-terminal",
  command: "wt",
  windowsPaths: ["C:\\fallback\\wt.exe"],
};

/** Fake deps: a fake spawn that emits "spawn" so launch resolves, plus probes. */
function fakeDeps(overrides: Partial<TerminalAdapterDeps> = {}): {
  deps: TerminalAdapterDeps;
  spawns: { cmd: string; args: readonly string[] }[];
} {
  const spawns: { cmd: string; args: readonly string[] }[] = [];
  const spawn = vi.fn((cmd: string, args: readonly string[]) => {
    spawns.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  return {
    spawns,
    deps: {
      commandOnPath: () => false,
      fileExists: () => false,
      spawn: spawn as unknown as TerminalAdapterDeps["spawn"],
      platform: "win32",
      ...overrides,
    },
  };
}

describe("buildTerminalArgs", () => {
  it.each<[TerminalId, string[]]>([
    ["windows-terminal", ["-d", "C:\\repo"]],
    ["wsl", ["--cd", "C:\\repo"]],
    ["git-bash", ["--cd=C:\\repo"]],
  ])("shapes %s launch args per ADR-0006", (id, expected) => {
    expect(buildTerminalArgs(id, "C:\\repo")).toEqual(expected);
  });
});

describe("createTerminalAdapter detection", () => {
  it("detects when the command is on PATH", () => {
    const { deps } = fakeDeps({ commandOnPath: (c) => c === "wt" });
    expect(createTerminalAdapter(WT_CONFIG, deps).detect()).toBe(true);
  });

  it("falls back to a Windows install path when not on PATH", () => {
    const { deps } = fakeDeps({
      commandOnPath: () => false,
      fileExists: (p) => p === "C:\\fallback\\wt.exe",
    });
    expect(createTerminalAdapter(WT_CONFIG, deps).detect()).toBe(true);
  });

  it("is not detected when neither PATH nor fallback paths resolve", () => {
    const { deps } = fakeDeps();
    expect(createTerminalAdapter(WT_CONFIG, deps).detect()).toBe(false);
  });

  it("is never detected off Windows, without probing PATH", () => {
    const commandOnPath = vi.fn().mockReturnValue(true);
    const { deps } = fakeDeps({ platform: "darwin", commandOnPath });
    expect(createTerminalAdapter(WT_CONFIG, deps).detect()).toBe(false);
    expect(commandOnPath).not.toHaveBeenCalled();
  });

  it("memoizes resolution so PATH is probed once across detect + launch", async () => {
    const commandOnPath = vi.fn().mockReturnValue(true);
    const { deps } = fakeDeps({ commandOnPath });
    const adapter = createTerminalAdapter(WT_CONFIG, deps);

    adapter.detect();
    adapter.detect();
    await adapter.launch({ path: "C:\\repo" });

    expect(commandOnPath).toHaveBeenCalledTimes(1);
  });
});

describe("createTerminalAdapter launch", () => {
  it("spawns the resolved command with directory args", async () => {
    const { deps, spawns } = fakeDeps({ commandOnPath: (c) => c === "wt" });
    await createTerminalAdapter(WT_CONFIG, deps).launch({ path: "C:\\repo" });

    expect(spawns).toEqual([{ cmd: "wt", args: ["-d", "C:\\repo"] }]);
  });

  it("spawns the fallback executable path when PATH lookup misses", async () => {
    const { deps, spawns } = fakeDeps({
      commandOnPath: () => false,
      fileExists: (p) => p === "C:\\fallback\\wt.exe",
    });
    await createTerminalAdapter(WT_CONFIG, deps).launch({ path: "C:\\repo" });

    expect(spawns[0]?.cmd).toBe("C:\\fallback\\wt.exe");
  });

  it("rejects when the terminal is not detected", async () => {
    const { deps, spawns } = fakeDeps();
    await expect(
      createTerminalAdapter(WT_CONFIG, deps).launch({ path: "C:\\repo" }),
    ).rejects.toThrow(/Terminal not detected: windows-terminal/);
    expect(spawns).toEqual([]);
  });

  it("exposes terminal-kind metadata to the registry", () => {
    const { deps } = fakeDeps();
    const adapter = createTerminalAdapter(WT_CONFIG, deps);
    expect(adapter.kind).toBe("terminal");
    expect(adapter.id).toBe("windows-terminal");
    expect(adapter.iconKey).toBe("windows-terminal");
  });
});
