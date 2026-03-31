/**
 * Simple Map-based LRU cache.
 * Map iteration order is insertion order, so deleting and re-inserting
 * a key on access moves it to the "most recently used" end.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  /** Retrieve a value, returning undefined on miss. Refreshes access order on hit. */
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Insert or update a key. Evicts the least recently used entry if at capacity. */
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Map.keys().next() returns the oldest (least recently used) key
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  /** Remove all entries. */
  clear(): void {
    this.map.clear();
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.map.size;
  }
}
