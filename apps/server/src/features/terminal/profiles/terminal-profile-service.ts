import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import which from "which";
import {
  TerminalCustomProfileSchema,
  TerminalCustomProfileIdSchema,
  TerminalProfileReferenceSchema,
  TerminalResolvedProfileSchema,
  type TerminalCustomProfile,
  type TerminalPlatform,
  type TerminalProfileReference,
  type TerminalResolvedProfile,
} from "@mcode/contracts";
import type { SettingsService } from "../../settings/settings-service.js";
import type { WorkspaceTerminalPreferencesService } from "../preferences/workspace-terminal-preferences-service.js";
import { terminalPlatform } from "../terminal-platform.js";

interface CertifiedProfileDefinition {
  readonly id: Exclude<TerminalProfileReference, "automatic" | `custom:${string}`>;
  readonly name: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly platform: TerminalPlatform;
}

const CERTIFIED_PROFILES: readonly CertifiedProfileDefinition[] = [
  { id: "certified:windows-powershell-5.1", name: "Windows PowerShell", executable: "powershell.exe", arguments: [], platform: "windows" },
  { id: "certified:windows-powershell-7", name: "PowerShell", executable: "pwsh.exe", arguments: [], platform: "windows" },
  { id: "certified:windows-cmd", name: "Command Prompt", executable: "cmd.exe", arguments: [], platform: "windows" },
  { id: "certified:windows-git-bash", name: "Git Bash", executable: "bash.exe", arguments: [], platform: "windows" },
  { id: "certified:windows-wsl", name: "WSL", executable: "wsl.exe", arguments: [], platform: "windows" },
  { id: "certified:macos-zsh", name: "zsh", executable: "/bin/zsh", arguments: [], platform: "macos" },
  { id: "certified:macos-bash", name: "bash", executable: "/bin/bash", arguments: [], platform: "macos" },
  { id: "certified:linux-bash", name: "bash", executable: "/bin/bash", arguments: [], platform: "linux" },
  { id: "certified:linux-zsh", name: "zsh", executable: "/bin/zsh", arguments: [], platform: "linux" },
] as const;

/** Injectable platform and executable probes for Terminal profile resolution. */
export interface TerminalProfileServiceOptions {
  readonly platform: TerminalPlatform;
  readonly resolveExecutable: (executable: string) => Promise<string | null>;
  readonly createId: () => string;
}

/** References that prevent deletion of a custom Terminal profile. */
export interface TerminalProfileReferences {
  readonly globalDefault: boolean;
  readonly workspaceIds: readonly string[];
}

/** Raised when a requested Terminal profile has no persisted definition. */
export class TerminalProfileNotFoundError extends Error {
  readonly code = "PROFILE_NOT_FOUND" as const;

  constructor(profileId: string) {
    super(`Terminal profile ${profileId} was not found`);
    this.name = "TerminalProfileNotFoundError";
  }
}

/** Raised when the executable for a Terminal profile is not available. */
export class TerminalProfileUnavailableError extends Error {
  readonly code = "PROFILE_UNAVAILABLE" as const;

  constructor(profileId: string) {
    super(`Terminal profile ${profileId} is not available`);
    this.name = "TerminalProfileUnavailableError";
  }
}

/** Raised when a custom Terminal profile remains selected as a default. */
export class TerminalProfileInUseError extends Error {
  readonly code = "PROFILE_IN_USE" as const;

  constructor(
    profileId: string,
    readonly references: TerminalProfileReferences,
  ) {
    super(`Terminal profile ${profileId} is still used as a default`);
    this.name = "TerminalProfileInUseError";
  }
}

/** Creates the production profile discovery probes for this server process. */
export function createTerminalProfileServiceOptions(
  platform: NodeJS.Platform,
): TerminalProfileServiceOptions {
  return {
    platform: terminalPlatform(platform),
    resolveExecutable: async (executable) => {
      if (NodePath.isAbsolute(executable)) {
        try {
          return NodeFS.statSync(executable).isFile() ? executable : null;
        } catch {
          return null;
        }
      }
      return await which(executable, { nothrow: true });
    },
    createId: NodeCrypto.randomUUID,
  };
}

/** Discovers, persists, validates, and resolves immutable Terminal profiles. */
export class TerminalProfileService {
  constructor(
    private readonly settings: SettingsService,
    private readonly workspacePreferences: WorkspaceTerminalPreferencesService,
    private readonly options: TerminalProfileServiceOptions = createTerminalProfileServiceOptions(),
  ) {}

  /** Lists available certified profiles and persisted custom profiles. */
  async list(): Promise<{
    readonly certified: readonly TerminalResolvedProfile[];
    readonly custom: readonly TerminalCustomProfile[];
    readonly recovery?: ReturnType<SettingsService["getTerminalRecoveryState"]>;
  }> {
    const certified = (await Promise.all(
      CERTIFIED_PROFILES
        .filter((profile) => profile.platform === this.options.platform)
        .map((profile) => this.resolveCertified(profile)),
    )).filter((profile): profile is TerminalResolvedProfile => profile !== null);
    const custom = this.settings.get().terminal.profiles.map((profile) => cloneCustomProfile(profile));
    const recovery = this.settings.getTerminalRecoveryState();
    return Object.freeze({
      certified: Object.freeze(certified),
      custom: Object.freeze(custom),
      ...(recovery ? { recovery } : {}),
    });
  }

  /** Creates one validated custom profile with a server-generated identifier. */
  async create(input: Omit<TerminalCustomProfile, "id">): Promise<TerminalCustomProfile> {
    const current = this.settings.get().terminal;
    if (current.profiles.length >= 32) {
      throw new Error("Terminal custom profile limit reached");
    }
    const profile = TerminalCustomProfileSchema().parse({
      ...input,
      id: `custom:${this.options.createId()}`,
    });
    await this.assertCustomProfileAvailable(profile);
    this.settings.replaceTerminalSettings({
      ...current,
      profiles: [...current.profiles, profile],
    });
    return cloneCustomProfile(profile);
  }

  /** Replaces one custom profile definition without changing its stable identifier. */
  async update(input: Omit<TerminalCustomProfile, "id"> & { readonly profileId: string }): Promise<TerminalCustomProfile> {
    const current = this.settings.get().terminal;
    const profileId = TerminalCustomProfileIdSchema().parse(input.profileId);
    const index = current.profiles.findIndex((profile) => profile.id === profileId);
    if (index < 0) {
      throw new TerminalProfileNotFoundError(profileId);
    }
    const profile = TerminalCustomProfileSchema().parse({
      id: profileId,
      name: input.name,
      executable: input.executable,
      arguments: input.arguments,
    });
    await this.assertCustomProfileAvailable(profile);
    const profiles = current.profiles.slice();
    profiles[index] = profile;
    this.settings.replaceTerminalSettings({ ...current, profiles });
    return cloneCustomProfile(profile);
  }

  /** Deletes one unreferenced custom profile. */
  async delete(profileId: string): Promise<void> {
    profileId = TerminalCustomProfileIdSchema().parse(profileId);
    const current = this.settings.get().terminal;
    if (!current.profiles.some((profile) => profile.id === profileId)) {
      throw new TerminalProfileNotFoundError(profileId);
    }
    const references = {
      globalDefault: current.defaultProfileId === profileId,
      workspaceIds: this.workspacePreferences.listReferences(profileId),
    } satisfies TerminalProfileReferences;
    if (references.globalDefault || references.workspaceIds.length > 0) {
      throw new TerminalProfileInUseError(profileId, references);
    }
    this.settings.replaceTerminalSettings({
      ...current,
      profiles: current.profiles.filter((profile) => profile.id !== profileId),
    });
  }

  /** Sets the global profile used by new Terminal sessions. */
  async setDefault(profileId: TerminalProfileReference): Promise<TerminalProfileReference> {
    const validated = await this.validateProfileReference(profileId);
    const current = this.settings.get().terminal;
    this.settings.replaceTerminalSettings({ ...current, defaultProfileId: validated });
    return validated;
  }

  /** Validates and stores an explicit workspace default-profile override. */
  async setWorkspaceDefault(
    workspaceId: string,
    profileId: TerminalProfileReference,
  ): Promise<TerminalProfileReference> {
    const validated = await this.validateProfileReference(profileId);
    this.workspacePreferences.update(workspaceId, validated);
    return validated;
  }

  /** Deletes an explicit workspace override so it inherits the global default. */
  resetWorkspaceDefault(workspaceId: string): void {
    this.workspacePreferences.reset(workspaceId);
  }

  /** Resolves one-time, workspace, global, then Automatic profile selection. */
  async resolve(input: {
    readonly workspaceId?: string;
    readonly requestedProfileId?: TerminalProfileReference;
  }): Promise<TerminalResolvedProfile> {
    return (await this.resolveLaunchProfile(input)).resolvedProfile;
  }

  /** Resolves and retains the exact requested profile for an immutable launch snapshot. */
  async resolveLaunchProfile(input: {
    readonly workspaceId?: string;
    readonly requestedProfileId?: TerminalProfileReference;
  }): Promise<{
    readonly requestedProfileId: TerminalProfileReference;
    readonly resolvedProfile: TerminalResolvedProfile;
  }> {
    const selected = input.requestedProfileId
      ?? (input.workspaceId ? this.workspacePreferences.get(input.workspaceId)?.defaultProfileId : undefined)
      ?? this.settings.get().terminal.defaultProfileId;
    if (selected !== "automatic") {
      return Object.freeze({
        requestedProfileId: selected,
        resolvedProfile: await this.resolveReference(selected),
      });
    }
    const available = await this.list();
    const automatic = available.certified[0];
    if (!automatic) {
      throw new TerminalProfileUnavailableError("automatic");
    }
    return Object.freeze({
      requestedProfileId: selected,
      resolvedProfile: freezeResolvedProfile(automatic),
    });
  }

  private async resolveReference(profileId: Exclude<TerminalProfileReference, "automatic">): Promise<TerminalResolvedProfile> {
    if (profileId.startsWith("certified:")) {
      const definition = CERTIFIED_PROFILES.find((profile) => profile.id === profileId);
      if (!definition || definition.platform !== this.options.platform) {
        throw new TerminalProfileUnavailableError(profileId);
      }
      const resolved = await this.resolveCertified(definition);
      if (!resolved) {
        throw new TerminalProfileUnavailableError(profileId);
      }
      return resolved;
    }
    const custom = this.settings.get().terminal.profiles.find((profile) => profile.id === profileId);
    if (!custom) {
      throw new TerminalProfileNotFoundError(profileId);
    }
    const executable = await this.options.resolveExecutable(custom.executable);
    if (!executable) {
      throw new TerminalProfileUnavailableError(profileId);
    }
    return freezeResolvedProfile(TerminalResolvedProfileSchema().parse({
      ...custom,
      executable,
      source: "custom",
      platform: this.options.platform,
    }));
  }

  private async validateProfileReference(
    profileId: TerminalProfileReference,
  ): Promise<TerminalProfileReference> {
    const validated = TerminalProfileReferenceSchema().parse(profileId);
    if (validated !== "automatic") {
      await this.resolveReference(validated);
    }
    return validated;
  }

  private async resolveCertified(definition: CertifiedProfileDefinition): Promise<TerminalResolvedProfile | null> {
    const executable = await this.options.resolveExecutable(definition.executable);
    if (!executable) return null;
    return freezeResolvedProfile(TerminalResolvedProfileSchema().parse({
      ...definition,
      executable,
      arguments: [...definition.arguments],
      source: "certified",
    }));
  }

  private async assertCustomProfileAvailable(profile: TerminalCustomProfile): Promise<void> {
    if (!await this.options.resolveExecutable(profile.executable)) {
      throw new TerminalProfileUnavailableError(profile.id);
    }
  }
}

function cloneCustomProfile(profile: TerminalCustomProfile): TerminalCustomProfile {
  return Object.freeze({ ...profile, arguments: Object.freeze([...profile.arguments]) }) as TerminalCustomProfile;
}

function freezeResolvedProfile(profile: TerminalResolvedProfile): TerminalResolvedProfile {
  return Object.freeze({ ...profile, arguments: Object.freeze([...profile.arguments]) }) as TerminalResolvedProfile;
}
