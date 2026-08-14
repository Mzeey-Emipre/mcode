import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";

const { transport } = vi.hoisted(() => ({
  transport: {
    terminalProfileList: vi.fn().mockResolvedValue({ certified: [], custom: [] }),
    terminalWorkspacePreferencesGet: vi.fn(),
  },
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));

import { TerminalSection } from "../TerminalSection";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

describe("TerminalSection", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true });
    useWorkspaceStore.setState({ activeWorkspaceId: null });
    useTerminalSettingsStore.setState({
      certifiedProfiles: [],
      customProfiles: [],
      recovery: null,
      profilesLoaded: true,
      profilesLoading: false,
      workspaceOverride: null,
      workspaceLoading: false,
      pending: false,
      error: null,
      deleteReferences: null,
      fetchProfiles: vi.fn(),
      fetchWorkspaceOverride: vi.fn(),
      setGlobalDefault: vi.fn().mockResolvedValue(true),
      setWorkspaceDefault: vi.fn().mockResolvedValue(true),
      resetWorkspaceDefault: vi.fn().mockResolvedValue(true),
      createProfile: vi.fn().mockResolvedValue(true),
      updateProfile: vi.fn().mockResolvedValue(true),
      deleteProfile: vi.fn().mockResolvedValue(true),
      updatePreferences: vi.fn().mockResolvedValue(true),
      resetPreferences: vi.fn().mockResolvedValue(true),
      clearError: vi.fn(),
    });
  });

  it("shows complete sections and bounded, named Terminal controls", { timeout: 15_000 }, () => {
    render(<TerminalSection />);

    expect(screen.getByRole("heading", { name: "Profiles and defaults" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Presentation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Behavior" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Accessibility" })).toBeInTheDocument();
    expect(screen.getByLabelText("Scrollback lines")).toHaveAttribute("min", "100");
    expect(screen.getByLabelText("Scrollback lines")).toHaveAttribute("max", "5000");
    expect(screen.getByLabelText("Session limit")).toHaveAttribute("min", "1");
    expect(screen.getByLabelText("Session limit")).toHaveAttribute("max", "20");
    expect(screen.getByRole("button", { name: "Reset Terminal preferences" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default Terminal profile" })).toHaveTextContent("Automatic");
  });

  it("keeps inherited and explicit Automatic workspace profiles distinct", { timeout: 15_000 }, async () => {
    const workspaceId = "workspace-1";
    const user = userEvent.setup();
    useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
    render(<TerminalSection />);

    const trigger = screen.getByRole("combobox", { name: "Workspace Terminal profile" });
    expect(trigger).toHaveTextContent("Use inherited global profile");
    await user.click(trigger);
    expect(screen.getByRole("option", { name: "Use inherited global profile" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Automatic" })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: "Automatic" }));
    const setWorkspaceDefault = useTerminalSettingsStore.getState().setWorkspaceDefault as ReturnType<typeof vi.fn>;
    expect(setWorkspaceDefault).toHaveBeenCalledWith(workspaceId, "automatic");
  });

  it("commits a non-empty font draft once and restores it on Escape", () => {
    render(<TerminalSection />);
    const input = screen.getByLabelText("Terminal font family");
    const updatePreferences = useTerminalSettingsStore.getState().updatePreferences as ReturnType<typeof vi.fn>;

    input.focus();
    fireEvent.change(input, { target: { value: "JetBrains Mono" } });
    expect(updatePreferences).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(updatePreferences).toHaveBeenCalledWith({ presentation: { fontFamily: "JetBrains Mono" } });

    fireEvent.change(input, { target: { value: "Unconfirmed Font" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue(getDefaultSettings().terminal.presentation.fontFamily);
    expect(updatePreferences).toHaveBeenCalledTimes(1);
  });

  it("shows blocked profiles and the unavailable selected reference for repair", () => {
    const blockedProfile = {
      id: "custom:11111111-1111-4111-8111-111111111111" as const,
      name: "Recovered shell",
      executable: "sh",
      arguments: [],
    };
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        terminal: { ...getDefaultSettings().terminal, defaultProfileId: "automatic" },
      },
    });
    useTerminalSettingsStore.setState({
      recovery: {
        status: "blocked",
        reason: "missing-profile-reference",
        blockedProfiles: [blockedProfile],
        unavailableProfileId: "custom:22222222-2222-4222-8222-222222222222",
      },
    });

    render(<TerminalSection />);

    expect(screen.getByText(/Terminal settings need repair/)).toBeInTheDocument();
    expect(screen.getByText("Recovered shell")).toBeInTheDocument();
    expect(screen.getByText(/Selected profile is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default Terminal profile" })).toHaveTextContent("Unavailable: Custom profile");
  });

  it("shows the selected custom profile name in the trigger", () => {
    const customProfile = {
      id: "custom:11111111-1111-4111-8111-111111111111" as const,
      name: "Live Test Profile",
      executable: "sh",
      arguments: [],
    };
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        terminal: { ...getDefaultSettings().terminal, defaultProfileId: customProfile.id },
      },
    });
    useTerminalSettingsStore.setState({ customProfiles: [customProfile] });

    render(<TerminalSection />);

    expect(screen.getByRole("combobox", { name: "Default Terminal profile" })).toHaveTextContent("Live Test Profile");
  });
});
