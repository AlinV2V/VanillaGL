import * as THREE from 'three';
import type { SpellModelAsset } from '../spell-visuals';
import type { M2StaticSkinAttributes } from './m2-gpu-skinning';

type Source = NonNullable<SpellModelAsset['geometry']>;
type Slot = { entry?: Entry };
type Entry = {
  refs: number; bytes: number; slot: Slot; geometries: THREE.BufferGeometry[];
  position: THREE.Float32BufferAttribute; normal: THREE.Float32BufferAttribute | null;
  skinAttributes?: M2StaticSkinAttributes;
};
export type SpellModelGeometryLease = Omit<Entry, 'refs' | 'bytes' | 'slot'> & { release(): void };

/** Immutable bind vertices/indices are shared; each spell still owns its animator and materials. */
export class SpellModelGeometryCache {
  // Retaining warm GPU buffers must not also pin the decoded JSON asset and material tracks.
  private readonly bySource = new WeakMap<Source, Slot>();
  private readonly entries = new Set<Entry>();
  private bytes = 0;
  private created = 0;
  private reused = 0;

  constructor(private readonly maxBytes = 16 * 1024 * 1024, private readonly maxEntries = 128) {}

  acquire(source: Source): SpellModelGeometryLease {
    let entry = this.bySource.get(source)?.entry;
    if (entry) { this.entries.delete(entry); this.reused++; }
    else {
      const position = new THREE.Float32BufferAttribute(source.positions, 3);
      const normal = source.normals?.length ? new THREE.Float32BufferAttribute(source.normals, 3) : null;
      const uv = source.uvs.length ? new THREE.Float32BufferAttribute(source.uvs, 2) : null;
      const skinned = source.boneWeights?.length === position.count * 4
        && source.boneIndices?.length === position.count * 4 && position.count > 0;
      const skinAttributes: M2StaticSkinAttributes | undefined = skinned ? {
        boneIndex: new THREE.Uint8BufferAttribute(Uint8Array.from(source.boneIndices!), 4, false),
        boneWeight: new THREE.Uint8BufferAttribute(Uint8Array.from(source.boneWeights!), 4, true),
      } : undefined;
      const geometries = source.submeshes.map((part) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', position);
        if (normal) geometry.setAttribute('normal', normal);
        if (uv) geometry.setAttribute('uv', uv);
        geometry.setIndex(source.indices.slice(part.start, part.start + part.count));
        return geometry;
      });
      const bytes = position.array.byteLength + (normal?.array.byteLength ?? 0) + (uv?.array.byteLength ?? 0)
        + (skinAttributes ? skinAttributes.boneIndex.array.byteLength + skinAttributes.boneWeight.array.byteLength : 0)
        + geometries.reduce((n, g) => n + (g.index?.array.byteLength ?? 0), 0);
      const slot: Slot = {};
      entry = { refs: 0, bytes, slot, geometries, position, normal, skinAttributes }; slot.entry = entry;
      this.bySource.set(source, slot);
      this.bytes += bytes; this.created++;
    }
    this.entries.add(entry); entry.refs++; this.trim();
    const owned = entry;
    let released = false;
    return { geometries: owned.geometries, position: owned.position, normal: owned.normal, skinAttributes: owned.skinAttributes,
      release: () => { if (released) return; released = true; owned.refs--; this.trim(); } };
  }

  private discard(entry: Entry): void {
    this.entries.delete(entry); this.bytes -= entry.bytes; entry.slot.entry = undefined;
    for (const geometry of entry.geometries) geometry.dispose();
  }

  private trim(): void {
    for (const entry of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      if (entry.refs === 0) this.discard(entry);
    }
  }

  clearUnused(): void { for (const entry of this.entries) if (entry.refs === 0) this.discard(entry); }
  diagnostics() { return { entries: this.entries.size, bytes: this.bytes, live: [...this.entries].reduce((n, e) => n + e.refs, 0), created: this.created, reused: this.reused }; }
}
