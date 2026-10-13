/** Single-flight ownership for work that should be shared only while it is unresolved. */
export class PendingPromiseCache<K, V> {
  private readonly entries = new Map<K, Promise<V>>();

  get size(): number { return this.entries.size; }

  getOrCreate(key: K, create: () => Promise<V>): Promise<V> {
    const existing = this.entries.get(key);
    if (existing) return existing;
    let promise!: Promise<V>;
    promise = Promise.resolve().then(create).finally(() => {
      if (this.entries.get(key) === promise) this.entries.delete(key);
    });
    this.entries.set(key, promise);
    return promise;
  }

  clear(): void { this.entries.clear(); }
}
