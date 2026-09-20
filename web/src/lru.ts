/** A cache that keeps the most recently used entries and drops the oldest when it is full. */
export class LruCache<K, V> {
  private readonly items = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a whole number of at least 1');
    this.capacity = capacity;
  }

  get size(): number {
    return this.items.size;
  }

  /** The value for a key, which then counts as the most recently used. */
  get(key: K): V | undefined {
    if (!this.items.has(key)) return undefined;
    const value = this.items.get(key) as V;
    this.items.delete(key);
    this.items.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.capacity) {
      this.items.delete(this.items.keys().next().value as K);
    }
  }
}
