import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs before importing SettingsService so the constructor's existsSync / watch
// calls don't hit the real filesystem.
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn(() => "/fake/mcode"),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../transport/push.js", () => ({
  broadcast: vi.fn(),
}));

import { SettingsService } from "../settings-service.js";
import { broadcast } from "../../transport/push.js";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

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

describe("SettingsService in-process change listener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
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
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
  });

  it.each(["webContentsView", "webview", "unknown-host"])(
    "removes legacy engine %s, validates the remainder, and persists it atomically",
    (engine) => {
      vi.mocked(readFileSync).mockReturnValue(legacySettings(
        engine,
        { memorySaver: { maxWarm: 5 }, unknownPreviewSetting: true },
        { unknownTopLevelSetting: true },
      ));

      const settings = new SettingsService().get();

      expect(settings.appearance.theme).toBe("dark");
      expect(settings.preview.memorySaver.maxWarm).toBe(5);
      expect(settings.preview).not.toHaveProperty("rendering");
      expect(writeFileSync).toHaveBeenCalledOnce();
      expect(renameSync).toHaveBeenCalledWith(
        join("/fake/mcode", "settings.json.tmp"),
        join("/fake/mcode", "settings.json"),
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        join("/fake/mcode", "settings.json.tmp"),
        expect.not.stringContaining("rendering"),
        "utf-8",
      );
      const persisted = JSON.parse(
        vi.mocked(writeFileSync).mock.calls[0]![1] as string,
      ) as Record<string, unknown>;
      expect(persisted).not.toHaveProperty("unknownTopLevelSetting");
      expect(persisted).not.toHaveProperty("preview.unknownPreviewSetting");
    },
  );

  it("removes an empty preview parent from the migrated document", () => {
    vi.mocked(readFileSync).mockReturnValue(legacySettings("webContentsView"));

    new SettingsService().get();

    const persisted = JSON.parse(
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("preview");
  });

  it("does not persist a migration when the remaining settings fail validation", () => {
    vi.mocked(readFileSync).mockReturnValue(legacySettings("webview", {
      memorySaver: { maxWarm: 0 },
    }));

    const settings = new SettingsService().get();

    expect(settings.preview.memorySaver.maxWarm).toBe(3);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
  });

  it("retains validated settings when atomic migration persistence fails", () => {
    vi.mocked(readFileSync).mockReturnValue(legacySettings("webview", {
      memorySaver: { maxWarm: 5 },
    }));
    vi.mocked(renameSync).mockImplementation(() => { throw new Error("EACCES"); });
    const service = new SettingsService();

    const settings = service.get();

    expect(settings.appearance.theme).toBe("dark");
    expect(settings.preview.memorySaver.maxWarm).toBe(5);
    expect(settings.preview).not.toHaveProperty("rendering");
    expect(unlinkSync).toHaveBeenCalledWith(join("/fake/mcode", "settings.json.tmp"));
    expect(service.get()).toBe(settings);
    expect(readFileSync).toHaveBeenCalledOnce();
  });

  it("does not rewrite current settings or repeat a completed migration", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(legacySettings("webview"));
    const service = new SettingsService();

    service.get();
    service.get();

    expect(readFileSync).toHaveBeenCalledOnce();
    expect(writeFileSync).toHaveBeenCalledOnce();
    expect(renameSync).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ appearance: { theme: "dark" } }));
    new SettingsService().get();

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
    expect(unlinkSync).not.toHaveBeenCalled();
  });
});
