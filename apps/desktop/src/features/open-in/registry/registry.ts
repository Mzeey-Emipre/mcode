/**
 * The Open-in app registry: a single source of truth that composes
 * {@link OpenInAdapter}s. It surfaces serializable metadata + detection for the
 * renderer and dispatches launches to the right adapter, so the IPC layer never
 * branches per app or carries its own allowlist.
 */

import type {
  LaunchTarget,
  OpenInAdapter,
  OpenInAppMeta,
} from "../contracts/types.js";

/** Serializable app metadata plus live detection status (the renderer's view). */
export interface OpenInAppStatus extends OpenInAppMeta {
  /** Whether the app is installed / available on this system. */
  readonly detected: boolean;
}

/**
 * Composes a set of adapters keyed by id. Construct with whatever adapters you
 * want registered — the production wiring lives in `index.ts`, and tests pass
 * fake adapters to exercise composition and dispatch without spawning anything.
 */
export class OpenInRegistry {
  private readonly adapters: ReadonlyMap<string, OpenInAdapter>;

  constructor(adapters: readonly OpenInAdapter[]) {
    this.adapters = new Map(adapters.map((a) => [a.id, a]));
  }

  /** Metadata + detection status for every registered app, in registration order. */
  list(): OpenInAppStatus[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      iconKey: a.iconKey,
      detected: a.detect(),
    }));
  }

  /** Dispatch a launch to the adapter for {@link appId}. Rejects for unknown ids. */
  async launch(appId: string, target: LaunchTarget): Promise<void> {
    const adapter = this.adapters.get(appId);
    if (!adapter) {
      throw new Error(`Unknown open-in app: ${appId}`);
    }
    await adapter.launch(target);
  }
}
