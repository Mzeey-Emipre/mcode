import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalPlatform, TerminalProfileRecovery, TerminalProfileReference } from "@mcode/contracts";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { WorkspaceTerminalPreferencesService } from "../../preferences/workspace-terminal-preferences-service.js";
import {
  TerminalProfileInUseError,
  TerminalProfileNotFoundError,
  TerminalProfileService,
  TerminalProfileUnavailableError,
} from "../terminal-profile-service.js";

describe("TerminalProfileService", () => {
  let settings: ReturnType<typeof settingsStub>;
  let workspacePreferences: ReturnType<typeof workspacePreferencesStub>;
  let available: Set<string>;
  let service: TerminalProfileService;

  beforeEach(() => {
    settings = settingsStub();
    workspacePreferences = workspacePreferencesStub();
    available = new Set(["powershell.exe", "pwsh.exe", "tool"]);
    service = new TerminalProfileService(
      settings as unknown as SettingsService,
      workspacePreferences as unknown as WorkspaceTerminalPreferencesService,
      {
        platform: "windows",
        resolveExecutable: vi.fn(async (executable) =>
          available.has(executable) ? `C:/resolved/${executable}` : null),
        createId: () => "11111111-1111-4111-8111-111111111111",
      },
    );
  });

  it("discovers certified shells and resolves the explicit selection order", async () => {
    const profiles = await service.list();
    expect(profiles.certified.map((profile) => profile.id)).toEqual([
      "certified:windows-powershell-5.1",
      "certified:windows-powershell-7",
    ]);

    workspacePreferences.get.mockReturnValue({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      defaultProfileId: "certified:windows-powershell-7",
      updatedAt: "2026-08-11T00:00:00.000Z",
    });
    expect((await service.resolve({
      workspaceId: "22222222-2222-4222-8222-222222222222",
    })).id).toBe("certified:windows-powershell-7");
    expect((await service.resolve({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      requestedProfileId: "certified:windows-powershell-5.1",
    })).id).toBe("certified:windows-powershell-5.1");
  });

  it("includes migration recovery details in profile listings", async () => {
    const recovery = {
      status: "blocked" as const,
      reason: "missing-profile-reference" as const,
      blockedProfiles: [],
      unavailableProfileId: "custom:33333333-3333-4333-8333-333333333333" as const,
    };
    settings.getTerminalRecoveryState.mockReturnValue(recovery);

    expect((await service.list()).recovery).toEqual(recovery);
  });

  it.each([
    ["macos", ["/bin/zsh", "/bin/bash"], ["certified:macos-zsh", "certified:macos-bash"]],
    ["linux", ["/bin/bash", "/bin/zsh"], ["certified:linux-bash", "certified:linux-zsh"]],
  ] as const)("discovers certified %s shells in Automatic order", async (platform, executables, expected) => {
    const installed = new Set<string>(executables);
    const platformService = new TerminalProfileService(
      settings as unknown as SettingsService,
      workspacePreferences as unknown as WorkspaceTerminalPreferencesService,
      {
        platform,
        resolveExecutable: vi.fn(async (executable) =>
          installed.has(executable) ? executable : null),
        createId: () => "11111111-1111-4111-8111-111111111111",
      },
    );

    expect((await platformService.list()).certified.map((profile) => profile.id)).toEqual(expected);
  });

  it("creates server IDs and returns immutable resolved snapshots", async () => {
    const created = await service.create({ name: " Tool ", executable: "tool", arguments: ["--one"] });
    const resolved = await service.resolve({ requestedProfileId: created.id });

    await service.update({
      profileId: created.id,
      name: "Tool 2",
      executable: "tool",
      arguments: ["--two"],
    });

    expect(created).toEqual({
      id: "custom:11111111-1111-4111-8111-111111111111",
      name: "Tool",
      executable: "tool",
      arguments: ["--one"],
    });
    expect(resolved.arguments).toEqual(["--one"]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.arguments)).toBe(true);
  });

  it("captures the requested profile separately from the resolved snapshot", async () => {
    const automatic = await service.resolveLaunchProfile({});
    const selected = await service.resolveLaunchProfile({
      requestedProfileId: "certified:windows-powershell-5.1",
    });

    expect(automatic.requestedProfileId).toBe("automatic");
    expect(automatic.resolvedProfile.id).toBe("certified:windows-powershell-5.1");
    expect(selected.requestedProfileId).toBe("certified:windows-powershell-5.1");
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it("never substitutes an unavailable or missing explicit profile", async () => {
    available.delete("pwsh.exe");
    await expect(service.resolve({
      requestedProfileId: "certified:windows-powershell-7",
    })).rejects.toBeInstanceOf(TerminalProfileUnavailableError);
    await expect(service.resolve({
      requestedProfileId: "custom:33333333-3333-4333-8333-333333333333",
    })).rejects.toBeInstanceOf(TerminalProfileNotFoundError);
  });

  it("validates workspace overrides before persistence and resets to inheritance", async () => {
    await service.setWorkspaceDefault(
      "22222222-2222-4222-8222-222222222222",
      "certified:windows-powershell-7",
    );
    expect(workspacePreferences.update).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "certified:windows-powershell-7",
    );

    available.delete("pwsh.exe");
    await expect(service.setWorkspaceDefault(
      "22222222-2222-4222-8222-222222222222",
      "certified:windows-powershell-7",
    )).rejects.toBeInstanceOf(TerminalProfileUnavailableError);
    expect(workspacePreferences.update).toHaveBeenCalledTimes(1);

    service.resetWorkspaceDefault("22222222-2222-4222-8222-222222222222");
    expect(workspacePreferences.reset).toHaveBeenCalledOnce();
  });

  it("blocks deletion and reports every global and workspace reference", async () => {
    const created = await service.create({ name: "Tool", executable: "tool", arguments: [] });
    settings.value.terminal.defaultProfileId = created.id;
    workspacePreferences.listReferences.mockReturnValue([
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]);

    await expect(service.delete(created.id)).rejects.toMatchObject({
      references: {
        globalDefault: true,
        workspaceIds: [
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
        ],
      },
    } satisfies Partial<TerminalProfileInUseError>);
  });
});

function settingsStub() {
  const value = {
    terminal: {
      defaultProfileId: "automatic" as TerminalProfileReference,
      profiles: [] as Array<{ id: `custom:${string}`; name: string; executable: string; arguments: string[] }>,
    },
  };
  return {
    value,
    get: vi.fn(() => value),
    replaceTerminalSettings: vi.fn((terminal) => {
      value.terminal = terminal;
      return terminal;
    }),
    getTerminalRecoveryState: vi.fn<() => TerminalProfileRecovery | null>(() => null),
  };
}

function workspacePreferencesStub() {
  return {
    get: vi.fn((): {
      workspaceId: string;
      defaultProfileId: TerminalProfileReference;
      updatedAt: string;
    } | null => null),
    update: vi.fn(),
    reset: vi.fn(() => true),
    listReferences: vi.fn((): string[] => []),
  };
}

void ("windows" satisfies TerminalPlatform);
