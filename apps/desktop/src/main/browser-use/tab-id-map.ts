/**
 * Bidirectional map between bridge-tracked **integer** tab ids (which Codex
 * sees on the wire) and Mcode-internal `(threadId, opaqueTabId)` pairs.
 *
 * dpcode's pipe server keeps two maps (`trackedTabByKey`, `trackedTabById`)
 * plus a counter; this module isolates that bookkeeping behind a focused API
 * so the router and tests can exercise it without touching network code.
 */

export interface TrackedTab {
  readonly id: number;
  readonly threadId: string;
  readonly tabId: string;
}

export class TabIdMap {
  private byKey = new Map<string, TrackedTab>();
  private byId = new Map<number, TrackedTab>();
  private nextId = 1;

  private static keyOf(threadId: string, tabId: string): string {
    return JSON.stringify([threadId, tabId]);
  }

  /**
   * Look up or assign an integer id for the given pair. Stable across calls -
   * a tab keeps the same integer for the lifetime of this map.
   */
  track(threadId: string, tabId: string): TrackedTab {
    const key = TabIdMap.keyOf(threadId, tabId);
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const tracked: TrackedTab = { id: this.nextId++, threadId, tabId };
    this.byKey.set(key, tracked);
    this.byId.set(tracked.id, tracked);
    return tracked;
  }

  /** Resolve by the integer id the wire client uses; null when unknown. */
  byTrackedId(id: number): TrackedTab | null {
    return this.byId.get(id) ?? null;
  }

  /** Drop a host-side tab; called when a tab is closed so ids are reclaimable. */
  untrack(threadId: string, tabId: string): void {
    const key = TabIdMap.keyOf(threadId, tabId);
    const tracked = this.byKey.get(key);
    if (!tracked) return;
    this.byKey.delete(key);
    this.byId.delete(tracked.id);
  }
}
