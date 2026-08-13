import { meetsMinVersion } from "./private/codex/codex-version.js";

/** Returns true when a dotted provider version meets the required floor. */
export function isProviderVersionAtLeast(version: string, minimum: string): boolean {
  return meetsMinVersion(version, minimum);
}

/** Warms the Codex provider availability cache without inspecting a turn. */
export function warmCodexProviderVersion(cliPath: string): Promise<void> {
  return import("./private/codex/codex-version.js").then(({ warmCodexVersionCache }) => (
    warmCodexVersionCache(cliPath)
  ));
}
