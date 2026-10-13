import * as THREE from 'three';
import { getPerformanceProfile } from '../platform/performance-profile';
import { contentHashForPath } from '../assets/content-delivery';
import { ensureTextureAssetScope } from '../assets/asset-url-resolver';
import { loadOptimizedTexture } from './optimized-texture-loader';
import { admitTextureUpload, texturePayloadBytes } from './texture-upload-admission';
import { awaitAbortable } from '../platform/abortable-promise';

type TextureOptions = { repeat?: boolean; flipY?: boolean };
type ConfigureTexture = (texture: THREE.Texture, options?: TextureOptions) => THREE.Texture;
type Entry = {
  promise: Promise<THREE.Texture | null>;
  texture: THREE.Texture | null;
  refs: number;
  lastUsed: number;
  resolvedAt: number;
  bytes: number;
};

// Recently-resolved entries get a grace window so the caller can pin the texture to its tile group
// before eviction is considered. The live cap comes from the active desktop/tablet/mobile profile.
const EVICTION_GRACE_MS = 10_000;
const entries = new Map<string, Entry>();
const entryForTexture = new WeakMap<THREE.Texture, Entry>();
const sharedTextures = new WeakSet<THREE.Texture>();
let cacheHits = 0, cacheMisses = 0, hashDeduplicatedHits = 0;
let resolvedEntries = 0, retainedEntries = 0;
let resolvedBytes = 0, peakBytes = 0, evictedBytes = 0;
let deferredTrim: ReturnType<typeof setTimeout> | undefined;

const keyFor = (url: string, options: TextureOptions) => {
  let path = url;
  try { path = new URL(url, typeof location === 'undefined' ? 'http://localhost/' : location.href).pathname; } catch { /* use logical URL */ }
  const hash = contentHashForPath(path);
  return `${hash ? `sha256:${hash}` : `url:${url}`}|repeat=${options.repeat === true ? 1 : 0}|flipY=${options.flipY === false ? 0 : 1}`;
};

const touch = (key: string, entry: Entry) => {
  entry.lastUsed = Date.now();
  entries.delete(key);
  entries.set(key, entry);
};

const evict = (scheduleGrace = true) => {
  const limit = getPerformanceProfile().worldTextureLimit;
  const byteLimit = limit * 256 * 1024;
  if (entries.size <= limit && resolvedBytes <= byteLimit) return;
  const cutoff = Date.now() - EVICTION_GRACE_MS;
  for (const [key, entry] of [...entries]) {
    if (entries.size <= limit && resolvedBytes <= byteLimit) break;
    if (!entry.texture || entry.refs > 0 || entry.resolvedAt > cutoff) continue;
    entries.delete(key);
    entryForTexture.delete(entry.texture);
    entry.texture.dispose();
    resolvedBytes = Math.max(0, resolvedBytes - entry.bytes);
    evictedBytes += entry.bytes;
    resolvedEntries = Math.max(0, resolvedEntries - 1);
  }
  if (scheduleGrace && (entries.size > limit || resolvedBytes > byteLimit) && !deferredTrim) {
    deferredTrim = setTimeout(() => { deferredTrim = undefined; evict(false); }, EVICTION_GRACE_MS);
    (deferredTrim as unknown as { unref?: () => void }).unref?.();
  }
};

export async function loadWorldTexture(
  loader: THREE.TextureLoader,
  configure: ConfigureTexture,
  url: string,
  options: TextureOptions,
  group: THREE.Group,
  signal?: AbortSignal,
): Promise<THREE.Texture> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('world texture load aborted', 'AbortError');
  await ensureTextureAssetScope(url);
  if (signal?.aborted) throw signal.reason ?? new DOMException('world texture load aborted', 'AbortError');
  const key = keyFor(url, options);
  const cached = entries.get(key);
  if (cached) {
    cacheHits++;
    if (key.startsWith('sha256:')) hashDeduplicatedHits++;
    touch(key, cached);
    const texture = await awaitAbortable(cached.promise, signal, 'world texture load aborted');
    if (signal?.aborted) throw signal.reason ?? new DOMException('world texture load aborted', 'AbortError');
    if (!texture) throw new Error(`world texture unavailable: ${url}`);
    retainWorldTextureForGroup(group, texture);
    return texture;
  }
  cacheMisses++;

  const entry: Entry = {
    promise: Promise.resolve(null),
    texture: null,
    refs: 0,
    lastUsed: Date.now(),
    resolvedAt: 0,
    bytes: 0,
  };
  entry.promise = loadOptimizedTexture(loader, url, { ownerId: 'world-texture-cache' })
    .then(async (texture) => {
      entry.texture = configure(texture, options);
      await admitTextureUpload(entry.texture, url);
      resolvedEntries++;
      entry.resolvedAt = Date.now();
      entry.bytes = texturePayloadBytes(entry.texture);
      resolvedBytes += entry.bytes;
      peakBytes = Math.max(peakBytes, resolvedBytes);
      sharedTextures.add(entry.texture);
      entryForTexture.set(entry.texture, entry);
      evict();
      return entry.texture;
    })
    .catch((error) => {
      entry.texture?.dispose();
      entries.delete(key);
      throw error;
    });
  entries.set(key, entry);
  const texture = await awaitAbortable(entry.promise, signal, 'world texture load aborted');
  if (signal?.aborted) throw signal.reason ?? new DOMException('world texture load aborted', 'AbortError');
  if (!texture) throw new Error(`world texture unavailable: ${url}`);
  retainWorldTextureForGroup(group, texture);
  return texture;
}

export function retainWorldTextureForGroup(group: THREE.Group, texture: THREE.Texture | null): void {
  if (!texture) return;
  const entry = entryForTexture.get(texture);
  if (!entry) return;
  let held = group.userData.wowWorldTextures as Set<THREE.Texture> | undefined;
  if (!held) {
    held = new Set<THREE.Texture>();
    group.userData.wowWorldTextures = held;
  }
  if (held.has(texture)) return;
  held.add(texture);
  if (entry.refs === 0) retainedEntries++;
  entry.refs++;
  entry.lastUsed = Date.now();
}

export function releaseWorldTexturesForGroup(group: THREE.Group): void {
  const held = group.userData.wowWorldTextures as Set<THREE.Texture> | undefined;
  if (!held) return;
  for (const texture of held) {
    const entry = entryForTexture.get(texture);
    if (entry) {
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0) retainedEntries = Math.max(0, retainedEntries - 1);
      entry.lastUsed = Date.now();
    }
  }
  held.clear();
  delete group.userData.wowWorldTextures;
  evict();
}

export function isSharedWorldTexture(value: unknown): boolean {
  return value instanceof THREE.Texture && sharedTextures.has(value);
}

export const worldTextureCacheDiagnostics = () => ({
  entries: entries.size,
  resolved: resolvedEntries,
  retained: retainedEntries,
  bytes: resolvedBytes,
  peakBytes,
  evictedBytes,
  cacheHits,
  cacheMisses,
  hashDeduplicatedHits,
});
