import type { ProviderId } from "./interfaces.js";

/**
 * Static per-provider metadata. Single source of truth for the server.
 * Frontend mirrors this in `apps/web/src/lib/model-registry.ts` (tech-debt
 * consolidation tracked separately).
 */
export interface ProviderCatalogEntry {
  /** Stable provider identifier. */
  id: ProviderId;
  /** Human-readable display name. */
  name: string;
  /** When true, renders a "Beta" badge with an "expect bugs" tooltip. */
  beta: boolean;
  /** When true, no adapter ships yet; the Settings switch is fixed off and non-interactive. */
  comingSoon: boolean;
  /**
   * Executable name looked up on PATH when `settings.provider.cli[id]` is empty.
   * For Cursor, the server also probes `agent` if `cursor-agent` is missing.
   */
  cliBinary: string;
}

/** Canonical ordered list of all providers known to the app. */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: "claude",   name: "Claude",         beta: false, comingSoon: false, cliBinary: "claude"   },
  { id: "codex",    name: "Codex",          beta: false, comingSoon: false, cliBinary: "codex"    },
  { id: "copilot",  name: "GitHub Copilot", beta: true,  comingSoon: false, cliBinary: "copilot"  },
  { id: "gemini",   name: "Gemini",         beta: false, comingSoon: true,  cliBinary: "gemini"   },
  { id: "cursor",   name: "Cursor",         beta: true,  comingSoon: false, cliBinary: "cursor-agent" },
  { id: "opencode", name: "OpenCode",       beta: true,  comingSoon: false, cliBinary: "opencode" },
] as const;

/** Look up a catalog entry by provider id. Throws if the id is not in the catalog. */
export function getCatalogEntry(id: ProviderId): ProviderCatalogEntry {
  const entry = PROVIDER_CATALOG.find((p) => p.id === id);
  if (!entry) throw new Error(`Unknown provider id: ${id}`);
  return entry;
}
