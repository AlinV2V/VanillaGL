export type Cooldown = {
  start: number;
  durationMs: number;
};

export class CooldownStore {
  private readonly map = new Map<number, Cooldown>();

  start(spellId: number, durationMs: number, now = performance.now()) {
    if (!spellId || durationMs <= 0) {
      this.map.delete(spellId);
      return;
    }
    const existing = this.map.get(spellId);
    if (existing && existing.start + existing.durationMs > now + durationMs) return;
    this.map.set(spellId, { start: now, durationMs });
  }

  clear(spellId: number) {
    this.map.delete(spellId);
  }

  clearAll() {
    this.map.clear();
  }

  get(spellId: number, now = performance.now()): Cooldown | undefined {
    const cooldown = this.map.get(spellId);
    if (!cooldown) return undefined;
    if (cooldown.start + cooldown.durationMs <= now) {
      this.map.delete(spellId);
      return undefined;
    }
    return cooldown;
  }

  remaining(spellId: number, now = performance.now()): number {
    const cooldown = this.get(spellId, now);
    return cooldown ? Math.max(0, cooldown.start + cooldown.durationMs - now) : 0;
  }
}
