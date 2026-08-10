/**
 * Simple Map-based LRU cache.
 * Map iteration order is insertion order, so deleting and re-inserting
 * a key on access moves it to the "most recently used" end.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private capacity: number;

  /**
   * @param capacity Maximum number of entries to hold. Clamped to a minimum of 1.
   */
  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  /** Retrieve a value, returning undefined on miss. Refreshes access order on hit. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Insert or update a key. Evicts the least recently used entry if at capacity. */
  set(key: K, value: V): K | null {
    let evicted: K | null = null;
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Map.keys().next() returns the oldest (least recently used) key
      evicted = this.map.keys().next().value as K;
      this.map.delete(evicted);
    }
    this.map.set(key, value);
    return evicted;
  }

  /**
   * Change the capacity. Clamped to a minimum of 1.
   * When shrinking, evicts the least-recently-used entries until size <= capacity
   * and returns the evicted keys in eviction order (oldest-first).
   * When growing or unchanged, returns an empty array.
   */
  resize(capacity: number): K[] {
    this.capacity = Math.max(1, capacity);
    const evicted: K[] = [];
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
      evicted.push(oldest);
    }
    return evicted;
  }

  /** Remove all entries. */
  clear(): void {
    this.map.clear();
  }

  /** Check if a key exists without refreshing access order. */
  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Return entries in least-recently-used order without changing recency. */
  entries(): Array<[K, V]> {
    return [...this.map.entries()];
  }

  /** Return keys in least-recently-used order without changing recency. */
  keys(): K[] {
    return [...this.map.keys()];
  }

  /** Remove an entry. Returns true if the key existed, false otherwise. */
  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.map.size;
  }
}
