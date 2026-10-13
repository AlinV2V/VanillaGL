import { beginSceneEffectFrame } from './scene-effect-budget';
import * as THREE from 'three';
import { recordRuntimeAttribution } from '../platform/runtime-attribution';
import { runtimeWorkScheduler } from '../platform/runtime-work-scheduler';
import { beginCpuScope, CpuScopeId, endCpuScope } from './performance-cpu-scopes';

type TextureAdmissionOptions = {
  prepare?: () => void;
  validate?: (renderer: THREE.WebGLRenderer) => void;
  payloadBytes?: number;
  signal?: AbortSignal;
};

let renderer: THREE.WebGLRenderer | null = null;
let queued = 0;
let queuedBytes = 0;
let admitted = 0;
let admittedBytes = 0;
let failures = 0;
let skippedWithoutRenderer = 0;
let uploadTotalMs = 0;
let uploadMaxMs = 0;
let largestUploadBytes = 0;
let largestUploadLabel = '';
let peakQueuedBytes = 0;
let frameTracking = false;
let intervalUploadBytes = 0;
let intervalUploadCount = 0;
let callbackUploadBytes = 0;
let lastFrameAt = 0;
let framesWithUploads = 0;
let maxFrameUploadBytes = 0;
let maxFrameMsWithUploads = 0;
let longFramesWithUploads = 0;
let callbacksWithUploads = 0;
let maxCallbackUploadBytes = 0;
let maxCallbackMsWithUploads = 0;
let unframedUploads = 0;
let unframedUploadBytes = 0;
type UploadRouteStats = { count: number; bytes: number; durationMs: number };
const byEncoding: Record<'compressed' | 'rgba', UploadRouteStats> = {
  compressed: { count: 0, bytes: 0, durationMs: 0 },
  rgba: { count: 0, bytes: 0, durationMs: 0 },
};
const byCategory: Record<string, UploadRouteStats> = {};
const pending = new WeakMap<THREE.Texture, Promise<void>>();

const uploadCategory = (label: string) => /terrain|splat|shadow/i.test(label) ? 'terrain'
  : /wmo/i.test(label) ? 'wmo'
    : /doodad|creature|model|appearance/i.test(label) ? 'model'
      : /ui|interface|portrait/i.test(label) ? 'ui' : 'other';
const recordRoute = (route: UploadRouteStats, bytes: number, durationMs: number) => {
  route.count++; route.bytes += bytes; route.durationMs += durationMs;
};

export function beginTextureUploadFrame(rafAt: number): void {
  beginSceneEffectFrame();
  if (intervalUploadBytes > 0) {
    const intervalMs = lastFrameAt > 0 ? Math.max(0, rafAt - lastFrameAt) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(intervalMs)) {
      framesWithUploads++;
      maxFrameUploadBytes = Math.max(maxFrameUploadBytes, intervalUploadBytes);
      maxFrameMsWithUploads = Math.max(maxFrameMsWithUploads, intervalMs);
      if (intervalMs > 16.7) longFramesWithUploads++;
    } else {
      unframedUploads += intervalUploadCount;
      unframedUploadBytes += intervalUploadBytes;
    }
  }
  lastFrameAt = rafAt;
  intervalUploadBytes = 0;
  intervalUploadCount = 0;
  frameTracking = true;
  callbackUploadBytes = 0;
}

export function endTextureUploadFrame(callbackMs: number): void {
  if (frameTracking && callbackUploadBytes > 0) {
    callbacksWithUploads++;
    maxCallbackUploadBytes = Math.max(maxCallbackUploadBytes, callbackUploadBytes);
    maxCallbackMsWithUploads = Math.max(maxCallbackMsWithUploads, callbackMs);
  }
  frameTracking = false;
}

export function texturePayloadBytes(texture: THREE.Texture): number {
  const mipBytes = texture.mipmaps?.reduce((total, mip) => {
    const data = (mip as { data?: ArrayBufferView }).data;
    return total + (data?.byteLength ?? 0);
  }, 0) ?? 0;
  if (mipBytes) return mipBytes;
  const image = texture.image as { width?: number; height?: number; data?: ArrayBufferView } | undefined;
  return image?.data?.byteLength ?? Math.max(0, Number(image?.width ?? 0) * Number(image?.height ?? 0) * 4);
}

export function configureTextureUploadAdmission(nextRenderer: THREE.WebGLRenderer | null): void {
  renderer = nextRenderer;
}

/**
 * Adopt and upload one immutable texture payload inside the shared per-frame work budget.
 * Callers should not expose a newly hydrated world object until this promise resolves.
 */
export function admitTextureUpload(
  texture: THREE.Texture,
  label: string,
  options: TextureAdmissionOptions = {},
): Promise<void> {
  const existing = pending.get(texture);
  if (existing) return existing;
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('texture upload aborted', 'AbortError'));

  const payloadBytes = Math.max(0, options.payloadBytes ?? texturePayloadBytes(texture));
  const activeRenderer = renderer;
  if (!activeRenderer) {
    options.prepare?.();
    skippedWithoutRenderer++;
    return Promise.resolve();
  }

  queued++;
  queuedBytes += payloadBytes;
  peakQueuedBytes = Math.max(peakQueuedBytes, queuedBytes);
  // WebGL uploads are indivisible. Charge large payloads the whole scheduler slice so at most one
  // begins in a gameplay frame; compressed/smaller bakes remain the real hard-stall remedy.
  const estimatedMs = Math.max(0.1, Math.min(8, 0.1 + payloadBytes / 1_000_000));
  let queueAccounted = true;
  const leaveQueue = () => {
    if (!queueAccounted) return;
    queueAccounted = false;
    queued = Math.max(0, queued - 1);
    queuedBytes = Math.max(0, queuedBytes - payloadBytes);
  };
  const scheduled = runtimeWorkScheduler.schedule(`texture-upload:${label}`, () => {
    const cpuScope = beginCpuScope(CpuScopeId.AssetDecodeUpload);
    try {
    leaveQueue();
    const started = performance.now();
    try {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('texture upload aborted', 'AbortError');
      options.prepare?.();
      // Upload now, before the object is admitted to the scene. A later render observes the
      // current source version and does not repeat this work during render submission.
      activeRenderer.initTexture(texture);
      options.validate?.(activeRenderer);
      const elapsed = performance.now() - started;
      admitted++;
      admittedBytes += payloadBytes;
      uploadTotalMs += elapsed;
      uploadMaxMs = Math.max(uploadMaxMs, elapsed);
      if (payloadBytes > largestUploadBytes) { largestUploadBytes = payloadBytes; largestUploadLabel = label; }
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (hidden) {
        unframedUploads++;
        unframedUploadBytes += payloadBytes;
      } else {
        intervalUploadBytes += payloadBytes;
        intervalUploadCount++;
      }
      if (frameTracking) callbackUploadBytes += payloadBytes;
      recordRoute(byEncoding[(texture as THREE.Texture & { isCompressedTexture?: boolean }).isCompressedTexture ? 'compressed' : 'rgba'], payloadBytes, elapsed);
      const category = uploadCategory(label);
      recordRoute(byCategory[category] ??= { count: 0, bytes: 0, durationMs: 0 }, payloadBytes, elapsed);
      recordRuntimeAttribution('texture-admission', label, elapsed, payloadBytes);
    } catch (error) {
      failures++;
      throw error;
    }
    } finally { endCpuScope(cpuScope); }
  }, { priority: 'normal', estimatedMs, signal: options.signal });
  const tracked = scheduled.finally(() => { leaveQueue(); pending.delete(texture); });
  pending.set(texture, tracked);
  return tracked;
}

export const textureUploadAdmissionDiagnostics = () => ({
  queued,
  queuedBytes,
  admitted,
  admittedBytes,
  failures,
  skippedWithoutRenderer,
  uploadTotalMs: Number(uploadTotalMs.toFixed(3)),
  uploadMaxMs: Number(uploadMaxMs.toFixed(3)),
  largestUploadBytes,
  largestUploadLabel,
  peakQueuedBytes,
  peakTransientPayloadBytes: peakQueuedBytes,
  framesWithUploads,
  maxFrameUploadBytes,
  maxFrameMsWithUploads: Number(maxFrameMsWithUploads.toFixed(3)),
  longFramesWithUploads,
  callbacksWithUploads,
  maxCallbackUploadBytes,
  maxCallbackMsWithUploads: Number(maxCallbackMsWithUploads.toFixed(3)),
  pendingFrameUploadBytes: intervalUploadBytes,
  unframedUploads,
  unframedUploadBytes,
  byEncoding: {
    compressed: { ...byEncoding.compressed },
    rgba: { ...byEncoding.rgba },
  },
  byCategory: Object.fromEntries(Object.entries(byCategory).map(([category, stats]) => [category, { ...stats }])),
  policy: 'normal-priority, shared frame budget, one oversized unit allowed; pre-frame/hidden uploads are reported as unframed',
});
