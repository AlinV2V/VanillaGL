import * as THREE from 'three';
import { textureHasUploadPayload } from '../m2-material';
import { texturePayloadBytes } from './texture-upload-admission';

type Entry = { texture: THREE.Texture; refs: number; lastUsed: number };
const MAX_TEXTURES = 512, MAX_BYTES = 128 * 1024 * 1024;

/** Ref-aware LRU for textures shared by live spell model instances. */
export class SpellVisualTextureCache {
  private readonly entries = new Map<string, Entry>();
  private evictions = 0;

  constructor(private readonly loader: THREE.TextureLoader, private readonly base: string) {}

  acquire(ref: string | null, owned: Set<string>): THREE.Texture | null {
    if (!ref) return null;
    let entry = this.entries.get(ref);
    if (!entry) {
      const texture = this.loader.load(`${this.base}${ref}`, (loaded) => {
        // TextureLoader is globally routed through optimized/admitted loading. Re-account
        // only after its placeholder owns decoded bytes, and retire late evicted uploads.
        if (this.entries.get(ref)?.texture !== loaded) loaded.dispose();
        else this.trim();
      });
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      if (textureHasUploadPayload(texture)) texture.needsUpdate = true;
      entry = { texture, refs: 0, lastUsed: performance.now() };
    } else {
      entry.lastUsed = performance.now();
      this.entries.delete(ref);
    }
    this.entries.set(ref, entry);
    owned.add(ref);
    return entry.texture;
  }

  retain(owned: Set<string>): void {
    for (const ref of owned) { const entry = this.entries.get(ref); if (entry) entry.refs++; }
    this.trim();
  }

  release(owned: Set<string>): void {
    for (const ref of owned) { const entry = this.entries.get(ref); if (entry) entry.refs = Math.max(0, entry.refs - 1); }
    this.trim();
  }

  clearUnused(): void {
    for (const [ref, entry] of this.entries) if (entry.refs === 0) {
      this.entries.delete(ref); entry.texture.dispose();
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.texture.dispose();
    this.entries.clear();
  }

  diagnostics() {
    return {
      evictions: this.evictions,
      textures: [...this.entries].map(([ref, entry]) => ({
        ref, refs: entry.refs, loaded: !!(entry.texture.image && (entry.texture.image as HTMLImageElement).width),
        w: (entry.texture.image as HTMLImageElement)?.width ?? 0,
        h: (entry.texture.image as HTMLImageElement)?.height ?? 0,
      })),
    };
  }

  private trim(): void {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += texturePayloadBytes(entry.texture);
    for (const [ref, entry] of this.entries) {
      if (this.entries.size <= MAX_TEXTURES && bytes <= MAX_BYTES) break;
      if (entry.refs > 0) continue;
      const size = texturePayloadBytes(entry.texture);
      this.entries.delete(ref); entry.texture.dispose(); bytes = Math.max(0, bytes - size); this.evictions++;
    }
  }
}
