import * as THREE from 'three';
import { createParticleGeometry } from './particle-geometry';

type Buffers = ReturnType<typeof createParticleGeometry>;
type Entry = { key: string; buffers: Buffers; bytes: number };
export type EffectBufferLease = Buffers & { release(): void };

function createRibbonGeometry(edges: number): Buffers {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edges * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const uv = new Float32Array(edges * 2 * 2);
  for (let i = 0; i < edges; i++) {
    const u = i / (edges - 1);
    uv[i * 4] = u; uv[i * 4 + 1] = 0; uv[i * 4 + 2] = u; uv[i * 4 + 3] = 1;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
  const indices: number[] = [];
  for (let i = 0; i < edges - 1; i++) {
    const a = i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geometry.setIndex(indices); geometry.setDrawRange(0, 0);
  return { geometry, copies: 2 };
}

/** Mutable emitter buffers have one live owner; only retired buffers may be reused. */
export class EffectBufferPool {
  private readonly idle = new Set<Entry>();
  private idleBytes = 0;
  private live = 0;
  private created = 0;
  private reused = 0;

  constructor(private readonly maxBytes = 4 * 1024 * 1024, private readonly maxIdle = 64) {}

  acquireParticles(capacity: number): EffectBufferLease {
    return this.acquire(`particles:${capacity}`, () => createParticleGeometry(capacity));
  }

  acquireRibbon(edges: number): EffectBufferLease {
    return this.acquire(`ribbon:${edges}`, () => createRibbonGeometry(edges));
  }

  private acquire(key: string, create: () => Buffers): EffectBufferLease {
    let entry: Entry | undefined;
    for (const candidate of this.idle) if (candidate.key === key) { entry = candidate; break; }
    if (entry) {
      this.idle.delete(entry); this.idleBytes -= entry.bytes; this.reused++;
    } else {
      const buffers = create();
      const bytes = Object.values(buffers.geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0)
        + (buffers.geometry.index?.array.byteLength ?? 0);
      entry = { key, buffers, bytes }; this.created++;
    }
    this.live++;
    const owned = entry;
    let released = false;
    return { ...owned.buffers, release: () => {
      if (released) return; released = true; this.live--;
      const geometry = owned.buffers.geometry;
      geometry.setDrawRange(0, 0);
      if (geometry instanceof THREE.InstancedBufferGeometry) geometry.instanceCount = 0;
      // Drop the old emitter's bounds; the next owner installs its own sphere.
      geometry.boundingSphere = null;
      this.idle.add(owned); this.idleBytes += owned.bytes;
      while (this.idle.size > this.maxIdle || this.idleBytes > this.maxBytes) this.discard(this.idle.values().next().value!);
    } };
  }

  private discard(entry: Entry): void {
    this.idle.delete(entry); this.idleBytes -= entry.bytes; entry.buffers.geometry.dispose();
  }

  clearUnused(): void { for (const entry of this.idle) this.discard(entry); }
  diagnostics() { return { live: this.live, idle: this.idle.size, idleBytes: this.idleBytes, created: this.created, reused: this.reused }; }
}
