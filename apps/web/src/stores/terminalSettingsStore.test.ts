import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";

const { transport } = vi.hoisted(() => ({
  transport: {
    getSettings: vi.fn(),
    terminalProfileList: vi.fn(),
    terminalProfileCreate: vi.fn(),
    terminalProfileUpdate: vi.fn(),
    terminalProfileDelete: vi.fn(),
    terminalProfileSetDefault: vi.fn(),
    terminalWorkspacePreferencesGet: vi.fn(),
    terminalWorkspacePreferencesUpdate: vi.fn(),
    terminalWorkspacePreferencesReset: vi.fn(),
    terminalPreferencesReset: vi.fn(),
    terminalPreferencesUpdate: vi.fn(),
  },
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));

import { useSettingsStore } from "./settingsStore";
import { useTerminalSettingsStore } from "./terminalSettingsStore";

const profile = {
  id: "custom:11111111-1111-4111-8111-111111111111",
  name: "Shell",
  executable: "sh",
  arguments: [] as string[],
} satisfies { readonly id: `custom:${string}`; readonly name: string; readonly executable: string; readonly arguments: string[] };

describe("terminal settings store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.getSettings.mockResolvedValue(getDefaultSettings());
    transport.terminalProfileList.mockResolvedValue({ certified: [], custom: [profile] });
    transport.terminalProfileCreate.mockResolvedValue(profile);
    transport.terminalProfileUpdate.mockResolvedValue(profile);
    transport.terminalProfileDelete.mockResolvedValue({ deleted: true });
    transport.terminalProfileSetDefault.mockResolvedValue({ defaultProfileId: "automatic" });
    transport.terminalWorkspacePreferencesGet.mockResolvedValue({ workspaceId: "workspace-1", defaultProfileId: null });
    transport.terminalWorkspacePreferencesUpdate.mockResolvedValue({ workspaceId: "workspace-1", defaultProfileId: "automatic" });
    transport.terminalWorkspacePreferencesReset.mockResolvedValue({ reset: true });
    transport.terminalPreferencesReset.mockResolvedValue({ reset: true });
    transport.terminalPreferencesUpdate.mockResolvedValue({
      terminal: {
        presentation: getDefaultSettings().terminal.presentation,
        behavior: { ...getDefaultSettings().terminal.behavior, scrollback: 2500 },
        accessibility: getDefaultSettings().terminal.accessibility,
      },
    });
    useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true });
    useTerminalSettingsStore.setState({
      certifiedProfiles: [],
      customProfiles: [],
      profilesLoaded: false,
      profilesLoading: false,
      workspaceOverride: null,
      workspaceLoading: false,
      pending: false,
      error: null,
      deleteReferences: null,
    });
  });

  it("sends the global default payload and keeps workspace Automatic distinct from inherit", async () => {
    await useTerminalSettingsStore.getState().setGlobalDefault("automatic");
    expect(transport.terminalProfileSetDefault).toHaveBeenCalledWith("automatic");

    await useTerminalSettingsStore.getState().setWorkspaceDefault("workspace-1", "automatic");
    expect(transport.terminalWorkspacePreferencesUpdate).toHaveBeenCalledWith("workspace-1", "automatic");
    expect(useTerminalSettingsStore.getState().workspaceOverride?.defaultProfileId).toBe("automatic");

    await useTerminalSettingsStore.getState().resetWorkspaceDefault("workspace-1");
    expect(transport.terminalWorkspacePreferencesReset).toHaveBeenCalledWith("workspace-1");
    expect(useTerminalSettingsStore.getState().workspaceOverride).toBeNull();
  });

  it("handles profile CRUD and exposes deletion references", async () => {
    await useTerminalSettingsStore.getState().fetchProfiles();
    expect(useTerminalSettingsStore.getState().customProfiles).toEqual([profile]);
    expect(await useTerminalSettingsStore.getState().createProfile({ name: "Shell", executable: "sh", arguments: [] })).toBe(true);
    expect(transport.terminalProfileCreate).toHaveBeenCalledWith({ name: "Shell", executable: "sh", arguments: [] });
    expect(await useTerminalSettingsStore.getState().updateProfile({ ...profile, profileId: profile.id })).toBe(true);
    expect(transport.terminalProfileUpdate).toHaveBeenCalledWith({ ...profile, profileId: profile.id });

    const error = Object.assign(new Error("Profile is in use"), {
      data: { references: { globalDefault: true, workspaceIds: ["workspace-1"] } },
    });
    transport.terminalProfileDelete.mockRejectedValueOnce(error);
    expect(await useTerminalSettingsStore.getState().deleteProfile(profile.id)).toBe(false);
    expect(useTerminalSettingsStore.getState().deleteReferences).toEqual({ globalDefault: true, workspaceIds: ["workspace-1"] });
  });

  it("retains bounded migration recovery details from the profile list", async () => {
    transport.terminalProfileList.mockResolvedValueOnce({
      certified: [],
      custom: [],
      recovery: {
        status: "blocked",
        reason: "missing-profile-reference",
        blockedProfiles: [profile],
        unavailableProfileId: "custom:22222222-2222-4222-8222-222222222222",
      },
    });

    await useTerminalSettingsStore.getState().fetchProfiles();

    expect(useTerminalSettingsStore.getState().recovery).toEqual(expect.objectContaining({
      reason: "missing-profile-reference",
      blockedProfiles: [profile],
    }));
  });

  it("updates bounded preferences and preserves custom profiles when resetting", async () => {
    await useTerminalSettingsStore.getState().fetchProfiles();
    await useTerminalSettingsStore.getState().updatePreferences({ behavior: { scrollback: 2500 } });
    expect(transport.terminalPreferencesUpdate).toHaveBeenCalledWith({ behavior: { scrollback: 2500 } });
    expect(useSettingsStore.getState().settings.terminal.behavior.scrollback).toBe(2500);

    await useTerminalSettingsStore.getState().resetPreferences();
    expect(transport.terminalPreferencesReset).toHaveBeenCalledWith(undefined);
    expect(useTerminalSettingsStore.getState().customProfiles).toEqual([profile]);
  });
});
