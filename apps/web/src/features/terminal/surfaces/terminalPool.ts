import type { TerminalInstance } from "@/features/terminal/state/terminalStore";

/** Flattened entry for the persistent terminal pool. */
export interface TerminalPoolEntry {
  readonly term: TerminalInstance;
  readonly ownerThreadId: string;
}

/**
 * Selector that flattens `terminals` into a stable array of pool entries.
 * Returns the same reference when the underlying `terminals` map has not
 * changed, avoiding unnecessary re-renders of the pool container.
 */
let _prevTerminals: Record<string, readonly TerminalInstance[]> | null = null;
let _cachedPool: readonly TerminalPoolEntry[] = [];

/** Zustand selector for the app-wide terminal pool. */
export function selectTerminalPool(s: {
  terminals: Record<string, readonly TerminalInstance[]>;
}): readonly TerminalPoolEntry[] {
  if (s.terminals === _prevTerminals) return _cachedPool;
  _prevTerminals = s.terminals;
  const entries: TerminalPoolEntry[] = [];
  for (const [tid, instances] of Object.entries(s.terminals)) {
    for (const term of instances) {
      entries.push({ term, ownerThreadId: tid });
    }
  }
  _cachedPool = entries;
  return _cachedPool;
}
