import { inject, injectable } from "tsyringe";
import type {
  ProviderCapabilityEntry,
  ProviderCatalogChange,
  ProviderCatalogContext,
  ProviderCatalogRequest,
  ProviderCatalogSnapshot,
  SelectableProviderAgent,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { ProviderCatalogSnapshotRepo } from "../repositories/provider-catalog-snapshot-repo.js";

/** Inputs for one stale-while-revalidate provider catalog request. */
export interface ProviderCatalogLoadInput {
  readonly request: ProviderCatalogRequest;
  readonly context: ProviderCatalogContext;
  readonly cwd?: string;
  readonly fallbackCwd?: string;
  readonly refresh: () => Promise<ProviderCatalogSnapshot>;
  readonly refreshFromCache?: () => Promise<ProviderCatalogSnapshot>;
}

const MAX_TRACKED_CATALOG_CONTEXTS = 64;

function capabilityIdentity(entry: ProviderCapabilityEntry): string {
  const { providerId, kind, nativeId } = entry.identity;
  return JSON.stringify([providerId, kind, nativeId]);
}

function agentIdentity(agent: SelectableProviderAgent): string {
  return JSON.stringify([agent.providerId, agent.nativeId]);
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Builds a stable persistence key for a provider and realized working directory. */
export function providerCatalogContextKey(
  request: ProviderCatalogRequest,
  cwd?: string,
): string {
  return JSON.stringify([
    request.providerId,
    request.workspaceId ?? null,
    cwd?.replace(/\\/g, "/") ?? null,
  ]);
}

function staleSnapshot(
  snapshot: ProviderCatalogSnapshot | null,
  request: ProviderCatalogRequest,
  context: ProviderCatalogContext,
): ProviderCatalogSnapshot {
  const fetchedAt = snapshot?.freshness.fetchedAt ?? new Date().toISOString();
  return {
    providerId: request.providerId,
    context,
    freshness: {
      status: "stale",
      fetchedAt,
      reason: snapshot
        ? "Refreshing the last confirmed provider catalog."
        : "The provider catalog has not been confirmed yet.",
    },
    diagnostics: snapshot?.diagnostics ?? [],
    entries: snapshot?.entries ?? [],
    selectableAgents: snapshot?.selectableAgents ?? [],
  };
}

function reconcileEntries(
  previous: ProviderCatalogSnapshot,
  next: ProviderCatalogSnapshot,
): Pick<ProviderCatalogChange, "additions" | "updates" | "removals"> {
  const previousById = new Map(previous.entries.map((entry) => [capabilityIdentity(entry), entry]));
  const nextById = new Map(next.entries.map((entry) => [capabilityIdentity(entry), entry]));
  return {
    additions: next.entries.filter((entry) => !previousById.has(capabilityIdentity(entry))),
    updates: next.entries.filter((entry) => {
      const oldEntry = previousById.get(capabilityIdentity(entry));
      return oldEntry !== undefined && !equal(oldEntry, entry);
    }),
    removals: previous.entries
      .filter((entry) => !nextById.has(capabilityIdentity(entry)))
      .map((entry) => entry.identity),
  };
}

function reconcileAgents(
  previous: ProviderCatalogSnapshot,
  next: ProviderCatalogSnapshot,
): ProviderCatalogChange["selectableAgents"] {
  const previousById = new Map(previous.selectableAgents.map((agent) => [agentIdentity(agent), agent]));
  const nextById = new Map(next.selectableAgents.map((agent) => [agentIdentity(agent), agent]));
  return {
    additions: next.selectableAgents.filter((agent) => !previousById.has(agentIdentity(agent))),
    updates: next.selectableAgents.filter((agent) => {
      const oldAgent = previousById.get(agentIdentity(agent));
      return oldAgent !== undefined && !equal(oldAgent, agent);
    }),
    removals: previous.selectableAgents
      .filter((agent) => !nextById.has(agentIdentity(agent)))
      .map((agent) => agent.nativeId),
  };
}

function catalogChange(
  request: ProviderCatalogRequest,
  previous: ProviderCatalogSnapshot,
  next: ProviderCatalogSnapshot,
): ProviderCatalogChange {
  return {
    request,
    ...reconcileEntries(previous, next),
    selectableAgents: reconcileAgents(previous, next),
    ...(!equal(previous.diagnostics, next.diagnostics) ? { diagnostics: next.diagnostics } : {}),
    ...(!equal(previous.freshness, next.freshness) ? { freshness: next.freshness } : {}),
  };
}

/** Coordinates persisted snapshots, background refresh, and incremental catalog changes. */
@injectable()
export class ProviderCatalogService {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly trackedContexts = new Map<string, ProviderCatalogLoadInput>();
  private readonly changedHandlers = new Set<(change: ProviderCatalogChange) => void>();

  constructor(
    @inject(ProviderCatalogSnapshotRepo)
    private readonly snapshotRepo: ProviderCatalogSnapshotRepo,
  ) {}

  /** Returns cached state immediately and starts one background refresh for the context. */
  request(input: ProviderCatalogLoadInput): ProviderCatalogSnapshot {
    const key = providerCatalogContextKey(input.request, input.cwd);
    const fallbackRequest = { ...input.request, threadId: undefined };
    const fallbackKey = input.fallbackCwd === undefined
      ? undefined
      : providerCatalogContextKey(fallbackRequest, input.fallbackCwd);
    const persisted = this.snapshotRepo.get(key)
      ?? (fallbackKey && fallbackKey !== key ? this.snapshotRepo.get(fallbackKey) : null);
    const visible = staleSnapshot(persisted, input.request, input.context);
    this.rememberContext(key, input);
    this.scheduleRefresh(key, visible, input);
    return visible;
  }

  /** Subscribes to completed refresh changes. */
  onChanged(handler: (change: ProviderCatalogChange) => void): () => void {
    this.changedHandlers.add(handler);
    return () => this.changedHandlers.delete(handler);
  }

  /** Reconciles requested contexts after a provider-native background change signal. */
  refreshKnownContexts(providerId: string, cwd?: string): void {
    for (const [key, input] of this.trackedContexts) {
      if (
        input.request.providerId !== providerId
        || input.cwd !== cwd
        || !input.refreshFromCache
      ) {
        continue;
      }
      const persisted = this.snapshotRepo.get(key);
      const visible = staleSnapshot(persisted, input.request, input.context);
      this.scheduleRefresh(key, visible, { ...input, refresh: input.refreshFromCache });
    }
  }

  private rememberContext(key: string, input: ProviderCatalogLoadInput): void {
    this.trackedContexts.delete(key);
    this.trackedContexts.set(key, input);
    while (this.trackedContexts.size > MAX_TRACKED_CATALOG_CONTEXTS) {
      const oldest = this.trackedContexts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.trackedContexts.delete(oldest);
    }
  }

  private scheduleRefresh(
    key: string,
    visible: ProviderCatalogSnapshot,
    input: ProviderCatalogLoadInput,
  ): void {
    if (this.inflight.has(key)) return;
    const refresh = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.refresh(key, visible, input).finally(resolve);
      });
    }).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, refresh);
  }

  private async refresh(
    key: string,
    visible: ProviderCatalogSnapshot,
    input: ProviderCatalogLoadInput,
  ): Promise<void> {
    let refreshed: ProviderCatalogSnapshot;
    try {
      refreshed = await input.refresh();
    } catch (error) {
      logger.warn("Provider catalog background refresh failed", {
        providerId: input.request.providerId,
        workspaceId: input.request.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      refreshed = {
        ...visible,
        diagnostics: [{
          severity: "warning",
          code: "source-unavailable",
          message: "The provider catalog is temporarily unavailable for this context.",
        }],
        freshness: {
          status: "stale",
          fetchedAt: visible.freshness.fetchedAt,
          reason: "Provider catalog refresh failed.",
        },
      };
    }

    const next = refreshed.freshness.status === "fresh"
      ? { ...refreshed, context: input.context }
      : {
          ...visible,
          diagnostics: refreshed.diagnostics,
          freshness: refreshed.freshness,
        };
    this.snapshotRepo.upsert(key, input.request.workspaceId, input.cwd, next);
    const change = catalogChange(input.request, visible, next);
    for (const handler of this.changedHandlers) {
      try {
        handler(change);
      } catch (error) {
        logger.debug("Provider catalog change subscriber failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
