import { inject, injectable } from "tsyringe";
import type {
  ProviderCapabilityEntry,
  ProviderCatalogChange,
  ProviderCatalogContext,
  ProviderCatalogRequest,
  ProviderCatalogSnapshot,
  ProviderCapabilityKind,
  SelectableProviderAgent,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { ProviderCatalogSnapshotRepo } from "./persistence/provider-catalog-snapshot-repo.js";

/** Inputs for one stale-while-revalidate provider catalog request. */
export interface ProviderCatalogLoadInput {
  readonly request: ProviderCatalogRequest;
  readonly context: ProviderCatalogContext;
  readonly cwd?: string;
  readonly fallbackCwd?: string;
  readonly refresh: () => Promise<ProviderCatalogSnapshot | ProviderCatalogPartialRefresh>;
  readonly refreshFromCache?: () => Promise<ProviderCatalogSnapshot>;
}

/** Stale snapshot plus the entry kinds that were authoritatively refreshed. */
export interface ProviderCatalogPartialRefresh {
  readonly snapshot: ProviderCatalogSnapshot;
  readonly confirmedEntryKinds: readonly ProviderCapabilityKind[];
}

const MAX_TRACKED_CATALOG_CONTEXTS = 64;
const MAX_INFLIGHT_CATALOG_REFRESHES = 64;

interface CatalogRefreshSubscriber {
  readonly visible: ProviderCatalogSnapshot;
  readonly input: ProviderCatalogLoadInput;
}

interface CatalogRefreshJob {
  readonly refresh: ProviderCatalogLoadInput["refresh"];
  readonly subscribers: Map<string, CatalogRefreshSubscriber>;
  readonly pendingSubscribers: Map<string, CatalogRefreshSubscriber>;
}

function applyConfirmedEntryKinds(
  visible: ProviderCatalogSnapshot,
  refreshed: ProviderCatalogSnapshot,
  confirmedEntryKinds: readonly ProviderCapabilityKind[],
): ProviderCatalogSnapshot {
  const confirmed = new Set(confirmedEntryKinds);
  const refreshedByIdentity = new Map(
    refreshed.entries.map((entry) => [capabilityIdentity(entry), entry]),
  );
  const entries = visible.entries.flatMap((entry) => {
    if (!confirmed.has(entry.kind)) return [entry];
    const updated = refreshedByIdentity.get(capabilityIdentity(entry));
    return updated ? [updated] : [];
  });
  const retainedIdentities = new Set(entries.map(capabilityIdentity));
  entries.push(...refreshed.entries.filter((entry) => (
    confirmed.has(entry.kind) && !retainedIdentities.has(capabilityIdentity(entry))
  )));
  return {
    ...visible,
    diagnostics: refreshed.diagnostics,
    freshness: refreshed.freshness,
    entries,
  };
}

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

function scopeSnapshot(
  snapshot: ProviderCatalogSnapshot,
  providerId: ProviderCatalogRequest["providerId"],
  context: ProviderCatalogContext,
): ProviderCatalogSnapshot {
  return {
    ...snapshot,
    providerId,
    context,
    diagnostics: snapshot.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      providerId,
      context,
    })),
  };
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

function providerCatalogRequestKey(
  request: ProviderCatalogRequest,
  cwd?: string,
): string {
  return JSON.stringify([
    request.providerId,
    request.workspaceId ?? null,
    request.threadId ?? null,
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
    diagnostics: (snapshot?.diagnostics ?? []).map((diagnostic) => ({
      ...diagnostic,
      providerId: request.providerId,
      context,
    })),
    entries: snapshot?.entries ?? [],
    selectableAgents: snapshot?.selectableAgents ?? [],
  };
}

function capacitySnapshot(snapshot: ProviderCatalogSnapshot): ProviderCatalogSnapshot {
  return {
    ...snapshot,
    diagnostics: [{
      providerId: snapshot.providerId,
      context: snapshot.context,
      sourceKind: "providerCatalog",
      rejectedSource: "refresh capacity",
      severity: "warning",
      code: "source-unavailable",
      message: "Provider catalog refresh capacity is full for this context. Try again shortly.",
    }],
    freshness: {
      status: "stale",
      fetchedAt: snapshot.freshness.fetchedAt,
      reason: "Provider catalog refresh capacity is full.",
    },
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
  private readonly inflight = new Map<string, CatalogRefreshJob>();
  private readonly trackedContexts = new Map<string, ProviderCatalogLoadInput>();
  private readonly changedHandlers = new Set<(change: ProviderCatalogChange) => void>();

  constructor(
    @inject(ProviderCatalogSnapshotRepo)
    private readonly snapshotRepo: ProviderCatalogSnapshotRepo,
  ) {}

  /** Returns cached state immediately and starts one background refresh for the context. */
  request(input: ProviderCatalogLoadInput): ProviderCatalogSnapshot {
    const persistenceKey = providerCatalogContextKey(input.request, input.cwd);
    const requestKey = providerCatalogRequestKey(input.request, input.cwd);
    const fallbackRequest = { ...input.request, threadId: undefined };
    const fallbackKey = input.fallbackCwd === undefined
      ? undefined
      : providerCatalogContextKey(fallbackRequest, input.fallbackCwd);
    const persisted = this.snapshotRepo.get(persistenceKey)
      ?? (fallbackKey && fallbackKey !== persistenceKey ? this.snapshotRepo.get(fallbackKey) : null);
    const visible = staleSnapshot(persisted, input.request, input.context);
    if (!this.rememberContext(requestKey, input)) return capacitySnapshot(visible);
    if (!this.scheduleRefresh(requestKey, persistenceKey, visible, input, false)) {
      return capacitySnapshot(visible);
    }
    return visible;
  }

  /** Subscribes to completed refresh changes. */
  onChanged(handler: (change: ProviderCatalogChange) => void): () => void {
    this.changedHandlers.add(handler);
    return () => this.changedHandlers.delete(handler);
  }

  /** Reconciles requested contexts after a provider-native background change signal. */
  refreshKnownContexts(providerId: string, cwd?: string): void {
    const queueByPersistenceKey = new Map<string, boolean>();
    for (const [requestKey, input] of this.trackedContexts) {
      if (
        input.request.providerId !== providerId
        || input.cwd !== cwd
        || !input.refreshFromCache
      ) {
        continue;
      }
      const persistenceKey = providerCatalogContextKey(input.request, input.cwd);
      const queueIfInflight = queueByPersistenceKey.get(persistenceKey)
        ?? this.inflight.has(persistenceKey);
      queueByPersistenceKey.set(persistenceKey, queueIfInflight);
      const persisted = this.snapshotRepo.get(persistenceKey);
      const visible = staleSnapshot(persisted, input.request, input.context);
      const scheduled = this.scheduleRefresh(
        requestKey,
        persistenceKey,
        visible,
        { ...input, refresh: input.refreshFromCache },
        queueIfInflight,
      );
      if (!scheduled) this.emitChange(catalogChange(input.request, visible, capacitySnapshot(visible)));
    }
  }

  private rememberContext(key: string, input: ProviderCatalogLoadInput): boolean {
    if (
      !this.trackedContexts.has(key)
      && this.trackedContexts.size >= MAX_TRACKED_CATALOG_CONTEXTS
    ) {
      let oldestInactive: string | undefined;
      for (const candidate of this.trackedContexts.keys()) {
        const active = [...this.inflight.values()].some((job) => (
          job.subscribers.has(candidate) || job.pendingSubscribers.has(candidate)
        ));
        if (!active) {
          oldestInactive = candidate;
          break;
        }
      }
      if (oldestInactive === undefined) return false;
      this.trackedContexts.delete(oldestInactive);
    }
    this.trackedContexts.delete(key);
    this.trackedContexts.set(key, input);
    return true;
  }

  private scheduleRefresh(
    requestKey: string,
    persistenceKey: string,
    visible: ProviderCatalogSnapshot,
    input: ProviderCatalogLoadInput,
    queueIfInflight: boolean,
  ): boolean {
    const subscriber = { visible, input } satisfies CatalogRefreshSubscriber;
    const currentJob = this.inflight.get(persistenceKey);
    if (currentJob) {
      const subscribers = queueIfInflight
        ? currentJob.pendingSubscribers
        : currentJob.subscribers;
      subscribers.set(requestKey, subscriber);
      return true;
    }
    if (this.inflight.size >= MAX_INFLIGHT_CATALOG_REFRESHES) return false;
    const job: CatalogRefreshJob = {
      refresh: input.refresh,
      subscribers: new Map([[requestKey, subscriber]]),
      pendingSubscribers: new Map(),
    };
    this.inflight.set(persistenceKey, job);
    void new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.refresh(persistenceKey, job).finally(resolve);
      });
    }).finally(() => {
      this.inflight.delete(persistenceKey);
      for (const [pendingRequestKey, pending] of job.pendingSubscribers) {
        const persisted = this.snapshotRepo.get(persistenceKey);
        const pendingVisible = staleSnapshot(
          persisted,
          pending.input.request,
          pending.input.context,
        );
        this.scheduleRefresh(
          pendingRequestKey,
          persistenceKey,
          pendingVisible,
          pending.input,
          false,
        );
      }
    });
    return true;
  }

  private emitChange(change: ProviderCatalogChange): void {
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

  private async refresh(
    persistenceKey: string,
    job: CatalogRefreshJob,
  ): Promise<void> {
    let refreshed: ProviderCatalogSnapshot;
    let confirmedEntryKinds: readonly ProviderCapabilityKind[] | undefined;
    try {
      const result = await job.refresh();
      if ("snapshot" in result) {
        refreshed = result.snapshot;
        confirmedEntryKinds = result.confirmedEntryKinds;
      } else {
        refreshed = result;
      }
    } catch (error) {
      const firstSubscriber = job.subscribers.values().next().value as
        | CatalogRefreshSubscriber
        | undefined;
      if (!firstSubscriber) return;
      logger.warn("Provider catalog background refresh failed", {
        providerId: firstSubscriber.input.request.providerId,
        workspaceId: firstSubscriber.input.request.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      refreshed = {
        ...firstSubscriber.visible,
        diagnostics: [{
          providerId: firstSubscriber.input.request.providerId,
          context: firstSubscriber.input.context,
          sourceKind: "providerCatalog",
          rejectedSource: "background refresh",
          severity: "warning",
          code: "source-unavailable",
          message: "The provider catalog is temporarily unavailable for this context.",
        }],
        freshness: {
          status: "stale",
          fetchedAt: firstSubscriber.visible.freshness.fetchedAt,
          reason: "Provider catalog refresh failed.",
        },
      };
    }

    let persisted = false;
    for (const { visible, input } of job.subscribers.values()) {
      const next = refreshed.freshness.status === "fresh"
        ? scopeSnapshot(refreshed, input.request.providerId, input.context)
        : confirmedEntryKinds
          ? scopeSnapshot(
              applyConfirmedEntryKinds(visible, refreshed, confirmedEntryKinds),
              input.request.providerId,
              input.context,
            )
          : scopeSnapshot({
              ...visible,
              diagnostics: refreshed.diagnostics,
              freshness: refreshed.freshness,
            }, input.request.providerId, input.context);
      if (!persisted) {
        const workspaceExists = this.snapshotRepo.upsert(
          persistenceKey,
          input.request.workspaceId,
          input.cwd,
          next,
        );
        if (!workspaceExists) return;
        persisted = true;
      }
      const change = catalogChange(input.request, visible, next);
      this.emitChange(change);
    }
  }
}
