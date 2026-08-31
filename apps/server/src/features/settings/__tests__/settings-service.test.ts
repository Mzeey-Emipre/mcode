import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs before importing SettingsService so the constructor's existsSync / watch
// calls don't hit the real filesystem.
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn(() => "/fake/mcode"),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../application/transport/push.js", () => ({
  broadcast: vi.fn(),
}));

import { SettingsService } from "../settings-service.js";
import { broadcast } from "../../../application/transport/push.js";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { getDefaultSettings } from "@mcode/contracts";

const legacySettings = (
  engine: unknown,
  preview: Record<string, unknown> = {},
  root: Record<string, unknown> = {},
) =>
  JSON.stringify({
    ...root,
    appearance: { theme: "dark" },
    preview: { ...preview, rendering: { engine } },
  });

describe("SettingsService agent runtime defaults", () => {
  const originalAgentRuntime = process.env.MCODE_AGENT_RUNTIME;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(NodeFS.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
  });

  afterEach(() => {
    if (originalAgentRuntime === undefined) {
      delete process.env.MCODE_AGENT_RUNTIME;
    } else {
      process.env.MCODE_AGENT_RUNTIME = originalAgentRuntime;
    }
  });

  it("uses Codex Luna without a fallback when settings are missing in the agent runtime", () => {
    process.env.MCODE_AGENT_RUNTIME = "1";

    const settings = new SettingsService().get();

    expect(settings.model.defaults.provider).toBe("codex");
    expect(settings.model.defaults.id).toBe("gpt-5.6-luna");
    expect(settings.model.defaults.fallbackId).toBe("");
  });

  it("uses the normal Claude defaults when settings are missing outside the agent runtime", () => {
    delete process.env.MCODE_AGENT_RUNTIME;

    const settings = new SettingsService().get();
    const defaults = getDefaultSettings();

    expect(settings.model.defaults.provider).toBe("claude");
    expect(settings.model.defaults.id).toBe("claude-opus-4-8");
    expect(settings.model.defaults.fallbackId).toBe("claude-sonnet-4-6");
    expect(settings.model.defaults.reasoning).toBe(defaults.model.defaults.reasoning);
  });

  it("preserves an explicit Claude model selection in a valid settings file", () => {
    process.env.MCODE_AGENT_RUNTIME = "1";
    const existingSettings = getDefaultSettings();
    existingSettings.model.defaults.provider = "claude";
    existingSettings.model.defaults.id = "claude-opus-4-8";
    existingSettings.model.defaults.fallbackId = "claude-sonnet-4-6";
    vi.mocked(NodeFS.readFileSync).mockReturnValue(JSON.stringify(existingSettings));

    const settings = new SettingsService().get();

    expect(settings.model.defaults.provider).toBe("claude");
    expect(settings.model.defaults.id).toBe("claude-opus-4-8");
    expect(settings.model.defaults.fallbackId).toBe("claude-sonnet-4-6");
  });
});

describe("SettingsService in-process change listener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(NodeFS.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
  });

  it("on('change', cb) fires cb with the validated settings when update() is called", () => {
    const svc = new SettingsService();
    const listener = vi.fn();
    svc.on("change", listener);

    svc.update({});

    expect(listener).toHaveBeenCalledOnce();
    // The argument should be a Settings object — it will have the provider key.
    const received = listener.mock.calls[0]![0];
    expect(received).toHaveProperty("provider");
    // broadcast must also have been called (existing behaviour is intact)
    expect(broadcast).toHaveBeenCalled();
  });

  it("on('change', cb) returns an unsubscribe function that removes the listener", () => {
    const svc = new SettingsService();
    const listener = vi.fn();
    const unsub = svc.on("change", listener);

    unsub();
    svc.update({});

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("SettingsService rendering-engine migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(NodeFS.renameSync).mockImplementation(() => undefined);
    vi.mocked(NodeFS.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
  });

  it.each(["webContentsView", "webview", "unknown-host"])(
    "removes legacy engine %s, validates the remainder, and persists it atomically",
    (engine) => {
      vi.mocked(NodeFS.readFileSync).mockReturnValue(legacySettings(
        engine,
        { memorySaver: { maxWarm: 5 }, unknownPreviewSetting: true },
        { unknownTopLevelSetting: true },
      ));

      const settings = new SettingsService().get();

      expect(settings.appearance.theme).toBe("dark");
      expect(settings.preview.memorySaver.maxWarm).toBe(5);
      expect(settings.preview).not.toHaveProperty("rendering");
      expect(NodeFS.writeFileSync).toHaveBeenCalledOnce();
      expect(NodeFS.renameSync).toHaveBeenCalledWith(
        NodePath.join("/fake/mcode", "settings.json.tmp"),
        NodePath.join("/fake/mcode", "settings.json"),
      );
      expect(NodeFS.writeFileSync).toHaveBeenCalledWith(
        NodePath.join("/fake/mcode", "settings.json.tmp"),
        expect.not.stringContaining("rendering"),
        "utf-8",
      );
      const persisted = JSON.parse(
        vi.mocked(NodeFS.writeFileSync).mock.calls[0]![1] as string,
      ) as Record<string, unknown>;
      expect(persisted).not.toHaveProperty("unknownTopLevelSetting");
      expect(persisted).not.toHaveProperty("preview.unknownPreviewSetting");
    },
  );

  it("removes an empty preview parent from the migrated document", () => {
    vi.mocked(NodeFS.readFileSync).mockReturnValue(legacySettings("webContentsView"));

    new SettingsService().get();

    const persisted = JSON.parse(
      vi.mocked(NodeFS.writeFileSync).mock.calls[0]![1] as string,
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("preview.rendering");
  });

  it("does not persist a migration when the remaining settings fail validation", () => {
    vi.mocked(NodeFS.readFileSync).mockReturnValue(legacySettings("webview", {
      memorySaver: { maxWarm: 0 },
    }));

    const settings = new SettingsService().get();

    expect(settings.preview.memorySaver.maxWarm).toBe(3);
    expect(NodeFS.writeFileSync).not.toHaveBeenCalled();
    expect(NodeFS.renameSync).not.toHaveBeenCalled();
  });

  it("retains validated settings when atomic migration persistence fails", () => {
    vi.mocked(NodeFS.readFileSync).mockReturnValue(legacySettings("webview", {
      memorySaver: { maxWarm: 5 },
    }));
    vi.mocked(NodeFS.renameSync).mockImplementation(() => { throw new Error("EACCES"); });
    const service = new SettingsService();

    const settings = service.get();

    expect(settings.appearance.theme).toBe("dark");
    expect(settings.preview.memorySaver.maxWarm).toBe(5);
    expect(settings.preview).not.toHaveProperty("rendering");
    expect(NodeFS.unlinkSync).toHaveBeenCalledWith(NodePath.join("/fake/mcode", "settings.json.tmp"));
    expect(service.get()).toBe(settings);
    expect(NodeFS.readFileSync).toHaveBeenCalledOnce();
    expect(service.getTerminalMigrationStatus()).toEqual({
      status: "blocked",
      reason: "migration-write-failed",
    });
    expect(() => service.update({ appearance: { theme: "light" } })).toThrow(/blocked/i);
  });

  it("does not rewrite current settings or repeat a completed migration", () => {
    vi.mocked(NodeFS.readFileSync).mockReturnValueOnce(legacySettings("webview"));
    const service = new SettingsService();

    service.get();
    service.get();

    expect(NodeFS.readFileSync).toHaveBeenCalledOnce();
    expect(NodeFS.writeFileSync).toHaveBeenCalledOnce();
    expect(NodeFS.renameSync).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    vi.mocked(NodeFS.readFileSync).mockReturnValue(JSON.stringify({
      ...getDefaultSettings(),
      appearance: { theme: "dark" },
    }));
    new SettingsService().get();

    expect(NodeFS.writeFileSync).not.toHaveBeenCalled();
    expect(NodeFS.renameSync).not.toHaveBeenCalled();
    expect(NodeFS.unlinkSync).not.toHaveBeenCalled();
  });
});

describe("SettingsService Terminal settings persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(NodeFS.renameSync).mockImplementation(() => undefined);
    vi.mocked(NodeFS.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
  });

  it("backs up and atomically persists the exact Terminal 0.0.1 migration once", () => {
    vi.mocked(NodeFS.readFileSync).mockReturnValue(JSON.stringify({
      appearance: { theme: "dark" },
      terminal: { scrollback: 0, confirmOnKill: "panel" },
    }));
    const service = new SettingsService();

    const settings = service.get();
    service.get();

    expect(settings.meta.schemaVersion).toBe("0.0.1");
    expect(settings.terminal.behavior).toMatchObject({
      scrollback: 5_000,
      confirmOnKill: "withChildProcesses",
    });
    expect(NodeFS.copyFileSync).toHaveBeenCalledOnce();
    expect(NodeFS.copyFileSync).toHaveBeenCalledWith(
      NodePath.join("/fake/mcode", "settings.json"),
      NodePath.join("/fake/mcode", "settings.json.pre-terminal-0.0.1.bak"),
    );
    expect(NodeFS.writeFileSync).toHaveBeenCalledOnce();
  });

  it("blocks writes for a future document until explicit reset repairs it", () => {
    vi.mocked(NodeFS.readFileSync).mockReturnValue(JSON.stringify({
      meta: { schemaVersion: "0.1.0" },
      terminal: {},
    }));
    const service = new SettingsService();

    expect(service.getTerminalMigrationStatus()).toEqual({
      status: "blocked",
      reason: "future-version",
    });
    expect(() => service.update({ appearance: { theme: "dark" } })).toThrow(/blocked/i);
    expect(NodeFS.writeFileSync).not.toHaveBeenCalled();

    service.resetTerminalPreferences();

    expect(service.getTerminalMigrationStatus()).toEqual({ status: "current" });
    expect(service.get().terminal.profiles).toEqual([]);
    expect(NodeFS.writeFileSync).toHaveBeenCalledOnce();
  });

  it("preserves valid custom profiles when reset repairs a missing default reference", () => {
    const defaults = getDefaultSettings();
    const preservedProfile = {
      id: "custom:22222222-2222-4222-8222-222222222222" as const,
      name: "Tool",
      executable: "tool",
      arguments: ["--login"],
    };
    vi.mocked(NodeFS.readFileSync).mockReturnValue(JSON.stringify({
      ...defaults,
      terminal: {
        ...defaults.terminal,
        defaultProfileId: "custom:11111111-1111-4111-8111-111111111111",
        profiles: [preservedProfile],
      },
    }));
    const service = new SettingsService();

    const reset = service.resetTerminalPreferences();

    expect(reset.defaultProfileId).toBe("automatic");
    expect(reset.profiles).toEqual([preservedProfile]);
    expect(service.getTerminalMigrationStatus()).toEqual({ status: "current" });
  });

  it("resets preferences while preserving custom profiles", () => {
    const service = new SettingsService();
    service.replaceTerminalSettings({
      ...service.get().terminal,
      defaultProfileId: "custom:11111111-1111-4111-8111-111111111111",
      profiles: [{
        id: "custom:11111111-1111-4111-8111-111111111111",
        name: "Tool",
        executable: "tool",
        arguments: [],
      }],
      presentation: { ...service.get().terminal.presentation, fontSize: "xl" },
    });

    const reset = service.resetTerminalPreferences();

    expect(reset.defaultProfileId).toBe("automatic");
    expect(reset.presentation.fontSize).toBe("sm");
    expect(reset.profiles).toHaveLength(1);
  });
});
