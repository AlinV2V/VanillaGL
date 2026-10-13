import type { WorldDelta } from '../protocol/world-delta';

type StampedDelta = { sequence: number; delta: WorldDelta };
const MAX_STATE_DELTAS = 32_768;
const MAX_LIFECYCLE_DELTAS = 8_192;

/** Coalesces authoritative state while preserving create/remove barriers and their exact order. */
export class PendingWorldDeltas {
  private readonly lifecycle: StampedDelta[] = [];
  private readonly state = new Map<string, StampedDelta>();
  private readonly revisions = new Map<string, number>();
  private sequence = 0;
  private coalesced = 0;
  private emergencyFlushes = 0;
  private peak = 0;
  private scratch: StampedDelta[] | null = [];

  get size(): number { return this.lifecycle.length + this.state.size; }
  get atCapacity(): boolean {
    return this.lifecycle.length >= MAX_LIFECYCLE_DELTAS || this.state.size >= MAX_STATE_DELTAS;
  }

  enqueue(delta: WorldDelta): void {
    const sequence = ++this.sequence;
    if (delta.kind === 'entity-create' || delta.kind === 'entity-remove') {
      const guid = delta.kind === 'entity-create' ? delta.entity.guid : delta.guid;
      this.revisions.set(guid, (this.revisions.get(guid) ?? 0) + 1);
      this.lifecycle.push({ sequence, delta });
    } else {
      const revision = this.revisions.get(delta.guid) ?? 0;
      const key = `${delta.guid}:${revision}:${delta.kind}`;
      if (this.state.has(key)) this.coalesced++;
      this.state.set(key, { sequence, delta });
    }
    this.peak = Math.max(this.peak, this.size);
  }

  drain(apply: (delta: WorldDelta) => void): void {
    if (this.size === 0) return;
    const pending = this.scratch ?? [];
    this.scratch = null; // A reentrant drain must not overwrite the current batch.
    for (const entry of this.lifecycle) pending.push(entry);
    for (const entry of this.state.values()) pending.push(entry);
    pending.sort((a, b) => a.sequence - b.sequence);
    this.lifecycle.length = 0;
    this.state.clear();
    this.revisions.clear();
    try { for (const entry of pending) apply(entry.delta); }
    finally { pending.length = 0; this.scratch = pending; }
  }

  noteEmergencyFlush(): void { this.emergencyFlushes++; }

  clear(): void {
    this.lifecycle.length = 0;
    this.state.clear();
    this.revisions.clear();
  }

  diagnostics() {
    return { pending: this.size, lifecycle: this.lifecycle.length, state: this.state.size, peak: this.peak, coalesced: this.coalesced, emergencyFlushes: this.emergencyFlushes };
  }
}
