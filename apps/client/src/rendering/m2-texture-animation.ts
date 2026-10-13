import * as THREE from 'three';
import { createTrackKeyCursor, findTrackKey, type TrackKeyCursor } from './track-key-search';
import { m2SamplingMode } from './performance-controls';
import { recordAnimatedMaterialTrack } from './performance-subsystem-metrics';
import { beginCpuScope, CpuScopeId, endCpuScope } from './performance-cpu-scopes';
/** Asset conversion utility. */
export type BakedTrack = {
  /** 0 = step, 1 = linear. */
  i: number;
  /** Global-sequence index, or -1 when the track is scoped to an animation sequence. */
  g: number;
  /** Keyframe times, milliseconds — ABSOLUTE model-timeline values, not 0-based per track. */
  ts: number[];
  /** Flat keyframe values, `components` per key. */
  v: number[];
  /**
   * Vanilla per-animation key windows: `r[sequenceIndex] = [firstKey, lastKey]` into `ts`/`v`.
   * Absent on global-sequence tracks, which are not scoped per animation.
   */
  r?: [number, number][];
};

/**
 * The clock a spell-visual instance samples its material tracks on.
 *
 * Vanilla M2 keyframe timestamps are absolute positions on the model timeline, scoped to an
 * animation sequence's [timeStart, timeEnd] window — IceBarrier_State's transparency track is
 * authored `ts=[3333,3500,4200,8333,9333] v=[0,0,1,1,0]` with per-animation ranges
 * `seq0=[0,2] seq158=[2,3] seq159=[3,4]` (raw Build 5875 bytes, tools/probe-m2-material-ranges.ts).
 * They are NOT a 0-based loop, so the last timestamp is not a period. Sampling them on a free
 * `elapsed % lastTimestamp` clock made the Hold sequence — authored as a constant alpha 1.0, a
 * solid block — spend 83.8% of a 4200ms cycle at alpha 0 and snap on the wrap.
 *
 * `sequenceMs` is the same clock the mesh and emitters use (hold/settle latches included), so
 * alpha stops exactly when the animation does. `globalMs` is raw instance time, which is what
 * global sequences genuinely loop on.
 */
export type TrackClock = { sequenceMs: number; globalMs: number; sequenceIndex: number };

export type BakedTransform = { t?: BakedTrack; r?: BakedTrack; s?: BakedTrack };
export type BakedMaterialColor = { c?: BakedTrack; a?: BakedTrack };

/** True if this data needs terms the offset-only path cannot express. */
export const hasUnsupportedTracks = (xf: BakedTransform): boolean => !!(xf.r || xf.s);

/**
 * Sample a track at `elapsedMs`, or — when `clock` is supplied — on the instance's sequence clock.
 *
 * Without a clock the caller has no sequence timeline (instanced doodads), so the legacy
 * "loop on the last timestamp" behaviour is kept verbatim rather than freezing them.
 */
function sampleTrack(
  track: BakedTrack,
  components: number,
  elapsedMs: number,
  globalSequences: number[],
  out: number[],
  clock?: TrackClock,
  cursor: TrackKeyCursor = createTrackKeyCursor(),
  cached = true,
): boolean {
  const keys = track.ts.length;
  if (!keys || track.v.length < keys * components) return false;
  if (keys === 1) {
    for (let c = 0; c < components; c++) out[c] = track.v[c];
    return true;
  }

  let t: number;
  // Key window to sample within. Sequence-scoped tracks use the window vanilla authored for the
  // sequence being played; everything else spans the whole track.
  let first = 0;
  let last = keys - 1;
  const globalPeriod = track.g >= 0 ? globalSequences[track.g] : undefined;
  if (globalPeriod && globalPeriod > 0) {
    // A global sequence is an independent timeline that genuinely loops on its own period.
    const source = clock ? clock.globalMs : elapsedMs;
    t = ((source % globalPeriod) + globalPeriod) % globalPeriod;
  } else if (clock) {
    const window = track.r?.[clock.sequenceIndex];
    if (window) {
      first = Math.max(0, Math.min(keys - 1, window[0]));
      last = Math.max(first, Math.min(keys - 1, window[1]));
    }
    // Sequence-scoped keys: clamp into the authored span. The sequence clock already holds or
    // settles when the animation ends, so no value is invented past the last key.
    t = Math.min(Math.max(clock.sequenceMs, track.ts[first]), track.ts[last]);
  } else {
    const period = track.ts[keys - 1];
    if (!period || period <= 0) {
      for (let c = 0; c < components; c++) out[c] = track.v[(keys - 1) * components + c];
      return true;
    }
    t = ((elapsedMs % period) + period) % period;
  }

  // Locate the segment containing t, inside the window.
  const lo = findTrackKey(track.ts, first, last, t, cursor, cached, true);
  if (lo === first && t <= track.ts[first]) {
    for (let c = 0; c < components; c++) out[c] = track.v[first * components + c];
    return true;
  }
  if (lo >= last) {
    for (let c = 0; c < components; c++) out[c] = track.v[last * components + c];
    return true;
  }

  const hi = lo + 1;
  if (track.i === 0) {
    for (let c = 0; c < components; c++) out[c] = track.v[lo * components + c];
    return true;
  }
  const span = track.ts[hi] - track.ts[lo];
  const f = span > 0 ? (t - track.ts[lo]) / span : 0;
  for (let c = 0; c < components; c++) {
    const a = track.v[lo * components + c];
    const b = track.v[hi * components + c];
    out[c] = a + (b - a) * f;
  }
  return true;
}

type Registered = {
  material: THREE.ShaderMaterial;
  transform: BakedTransform;
  globalSequences: number[];
  elapsed?: () => number;
  clock?: () => TrackClock;
  cursor: TrackKeyCursor;
};

type RegisteredMaterial = {
  material: THREE.ShaderMaterial;
  color?: BakedMaterialColor;
  weight?: BakedTrack;
  globalSequences: number[];
  elapsed?: () => number;
  clock?: () => TrackClock;
  cursors: { color: TrackKeyCursor; alpha: TrackKeyCursor; weight: TrackKeyCursor };
};

const registered: Registered[] = [];
const registeredMaterials: RegisteredMaterial[] = [];
const scratch = [0, 0, 0, 0];

/**
 * Drive `material`'s uTexOffset from `transform`. The material must be a createM2Material product
 * and must not be shared with a static part (the offset is per-material).
 */
export function registerAnimatedUV(
  material: THREE.ShaderMaterial,
  transform: BakedTransform,
  globalSequences: number[] = [],
  elapsed?: () => number,
  clock?: () => TrackClock,
): void {
  if (!material.uniforms?.uTexOffset) return;
  registered.push({ material, transform, globalSequences, elapsed, clock, cursor: createTrackKeyCursor() });
}

/** Drive a material's M2Color and M2TextureWeight tracks through its uM2Color multiplier. */
export function registerAnimatedMaterial(
  material: THREE.ShaderMaterial,
  color?: BakedMaterialColor,
  weight?: BakedTrack,
  globalSequences: number[] = [],
  elapsed?: () => number,
  clock?: () => TrackClock,
): void {
  if (!material.uniforms?.uM2Color || (!color && !weight)) return;
  registeredMaterials.push({
    material, color, weight, globalSequences, elapsed, clock,
    cursors: { color: createTrackKeyCursor(), alpha: createTrackKeyCursor(), weight: createTrackKeyCursor() },
  });
}

type AnimatedOwnerMaterial = THREE.ShaderMaterial & { userData: { wowAnimatedOwners?: Set<THREE.Object3D> } };

export function prepareAnimatedMaterialOwnership(material: THREE.ShaderMaterial): void {
  (material as AnimatedOwnerMaterial).userData.wowAnimatedOwners ??= new Set();
}

export function registerAnimatedMaterialOwner(material: THREE.Material | THREE.Material[], owner: THREE.Object3D): void {
  const materials = Array.isArray(material) ? material : [material];
  for (const value of materials) (value as AnimatedOwnerMaterial).userData.wowAnimatedOwners?.add(owner);
}

function materialHasVisibleOwner(material: THREE.ShaderMaterial): boolean {
  const owners = (material as AnimatedOwnerMaterial).userData.wowAnimatedOwners;
  if (!owners) return true;
  for (const owner of owners) {
    let visible = true;
    let current: THREE.Object3D | null = owner;
    while (current) { if (!current.visible) { visible = false; break; } current = current.parent; }
    if (visible) return true;
  }
  return false;
}

/** Drop every registration for materials that are no longer in the scene. */
export function clearAnimatedUVs(predicate?: (material: THREE.ShaderMaterial) => boolean): void {
  for (let i = registered.length - 1; i >= 0; i--) {
    if (!predicate || predicate(registered[i].material)) registered.splice(i, 1);
  }
  for (let i = registeredMaterials.length - 1; i >= 0; i--) {
    if (!predicate || predicate(registeredMaterials[i].material)) registeredMaterials.splice(i, 1);
  }
}

let elapsedMs = 0;

/** Advance every registered UV animation. Call once per frame with the frame delta in seconds. */
export function updateTextureAnimations(dt: number): void {
  const cpuScope = beginCpuScope(CpuScopeId.AnimatedMaterials);
  try {
  if (!registered.length && !registeredMaterials.length) return;
  const mode = m2SamplingMode();
  if (mode === 'off') return;
  const cached = mode === 'cached';
  elapsedMs += dt * 1000;
  for (const entry of registered) {
    if (!materialHasVisibleOwner(entry.material)) { recordAnimatedMaterialTrack(true); continue; }
    const track = entry.transform.t;
    if (!track) continue;
    const clock = entry.clock?.();
    if (!sampleTrack(track, 3, entry.elapsed?.() ?? elapsedMs, entry.globalSequences, scratch, clock, entry.cursor, cached)) continue;
    recordAnimatedMaterialTrack(false);
    (entry.material.uniforms.uTexOffset.value as THREE.Vector2).set(scratch[0], scratch[1]);
  }
  for (const entry of registeredMaterials) {
    if (!materialHasVisibleOwner(entry.material)) { recordAnimatedMaterialTrack(true); continue; }
    const tint = entry.material.uniforms.uM2Color.value as THREE.Vector4;
    tint.set(1, 1, 1, 1);
    const colorTrack = entry.color?.c;
    const entryElapsed = entry.elapsed?.() ?? elapsedMs;
    const clock = entry.clock?.();
    if (colorTrack && sampleTrack(colorTrack, 3, entryElapsed, entry.globalSequences, scratch, clock, entry.cursors.color, cached)) {
      recordAnimatedMaterialTrack(false);
      tint.setX(scratch[0]).setY(scratch[1]).setZ(scratch[2]);
    }
    const alphaTrack = entry.color?.a;
    if (alphaTrack && sampleTrack(alphaTrack, 1, entryElapsed, entry.globalSequences, scratch, clock, entry.cursors.alpha, cached)) {
      recordAnimatedMaterialTrack(false); tint.w *= scratch[0];
    }
    if (entry.weight && sampleTrack(entry.weight, 1, entryElapsed, entry.globalSequences, scratch, clock, entry.cursors.weight, cached)) {
      recordAnimatedMaterialTrack(false); tint.w *= scratch[0];
    }
  }
  } finally { endCpuScope(cpuScope); }
}

/**
 * Test seam: evaluate any baked track on an explicit sequence clock with the SHIPPED sampler, so
 * a gate can compare the renderer's output against the raw M2 bytes instead of a reimplementation.
 */
export function sampleTrackAt(
  track: BakedTrack,
  components: number,
  clock: TrackClock,
  globalSequences: number[] = [],
): number[] | null {
  const out = [0, 0, 0, 0];
  if (!sampleTrack(track, components, clock.globalMs, globalSequences, out, clock, createTrackKeyCursor(), true)) return null;
  return out.slice(0, components);
}

/** Test seam: evaluate a transform at an explicit time without touching the shared clock. */
export function sampleTransformAt(transform: BakedTransform, atMs: number, globalSequences: number[] = []): [number, number] {
  const track = transform.t;
  if (!track) return [0, 0];
  return sampleTrack(track, 3, atMs, globalSequences, scratch, undefined, createTrackKeyCursor(), true) ? [scratch[0], scratch[1]] : [0, 0];
}

/** Number of live registrations — QA hook. */
export const animatedUVCount = (): number => registered.length;
