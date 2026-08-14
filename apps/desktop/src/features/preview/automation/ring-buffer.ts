/** A bounded oldest-first buffer used for browser diagnostics and action history. */
export class OldestFirstRingBuffer<T> {
  private readonly entries: T[] = [];
  private evictedEntries = 0;

  constructor(private readonly capacity: number) {}

  /** Appends one value and evicts the oldest when full. */
  push(value: T): void {
    if (this.entries.length === this.capacity) {
      this.entries.shift();
      this.evictedEntries += 1;
    }
    this.entries.push(value);
  }

  /** Returns the newest requested entries in chronological order. */
  read(limit = this.capacity): T[] {
    return this.entries.slice(-Math.max(0, Math.min(limit, this.capacity)));
  }

  /** Clears every retained value. */
  clear(): void {
    this.entries.length = 0;
    this.evictedEntries = 0;
  }

  /** Returns the number of retained values. */
  get size(): number {
    return this.entries.length;
  }

  /** Returns how many oldest entries were discarded since the last clear. */
  get evicted(): number {
    return this.evictedEntries;
  }
}
