import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { LaunchTarget, OpenInAdapter } from "../../contracts/types";
import { registerOpenInHandlers as registerConfiguredOpenInHandlers } from "../../index";
import { OpenInRegistry } from "../../registry/registry";
import {
  registerOpenInHandlers as registerHandlers,
  type OpenInIpc,
} from "../handlers";

const { shellOpenPath } = vi.hoisted(() => ({
  shellOpenPath: vi.fn().mockResolvedValue(""),
}));

vi.mock("electron", () => ({ shell: { openPath: shellOpenPath } }));

type Handler = Parameters<OpenInIpc["handle"]>[1];

function createIpc(): {
  ipcMain: OpenInIpc;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: {
      handle(channel, listener): void {
        handlers.set(channel, listener);
      },
    },
    handlers,
  };
}

function createRegistry(): {
  registry: OpenInRegistry;
  launches: LaunchTarget[];
} {
  const launches: LaunchTarget[] = [];
  const editor: OpenInAdapter = {
    id: "code",
    label: "VS Code",
    kind: "editor",
    iconKey: "vscode",
    detect: () => true,
    launch: async (target) => {
      launches.push(target);
    },
  };
  return { registry: new OpenInRegistry([editor]), launches };
}

function absoluteExistingTarget(): string {
  return NodePath.resolve("src/features/open-in/ipc/handlers.ts");
}

describe("registerOpenInHandlers", () => {
  it("registers handlers through the configured feature entry point", () => {
    const { ipcMain, handlers } = createIpc();

    registerConfiguredOpenInHandlers(ipcMain, "linux");

    expect([...handlers.keys()]).toEqual(["list-open-in-apps", "open-in"]);
  });

  it("lists every configured app with exact metadata and boolean detection", () => {
    const { ipcMain, handlers } = createIpc();
    registerConfiguredOpenInHandlers(ipcMain, "linux");

    expect(handlers.get("list-open-in-apps")?.({})).toEqual([
      {
        id: "code",
        label: "VS Code",
        kind: "editor",
        iconKey: "vscode",
        detected: expect.any(Boolean),
      },
      {
        id: "vs",
        label: "Visual Studio",
        kind: "editor",
        iconKey: "visualstudio",
        detected: expect.any(Boolean),
      },
      {
        id: "cursor",
        label: "Cursor",
        kind: "editor",
        iconKey: "cursor",
        detected: expect.any(Boolean),
      },
      {
        id: "zed",
        label: "Zed",
        kind: "editor",
        iconKey: "zed",
        detected: expect.any(Boolean),
      },
      {
        id: "github-desktop",
        label: "GitHub Desktop",
        kind: "gitGui",
        iconKey: "githubDesktop",
        detected: expect.any(Boolean),
      },
      {
        id: "windows-terminal",
        label: "Windows Terminal",
        kind: "terminal",
        iconKey: "windows-terminal",
        detected: expect.any(Boolean),
      },
      {
        id: "git-bash",
        label: "Git Bash",
        kind: "terminal",
        iconKey: "git-bash",
        detected: expect.any(Boolean),
      },
      {
        id: "wsl",
        label: "WSL",
        kind: "terminal",
        iconKey: "wsl",
        detected: expect.any(Boolean),
      },
      {
        id: "explorer",
        label: "File Explorer",
        kind: "fileManager",
        iconKey: "explorer",
        detected: expect.any(Boolean),
      },
    ]);
  });

  it("dispatches a configured Explorer request to shell.openPath", async () => {
    const { ipcMain, handlers } = createIpc();
    registerConfiguredOpenInHandlers(ipcMain);
    const target = absoluteExistingTarget();
    shellOpenPath.mockClear();

    await expect(
      handlers.get("open-in")?.({}, "explorer", target),
    ).resolves.toBeUndefined();

    expect(shellOpenPath).toHaveBeenCalledWith(target);
  });

  it("registers the existing listing and launch channels", () => {
    const { ipcMain, handlers } = createIpc();
    const { registry } = createRegistry();

    registerHandlers({ ipcMain, registry });

    expect([...handlers.keys()]).toEqual(["list-open-in-apps", "open-in"]);
  });

  it("returns registry metadata through the listing handler", () => {
    const { ipcMain, handlers } = createIpc();
    const { registry } = createRegistry();
    registerHandlers({ ipcMain, registry });

    expect(handlers.get("list-open-in-apps")?.({})).toEqual([
      {
        id: "code",
        label: "VS Code",
        kind: "editor",
        iconKey: "vscode",
        detected: true,
      },
    ]);
  });

  it("rejects relative targets before registry dispatch", async () => {
    const { ipcMain, handlers } = createIpc();
    const { registry, launches } = createRegistry();
    registerHandlers({ ipcMain, registry });

    await expect(
      handlers.get("open-in")?.({}, "code", "relative/file.ts", 42),
    ).rejects.toThrow("Open-in path must be absolute");
    expect(launches).toEqual([]);
  });

  it("rejects missing absolute targets before registry dispatch", async () => {
    const { ipcMain, handlers } = createIpc();
    const { registry, launches } = createRegistry();
    registerHandlers({ ipcMain, registry });
    const missing = NodePath.resolve("src/features/open-in/ipc/missing-target.ts");

    await expect(
      handlers.get("open-in")?.({}, "code", missing),
    ).rejects.toThrow(`Path does not exist: ${missing}`);
    expect(launches).toEqual([]);
  });

  it("forwards valid targets and optional lines through the registry", async () => {
    const { ipcMain, handlers } = createIpc();
    const { registry, launches } = createRegistry();
    registerHandlers({ ipcMain, registry });
    const target = absoluteExistingTarget();

    await expect(
      handlers.get("open-in")?.({}, "code", target, 42),
    ).resolves.toBeUndefined();
    expect(launches).toEqual([{ path: target, line: 42 }]);
  });

  it("leaves unknown application failures to the registry", async () => {
    const { ipcMain, handlers } = createIpc();
    const { registry } = createRegistry();
    registerHandlers({ ipcMain, registry });

    await expect(
      handlers.get("open-in")?.({}, "ghost", absoluteExistingTarget()),
    ).rejects.toThrow("Unknown open-in app: ghost");
  });
});
