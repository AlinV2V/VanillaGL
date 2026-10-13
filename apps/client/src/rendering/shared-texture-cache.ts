import * as THREE from 'three';
import { getPerformanceProfile } from '../platform/performance-profile';
/** Asset conversion utility. */
// Total references = cache-entry references + live-model references. Disposed at 0.
const totalRefs = new Map<THREE.Texture, number>();
// Live-model references only. Used solely to keep still-worn entries in cache (dedup); never gates
// disposal, which is governed by totalRefs.
const modelRefs = new Map<THREE.Texture, number>();
const trimRegistries = new Set<() => void>();

// The caller owns any bookkeeping tied to disposal (e.g. removing the texture from a "shared" set);
// default just disposes the GPU resource.
let disposeTexture: (tex: THREE.Texture) => void = (tex) => tex.dispose();

export function setSharedTextureDisposer(fn: (tex: THREE.Texture) => void): void {
  disposeTexture = fn;
}

export function retainSharedTexture(tex: THREE.Texture): void {
  totalRefs.set(tex, (totalRefs.get(tex) ?? 0) + 1);
}

export function releaseSharedTexture(tex: THREE.Texture): void {
  const n = totalRefs.get(tex);
  if (n === undefined) return;
  if (n <= 1) {
    totalRefs.delete(tex);
    modelRefs.delete(tex);
    disposeTexture(tex);
  } else {
    totalRefs.set(tex, n - 1);
  }
}

export function retainSharedTextureForModel(tex: THREE.Texture): void {
  modelRefs.set(tex, (modelRefs.get(tex) ?? 0) + 1);
  retainSharedTexture(tex);
}

export function releaseSharedTextureForModel(tex: THREE.Texture): void {
  const m = modelRefs.get(tex);
  if (m !== undefined) {
    if (m <= 1) modelRefs.delete(tex);
    else modelRefs.set(tex, m - 1);
  }
  releaseSharedTexture(tex);
  for (const trim of trimRegistries) trim();
}

export function isSharedTexturePinnedByModel(tex: THREE.Texture): boolean {
  return (modelRefs.get(tex) ?? 0) > 0;
}

export function sharedTextureStats(): { tracked: number; modelPinned: number } {
  return { tracked: totalRefs.size, modelPinned: modelRefs.size };
}

/**
 * LRU registry over resolved cache entries. Insertion order is the LRU order; `touch` promotes an
 * entry to most-recently-used. When the registry exceeds its cap it evicts least-recently-used
 * entries, but NEVER an entry whose textures are still worn by a live model or younger than the
 * grace window. Device profiles lower the two large model registries (768 URL textures and 256
 * appearance atlases) on phones/tablets while leaving smaller utility registries untouched.
 */
export type BoundedTextureRegistryOptions = { graceMs?: number; now?: () => number };

const deviceBudgetForRequestedCap = (cap: number): number => {
  const profile = getPerformanceProfile();
  if (cap >= 700) return Math.min(cap, profile.modelTextureLimit);
  if (cap >= 200) return Math.min(cap, profile.appearanceAtlasLimit);
  return cap;
};

export class BoundedTextureRegistry<V> {
  private readonly order = new Map<string, { value: V; at: number }>();
  private readonly cap: number;
  private readonly texturesOf: (value: V) => readonly THREE.Texture[];
  private readonly onEvict: (key: string) => void;
  private readonly graceMs: number;
  private readonly now: () => number;
  private trimTimer?: ReturnType<typeof setTimeout>;

  constructor(
    cap: number,
    texturesOf: (value: V) => readonly THREE.Texture[],
    onEvict: (key: string) => void,
    options: BoundedTextureRegistryOptions = {},
  ) {
    this.cap = deviceBudgetForRequestedCap(cap);
    this.texturesOf = texturesOf;
    this.onEvict = onEvict;
    this.graceMs = options.graceMs ?? 10000;
    this.now = options.now ?? (() => Date.now());
    trimRegistries.add(() => this.trim());
  }

  get size(): number {
    return this.order.size;
  }

  touch(key: string): void {
    const entry = this.order.get(key);
    if (entry === undefined) return;
    entry.at = this.now();
    this.order.delete(key);
    this.order.set(key, entry);
  }

  register(key: string, value: V): void {
    const previous = this.order.get(key);
    if (previous?.value === value) {
      this.touch(key);
      return;
    }
    if (previous) {
      this.order.delete(key);
      for (const texture of this.texturesOf(previous.value)) releaseSharedTexture(texture);
    }
    this.order.set(key, { value, at: this.now() });
    for (const tex of this.texturesOf(value)) retainSharedTexture(tex);
    this.evict();
  }

  clear(): void {
    if (this.trimTimer) clearTimeout(this.trimTimer);
    this.trimTimer = undefined;
    for (const [key, entry] of this.order) {
      this.onEvict(key);
      for (const texture of this.texturesOf(entry.value)) releaseSharedTexture(texture);
    }
    this.order.clear();
  }

  trim(): void { this.evict(); }

  private evict(scheduleGrace = true): void {
    if (this.order.size <= this.cap) return;
    const cutoff = this.now() - this.graceMs;
    for (const [key, entry] of [...this.order]) {
      if (this.order.size <= this.cap) break;
      if (entry.at > cutoff) continue;
      const textures = this.texturesOf(entry.value);
      if (textures.some(isSharedTexturePinnedByModel)) continue;
      this.order.delete(key);
      this.onEvict(key);
      for (const tex of textures) releaseSharedTexture(tex);
    }
    if (scheduleGrace && this.order.size > this.cap && !this.trimTimer) {
      this.trimTimer = setTimeout(() => { this.trimTimer = undefined; this.evict(false); }, this.graceMs);
      (this.trimTimer as unknown as { unref?: () => void }).unref?.();
    }
  }
}
