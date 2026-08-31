import * as NodeEvents from "node:events";
import { describe, it, expect, vi } from "vitest";
import {
  buildTerminalArgs,
  createTerminalAdapter,
  type TerminalAdapterConfig,
  type TerminalAdapterDeps,
  type TerminalId,
} from "../terminal";

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
  spawnOptions: Record<string, unknown>[];
} {
  const spawns: { cmd: string; args: readonly string[] }[] = [];
  const spawnOptions: Record<string, unknown>[] = [];
  const spawn = vi.fn(
    (cmd: string, args: readonly string[], options: Record<string, unknown>) => {
      spawns.push({ cmd, args });
      spawnOptions.push(options);
      const child = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & { unref(): void };
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  );
  return {
    spawns,
    spawnOptions,
    deps: {
      commandOnPath: () => false,
      fileExists: () => false,
      spawn: spawn as unknown as TerminalAdapterDeps["spawn"],
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
    expect(createTerminalAdapter(WT_CONFIG, "win32", deps).detect()).toBe(true);
  });

  it("falls back to a Windows install path when not on PATH", () => {
    const { deps } = fakeDeps({
      commandOnPath: () => false,
      fileExists: (p) => p === "C:\\fallback\\wt.exe",
    });
    expect(createTerminalAdapter(WT_CONFIG, "win32", deps).detect()).toBe(true);
  });

  it("is not detected when neither PATH nor fallback paths resolve", () => {
    const { deps } = fakeDeps();
    expect(createTerminalAdapter(WT_CONFIG, "win32", deps).detect()).toBe(false);
  });

  it("is never detected off Windows, without probing PATH", () => {
    const commandOnPath = vi.fn().mockReturnValue(true);
    const { deps } = fakeDeps({ commandOnPath });
    expect(createTerminalAdapter(WT_CONFIG, "darwin", deps).detect()).toBe(false);
    expect(commandOnPath).not.toHaveBeenCalled();
  });

  it("memoizes resolution so PATH is probed once across detect + launch", async () => {
    const commandOnPath = vi.fn().mockReturnValue(true);
    const { deps } = fakeDeps({ commandOnPath });
    const adapter = createTerminalAdapter(WT_CONFIG, "win32", deps);

    adapter.detect();
    adapter.detect();
    await adapter.launch({ path: "C:\\repo" });

    expect(commandOnPath).toHaveBeenCalledTimes(1);
  });
});

describe("createTerminalAdapter launch", () => {
  it("spawns the resolved command with directory args", async () => {
    const { deps, spawns, spawnOptions } = fakeDeps({ commandOnPath: (c) => c === "wt" });
    await createTerminalAdapter(WT_CONFIG, "win32", deps).launch({ path: "C:\\repo" });

    expect(spawns).toEqual([
      {
        cmd: "cmd.exe",
        args: [
          "/d",
          "/v:on",
          "/s",
          "/c",
          "!MCODE_OPEN_IN_COMMAND! !MCODE_OPEN_IN_ARG_0! !MCODE_OPEN_IN_ARG_1!",
        ],
      },
    ]);
    expect(spawnOptions[0]).toEqual(
      expect.objectContaining({
        shell: false,
        windowsVerbatimArguments: true,
        env: expect.objectContaining({
          MCODE_OPEN_IN_COMMAND: '"wt"',
          MCODE_OPEN_IN_ARG_0: '"-d"',
          MCODE_OPEN_IN_ARG_1: '"C:\\repo"',
        }),
      }),
    );
  });

  it("spawns the fallback executable path when PATH lookup misses", async () => {
    const { deps, spawns } = fakeDeps({
      commandOnPath: () => false,
      fileExists: (p) => p === "C:\\fallback\\wt.exe",
    });
    await createTerminalAdapter(WT_CONFIG, "win32", deps).launch({ path: "C:\\repo" });

    expect(spawns[0]?.cmd).toBe("C:\\fallback\\wt.exe");
  });

  it("launches a safe executable fallback directly (Git Bash)", async () => {
    const gitBashPath = "C:\\Program Files\\Git\\git-bash.exe";
    const { deps, spawns } = fakeDeps({
      commandOnPath: () => false,
      fileExists: (p) => p === gitBashPath,
    });
    await createTerminalAdapter(
      {
        id: "git-bash",
        label: "Git Bash",
        iconKey: "git-bash",
        command: "git-bash",
        windowsPaths: [gitBashPath],
      },
      "win32",
      deps,
    ).launch({ path: "C:\\repo" });

    expect(spawns[0]).toEqual({
      cmd: gitBashPath,
      args: ["--cd=C:\\repo"],
    });
  });

  it("keeps hostile terminal targets literal in the shared Windows launch slots", async () => {
    const { deps, spawns, spawnOptions } = fakeDeps({ commandOnPath: (c) => c === "wt" });
    const target = "C:\\Open In Probe\\%NAME%\\!NAME!\\target folder&calc^";
    await createTerminalAdapter(WT_CONFIG, "win32", deps).launch({ path: target });

    expect(spawns[0]).toEqual({
      cmd: "cmd.exe",
      args: [
        "/d",
        "/v:on",
        "/s",
        "/c",
        "!MCODE_OPEN_IN_COMMAND! !MCODE_OPEN_IN_ARG_0! !MCODE_OPEN_IN_ARG_1!",
      ],
    });
    expect(spawnOptions[0]).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          MCODE_OPEN_IN_COMMAND: '"wt"',
          MCODE_OPEN_IN_ARG_0: '"-d"',
          MCODE_OPEN_IN_ARG_1: `"${target}"`,
        }),
      }),
    );
  });

  it("preserves the terminal argument shape for a spaced target", async () => {
    const { deps, spawns } = fakeDeps({ commandOnPath: (c) => c === "wt" });
    await createTerminalAdapter(WT_CONFIG, "win32", deps).launch({
      path: "C:\\Users\\John Doe\\repo",
    });

    expect(spawns[0]?.args).toEqual([
      "/d",
      "/v:on",
      "/s",
      "/c",
      "!MCODE_OPEN_IN_COMMAND! !MCODE_OPEN_IN_ARG_0! !MCODE_OPEN_IN_ARG_1!",
    ]);
  });

  it("rejects when the terminal is not detected", async () => {
    const { deps, spawns } = fakeDeps();
    await expect(
      createTerminalAdapter(WT_CONFIG, "win32", deps).launch({ path: "C:\\repo" }),
    ).rejects.toThrow(/Terminal not detected: windows-terminal/);
    expect(spawns).toEqual([]);
  });

  it("exposes terminal-kind metadata to the registry", () => {
    const { deps } = fakeDeps();
    const adapter = createTerminalAdapter(WT_CONFIG, "win32", deps);
    expect(adapter.kind).toBe("terminal");
    expect(adapter.id).toBe("windows-terminal");
    expect(adapter.iconKey).toBe("windows-terminal");
  });
});
