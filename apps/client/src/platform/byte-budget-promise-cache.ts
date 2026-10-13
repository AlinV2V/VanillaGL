type CacheEntry<V> = { promise: Promise<V>; bytes: number };

/** Budget estimate, not a browser heap measurement: 8-byte slots, UTF-16 strings, 32-byte containers.
 * Binary buffers count once. Ordinary JSON arrays/metadata must also consume the budget.
 */
export function estimateDecodedBytes(value: unknown): number {
  const buffers = new Set<ArrayBufferLike>();
  const objects = new Set<object>();
  const visit = (next: unknown): number => {
    if (next == null) return 0;
    if (typeof next === 'string') return 16 + next.length * 2;
    if (typeof next !== 'object') return typeof next === 'number' || typeof next === 'boolean' ? 8 : 0;
    const buffer = ArrayBuffer.isView(next) ? next.buffer
      : next instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && next instanceof SharedArrayBuffer) ? next : null;
    if (buffer) {
      if (buffers.has(buffer)) return 0;
      buffers.add(buffer);
      return buffer.byteLength; // Even zero/previously counted views must never enumerate their elements.
    }
    const object = next as object;
    if (objects.has(object)) return 0;
    objects.add(object);
    if (Array.isArray(next)) {
      let bytes = 32 + next.length * 8;
      for (const item of next) if (item != null && (typeof item === 'object' || typeof item === 'string')) bytes += visit(item);
      return bytes;
    }
    let bytes = 32;
    for (const key in next) if (Object.prototype.hasOwnProperty.call(next, key)) {
      bytes += 8 + key.length * 2 + visit((next as Record<string, unknown>)[key]);
    }
    return bytes;
  };
  return visit(value);
}

/** LRU for async decoded assets. Eviction drops cache ownership; live render objects remain valid. */
export class ByteBudgetPromiseCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private bytes = 0;
  private peakBytes = 0;
  private evictions = 0;

  constructor(
    readonly maxBytes: number,
    readonly maxEntries: number,
    private readonly estimate: (value: V) => number = estimateDecodedBytes,
  ) {}

  get size(): number { return this.entries.size; }

  get(key: K): Promise<V> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.promise;
  }

  set(key: K, promise: Promise<V>): void {
    this.delete(key);
    const entry: CacheEntry<V> = { promise, bytes: 0 };
    this.entries.set(key, entry);
    void promise.then((value) => {
      if (this.entries.get(key) !== entry) return;
      entry.bytes = Math.max(0, this.estimate(value));
      this.bytes += entry.bytes;
      this.peakBytes = Math.max(this.peakBytes, this.bytes);
      this.trim();
    }, () => {
      if (this.entries.get(key) === entry) this.delete(key);
    });
    this.trim();
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes = Math.max(0, this.bytes - entry.bytes);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  diagnostics() {
    return { entries: this.entries.size, bytes: this.bytes, peakBytes: this.peakBytes, evictions: this.evictions };
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
      this.evictions++;
    }
  }
}
