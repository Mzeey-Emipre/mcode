import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";

describe("SettingsStore", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: "system",
      maxConcurrentAgents: 5,
      notificationsEnabled: true,
    });
  });

  it("default theme is system", () => {
    expect(useSettingsStore.getState().theme).toBe("system");
  });

  it("default maxConcurrentAgents is 5", () => {
    expect(useSettingsStore.getState().maxConcurrentAgents).toBe(5);
  });

  it("setTheme updates state", () => {
    useSettingsStore.getState().setTheme("dark");
    expect(useSettingsStore.getState().theme).toBe("dark");
  });

  it("setMaxConcurrentAgents updates state", () => {
    useSettingsStore.getState().setMaxConcurrentAgents(3);
    expect(useSettingsStore.getState().maxConcurrentAgents).toBe(3);
  });

  it("setNotificationsEnabled updates state", () => {
    useSettingsStore.getState().setNotificationsEnabled(false);
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false);
  });
});
