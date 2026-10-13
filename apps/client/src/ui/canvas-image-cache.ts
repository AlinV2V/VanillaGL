import { getPerformanceProfile } from '../platform/performance-profile';

type CacheListener = (path: string) => void;

type CanvasImageEntry = {
  image?: HTMLImageElement;
  state: 'loading' | 'ready' | 'failed';
  decodedBytes: number;
  failures: number;
  retryAt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  readonly listeners: Set<CacheListener>;
};

const MAX_CANVAS_IMAGES = 256;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const entries = new Map<string, CanvasImageEntry>();
let decodedBytes = 0;
let peakDecodedBytes = 0;
let hits = 0;
let misses = 0;
let evictions = 0;
let failures = 0;
const MAX_TINT_IMAGES = 64;
const MAX_TINT_BYTES = 16 * 1024 * 1024;
const tintEntries = new Map<string, { canvas: HTMLCanvasElement; bytes: number }>();
let tintBytes = 0;
let tintHits = 0;
let tintMisses = 0;
let tintEvictions = 0;

const touch = (path: string, entry: CanvasImageEntry) => {
  entries.delete(path);
  entries.set(path, entry);
};

const notify = (path: string, entry: CanvasImageEntry) => {
  const listeners = [...entry.listeners];
  entry.listeners.clear();
  for (const listener of listeners) listener(path);
};

const trim = () => {
  if (entries.size <= MAX_CANVAS_IMAGES && decodedBytes <= MAX_DECODED_BYTES) return;
  const evict = (path: string, entry: CanvasImageEntry) => {
    clearTimeout(entry.retryTimer);
    entries.delete(path);
    decodedBytes -= entry.decodedBytes;
    const pendingImage = entry.state === 'loading' ? entry.image : undefined;
    entry.image = undefined;
    pendingImage?.removeAttribute('src');
    notify(path, entry);
    evictions++;
  };
  for (const [path, entry] of entries) {
    if (entries.size <= MAX_CANVAS_IMAGES && decodedBytes <= MAX_DECODED_BYTES) break;
    if (entry.state === 'loading') continue;
    evict(path, entry);
  }
  // A burst of unique URLs must not bypass the hard cap merely because every image is pending.
  for (const [path, entry] of entries) {
    if (entries.size <= MAX_CANVAS_IMAGES && decodedBytes <= MAX_DECODED_BYTES) break;
    evict(path, entry);
  }
};

const startLoad = (path: string, entry: CanvasImageEntry) => {
  clearTimeout(entry.retryTimer);
  entry.retryTimer = undefined;
  entry.state = 'loading';
  const image = new Image();
  image.decoding = 'async';
  entry.image = image;
  image.addEventListener('load', () => {
    if (entries.get(path) !== entry || entry.image !== image) return;
    const loadedBytes = image.naturalWidth * image.naturalHeight * 4;
    if (loadedBytes > MAX_DECODED_BYTES) {
      entry.image = undefined; entry.state = 'failed'; entry.failures++; failures++;
      entry.retryAt = Date.now() + 30_000; notify(path, entry); return;
    }
    entry.state = 'ready';
    entry.failures = 0;
    entry.decodedBytes = loadedBytes;
    decodedBytes += entry.decodedBytes;
    peakDecodedBytes = Math.max(peakDecodedBytes, decodedBytes);
    touch(path, entry);
    notify(path, entry);
    trim();
  }, { once: true });
  image.addEventListener('error', () => {
    if (entries.get(path) !== entry || entry.image !== image) return;
    entry.image = undefined;
    entry.state = 'failed';
    entry.failures++;
    failures++;
    entry.retryAt = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(entry.failures - 1, 6));
    notify(path, entry);
  }, { once: true });
  image.src = path;
};

/** Module-wide decoded-image LRU with capped retry/backoff for transient browser image failures. */
export function resolveCachedCanvasImage(path: string, listener: CacheListener): HTMLImageElement | undefined {
  let entry = entries.get(path);
  if (!entry) {
    misses++;
    entry = { state: 'loading', decodedBytes: 0, failures: 0, retryAt: 0, listeners: new Set([listener]) };
    entries.set(path, entry);
    startLoad(path, entry);
    trim();
    return undefined;
  }
  touch(path, entry);
  if (entry.state === 'ready' && entry.image?.naturalWidth) { hits++; return entry.image; }
  entry.listeners.add(listener);
  if (entry.state === 'failed' && !entry.retryTimer) {
    const delay = Math.max(0, entry.retryAt - Date.now());
    entry.retryTimer = setTimeout(() => startLoad(path, entry!), delay);
  }
  return undefined;
}

/** Mobile-only pre-tint cache. Desktop retains the exact historical per-draw canvas path. */
export function resolveMobileTintedCanvas(
  image: HTMLImageElement,
  path: string,
  color: string,
): HTMLCanvasElement | undefined {
  if (!getPerformanceProfile().device.mobile) return undefined;
  const key = `${path}|${color}`;
  const cached = tintEntries.get(key);
  if (cached) {
    tintEntries.delete(key); tintEntries.set(key, cached); tintHits++;
    return cached.canvas;
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const bytes = width * height * 4;
  if (!width || !height || bytes > MAX_TINT_BYTES) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.drawImage(image, 0, 0);
  context.globalCompositeOperation = 'multiply';
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(image, 0, 0);
  tintEntries.set(key, { canvas, bytes }); tintBytes += bytes; tintMisses++;
  while (tintEntries.size > MAX_TINT_IMAGES || tintBytes > MAX_TINT_BYTES) {
    const oldestKey = tintEntries.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = tintEntries.get(oldestKey)!;
    tintEntries.delete(oldestKey); tintBytes -= oldest.bytes; tintEvictions++;
  }
  return canvas;
}

export const canvasImageCacheDiagnostics = () => ({
  entries: entries.size, decodedBytes, peakDecodedBytes, hits, misses, evictions, failures,
  limitEntries: MAX_CANVAS_IMAGES, limitDecodedBytes: MAX_DECODED_BYTES,
  tintEntries: tintEntries.size, tintBytes, tintHits, tintMisses, tintEvictions,
});
