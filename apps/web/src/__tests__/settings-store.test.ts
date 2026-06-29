import { describe, it, expect, beforeEach } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";

describe("SettingsStore", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      loaded: false,
    });
  });

  it("defaults to getDefaultSettings()", () => {
    expect(useSettingsStore.getState().settings).toEqual(getDefaultSettings());
  });

  it("starts with loaded = false", () => {
    expect(useSettingsStore.getState().loaded).toBe(false);
  });

  it("_applyPush replaces settings", () => {
    const updated = {
      ...getDefaultSettings(),
      appearance: { theme: "dark" as const },
    };
    useSettingsStore.getState()._applyPush(updated);
    expect(useSettingsStore.getState().settings.appearance.theme).toBe("dark");
  });

  it("_applyPush exposes the effective preview rendering engine", () => {
    const updated = {
      ...getDefaultSettings(),
      preview: {
        ...getDefaultSettings().preview,
        rendering: { engine: "webview" as const },
      },
    };
    useSettingsStore.getState()._applyPush(updated);
    expect(useSettingsStore.getState().settings.preview.rendering.engine).toBe("webview");
  });
});
