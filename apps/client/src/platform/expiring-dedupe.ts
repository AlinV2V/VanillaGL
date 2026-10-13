/** Time-window dedupe whose storage remains proportional to recent activity. */
export class ExpiringDedupe {
  private readonly seen = new Map<string, number>();
  private lastPrune = 0;

  constructor(private readonly duplicateWindowMs: number, private readonly retentionMs: number) {}

  accept(key: string, now = performance.now()): boolean {
    const previous = this.seen.get(key) ?? Number.NEGATIVE_INFINITY;
    if (now - previous < this.duplicateWindowMs) return false;
    this.seen.set(key, now);
    if (now - this.lastPrune >= Math.min(this.retentionMs, 5000) || this.seen.size > 1024) {
      const cutoff = now - this.retentionMs;
      for (const [candidate, at] of this.seen) if (at < cutoff) this.seen.delete(candidate);
      this.lastPrune = now;
    }
    return true;
  }

  clear(): void { this.seen.clear(); this.lastPrune = 0; }
  get size(): number { return this.seen.size; }
}
