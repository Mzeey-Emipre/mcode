/**
 * Pure Memory Saver discard policy for the embedded preview (ADR 0002).
 *
 * Decides which warm preview tabs to discard given the current warm set, which
 * tab is active, whether the panel is visible, the clock, and the tunable
 * thresholds. No Electron or session state: callers map the result back to
 * concrete tabs and dispose them.
 */

/** A warm (live-renderer) preview tab considered for discard. */
export interface WarmTabRef {
  /** Stable tab id (unique across threads). */
  readonly tabId: string;
  /** Owning thread id. */
  readonly threadId: string;
  /** Epoch ms when the tab was last activated; drives LRU ordering. */
  readonly lastActiveAt: number;
}

/** Tunable thresholds, sourced from `preview.memorySaver.*` settings. */
export interface DiscardConfig {
  /** Most-recently-used warm tabs kept when the panel is hidden. */
  readonly maxWarm: number;
  /** Idle ms before a background tab is discarded while the panel is visible. */
  readonly bgIdleMs: number;
  /** Idle ms an overflow tab must exceed before it is trimmed when hidden. */
  readonly hiddenIdleMs: number;
}

/**
 * Returns the ids of warm tabs to discard. See ADR 0002:
 * - Visible: active tab protected, no count cap, background tabs dropped after `bgIdleMs`.
 * - Hidden: active loses protection; warm set trimmed to the `maxWarm` MRU tabs,
 *   each overflow tab dropped once idle past `hiddenIdleMs`.
 *
 * Pure: never mutates its inputs.
 */
export function selectTabsToDiscard(
  warmTabs: readonly WarmTabRef[],
  activeThreadId: string | null,
  activeTabId: string | null,
  visible: boolean,
  now: number,
  config: DiscardConfig,
): string[] {
  const isActive = (t: WarmTabRef): boolean =>
    activeThreadId !== null &&
    activeTabId !== null &&
    t.threadId === activeThreadId &&
    t.tabId === activeTabId;

  if (visible) {
    return warmTabs
      .filter((t) => !isActive(t) && now - t.lastActiveAt >= config.bgIdleMs)
      .map((t) => t.tabId);
  }

  // Hidden: rank by recency, keep the top `maxWarm`, discard the idle overflow.
  const byMru = [...warmTabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const overflow = byMru.slice(Math.max(0, config.maxWarm));
  return overflow
    .filter((t) => now - t.lastActiveAt >= config.hiddenIdleMs)
    .map((t) => t.tabId);
}
