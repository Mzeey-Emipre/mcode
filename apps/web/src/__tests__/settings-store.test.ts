import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";

describe("SettingsStore", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: DEFAULT_SETTINGS,
      loaded: false,
    });
  });

  it("defaults to DEFAULT_SETTINGS", () => {
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it("starts with loaded = false", () => {
    expect(useSettingsStore.getState().loaded).toBe(false);
  });

  it("_applyPush replaces settings", () => {
    const updated = {
      ...DEFAULT_SETTINGS,
      appearance: { theme: "dark" as const },
    };
    useSettingsStore.getState()._applyPush(updated);
    expect(useSettingsStore.getState().settings.appearance.theme).toBe("dark");
  });
});
