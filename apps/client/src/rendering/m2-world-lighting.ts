import { mappedLocalLights } from './m2-nearest-lights';
import { wmoLightCandidates } from './wmo-light-candidates';
import * as THREE from 'three';
import {
  resolveWmoGroupAtLocalPoint,
  wmoGroupUsesOutdoorLighting,
  type WmoVisibilityInstance,
} from './wmo-visibility.ts';
import { performanceAblations, recordEntityLightingLookup } from './performance-detail-diagnostics';
import { visitMocvCandidateFaces } from './wmo-mocv-spatial-index';

export const M2_MAX_LOCAL_LIGHTS = 4;
export type M2LocalLight = {
  pos: [number, number, number];
  color: [number, number, number];
  attenStart: number;
  attenEnd: number;
};
export type M2WorldLight = {
  ambient: [number, number, number];
  directional: [number, number, number];
  direction: [number, number, number];
  localLights: M2LocalLight[];
  source: { tile: string; wmo: string; group: number; sample: 'mocv' | 'ambient' };
};

type Numeric = ArrayLike<number>;
type CachedLight = { x: number; y: number; z: number; at: number; sourceKey: string; value: M2WorldLight | null };
const FIXED_DIRECTION: [number, number, number] = [0.30822, 0.30822, 0.9];

const sampleRawMocv = (group: any, point: THREE.Vector3): [number, number, number] | null => {
  const positions = group?.positions as Numeric | undefined;
  const indices = group?.indices as Numeric | undefined;
  const rawMocv = group?.rawMocv as Numeric | undefined;
  const mopyFlags = group?.mopyFlags as Numeric | undefined;
  if (!positions || !indices || !rawMocv || rawMocv.length !== positions.length / 3 * 4) return null;
  let bestZ = Number.NEGATIVE_INFINITY;
  let best: [number, number, number] | null = null;
  const sampleFace = (face: number) => {
    if (((mopyFlags?.[face] ?? 0) & 0x08) !== 0) return;
    const ia = indices[face * 3], ib = indices[face * 3 + 1], ic = indices[face * 3 + 2];
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
    const v0x = bx - ax, v0y = by - ay, v1x = cx - ax, v1y = cy - ay;
    const denom = v0x * v1y - v1x * v0y;
    if (Math.abs(denom) < 1e-8) return;
    const px = point.x - ax, py = point.y - ay;
    const wb = (px * v1y - v1x * py) / denom;
    const wc = (v0x * py - px * v0y) / denom;
    const wa = 1 - wb - wc;
    if (wa < -1e-5 || wb < -1e-5 || wc < -1e-5) return;
    const z = az * wa + bz * wb + cz * wc;
    if (z > point.z + 1.5 || z < point.z - 1760 || z <= bestZ) return;
    const channel = (bgra: number) => Math.max(0, Math.min(255, Math.floor(
      rawMocv[ia * 4 + bgra] * wa + rawMocv[ib * 4 + bgra] * wb + rawMocv[ic * 4 + bgra] * wc,
    )));
    bestZ = z;
    best = [channel(2), channel(1), channel(0)];
  };
  if (!visitMocvCandidateFaces(group, point, sampleFace)) {
    for (let face = 0; face * 3 + 2 < indices.length; face++) sampleFace(face);
  }
  return best;
};


export const build5875StaticLightPair = (rgb: readonly number[]) => {
  const max = Math.max(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, 1);
  const ambientScale = Math.min(1, 96 / max) / 255;
  const directionalScale = Math.max(1, 168 / max) / 255;
  return {
    ambient: [rgb[0] * ambientScale, rgb[1] * ambientScale, rgb[2] * ambientScale] as [number, number, number],
    directional: [rgb[0] * directionalScale, rgb[1] * directionalScale, rgb[2] * directionalScale] as [number, number, number],
  };
};

const sourceKey = (inst: WmoVisibilityInstance, group: number) => `${inst.root.uuid}:${group}`;

/**
 * Per-object WMO light provider. Camera/player membership is accepted only for the local player;
 * every other model resolves its own authored group without mutating portal state.
 */
export class M2WorldLightingResolver {
  private readonly cache = new WeakMap<THREE.Object3D, CachedLight>();
  private readonly local = new THREE.Vector3();
  private readonly candidates: WmoVisibilityInstance[] = [];
  private readonly instances: () => readonly WmoVisibilityInstance[];

  constructor(instances: () => readonly WmoVisibilityInstance[]) { this.instances = instances; }

  update(owner: THREE.Object3D, point: THREE.Vector3, useResolvedLightingGroup = false): M2WorldLight | null {
    const prior = this.cache.get(owner);
    const now = performance.now();
    if (prior && now - prior.at < 500
      && Math.hypot(point.x - prior.x, point.y - prior.y, point.z - prior.z) < 0.25) {
      owner.userData.wowM2Light = prior.value;
      if (performanceAblations.detail) recordEntityLightingLookup({ cacheHit: true, instancesTested: 0, indoor: !!prior.value,
        mocv: prior.value?.source.sample === 'mocv', localLights: prior.value?.localLights.length ?? 0, startedAt: now });
      return prior.value;
    }
    let instancesTested = 0;
    for (const inst of useResolvedLightingGroup ? this.instances() : wmoLightCandidates(this.instances(), point, this.candidates)) {
      if (performanceAblations.detail) instancesTested++;
      inst.root.updateWorldMatrix(true, false);
      this.local.copy(point);
      inst.root.worldToLocal(this.local);
      const groupIndex = useResolvedLightingGroup ? inst.lightingGroup : resolveWmoGroupAtLocalPoint(inst, this.local);
      const group = groupIndex >= 0 ? inst.groups[groupIndex] : undefined;
      if (!group || wmoGroupUsesOutdoorLighting(group.flags)) continue;
      const key = sourceKey(inst, groupIndex);
      const raw = sampleRawMocv(inst.model?.groups?.[groupIndex], this.local);
      const fallback = (inst.model?.ambient ?? [0.1, 0.1, 0.1]) as number[];
      const pair = raw
        ? build5875StaticLightPair(raw)
        : { ambient: [...fallback] as [number, number, number], directional: [0, 0, 0] as [number, number, number] };
      const pick = inst.root.userData.wmoPick as { tile?: string } | undefined;
      const localLights = mappedLocalLights(inst, point);
      const value: M2WorldLight = {
        ...pair,
        direction: FIXED_DIRECTION,
        localLights,
        source: {
          tile: pick?.tile ?? 'unknown',
          wmo: String(inst.model?.name ?? ''),
          group: groupIndex,
          sample: raw ? 'mocv' : 'ambient',
        },
      };
      this.cache.set(owner, { x: point.x, y: point.y, z: point.z, at: now, sourceKey: key, value });
      owner.userData.wowM2Light = value;
      if (performanceAblations.detail) recordEntityLightingLookup({ cacheHit: false, instancesTested, indoor: true,
        mocv: !!raw, localLights: localLights.length, startedAt: now });
      return value;
    }
    this.cache.set(owner, { x: point.x, y: point.y, z: point.z, at: now, sourceKey: 'outdoor', value: null });
    owner.userData.wowM2Light = null;
    if (performanceAblations.detail) recordEntityLightingLookup({ cacheHit: false, instancesTested, indoor: false,
      mocv: false, localLights: 0, startedAt: now });
    return null;
  }
}
