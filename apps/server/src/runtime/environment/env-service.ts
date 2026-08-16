/**
 * Builds complete environment objects for child spawns: current process env,
 * merged with a periodic fresh resolution from the user's shell or OS config,
 * with server-owned keys forced to the values captured at startup.
 */

import { injectable, inject } from "tsyringe";
import { ProtectedEnvStore } from "./protected-env-store.js";
import { flattenProcessEnv } from "./shell-env-utils.js";
import { ShellEnvResolver } from "./shell-env-resolver.js";

const DEFAULT_TTL_MS = 60_000;
/** Coalesces overlapping `getEnv` calls while an async shell/registry refresh is in flight. */
const UNTIL_ASYNC_MS = 2_000;

/**
 * Public facade used by terminals and providers when spawning subprocesses.
 */
@injectable()
export class EnvService {
  private cached: Record<string, string> | null = null;
  private cacheExpiresAt = 0;
  private refreshInFlight = false;

  constructor(
    @inject(ShellEnvResolver) private readonly shellEnvResolver: ShellEnvResolver,
    @inject(ProtectedEnvStore) private readonly protectedEnvStore: ProtectedEnvStore,
  ) {}

  /**
   * Returns env for `spawn` / PTY: live `process.env`, overlaid with the last
   * async shell/registry resolution (TTL {@link DEFAULT_TTL_MS}), then
   * server-protected keys. Never blocks the event loop on a shell spawn; a
   * background refresh runs when the cache expires.
   */
  getEnv(): Record<string, string> {
    const now = Date.now();
    if (this.cached !== null && now < this.cacheExpiresAt) {
      return { ...this.cached };
    }

    const base = flattenProcessEnv(process.env);
    const overlay = this.shellEnvResolver.peekResolvedOverlay();
    const merged = this.protectedEnvStore.applyTo({ ...base, ...overlay });
    this.cached = merged;
    this.cacheExpiresAt = now + UNTIL_ASYNC_MS;
    this.scheduleRefresh();
    return { ...merged };
  }

  private scheduleRefresh(): void {
    if (this.refreshInFlight) {
      return;
    }
    this.refreshInFlight = true;
    void this.shellEnvResolver
      .resolveFreshAsync()
      .then((resolved) => {
        const base = flattenProcessEnv(process.env);
        this.cached = this.protectedEnvStore.applyTo({ ...base, ...resolved });
        this.cacheExpiresAt = Date.now() + DEFAULT_TTL_MS;
      })
      .catch(() => {
        /* resolveFreshAsync already logged and returned fallback */
      })
      .finally(() => {
        this.refreshInFlight = false;
      });
  }
}
