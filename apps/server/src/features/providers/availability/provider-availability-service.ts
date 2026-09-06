import { inject, injectable } from "tsyringe";
import {
  PROVIDER_CATALOG,
  getCatalogEntry,
  type ProviderAvailability,
  type ProviderId,
  type IProviderRegistry,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../settings/settings-service.js";
import {
  ProviderDisabledError,
  ProviderCliMissingError,
} from "./provider-availability-errors.js";
import whichModule from "which";
import * as NodeFS from "node:fs";

type CliRuntime = {
  status: "found" | "not_found" | "unchecked";
  resolvedPath: string | null;
};

/** Provider IDs whose CLI path is user-configurable via `settings.provider.cli`. */
type CliProvider = "codex" | "claude" | "copilot" | "cursor" | "opencode";

/** Narrows a ProviderId to those that carry a configurable CLI path setting. */
function hasCliPath(id: ProviderId): id is CliProvider {
  return id === "codex" || id === "claude" || id === "copilot" || id === "cursor" || id === "opencode";
}

/** Executable names to try on PATH when no custom CLI path is set (Cursor installs vary by platform). */
function cliPathLookupBinaries(id: ProviderId): readonly string[] {
  if (id === "cursor") return ["cursor-agent", "agent"];
  return [getCatalogEntry(id).cliBinary];
}

/** Thin shim over `which` + fs so tests can inject stubs. */
export interface CliResolver {
  which(binary: string): Promise<string>;
  statExecutable(path: string): Promise<boolean>;
}

export const defaultResolver: CliResolver = {
  which: (binary) => whichModule(binary),
  statExecutable: async (path) => {
    try {
      await NodeFS.promises.access(path, NodeFS.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Tracks per-provider enabled flag + CLI verification state.
 * Use `assertEnabled` before read-only discovery calls (e.g. `listModels`) —
 * it checks the enabled flag and `comingSoon` without requiring a CLI binary.
 * Use `assertUsable` before send/execution calls that require the CLI binary.
 */
@injectable()
export class ProviderAvailabilityService {
  private cliCache = new Map<ProviderId, CliRuntime>();

  constructor(
    @inject(SettingsService) private readonly settings: SettingsService,
    @inject("IProviderRegistry") private readonly registry: IProviderRegistry,
    @inject("CliResolver") private readonly resolver: CliResolver = defaultResolver,
  ) {}

  /** Build the full availability list from catalog + settings + cached CLI state. */
  listAvailability(): ProviderAvailability[] {
    const s = this.settings.get();
    const registered = new Map(this.registry.resolveAll().map((provider) => [provider.id, provider]));

    return PROVIDER_CATALOG.map((entry): ProviderAvailability => {
      const cliRuntime: CliRuntime = this.cliCache.get(entry.id) ?? {
        status: "unchecked",
        resolvedPath: null,
      };
      const configuredPath = hasCliPath(entry.id) ? s.provider.cli[entry.id] : "";
      return {
        id: entry.id,
        enabled: s.provider.enabled[entry.id],
        hasAdapter: registered.has(entry.id),
        beta: entry.beta,
        comingSoon: entry.comingSoon,
        capabilities: [...(registered.get(entry.id)?.descriptor.capabilities ?? [])],
        cli: {
          status: cliRuntime.status,
          resolvedPath: cliRuntime.resolvedPath,
          configuredPath,
        },
      };
    });
  }

  /**
   * Resolve and validate the CLI binary for the given provider.
   * When `settings.provider.cli[id]` is set, checks that exact path for execute
   * permissions; otherwise falls back to PATH lookup via `which`.
   * Caches the result for subsequent `listAvailability` calls.
   */
  async verifyCli(id: ProviderId): Promise<CliRuntime> {
    const s = this.settings.get();
    const configured = hasCliPath(id) ? s.provider.cli[id] : "";

    let result: CliRuntime;
    if (configured) {
      const ok = await this.resolver.statExecutable(configured);
      result = ok
        ? { status: "found", resolvedPath: configured }
        : { status: "not_found", resolvedPath: null };
    } else {
      let resolved: string | null = null;
      for (const binary of cliPathLookupBinaries(id)) {
        try {
          resolved = await this.resolver.which(binary);
          break;
        } catch {
          /* try next candidate */
        }
      }
      result = resolved
        ? { status: "found", resolvedPath: resolved }
        : { status: "not_found", resolvedPath: null };
    }
    this.cliCache.set(id, result);
    return result;
  }

  /**
   * Throw if the provider is disabled or coming-soon. Does NOT check CLI
   * binary status, so read-only discovery calls (e.g. listModels) work even
   * when the CLI is missing - SDK-based providers don't need the binary.
   */
  assertEnabled(id: ProviderId): void {
    const entry = getCatalogEntry(id);
    if (entry.comingSoon || !this.settings.get().provider.enabled[id]) {
      throw new ProviderDisabledError(id);
    }
  }

  /**
   * Throw a typed error if the provider is unusable. Returns normally otherwise.
   * CLI `unchecked` state is treated as "probably ok" — the first send will
   * re-verify and surface the real error if the binary is missing.
   */
  assertUsable(id: ProviderId): void {
    this.assertEnabled(id);
    const cached = this.cliCache.get(id);
    if (cached?.status === "not_found") {
      const configuredPath = hasCliPath(id) ? this.settings.get().provider.cli[id] : "";
      throw new ProviderCliMissingError(id, configuredPath);
    }
  }

  /** Run verification for every provider whose enabled flag is true and that has an adapter. */
  async verifyAllEnabled(): Promise<void> {
    const s = this.settings.get();
    const registered = new Set(this.registry.resolveAll().map((p) => p.id));
    const targets = PROVIDER_CATALOG.filter(
      (entry) => s.provider.enabled[entry.id] && registered.has(entry.id),
    );
    await Promise.all(targets.map((entry) => this.verifyCli(entry.id)));
  }

  private broadcastListeners: Array<(list: ProviderAvailability[]) => void> = [];
  private settingsSubscribed = false;
  /** Snapshot of `settings.provider` from the last broadcast — used to skip no-op re-verifies. */
  private lastProviderSnapshot: string | null = null;

  /** Register a broadcast callback invoked whenever availability changes due to a settings update. */
  onChange(cb: (list: ProviderAvailability[]) => void): void {
    this.broadcastListeners.push(cb);
    // Subscribe to SettingsService once, no matter how many onChange callers there are.
    if (!this.settingsSubscribed) {
      this.settingsSubscribed = true;
      this.lastProviderSnapshot = JSON.stringify(this.settings.get().provider);
      this.settings.on("change", (s) => {
        void this.handleSettingsChange(s);
      });
    }
  }

  private async handleSettingsChange(
    next: ReturnType<SettingsService["get"]>,
  ): Promise<void> {
    // Settings emits on every update — skip when the provider slice didn't change
    // to avoid respawning `which`/`fs.access` probes on unrelated edits (theme, terminal, etc.).
    const snapshot = JSON.stringify(next.provider);
    if (snapshot === this.lastProviderSnapshot) return;
    this.lastProviderSnapshot = snapshot;

    try {
      await this.verifyAllEnabled();
    } catch (err) {
      // Log and continue — listeners still need to receive the updated availability
      // snapshot. Per-provider CLI entries will stay at their prior cached status.
      logger.warn("verifyAllEnabled failed during settings change", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const list = this.listAvailability();
    for (const cb of this.broadcastListeners) {
      try {
        cb(list);
      } catch (err) {
        // Isolate listeners: one throwing callback must not prevent others from firing.
        logger.warn("provider availability onChange listener threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
